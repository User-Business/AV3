import { createHmac } from 'node:crypto';
import type { FormatoRelatorio, Prisma, TarefaRelatorio } from '../generated/prisma/client.js';
import { idadeEmAnos, nivelEstado, projetarVidaRemanescente } from '../domain/analises.js';
import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import { exigirEscopo, type ParceiroAutenticado } from '../domain/chave-api.js';
import { ErroExpirado, ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../domain/erros.js';
import type { Armazenamento } from '../infra/armazenamento.js';
import { ErroDefinitivo, POLITICA_RETENTATIVA, type FilaTarefas } from '../infra/fila.js';
import type { UnidadeDeTrabalho } from '../repositories/index.js';
import type { AnaliseService } from './analise.service.js';

export const TIPOS_RELATORIO = ['PREDITIVO_VIDA_UTIL', 'RENTABILIDADE_EQUIPAMENTOS', 'RASTREABILIDADE'] as const;
export type TipoRelatorio = (typeof TIPOS_RELATORIO)[number];

export interface Registro {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface ConfiguracaoRelatorios {
  validadeHoras: number;
  webhookSecret: string;
  exigirHttps: boolean;
}

type Linha = Record<string, string | number | null>;
type EquipamentoRelatorio = Awaited<ReturnType<UnidadeDeTrabalho['leitura']['equipamentos']['paginaParaRelatorio']>>[number];

const TAMANHO_PAGINA = 1000;
const ENCERRADOS = ['BAIXA_DEFINITIVA', 'DESCARTE_SEGURO'] as const;

/** Célula CSV (RFC 4180), neutralizando injeção de fórmulas em planilhas. */
export function celulaCsv(valor: string | number | null): string {
  if (valor === null) return '';
  let texto = String(valor);
  if (typeof valor === 'string' && /^[=+\-@]/.test(texto)) texto = `'${texto}`;
  return /[",;\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export function tarefaDTO(t: TarefaRelatorio, prefixo: string) {
  return {
    tarefaId: t.id,
    tipo: t.tipo,
    formato: t.formato,
    status: t.status,
    tentativas: t.tentativas,
    criadaEm: t.criadaEm.toISOString(),
    concluidaEm: t.concluidaEm?.toISOString() ?? null,
    expiraEm: t.expiraEm?.toISOString() ?? null,
    tamanhoBytes: t.tamanhoBytes,
    erro: t.status === 'FALHOU' ? 'Falha ao gerar o relatório; solicite novamente' : null,
    links: {
      status: `${prefixo}/relatorios/${t.id}`,
      download: t.status === 'CONCLUIDA' ? `${prefixo}/relatorios/${t.id}/download` : null,
    },
  };
}

/**
 * Relatórios assíncronos: solicitação → fila → processamento com retentativas
 * → download (polling) ou aviso por webhook. O banco guarda o estado; a fila
 * transporta só o id da tarefa.
 */
export class RelatorioAssincronoService {
  constructor(
    private readonly uow: UnidadeDeTrabalho,
    private readonly analises: AnaliseService,
    private readonly fila: FilaTarefas,
    private readonly armazenamento: Armazenamento,
    private readonly config: ConfiguracaoRelatorios,
    private readonly log: Registro,
  ) {}

  // ------------------------------------------------------- solicitação

  async solicitarPorParceiro(
    parceiro: ParceiroAutenticado,
    dados: { tipo: TipoRelatorio; formato: FormatoRelatorio; webhookUrl?: string },
  ) {
    exigirEscopo(parceiro, 'RELATORIOS_SOLICITAR');
    return this.solicitar({
      organizacaoId: parceiro.organizacaoId,
      parceiroId: parceiro.parceiroId,
      solicitante: `parceiro:${parceiro.nome}`,
      ...dados,
    });
  }

  async solicitarInterno(ator: Ator, dados: { organizacao: string; tipo: TipoRelatorio; formato: FormatoRelatorio }) {
    exigirPermissao(ator, 'relatorio:gerar');
    const ehUuid = /^[0-9a-f-]{36}$/i.test(dados.organizacao);
    const org = ehUuid
      ? await this.uow.leitura.organizacoes.buscarPorId(dados.organizacao)
      : await this.uow.leitura.organizacoes.buscarPorCodigo(dados.organizacao.toUpperCase());
    if (!org) throw new ErroNaoEncontrado('Organização', dados.organizacao);
    return this.solicitar({ organizacaoId: org.id, parceiroId: null, solicitante: ator.usuario, tipo: dados.tipo, formato: dados.formato });
  }

  private async solicitar(dados: {
    organizacaoId: string;
    parceiroId: string | null;
    solicitante: string;
    tipo: TipoRelatorio;
    formato: FormatoRelatorio;
    webhookUrl?: string;
  }) {
    if (dados.webhookUrl) this.validarWebhook(dados.webhookUrl);
    const tarefa = await this.uow.leitura.tarefas.criar({
      organizacaoId: dados.organizacaoId,
      parceiroId: dados.parceiroId,
      solicitante: dados.solicitante.slice(0, 160),
      tipo: dados.tipo,
      formato: dados.formato,
      webhookUrl: dados.webhookUrl ?? null,
      maxTentativas: POLITICA_RETENTATIVA.tentativas,
    });
    await this.fila.publicar(tarefa.id);
    return tarefa;
  }

  // ------------------------------------------------- consulta e download

  async consultarPorParceiro(parceiro: ParceiroAutenticado, id: string) {
    exigirEscopo(parceiro, 'RELATORIOS_SOLICITAR');
    return this.uow.leitura.tarefas.buscarNoEscopoOuFalhar(id, { parceiroId: parceiro.parceiroId });
  }

  async consultarInterno(ator: Ator, id: string) {
    exigirPermissao(ator, 'relatorio:gerar');
    return this.uow.leitura.tarefas.buscarNoEscopoOuFalhar(id, {});
  }

  /** Abre o arquivo de uma tarefa já autorizada (consultada no escopo correto). */
  async abrirDownload(tarefa: TarefaRelatorio) {
    if (tarefa.status !== 'CONCLUIDA' || !tarefa.arquivo) {
      throw new ErroRegraNegocio(`Relatório ainda não disponível (status ${tarefa.status})`);
    }
    if ((tarefa.expiraEm && tarefa.expiraEm < new Date()) || !(await this.armazenamento.existe(tarefa.arquivo))) {
      throw new ErroExpirado('Relatório expirado; solicite uma nova geração');
    }
    return this.armazenamento.abrirLeitura(tarefa.arquivo);
  }

  // ------------------------------------------------------ processamento

  /** Processador registrado na fila. Idempotente: tarefa já finalizada é ignorada. */
  processar = async (tarefaId: string, tentativa: number): Promise<void> => {
    const repos = this.uow.leitura.tarefas;
    const tarefa = await repos.buscar(tarefaId);
    if (!tarefa) throw new ErroDefinitivo(`Tarefa ${tarefaId} inexistente`);
    if (tarefa.status === 'CONCLUIDA' || tarefa.status === 'FALHOU') return;
    if (!(TIPOS_RELATORIO as readonly string[]).includes(tarefa.tipo)) {
      await repos.atualizar(tarefaId, { status: 'FALHOU', erro: 'Tipo de relatório desconhecido' });
      throw new ErroDefinitivo(`Tipo ${tarefa.tipo} desconhecido`);
    }

    await repos.atualizar(tarefaId, { status: 'PROCESSANDO', tentativas: tentativa, iniciadaEm: new Date(), erro: null });
    const nomeArquivo = `${tarefa.id}.${tarefa.formato === 'CSV' ? 'csv' : 'json'}`;
    const escrita = await this.armazenamento.criarEscrita(nomeArquivo);
    try {
      const linhas = await this.gerar(tarefa.tipo as TipoRelatorio, tarefa.formato, tarefa.organizacaoId, escrita.escrever);
      const tamanhoBytes = await escrita.concluir();
      const concluida = await repos.atualizar(tarefaId, {
        status: 'CONCLUIDA',
        arquivo: nomeArquivo,
        tamanhoBytes,
        concluidaEm: new Date(),
        expiraEm: new Date(Date.now() + this.config.validadeHoras * 3_600_000),
      });
      this.log.info({ tarefaId, linhas, tamanhoBytes, tentativa }, 'relatório gerado');
      await this.notificar(concluida);
    } catch (erro) {
      await escrita.descartar();
      const definitivo = erro instanceof ErroDefinitivo || tentativa >= tarefa.maxTentativas;
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      const atualizada = await repos.atualizar(tarefaId, { status: definitivo ? 'FALHOU' : 'PENDENTE', erro: mensagem.slice(0, 2000) });
      this.log.warn({ tarefaId, tentativa, definitivo, erro: mensagem }, 'falha ao gerar relatório');
      if (definitivo) await this.notificar(atualizada);
      throw erro;
    }
  };

  /** Com a fila em memória, tarefas interrompidas por um reinício são republicadas. */
  async republicarInterrompidas(): Promise<number> {
    const tarefas = await this.uow.leitura.tarefas.listarInterrompidas();
    for (const { id } of tarefas) await this.fila.publicar(id);
    return tarefas.length;
  }

  /** Remove arquivos cujo prazo de download expirou (rotina diária). */
  async limparExpirados(): Promise<number> {
    const expiradas = await this.uow.leitura.tarefas.listarExpiradasComArquivo(new Date());
    for (const t of expiradas) {
      await this.armazenamento.remover(t.arquivo!);
      await this.uow.leitura.tarefas.atualizar(t.id, { arquivo: null });
    }
    return expiradas.length;
  }

  // ------------------------------------------------------------ geração

  /**
   * Percorre os equipamentos da organização em páginas de 1000 (cursor por id)
   * escrevendo direto no arquivo: memória constante com qualquer volume.
   */
  private async gerar(tipo: TipoRelatorio, formato: FormatoRelatorio, organizacaoId: string, escrever: (t: string) => Promise<void>) {
    const { colunas, filtro, linha } = await this.definicao(tipo);
    const where: Prisma.EquipamentoWhereInput = { ...filtro, lote: { organizacaoId } };

    if (formato === 'CSV') await escrever(colunas.join(';') + '\r\n');
    else await escrever(`{"tipo":"${tipo}","organizacaoId":"${organizacaoId}","geradoEm":"${new Date().toISOString()}","itens":[`);

    let cursor: string | undefined;
    let total = 0;
    for (;;) {
      const pagina = await this.uow.leitura.equipamentos.paginaParaRelatorio(where, cursor, TAMANHO_PAGINA);
      if (pagina.length === 0) break;
      const blocos = pagina.map((e) => {
        const l = linha(e);
        return formato === 'CSV' ? colunas.map((c) => celulaCsv(l[c] ?? null)).join(';') : JSON.stringify(l);
      });
      await escrever(formato === 'CSV' ? blocos.join('\r\n') + '\r\n' : (total > 0 ? ',' : '') + blocos.join(','));
      total += pagina.length;
      cursor = pagina[pagina.length - 1]!.id;
      if (pagina.length < TAMANHO_PAGINA) break;
    }
    if (formato === 'JSON') await escrever(`],"total":${total}}`);
    return total;
  }

  private async definicao(tipo: TipoRelatorio): Promise<{
    colunas: string[];
    filtro: Prisma.EquipamentoWhereInput;
    linha: (e: EquipamentoRelatorio) => Linha;
  }> {
    switch (tipo) {
      case 'PREDITIVO_VIDA_UTIL': {
        const execucao = await this.analises.modelosVidaUtilVigentes();
        const modelos = new Map(execucao.previsoesVidaUtil.map((p) => [p.tipo, p]));
        const agora = new Date();
        return {
          colunas: ['codigoBarras', 'tipo', 'marca', 'modelo', 'anoFabricacao', 'idadeAnos', 'estadoFisico', 'vidaRemanescenteAnos', 'dataPrevistaInservivel', 'metodo'],
          filtro: { statusRastreamento: { notIn: [...ENCERRADOS] } },
          linha: (e) => {
            const modelo = modelos.get(e.tipo);
            const projecao = projetarVidaRemanescente(modelo, nivelEstado(e.estadoFisico), agora);
            return {
              codigoBarras: e.codigoBarrasInterno,
              tipo: e.tipo,
              marca: e.marca,
              modelo: e.modelo,
              anoFabricacao: e.anoFabricacao,
              idadeAnos: Math.round(idadeEmAnos(e.anoFabricacao, agora) * 100) / 100,
              estadoFisico: e.estadoFisico,
              vidaRemanescenteAnos: projecao.anos,
              dataPrevistaInservivel: projecao.dataPrevista?.toISOString().slice(0, 10) ?? null,
              metodo: modelo?.metodo ?? null,
            };
          },
        };
      }
      case 'RENTABILIDADE_EQUIPAMENTOS':
        return {
          colunas: ['codigoBarras', 'tipo', 'marca', 'modelo', 'estadoFisico', 'pesoKg', 'status', 'valorRecuperado'],
          filtro: {},
          linha: (e) => ({
            codigoBarras: e.codigoBarrasInterno,
            tipo: e.tipo,
            marca: e.marca,
            modelo: e.modelo,
            estadoFisico: e.estadoFisico,
            pesoKg: e.pesoQuilogramas.toNumber(),
            status: e.statusRastreamento,
            valorRecuperado: e.valorRecuperado?.toNumber() ?? null,
          }),
        };
      case 'RASTREABILIDADE':
        return {
          colunas: ['codigoBarras', 'tipo', 'notaFiscal', 'dataEntrada', 'status', 'localAtual', 'ultimaMovimentacao'],
          filtro: {},
          linha: (e) => ({
            codigoBarras: e.codigoBarrasInterno,
            tipo: e.tipo,
            notaFiscal: e.lote.notaFiscal,
            dataEntrada: e.lote.dataEntrada.toISOString(),
            status: e.statusRastreamento,
            localAtual: e.movimentacoes[0]?.destino ?? null,
            ultimaMovimentacao: e.movimentacoes[0]?.dataHora.toISOString() ?? null,
          }),
        };
    }
  }

  // ------------------------------------------------------------ webhook

  private validarWebhook(url: string) {
    let alvo: URL;
    try {
      alvo = new URL(url);
    } catch {
      throw new ErroValidacao('webhookUrl inválida');
    }
    const permitidos = this.config.exigirHttps ? ['https:'] : ['https:', 'http:'];
    if (!permitidos.includes(alvo.protocol)) throw new ErroValidacao(`webhookUrl deve usar ${permitidos.join(' ou ')}`);
  }

  /** Aviso ao parceiro (melhor esforço), assinado com HMAC-SHA256. */
  private async notificar(tarefa: TarefaRelatorio) {
    if (!tarefa.webhookUrl) return;
    const corpo = JSON.stringify({
      evento: tarefa.status === 'CONCLUIDA' ? 'relatorio.concluido' : 'relatorio.falhou',
      ...tarefaDTO(tarefa, '/api/v1/public'),
    });
    const assinatura = createHmac('sha256', this.config.webhookSecret).update(corpo).digest('hex');
    try {
      const resposta = await fetch(tarefa.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-greencode-assinatura': `sha256=${assinatura}` },
        body: corpo,
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!resposta.ok) this.log.warn({ tarefaId: tarefa.id, status: resposta.status }, 'webhook respondeu com erro');
    } catch (erro) {
      this.log.warn({ tarefaId: tarefa.id, erro: (erro as Error).message }, 'falha ao entregar webhook');
    }
  }
}
