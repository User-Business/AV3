import type { Db } from '../database.js';
import type {
  Equipamento,
  Prisma,
  StatusLote,
  StatusRastreamento,
  TipoEquipamento,
} from '../generated/prisma/client.js';
import { ErroNaoEncontrado, conflitoDeVersao } from '../domain/erros.js';

const INCLUIR_RASTREIO = {
  lote: {
    select: {
      id: true,
      notaFiscal: true,
      dataEntrada: true,
      statusProcessamento: true,
      organizacao: { select: { id: true, codigo: true, razaoSocial: true } },
    },
  },
  movimentacoes: { orderBy: { dataHora: 'asc' } },
  historicoEstados: { orderBy: { dataHora: 'asc' } },
} as const satisfies Prisma.EquipamentoInclude;

export type EquipamentoRastreado = Prisma.EquipamentoGetPayload<{ include: typeof INCLUIR_RASTREIO }>;
export type EquipamentoComLote = Equipamento & { lote: { statusProcessamento: StatusLote } };

export class EquipamentoRepository {
  constructor(private readonly db: Db) {}

  /** Sequence do PostgreSQL: atômica mesmo com requisições simultâneas. */
  async proximaSequenciaCodigo(): Promise<number> {
    const [linha] = await this.db.$queryRaw<{ valor: bigint }[]>`SELECT nextval('equipamento_codigo_seq') AS valor`;
    return Number(linha!.valor);
  }

  criar(dados: Prisma.EquipamentoUncheckedCreateInput): Promise<Equipamento> {
    return this.db.equipamento.create({ data: dados });
  }

  buscarComLote(id: string): Promise<EquipamentoComLote | null> {
    return this.db.equipamento.findUnique({
      where: { id },
      include: { lote: { select: { statusProcessamento: true } } },
    });
  }

  async buscarComLoteOuFalhar(id: string): Promise<EquipamentoComLote> {
    const equipamento = await this.buscarComLote(id);
    if (!equipamento) throw new ErroNaoEncontrado('Equipamento', id);
    return equipamento;
  }

  /**
   * Eager loading do histórico completo (lote, organização, movimentações e
   * estados). Com `organizacaoId`, só encontra equipamentos daquela organização
   * (uso da API pública).
   */
  rastrear(idOuCodigo: string, organizacaoId?: string): Promise<EquipamentoRastreado | null> {
    const ehUuid = /^[0-9a-f-]{36}$/i.test(idOuCodigo);
    return this.db.equipamento.findFirst({
      where: {
        ...(ehUuid ? { id: idOuCodigo } : { codigoBarrasInterno: idOuCodigo.toUpperCase() }),
        ...(organizacaoId ? { lote: { organizacaoId } } : {}),
      },
      include: INCLUIR_RASTREIO,
    });
  }

  /**
   * Página de equipamentos para os relatórios assíncronos. Paginação por cursor
   * (id): o consumo de memória fica constante mesmo com milhares de registros.
   */
  paginaParaRelatorio(filtro: Prisma.EquipamentoWhereInput, depoisDe: string | undefined, tamanho: number) {
    return this.db.equipamento.findMany({
      where: filtro,
      orderBy: { id: 'asc' },
      take: tamanho,
      ...(depoisDe ? { cursor: { id: depoisDe }, skip: 1 } : {}),
      include: {
        lote: { select: { notaFiscal: true, dataEntrada: true } },
        movimentacoes: { orderBy: { dataHora: 'desc' }, take: 1, select: { destino: true, dataHora: true } },
      },
    });
  }

  listar(filtro: { status?: StatusRastreamento; tipo?: TipoEquipamento; loteId?: string }, limite = 200) {
    return this.db.equipamento.findMany({
      where: {
        ...(filtro.status ? { statusRastreamento: filtro.status } : {}),
        ...(filtro.tipo ? { tipo: filtro.tipo } : {}),
        ...(filtro.loteId ? { loteId: filtro.loteId } : {}),
      },
      orderBy: [{ loteId: 'asc' }, { posicaoNoLote: 'asc' }],
      take: limite,
    });
  }

  listarEmPreTriagemDoLote(loteId: string): Promise<Equipamento[]> {
    return this.db.equipamento.findMany({
      where: { loteId, statusRastreamento: 'AGUARDANDO_TRIAGEM' },
      orderBy: { posicaoNoLote: 'asc' },
    });
  }

  async atualizar(id: string, versao: number, dados: Prisma.EquipamentoUpdateManyMutationInput): Promise<void> {
    const { count } = await this.db.equipamento.updateMany({
      where: { id, versao },
      data: { ...dados, versao: { increment: 1 } },
    });
    if (count === 0) {
      const existe = await this.db.equipamento.count({ where: { id } });
      throw existe ? conflitoDeVersao('Equipamento', id) : new ErroNaoEncontrado('Equipamento', id);
    }
  }

  async remover(id: string): Promise<void> {
    await this.db.equipamento.delete({ where: { id } });
  }

  contarPorStatus(filtro: Prisma.EquipamentoWhereInput = {}) {
    return this.db.equipamento.groupBy({
      by: ['statusRastreamento'],
      where: filtro,
      _count: { _all: true },
      _sum: { pesoQuilogramas: true },
    });
  }
}
