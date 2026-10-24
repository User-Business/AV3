import { Prisma, type StatusRastreamento } from '../generated/prisma/client.js';
import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import { isoDeDataSemHora, paraDataSemHora } from '../domain/contrato.js';
import { ErroNaoEncontrado, ErroValidacao } from '../domain/erros.js';
import type { UnidadeDeTrabalho } from '../repositories/index.js';
import { journalDTO } from './dto.js';

const UM_DIA_MS = 24 * 60 * 60 * 1000;

export class RelatorioService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  /** Quantidade e peso de equipamentos por status de rastreamento. */
  async porStatus(ator: Ator, status?: StatusRastreamento) {
    exigirPermissao(ator, 'relatorio:gerar');
    const grupos = await this.uow.leitura.equipamentos.contarPorStatus(
      status ? { statusRastreamento: status } : {},
    );
    return grupos
      .map((g) => ({
        status: g.statusRastreamento,
        quantidade: g._count._all,
        pesoTotalQuilogramas: g._sum.pesoQuilogramas?.toNumber() ?? 0,
      }))
      .sort((a, b) => a.status.localeCompare(b.status));
  }

  async porOrganizacao(ator: Ator, idOuCodigo: string, inicio: string, fim: string) {
    exigirPermissao(ator, 'relatorio:gerar');
    const { de, ate } = periodo(inicio, fim);
    const repos = this.uow.leitura;
    const ehUuid = /^[0-9a-f-]{36}$/i.test(idOuCodigo);
    const org = ehUuid
      ? await repos.organizacoes.buscarPorId(idOuCodigo)
      : await repos.organizacoes.buscarPorCodigo(idOuCodigo.toUpperCase());
    if (!org) throw new ErroNaoEncontrado('Organização', idOuCodigo);

    const lotes = await repos.lotes.listarPorPeriodo({ inicio: de, fim: ate, organizacaoId: org.id });
    const equipamentos = await repos.equipamentos.contarPorStatus({
      lote: { organizacaoId: org.id, dataEntrada: { gte: de, lte: ate } },
    });
    return {
      organizacao: { id: org.id, codigo: org.codigo, razaoSocial: org.razaoSocial },
      periodo: { inicio: de.toISOString(), fim: ate.toISOString() },
      quantidadeLotes: lotes.length,
      lotes: lotes.map((l) => ({
        id: l.id,
        notaFiscal: l.notaFiscal,
        dataEntrada: l.dataEntrada.toISOString(),
        statusProcessamento: l.statusProcessamento,
        quantidadeEquipamentos: l._count.equipamentos,
      })),
      equipamentosPorStatus: equipamentos.map((g) => ({
        status: g.statusRastreamento,
        quantidade: g._count._all,
        pesoTotalQuilogramas: g._sum.pesoQuilogramas?.toNumber() ?? 0,
      })),
    };
  }

  /**
   * Receita contratual proporcional aos dias de vigência dentro do período.
   * Aritmética em Decimal: somar dinheiro em float gera centavos fantasmas.
   */
  async financeiro(ator: Ator, inicio: string, fim: string) {
    exigirPermissao(ator, 'relatorio:gerar');
    const de = paraDataSemHora(inicio);
    const ate = paraDataSemHora(fim);
    if (de > ate) throw new ErroValidacao('Período inválido: inicio deve ser <= fim');

    const contratos = await this.uow.leitura.contratos.listarAtivosNoPeriodo(de, ate);
    let total = new Prisma.Decimal(0);
    const itens = contratos.map((c) => {
      const inicioEfetivo = Math.max(c.dataAssinatura.getTime(), de.getTime());
      const fimEfetivo = Math.min(c.dataVencimento.getTime(), ate.getTime());
      const dias = Math.floor((fimEfetivo - inicioEfetivo) / UM_DIA_MS) + 1;
      const receita = c.valorMensal.mul(dias).div(30).toDecimalPlaces(2);
      total = total.add(receita);
      return {
        contratoId: c.id,
        organizacao: c.organizacao,
        valorMensal: c.valorMensal.toFixed(2),
        diasNoPeriodo: dias,
        receitaEstimada: receita.toFixed(2),
      };
    });

    return {
      periodo: { inicio: isoDeDataSemHora(de), fim: isoDeDataSemHora(ate) },
      criterio: 'valorMensal x dias de vigência no período / 30',
      receitaTotalEstimada: total.toFixed(2),
      contratos: itens,
    };
  }

  async journal(
    ator: Ator,
    filtro: { entidade?: string; entidadeId?: string; inicio?: string; fim?: string; limite?: number },
  ) {
    exigirPermissao(ator, 'auditoria:ler');
    const registros = await this.uow.leitura.historico.listarJournal(
      {
        ...(filtro.entidade ? { entidade: filtro.entidade } : {}),
        ...(filtro.entidadeId ? { entidadeId: filtro.entidadeId } : {}),
        ...(filtro.inicio ? { inicio: new Date(filtro.inicio) } : {}),
        ...(filtro.fim ? { fim: new Date(filtro.fim) } : {}),
      },
      Math.min(filtro.limite ?? 100, 500),
    );
    return registros.map(journalDTO);
  }
}

function periodo(inicio: string, fim: string) {
  const de = new Date(inicio);
  const ate = new Date(fim);
  if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime()) || de > ate) {
    throw new ErroValidacao('Período inválido: informe inicio <= fim');
  }
  return { de, ate };
}
