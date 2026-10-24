import type { Db } from '../database.js';
import type { Equipamento, Lote, Prisma, StatusLote } from '../generated/prisma/client.js';
import { ErroNaoEncontrado, conflitoDeVersao } from '../domain/erros.js';

export type LoteComEquipamentos = Lote & {
  equipamentos: Equipamento[];
  organizacao: { codigo: string; razaoSocial: string };
};

const INCLUIR_DETALHES = {
  equipamentos: { orderBy: { posicaoNoLote: 'asc' } },
  organizacao: { select: { codigo: true, razaoSocial: true } },
} as const satisfies Prisma.LoteInclude;

export class LoteRepository {
  constructor(private readonly db: Db) {}

  criar(dados: Prisma.LoteUncheckedCreateInput): Promise<Lote> {
    return this.db.lote.create({ data: dados });
  }

  buscarPorId(id: string): Promise<LoteComEquipamentos | null> {
    return this.db.lote.findUnique({ where: { id }, include: INCLUIR_DETALHES });
  }

  async buscarOuFalhar(id: string): Promise<LoteComEquipamentos> {
    const lote = await this.buscarPorId(id);
    if (!lote) throw new ErroNaoEncontrado('Lote', id);
    return lote;
  }

  existeNotaFiscal(organizacaoId: string, notaFiscal: string): Promise<number> {
    return this.db.lote.count({ where: { organizacaoId, notaFiscal } });
  }

  /** Seleção de campos: a listagem não carrega os equipamentos, só a contagem. */
  listarPorPeriodo(filtro: { inicio: Date; fim: Date; status?: StatusLote; organizacaoId?: string }) {
    return this.db.lote.findMany({
      where: {
        dataEntrada: { gte: filtro.inicio, lte: filtro.fim },
        ...(filtro.status ? { statusProcessamento: filtro.status } : {}),
        ...(filtro.organizacaoId ? { organizacaoId: filtro.organizacaoId } : {}),
      },
      include: {
        organizacao: { select: { codigo: true, razaoSocial: true } },
        _count: { select: { equipamentos: true } },
      },
      orderBy: { dataEntrada: 'desc' },
    });
  }

  async proximaPosicao(loteId: string): Promise<number> {
    const { _max } = await this.db.equipamento.aggregate({ where: { loteId }, _max: { posicaoNoLote: true } });
    return (_max.posicaoNoLote ?? 0) + 1;
  }

  /**
   * Incrementa a versão do lote (com checagem otimista) alterando ou não o
   * status. Também serve de "trava": o UPDATE segura a linha até o fim da
   * transação, serializando inclusões concorrentes de equipamentos.
   */
  async atualizar(id: string, versao: number, dados: Prisma.LoteUpdateManyMutationInput = {}): Promise<void> {
    const { count } = await this.db.lote.updateMany({
      where: { id, versao },
      data: { ...dados, versao: { increment: 1 } },
    });
    if (count === 0) {
      const existe = await this.db.lote.count({ where: { id } });
      throw existe ? conflitoDeVersao('Lote', id) : new ErroNaoEncontrado('Lote', id);
    }
  }
}
