import type { Db } from '../database.js';
import type { ChaveApi, EscopoChave, Parceiro, PlanoAcesso, Prisma } from '../generated/prisma/client.js';
import { ErroNaoEncontrado, conflitoDeVersao } from '../domain/erros.js';

export type ChaveComParceiro = ChaveApi & { parceiro: Parceiro };

/** Parceiros externos e suas chaves de API. */
export class ParceiroRepository {
  constructor(private readonly db: Db) {}

  criar(dados: { nome: string; organizacaoId: string; plano: PlanoAcesso }): Promise<Parceiro> {
    return this.db.parceiro.create({ data: dados });
  }

  async buscarOuFalhar(id: string): Promise<Parceiro> {
    const parceiro = await this.db.parceiro.findUnique({ where: { id } });
    if (!parceiro) throw new ErroNaoEncontrado('Parceiro', id);
    return parceiro;
  }

  listar() {
    return this.db.parceiro.findMany({
      include: { organizacao: { select: { codigo: true, razaoSocial: true } }, _count: { select: { chaves: true } } },
      orderBy: { nome: 'asc' },
    });
  }

  async atualizar(id: string, versao: number, dados: Prisma.ParceiroUpdateManyMutationInput): Promise<void> {
    const { count } = await this.db.parceiro.updateMany({
      where: { id, versao },
      data: { ...dados, versao: { increment: 1 } },
    });
    if (count === 0) {
      const existe = await this.db.parceiro.count({ where: { id } });
      throw existe ? conflitoDeVersao('Parceiro', id) : new ErroNaoEncontrado('Parceiro', id);
    }
  }

  // --------------------------------------------------------------- chaves

  criarChave(dados: {
    parceiroId: string;
    prefixo: string;
    hashSegredo: string;
    escopos: EscopoChave[];
    descricao: string | null;
    expiraEm: Date | null;
  }): Promise<ChaveApi> {
    return this.db.chaveApi.create({ data: dados });
  }

  buscarChavePorPrefixo(prefixo: string): Promise<ChaveComParceiro | null> {
    return this.db.chaveApi.findUnique({ where: { prefixo }, include: { parceiro: true } });
  }

  async buscarChaveOuFalhar(id: string): Promise<ChaveApi> {
    const chave = await this.db.chaveApi.findUnique({ where: { id } });
    if (!chave) throw new ErroNaoEncontrado('Chave de API', id);
    return chave;
  }

  listarChaves(parceiroId: string): Promise<ChaveApi[]> {
    return this.db.chaveApi.findMany({ where: { parceiroId }, orderBy: { criadaEm: 'desc' } });
  }

  async revogarChave(id: string): Promise<void> {
    await this.db.chaveApi.update({ where: { id }, data: { revogadaEm: new Date() } });
  }

  async registrarUso(id: string, quando: Date): Promise<void> {
    await this.db.chaveApi.update({ where: { id }, data: { ultimoUso: quando } });
  }
}
