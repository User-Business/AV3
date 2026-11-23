import type { Db } from '../database.js';
import type { Prisma, TipoAnalise } from '../generated/prisma/client.js';
import { ErroNaoEncontrado } from '../domain/erros.js';

export const INCLUIR_RESULTADOS = {
  metricasEficiencia: { orderBy: [{ dimensao: 'asc' }, { chave: 'asc' }] },
  metricasRentabilidade: { orderBy: { valorMedio: 'desc' } },
  previsoesVidaUtil: { orderBy: { tipo: 'asc' } },
} as const satisfies Prisma.ExecucaoAnaliseInclude;

export type ExecucaoCompleta = Prisma.ExecucaoAnaliseGetPayload<{ include: typeof INCLUIR_RESULTADOS }>;

/** Leitura dos dados de origem e persistência das execuções analíticas. */
export class AnaliseRepository {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------- origem

  lotesTriados(filtro: { organizacaoId?: string; inicio?: Date; fim?: Date }) {
    return this.db.lote.findMany({
      where: {
        conclusaoTriagemEm: {
          not: null,
          ...(filtro.inicio ? { gte: filtro.inicio } : {}),
          ...(filtro.fim ? { lte: filtro.fim } : {}),
        },
        ...(filtro.organizacaoId ? { organizacaoId: filtro.organizacaoId } : {}),
      },
      select: { dataEntrada: true, conclusaoTriagemEm: true, responsavelTriagem: true },
    });
  }

  equipamentosComValorRecuperado(filtro: { organizacaoId?: string; inicio?: Date; fim?: Date }) {
    return this.db.equipamento.findMany({
      where: {
        valorRecuperado: { not: null },
        lote: {
          ...(filtro.organizacaoId ? { organizacaoId: filtro.organizacaoId } : {}),
          ...(filtro.inicio || filtro.fim
            ? { dataEntrada: { ...(filtro.inicio ? { gte: filtro.inicio } : {}), ...(filtro.fim ? { lte: filtro.fim } : {}) } }
            : {}),
        },
      },
      select: { tipo: true, estadoFisico: true, marca: true, modelo: true, valorRecuperado: true, pesoQuilogramas: true },
    });
  }

  historicoEstados(filtro: { organizacaoId?: string; inicio?: Date; fim?: Date }) {
    return this.db.historicoEstadoFisico.findMany({
      where: {
        ...(filtro.inicio || filtro.fim
          ? { dataHora: { ...(filtro.inicio ? { gte: filtro.inicio } : {}), ...(filtro.fim ? { lte: filtro.fim } : {}) } }
          : {}),
        ...(filtro.organizacaoId ? { equipamento: { lote: { organizacaoId: filtro.organizacaoId } } } : {}),
      },
      select: { dataHora: true, estadoNovo: true, equipamento: { select: { tipo: true, anoFabricacao: true } } },
    });
  }

  equipamentosInserviveis() {
    return this.db.equipamento.findMany({
      where: { inservivelEm: { not: null } },
      select: { tipo: true, anoFabricacao: true, inservivelEm: true },
    });
  }

  previsoesComIdade() {
    return this.db.previsaoVidaUtil.findMany({
      where: { idadeInservivelAnos: { not: null } },
      select: { tipo: true, idadeInservivelAnos: true, execucao: { select: { geradaEm: true } } },
      orderBy: { execucao: { geradaEm: 'desc' } },
    });
  }

  // ---------------------------------------------------------- execuções

  criarExecucao(dados: Prisma.ExecucaoAnaliseCreateInput): Promise<ExecucaoCompleta> {
    return this.db.execucaoAnalise.create({ data: dados, include: INCLUIR_RESULTADOS });
  }

  async buscarExecucao(id: string): Promise<ExecucaoCompleta> {
    const execucao = await this.db.execucaoAnalise.findUnique({ where: { id }, include: INCLUIR_RESULTADOS });
    if (!execucao) throw new ErroNaoEncontrado('Execução de análise', id);
    return execucao;
  }

  /** Execução mais recente do tipo/escopo gerada a partir de `desde`. */
  recente(tipo: TipoAnalise, organizacaoId: string | null, desde?: Date): Promise<ExecucaoCompleta | null> {
    return this.db.execucaoAnalise.findFirst({
      where: {
        tipo,
        organizacaoId,
        periodoInicio: null,
        periodoFim: null,
        ...(desde ? { geradaEm: { gte: desde } } : {}),
      },
      orderBy: { geradaEm: 'desc' },
      include: INCLUIR_RESULTADOS,
    });
  }

  listarExecucoes(filtro: { tipo?: TipoAnalise; limite: number }) {
    return this.db.execucaoAnalise.findMany({
      where: filtro.tipo ? { tipo: filtro.tipo } : {},
      orderBy: { geradaEm: 'desc' },
      take: filtro.limite,
    });
  }
}
