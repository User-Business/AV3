import type { Db } from '../database.js';
import type { Contrato, Organizacao, Prisma } from '../generated/prisma/client.js';
import { ErroNaoEncontrado, conflitoDeVersao } from '../domain/erros.js';

export type OrganizacaoComContrato = Organizacao & { contrato: Contrato | null };

export class OrganizacaoRepository {
  constructor(private readonly db: Db) {}

  criar(dados: Prisma.OrganizacaoCreateInput): Promise<OrganizacaoComContrato> {
    return this.db.organizacao.create({ data: dados, include: { contrato: true } });
  }

  buscarPorId(id: string): Promise<OrganizacaoComContrato | null> {
    return this.db.organizacao.findUnique({ where: { id }, include: { contrato: true } });
  }

  buscarPorCodigo(codigo: string): Promise<OrganizacaoComContrato | null> {
    return this.db.organizacao.findUnique({ where: { codigo }, include: { contrato: true } });
  }

  buscarPorCnpj(cnpj: string): Promise<Organizacao | null> {
    return this.db.organizacao.findUnique({ where: { cnpj } });
  }

  listar(filtro: { ativo?: boolean }): Promise<OrganizacaoComContrato[]> {
    return this.db.organizacao.findMany({
      where: filtro.ativo === undefined ? {} : { ativo: filtro.ativo },
      include: { contrato: true },
      orderBy: { razaoSocial: 'asc' },
    });
  }

  contarLotesEmAberto(organizacaoId: string): Promise<number> {
    return this.db.lote.count({ where: { organizacaoId, statusProcessamento: { not: 'FINALIZADO' } } });
  }

  /**
   * Atualização com concorrência otimista: o UPDATE só afeta a linha se a
   * versão no banco ainda for a que o cliente leu. Zero linhas afetadas =
   * alguém alterou antes (409) ou o registro não existe (404).
   */
  async atualizar(id: string, versao: number, dados: Prisma.OrganizacaoUpdateManyMutationInput): Promise<void> {
    const { count } = await this.db.organizacao.updateMany({
      where: { id, versao },
      data: { ...dados, versao: { increment: 1 } },
    });
    if (count === 0) {
      const existe = await this.db.organizacao.count({ where: { id } });
      throw existe ? conflitoDeVersao('Organização', id) : new ErroNaoEncontrado('Organização', id);
    }
  }
}
