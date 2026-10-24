import type { Db } from '../database.js';
import type { Contrato, Prisma } from '../generated/prisma/client.js';
import { ErroNaoEncontrado, conflitoDeVersao } from '../domain/erros.js';

export class ContratoRepository {
  constructor(private readonly db: Db) {}

  criar(dados: Prisma.ContratoUncheckedCreateInput): Promise<Contrato> {
    return this.db.contrato.create({ data: dados });
  }

  buscarPorOrganizacao(organizacaoId: string): Promise<Contrato | null> {
    return this.db.contrato.findUnique({ where: { organizacaoId } });
  }

  /** Contratos cujo período intersecta [inicio, fim] (datas sem hora). */
  listarAtivosNoPeriodo(inicio: Date, fim: Date) {
    return this.db.contrato.findMany({
      where: { dataAssinatura: { lte: fim }, dataVencimento: { gte: inicio } },
      include: { organizacao: { select: { codigo: true, razaoSocial: true } } },
      orderBy: { dataAssinatura: 'asc' },
    });
  }

  async atualizar(id: string, versao: number, dados: Prisma.ContratoUpdateManyMutationInput): Promise<void> {
    const { count } = await this.db.contrato.updateMany({
      where: { id, versao },
      data: { ...dados, versao: { increment: 1 } },
    });
    if (count === 0) {
      const existe = await this.db.contrato.count({ where: { id } });
      throw existe ? conflitoDeVersao('Contrato', id) : new ErroNaoEncontrado('Contrato', id);
    }
  }
}
