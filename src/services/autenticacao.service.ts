import type { PapelUsuario } from '../generated/prisma/client.js';
import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import { ErroConflito, ErroNaoAutenticado, ErroValidacao } from '../domain/erros.js';
import {
  HASH_FICTICIO,
  gerarHashSenha,
  validarForcaSenha,
  verificarSenha,
} from '../domain/senha.js';
import type { UnidadeDeTrabalho } from '../repositories/index.js';
import { usuarioDTO } from './dto.js';

/** Conteúdo do JWT. `tv` = versão do token (revogação em logout/troca de senha). */
export interface ClaimsToken {
  sub: string;
  usuario: string;
  papel: PapelUsuario;
  tv: number;
}

export class AutenticacaoService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  /**
   * Verifica as credenciais e devolve as claims a serem assinadas no JWT. A
   * assinatura em si fica na camada HTTP (@fastify/jwt); o serviço não
   * depende do framework.
   */
  async login(usuario: string, senha: string): Promise<ClaimsToken> {
    const registro = await this.uow.leitura.usuarios.buscarPorUsuario(usuario.trim().toLowerCase());

    // Compara mesmo quando o usuário não existe: tempo de resposta constante
    const { valida, precisaRehash } = await verificarSenha(senha, registro?.hashSenha ?? HASH_FICTICIO);

    if (!registro || !valida || !registro.ativo) {
      // Mensagem genérica de propósito: não revela se o usuário existe
      throw new ErroNaoAutenticado('Usuário ou senha inválidos');
    }

    await this.uow.emTransacao(async (repos) => {
      // Migração transparente do hash SHA-256 legado do CLI para bcrypt
      await repos.usuarios.registrarAcesso(registro.id, precisaRehash ? await gerarHashSenha(senha) : undefined);
      await repos.historico.registrarJournal({
        operacao: precisaRehash ? 'LOGIN_REHASH' : 'LOGIN',
        entidade: 'Usuario',
        entidadeId: registro.id,
        usuarioResponsavel: registro.usuario,
      });
    });

    return { sub: registro.id, usuario: registro.usuario, papel: registro.papel, tv: registro.versaoToken };
  }

  /**
   * Chamado a cada requisição autenticada. Além da assinatura/expiração (já
   * verificadas pelo @fastify/jwt), confere se o usuário continua ativo e se o
   * token não foi revogado. Custo: uma busca por chave primária.
   */
  async validarSessao(claims: ClaimsToken): Promise<Ator> {
    const usuario = await this.uow.leitura.usuarios.buscarPorId(claims.sub);
    if (!usuario || !usuario.ativo || usuario.versaoToken !== claims.tv) {
      throw new ErroNaoAutenticado('Sessão inválida ou revogada. Faça login novamente.');
    }
    return { id: usuario.id, usuario: usuario.usuario, papel: usuario.papel };
  }

  /** Renovação (equivalente ao Sessao.renovar() do CLI): novas claims, mesmo tv. */
  async renovar(ator: Ator): Promise<ClaimsToken> {
    const usuario = await this.uow.leitura.usuarios.buscarPorId(ator.id);
    if (!usuario || !usuario.ativo) throw new ErroNaoAutenticado('Sessão inválida');
    return { sub: usuario.id, usuario: usuario.usuario, papel: usuario.papel, tv: usuario.versaoToken };
  }

  /** JWT é stateless; o logout revoga todos os tokens do usuário via versaoToken. */
  async logout(ator: Ator): Promise<void> {
    await this.uow.emTransacao(async (repos) => {
      await repos.usuarios.revogarTokens(ator.id);
      await repos.historico.registrarJournal({
        operacao: 'LOGOUT',
        entidade: 'Usuario',
        entidadeId: ator.id,
        usuarioResponsavel: ator.usuario,
      });
    });
  }

  async alterarSenha(ator: Ator, senhaAtual: string, senhaNova: string): Promise<void> {
    const usuario = await this.uow.leitura.usuarios.buscarPorId(ator.id);
    if (!usuario) throw new ErroNaoAutenticado('Sessão inválida');

    const { valida } = await verificarSenha(senhaAtual, usuario.hashSenha);
    if (!valida) throw new ErroNaoAutenticado('Senha atual incorreta');
    if (senhaAtual === senhaNova) throw new ErroValidacao('A nova senha deve ser diferente da atual');
    validarForcaSenha(senhaNova);

    const novoHash = await gerarHashSenha(senhaNova);
    await this.uow.emTransacao(async (repos) => {
      await repos.usuarios.trocarSenha(ator.id, novoHash);
      await repos.historico.registrarJournal({
        operacao: 'ALTERAR_SENHA',
        entidade: 'Usuario',
        entidadeId: ator.id,
        usuarioResponsavel: ator.usuario,
      });
    });
  }

  async criarUsuario(ator: Ator, dados: { usuario: string; senha: string; papel: PapelUsuario }) {
    exigirPermissao(ator, 'usuario:gerenciar');
    const nome = dados.usuario.trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,60}$/.test(nome)) {
      throw new ErroValidacao('usuario deve ter de 3 a 60 caracteres: letras minúsculas, números, ".", "_" ou "-"');
    }
    validarForcaSenha(dados.senha);
    if (await this.uow.leitura.usuarios.buscarPorUsuario(nome)) {
      throw new ErroConflito(`Usuário '${nome}' já existe`);
    }

    const hashSenha = await gerarHashSenha(dados.senha);
    return this.uow.emTransacao(async (repos) => {
      const criado = await repos.usuarios.criar({ usuario: nome, hashSenha, papel: dados.papel });
      await repos.historico.registrarJournal({
        operacao: 'CRIAR',
        entidade: 'Usuario',
        entidadeId: criado.id,
        dadosDepois: { usuario: criado.usuario, papel: criado.papel },
        usuarioResponsavel: ator.usuario,
      });
      return usuarioDTO(criado);
    });
  }

  async listarUsuarios(ator: Ator) {
    exigirPermissao(ator, 'usuario:gerenciar');
    return (await this.uow.leitura.usuarios.listar()).map(usuarioDTO);
  }
}
