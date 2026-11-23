import type { OrigemExecucao, Prisma, TipoAnalise } from '../generated/prisma/client.js';
import {
  ajustarModelosVidaUtil,
  calcularEficiencia,
  calcularRentabilidade,
  erroAbsolutoMedio,
  idadeEmAnos,
  nivelEstado,
} from '../domain/analises.js';
import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import { exigirEscopo, type ParceiroAutenticado } from '../domain/chave-api.js';
import { ErroNaoEncontrado, ErroValidacao } from '../domain/erros.js';
import type { ExecucaoCompleta } from '../repositories/analise.repository.js';
import type { UnidadeDeTrabalho } from '../repositories/index.js';

export interface OpcoesExecucao {
  origem: OrigemExecucao;
  organizacaoId?: string;
  inicio?: Date;
  fim?: Date;
}

/** Validade de uma execução reaproveitada pela API pública. */
const VALIDADE_CACHE_MS = 24 * 3_600_000;

/**
 * Camada analítica. Cada execução é gravada como registro imutável com suas
 * métricas em tabelas filhas: preserva o histórico e permite confrontar
 * previsões antigas com o que de fato aconteceu.
 */
export class AnaliseService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  // ------------------------------------------------------ uso interno

  async executar(ator: Ator, tipo: TipoAnalise, filtro: { organizacao?: string; inicio?: string; fim?: string }) {
    exigirPermissao(ator, 'analise:executar');
    const inicio = filtro.inicio ? new Date(`${filtro.inicio}T00:00:00.000Z`) : undefined;
    const fim = filtro.fim ? new Date(`${filtro.fim}T23:59:59.999Z`) : undefined;
    if (inicio && fim && inicio > fim) throw new ErroValidacao('Período inválido: inicio deve ser <= fim');

    let organizacaoId: string | undefined;
    if (filtro.organizacao) {
      const ehUuid = /^[0-9a-f-]{36}$/i.test(filtro.organizacao);
      const org = ehUuid
        ? await this.uow.leitura.organizacoes.buscarPorId(filtro.organizacao)
        : await this.uow.leitura.organizacoes.buscarPorCodigo(filtro.organizacao.toUpperCase());
      if (!org) throw new ErroNaoEncontrado('Organização', filtro.organizacao);
      organizacaoId = org.id;
    }
    return this.calcular(tipo, {
      origem: 'SOB_DEMANDA',
      ...(organizacaoId ? { organizacaoId } : {}),
      ...(inicio ? { inicio } : {}),
      ...(fim ? { fim } : {}),
    });
  }

  async buscarExecucao(ator: Ator, id: string) {
    exigirPermissao(ator, 'analise:ler');
    return this.uow.leitura.analises.buscarExecucao(id);
  }

  async listarExecucoes(ator: Ator, filtro: { tipo?: TipoAnalise; limite?: number }) {
    exigirPermissao(ator, 'analise:ler');
    return this.uow.leitura.analises.listarExecucoes({
      ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
      limite: Math.min(filtro.limite ?? 50, 200),
    });
  }

  /**
   * Para cada equipamento que já se tornou inservível, compara a idade real com
   * a idade prevista pela última execução ANTERIOR ao evento (erro absoluto médio).
   */
  async acuraciaVidaUtil(ator: Ator) {
    exigirPermissao(ator, 'analise:ler');
    const repos = this.uow.leitura.analises;
    const [realizados, previsoes] = await Promise.all([repos.equipamentosInserviveis(), repos.previsoesComIdade()]);

    const pares: Array<{ tipo: string; previsto: number; real: number }> = [];
    for (const eq of realizados) {
      const anterior = previsoes.find((p) => p.tipo === eq.tipo && p.execucao.geradaEm < eq.inservivelEm!);
      if (!anterior) continue;
      pares.push({ tipo: eq.tipo, previsto: anterior.idadeInservivelAnos!, real: idadeEmAnos(eq.anoFabricacao, eq.inservivelEm!) });
    }
    const tipos = [...new Set(pares.map((p) => p.tipo))].sort();
    return {
      comparacoes: pares.length,
      erroAbsolutoMedioAnos: erroAbsolutoMedio(pares),
      porTipo: tipos.map((tipo) => {
        const doTipo = pares.filter((p) => p.tipo === tipo);
        return { tipo, comparacoes: doTipo.length, erroAbsolutoMedioAnos: erroAbsolutoMedio(doTipo) };
      }),
    };
  }

  // ------------------------------------------------------- API pública

  /** Eficiência da própria organização do parceiro (reaproveita execução de até 24 h). */
  async eficienciaParaParceiro(parceiro: ParceiroAutenticado) {
    exigirEscopo(parceiro, 'ANALISES_LEITURA');
    return this.recenteOuCalcular('EFICIENCIA_OPERACIONAL', parceiro.organizacaoId);
  }

  /** Rentabilidade e vida útil: referência de mercado agregada sobre toda a base. */
  async referenciaParaParceiro(parceiro: ParceiroAutenticado, tipo: 'RENTABILIDADE' | 'VIDA_UTIL') {
    exigirEscopo(parceiro, 'ANALISES_LEITURA');
    return this.recenteOuCalcular(tipo, null);
  }

  // ----------------------------------------------- agendador e relatórios

  /** Recalcula as três análises sobre a base completa (rotina diária). */
  async executarTodas(origem: OrigemExecucao): Promise<ExecucaoCompleta[]> {
    const resultado: ExecucaoCompleta[] = [];
    for (const tipo of ['EFICIENCIA_OPERACIONAL', 'RENTABILIDADE', 'VIDA_UTIL'] as const) {
      resultado.push(await this.calcular(tipo, { origem }));
    }
    return resultado;
  }

  /** Modelos de vida útil vigentes (base completa), usados pelo relatório preditivo. */
  async modelosVidaUtilVigentes(): Promise<ExecucaoCompleta> {
    return (await this.uow.leitura.analises.recente('VIDA_UTIL', null)) ?? this.calcular('VIDA_UTIL', { origem: 'SOB_DEMANDA' });
  }

  // ----------------------------------------------------------- cálculo

  private async recenteOuCalcular(tipo: TipoAnalise, organizacaoId: string | null) {
    const recente = await this.uow.leitura.analises.recente(tipo, organizacaoId, new Date(Date.now() - VALIDADE_CACHE_MS));
    return recente ?? this.calcular(tipo, { origem: 'API_PUBLICA', ...(organizacaoId ? { organizacaoId } : {}) });
  }

  async calcular(tipo: TipoAnalise, opcoes: OpcoesExecucao): Promise<ExecucaoCompleta> {
    const inicio = Date.now();
    const repos = this.uow.leitura.analises;
    const filtro = {
      ...(opcoes.organizacaoId ? { organizacaoId: opcoes.organizacaoId } : {}),
      ...(opcoes.inicio ? { inicio: opcoes.inicio } : {}),
      ...(opcoes.fim ? { fim: opcoes.fim } : {}),
    };

    let amostras: number;
    let resumo: Prisma.InputJsonValue;
    let filhos: Pick<Prisma.ExecucaoAnaliseCreateInput, 'metricasEficiencia' | 'metricasRentabilidade' | 'previsoesVidaUtil'>;

    switch (tipo) {
      case 'EFICIENCIA_OPERACIONAL': {
        const lotes = await repos.lotesTriados(filtro);
        const grupos = calcularEficiencia(
          lotes.map((l) => ({ dataEntrada: l.dataEntrada, conclusaoTriagemEm: l.conclusaoTriagemEm!, responsavelTriagem: l.responsavelTriagem })),
        );
        const geral = grupos[0]!;
        amostras = lotes.length;
        resumo = {
          mediaHoras: geral.media,
          medianaHoras: geral.mediana,
          gargalos: grupos.filter((g) => g.gargalo).map((g) => ({ dimensao: g.dimensao, rotulo: g.rotulo, medianaHoras: g.mediana })),
        };
        filhos = {
          metricasEficiencia: {
            create: grupos.map((g) => ({
              dimensao: g.dimensao,
              chave: g.chave.slice(0, 60),
              rotulo: g.rotulo.slice(0, 100),
              quantidadeLotes: g.n,
              mediaHoras: g.media,
              medianaHoras: g.mediana,
              desvioPadraoHoras: g.desvioPadrao,
              percentil90Horas: g.percentil90,
              gargalo: g.gargalo,
            })),
          },
        };
        break;
      }
      case 'RENTABILIDADE': {
        const itens = await repos.equipamentosComValorRecuperado(filtro);
        const grupos = calcularRentabilidade(
          itens.map((e) => ({
            tipo: e.tipo,
            estadoFisico: e.estadoFisico,
            marca: e.marca,
            modelo: e.modelo,
            valor: e.valorRecuperado!.toNumber(),
            pesoKg: e.pesoQuilogramas.toNumber(),
          })),
        );
        const porTipo = grupos.filter((g) => !g.estadoFisico && !g.marca);
        amostras = itens.length;
        resumo = {
          valorTotalRecuperado: porTipo.reduce((s, g) => s + g.valorTotal, 0),
          rankingTipos: porTipo.map((g) => ({ tipo: g.tipo, valorMedio: g.valorMedio, amostras: g.amostras })),
        };
        filhos = { metricasRentabilidade: { create: grupos } };
        break;
      }
      case 'VIDA_UTIL': {
        const historico = await repos.historicoEstados(filtro);
        const modelos = ajustarModelosVidaUtil(
          historico.map((h) => ({
            tipo: h.equipamento.tipo,
            idadeAnos: idadeEmAnos(h.equipamento.anoFabricacao, h.dataHora),
            nivel: nivelEstado(h.estadoNovo),
          })),
        );
        amostras = historico.length;
        resumo = {
          tiposModelados: modelos.length,
          tiposComAmostraSuficiente: modelos.filter((m) => m.suficiente).length,
          idadeInservivelPorTipo: Object.fromEntries(modelos.map((m) => [m.tipo, m.idadeInservivelAnos])),
        };
        filhos = { previsoesVidaUtil: { create: modelos } };
        break;
      }
    }

    return repos.criarExecucao({
      tipo,
      origem: opcoes.origem,
      organizacaoId: opcoes.organizacaoId ?? null,
      periodoInicio: opcoes.inicio ?? null,
      periodoFim: opcoes.fim ?? null,
      amostras,
      resumo,
      duracaoMs: Date.now() - inicio,
      ...filhos,
    });
  }
}
