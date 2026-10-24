import {
  StatusLote,
  StatusRastreamento,
  type EstadoFisico,
  type TipoEquipamento,
} from '../generated/prisma/client.js';
import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import { contratoParaDominio, equipamentoDTO, equipamentoParaDominio, loteDTO, loteParaDominio } from './dto.js';
import { Equipamento, gerarCodigoBarras } from '../domain/equipamento.js';
import { ErroConflito, ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../domain/erros.js';
import { validarDataEntrada } from '../domain/lote.js';
import type { Repositorios, UnidadeDeTrabalho } from '../repositories/index.js';

export interface DadosNovoEquipamento {
  tipo: TipoEquipamento;
  marca: string;
  modelo: string;
  anoFabricacao: number;
  estadoFisico: EstadoFisico;
  pesoQuilogramas: number;
}

export interface DadosNovoLote {
  /** id (uuid) ou código da organização, ex.: BR001 */
  organizacao: string;
  notaFiscal: string;
  transportadora: string;
  dataEntrada: string;
  observacoes?: string;
  equipamentos: DadosNovoEquipamento[];
}

export const MAXIMO_EQUIPAMENTOS_POR_REQUISICAO = 500;

export class LoteService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  /**
   * Cria o lote JÁ com seus equipamentos, numa única transação: ou entra tudo
   * (lote, equipamentos, movimentações de entrada e journal) ou nada.
   */
  async criar(ator: Ator, dados: DadosNovoLote, agora = new Date()) {
    exigirPermissao(ator, 'lote:escrever');

    const dataEntrada = new Date(dados.dataEntrada);
    validarDataEntrada(dataEntrada, agora);
    if (dados.equipamentos.length === 0) {
      throw new ErroValidacao('Um lote deve conter ao menos um equipamento');
    }
    if (dados.equipamentos.length > MAXIMO_EQUIPAMENTOS_POR_REQUISICAO) {
      throw new ErroValidacao(`Máximo de ${MAXIMO_EQUIPAMENTOS_POR_REQUISICAO} equipamentos por requisição`);
    }
    dados.equipamentos.forEach((e) => Equipamento.validarNovo(e, agora));

    return this.uow.emTransacao(async (repos) => {
      const org = await obterOrganizacao(repos, dados.organizacao);
      if (!org.ativo) throw new ErroRegraNegocio(`A organização ${org.codigo} está inativa`);
      if (!org.contrato || !contratoParaDominio(org.contrato).estaVigente()) {
        throw new ErroRegraNegocio(`A organização ${org.codigo} não possui contrato vigente`);
      }
      const notaFiscal = dados.notaFiscal.trim();
      if (await repos.lotes.existeNotaFiscal(org.id, notaFiscal)) {
        throw new ErroConflito(`A nota fiscal ${notaFiscal} já foi registrada para ${org.codigo}`);
      }

      const lote = await repos.lotes.criar({
        organizacaoId: org.id,
        dataEntrada,
        notaFiscal,
        transportadora: dados.transportadora.trim(),
        observacoes: dados.observacoes?.trim() || null,
      });

      let posicao = 1;
      for (const equipamento of dados.equipamentos) {
        await incluirEquipamento(repos, ator, lote.id, posicao++, equipamento, `ORGANIZACAO:${org.codigo}`);
      }

      const criado = await repos.lotes.buscarOuFalhar(lote.id);
      await repos.historico.registrarJournal({
        operacao: 'CRIAR',
        entidade: 'Lote',
        entidadeId: lote.id,
        dadosDepois: { ...loteDTO(criado), equipamentos: criado.equipamentos.map((e) => e.codigoBarrasInterno) },
        usuarioResponsavel: ator.usuario,
      });
      return loteDTO(criado);
    });
  }

  async adicionarEquipamento(ator: Ator, loteId: string, versao: number, dados: DadosNovoEquipamento) {
    exigirPermissao(ator, 'lote:escrever');
    Equipamento.validarNovo(dados);

    return this.uow.emTransacao(async (repos) => {
      const lote = await repos.lotes.buscarOuFalhar(loteId);
      loteParaDominio(lote).garantirAbertoParaAlteracao();
      // Versão + trava da linha do lote: inclusões simultâneas não disputam a mesma posição
      await repos.lotes.atualizar(lote.id, versao);
      const posicao = await repos.lotes.proximaPosicao(lote.id);
      const equipamento = await incluirEquipamento(
        repos, ator, lote.id, posicao, dados, `ORGANIZACAO:${lote.organizacao.codigo}`,
      );
      await repos.historico.registrarJournal({
        operacao: 'ADICIONAR_EQUIPAMENTO',
        entidade: 'Lote',
        entidadeId: lote.id,
        dadosDepois: equipamentoDTO(equipamento),
        usuarioResponsavel: ator.usuario,
      });
      return loteDTO(await repos.lotes.buscarOuFalhar(lote.id));
    });
  }

  async removerEquipamento(ator: Ator, loteId: string, equipamentoId: string, versao: number) {
    exigirPermissao(ator, 'lote:escrever');

    return this.uow.emTransacao(async (repos) => {
      const lote = await repos.lotes.buscarOuFalhar(loteId);
      const equipamento = lote.equipamentos.find((e) => e.id === equipamentoId);
      if (!equipamento) throw new ErroNaoEncontrado(`Equipamento no lote ${loteId}`, equipamentoId);
      loteParaDominio(lote).garantirPodeRemoverEquipamento();

      await repos.lotes.atualizar(lote.id, versao);
      await repos.equipamentos.remover(equipamento.id);
      await repos.historico.registrarJournal({
        operacao: 'REMOVER_EQUIPAMENTO',
        entidade: 'Lote',
        entidadeId: lote.id,
        dadosAntes: equipamentoDTO(equipamento),
        usuarioResponsavel: ator.usuario,
      });
      return loteDTO(await repos.lotes.buscarOuFalhar(lote.id));
    });
  }

  /**
   * Avança o status do lote. Ao iniciar a triagem, todos os equipamentos
   * aguardando triagem passam para EM_TRIAGEM na mesma transação, cada um com
   * sua movimentação registrada.
   */
  async alterarStatus(ator: Ator, loteId: string, versao: number, novoStatus: StatusLote) {
    exigirPermissao(ator, 'lote:escrever');

    return this.uow.emTransacao(async (repos) => {
      const lote = await repos.lotes.buscarOuFalhar(loteId);
      const transicao = loteParaDominio(lote).avancarStatus(novoStatus);
      await repos.lotes.atualizar(lote.id, versao, { statusProcessamento: novoStatus });

      if (novoStatus === StatusLote.EM_TRIAGEM) {
        for (const registro of await repos.equipamentos.listarEmPreTriagemDoLote(lote.id)) {
          const equipamento = equipamentoParaDominio(registro);
          const mudanca = equipamento.atualizarStatus(StatusRastreamento.EM_TRIAGEM, undefined, StatusLote.EM_TRIAGEM);
          await repos.equipamentos.atualizar(registro.id, registro.versao, { statusRastreamento: mudanca.destino });
          await repos.historico.registrarMovimentacao({
            equipamentoId: registro.id,
            origem: mudanca.origem,
            destino: mudanca.destino,
            responsavel: ator.usuario,
            observacao: 'Início da triagem do lote',
          });
        }
      }

      await repos.historico.registrarJournal({
        operacao: 'ALTERAR_STATUS',
        entidade: 'Lote',
        entidadeId: lote.id,
        dadosAntes: { statusProcessamento: transicao.origem },
        dadosDepois: { statusProcessamento: transicao.destino },
        usuarioResponsavel: ator.usuario,
      });
      return loteDTO(await repos.lotes.buscarOuFalhar(lote.id));
    });
  }

  async buscar(ator: Ator, id: string) {
    exigirPermissao(ator, 'lote:ler');
    return loteDTO(await this.uow.leitura.lotes.buscarOuFalhar(id));
  }

  async consultarPorPeriodo(
    ator: Ator,
    filtro: { inicio: string; fim: string; status?: StatusLote; organizacao?: string },
  ) {
    exigirPermissao(ator, 'lote:ler');
    const inicio = new Date(filtro.inicio);
    const fim = new Date(filtro.fim);
    if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || inicio > fim) {
      throw new ErroValidacao('Período inválido: informe inicio <= fim');
    }
    const organizacaoId = filtro.organizacao
      ? (await obterOrganizacao(this.uow.leitura, filtro.organizacao)).id
      : undefined;

    const lotes = await this.uow.leitura.lotes.listarPorPeriodo({
      inicio,
      fim,
      ...(filtro.status ? { status: filtro.status } : {}),
      ...(organizacaoId ? { organizacaoId } : {}),
    });
    return lotes.map((l) => ({
      id: l.id,
      organizacao: l.organizacao,
      dataEntrada: l.dataEntrada.toISOString(),
      notaFiscal: l.notaFiscal,
      transportadora: l.transportadora,
      statusProcessamento: l.statusProcessamento,
      quantidadeEquipamentos: l._count.equipamentos,
      versao: l.versao,
    }));
  }

  /** Equivalente ao Lote.gerarRelatorioTriagem() do diagrama, em JSON. */
  async relatorioTriagem(ator: Ator, id: string) {
    exigirPermissao(ator, 'lote:ler');
    const lote = await this.uow.leitura.lotes.buscarOuFalhar(id);
    const contar = <K extends string>(chaves: K[]) =>
      chaves.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
    const depreciacoes = lote.equipamentos.map((e) => equipamentoParaDominio(e).calcularDepreciacao());

    return {
      loteId: lote.id,
      organizacao: lote.organizacao,
      statusProcessamento: lote.statusProcessamento,
      quantidadeEquipamentos: lote.equipamentos.length,
      pesoTotalQuilogramas: loteParaDominio(lote).calcularPesoTotal(),
      porStatus: contar(lote.equipamentos.map((e) => e.statusRastreamento)),
      porEstadoFisico: contar(lote.equipamentos.map((e) => e.estadoFisico)),
      porTipo: contar(lote.equipamentos.map((e) => e.tipo)),
      depreciacaoMedia: depreciacoes.length
        ? Math.round((depreciacoes.reduce((a, b) => a + b, 0) / depreciacoes.length) * 10_000) / 10_000
        : 0,
    };
  }
}

