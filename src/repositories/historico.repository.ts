import type { Db } from '../database.js';
import type { EstadoFisico, HistoricoEstadoFisico, JournalTransacao, Movimentacao, Prisma } from '../generated/prisma/client.js';

/** Movimentações e histórico de estado físico (append-only) e journal de auditoria. */
export class HistoricoRepository {
  constructor(private readonly db: Db) {}

  registrarMovimentacao(dados: {
    equipamentoId: string;
    origem: string;
    destino: string;
    responsavel: string;
    observacao?: string | null;
  }): Promise<Movimentacao> {
    return this.db.movimentacao.create({ data: dados });
  }

  /** Ponto da série temporal usada na análise de vida útil. */
  registrarEstadoFisico(dados: {
    equipamentoId: string;
    estadoAnterior: EstadoFisico | null;
    estadoNovo: EstadoFisico;
    responsavel: string;
    justificativa?: string | null;
  }): Promise<HistoricoEstadoFisico> {
    return this.db.historicoEstadoFisico.create({ data: dados });
  }

  registrarJournal(dados: {
    operacao: string;
    entidade: string;
    entidadeId: string;
    dadosAntes?: unknown;
    dadosDepois?: unknown;
    usuarioResponsavel: string;
  }): Promise<JournalTransacao> {
    return this.db.journalTransacao.create({
      data: {
        operacao: dados.operacao,
        entidade: dados.entidade,
        entidadeId: dados.entidadeId,
        dadosAntes: paraJson(dados.dadosAntes),
        dadosDepois: paraJson(dados.dadosDepois),
        usuarioResponsavel: dados.usuarioResponsavel,
      },
    });
  }

  listarJournal(filtro: { entidade?: string; entidadeId?: string; inicio?: Date; fim?: Date }, limite = 100) {
    return this.db.journalTransacao.findMany({
      where: {
        ...(filtro.entidade ? { entidade: filtro.entidade } : {}),
        ...(filtro.entidadeId ? { entidadeId: filtro.entidadeId } : {}),
        ...(filtro.inicio || filtro.fim
          ? { timestamp: { ...(filtro.inicio ? { gte: filtro.inicio } : {}), ...(filtro.fim ? { lte: filtro.fim } : {}) } }
          : {}),
      },
      orderBy: { id: 'desc' },
      take: limite,
    });
  }
}

/** Snapshot serializável (Decimal/Date -> string) para colunas JSONB. */
function paraJson(valor: unknown): Prisma.InputJsonValue | undefined {
  if (valor === undefined || valor === null) return undefined;
  return JSON.parse(JSON.stringify(valor)) as Prisma.InputJsonValue;
}
