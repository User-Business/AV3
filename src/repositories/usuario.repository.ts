import type { Db } from '../database.js';
import type { PapelUsuario, Usuario } from '../generated/prisma/client.js';

export class UsuarioRepository {
  constructor(private readonly db: Db) {}

  buscarPorUsuario(usuario: string): Promise<Usuario | null> {
    return this.db.usuario.findUnique({ where: { usuario } });
  }

  buscarPorId(id: string): Promise<Usuario | null> {
    return this.db.usuario.findUnique({ where: { id } });
  }

  listar(): Promise<Usuario[]> {
    return this.db.usuario.findMany({ orderBy: { usuario: 'asc' } });
  }

  criar(dados: { usuario: string; hashSenha: string; papel: PapelUsuario }): Promise<Usuario> {
    return this.db.usuario.create({ data: dados });
  }

  async registrarAcesso(id: string, novoHash?: string): Promise<void> {
    await this.db.usuario.update({
      where: { id },
      data: { ultimoAcesso: new Date(), ...(novoHash ? { hashSenha: novoHash } : {}) },
    });
  }

  /** Troca a senha e invalida todos os tokens emitidos até agora. */
  async trocarSenha(id: string, novoHash: string): Promise<void> {
    await this.db.usuario.update({
      where: { id },
      data: { hashSenha: novoHash, versaoToken: { increment: 1 }, versao: { increment: 1 } },
    });
  }

  async revogarTokens(id: string): Promise<void> {
    await this.db.usuario.update({ where: { id }, data: { versaoToken: { increment: 1 } } });
  }
}