async function obterOrganizacao(repos: Repositorios, idOuCodigo: string) {
  const ehUuid = /^[0-9a-f-]{36}$/i.test(idOuCodigo);
  const org = ehUuid
    ? await repos.organizacoes.buscarPorId(idOuCodigo)
    : await repos.organizacoes.buscarPorCodigo(idOuCodigo.trim().toUpperCase());
  if (!org) throw new ErroNaoEncontrado('Organização', idOuCodigo);
  return org;
}

async function incluirEquipamento(
  repos: Repositorios,
  ator: Ator,
  loteId: string,
  posicao: number,
  dados: DadosNovoEquipamento,
  origem: string,
) {
  const sequencia = await repos.equipamentos.proximaSequenciaCodigo();
  const criado = await repos.equipamentos.criar({
    codigoBarrasInterno: gerarCodigoBarras(dados.tipo, sequencia),
    tipo: dados.tipo,
    marca: dados.marca.trim(),
    modelo: dados.modelo.trim(),
    anoFabricacao: dados.anoFabricacao,
    estadoFisico: dados.estadoFisico,
    pesoQuilogramas: dados.pesoQuilogramas,
    loteId,
    posicaoNoLote: posicao,
  });
  await repos.historico.registrarMovimentacao({
    equipamentoId: criado.id,
    origem,
    destino: criado.statusRastreamento,
    responsavel: ator.usuario,
    observacao: 'Entrada no almoxarifado',
  });
  return criado;
}
