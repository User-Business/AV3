import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AutenticacaoService } from '../../services/autenticacao.service.js';
import type { Entrada, rotasAuth } from '../schemas.js';

type R = typeof rotasAuth;

export class AutenticacaoController {
  constructor(
    private readonly servico: AutenticacaoService,
    private readonly app: FastifyInstance,
  ) {}

  login = async (req: FastifyRequest<Entrada<R['login']>>) => {
    const claims = await this.servico.login(req.body.usuario, req.body.senha);
    return this.app.emitirToken(claims);
  };

  renovar = async (req: FastifyRequest) => this.app.emitirToken(await this.servico.renovar(req.ator!));

  logout = async (req: FastifyRequest, reply: FastifyReply) => {
    await this.servico.logout(req.ator!);
    return reply.status(204).send();
  };

  eu = async (req: FastifyRequest) => req.ator!;

  alterarSenha = async (req: FastifyRequest<Entrada<R['alterarSenha']>>, reply: FastifyReply) => {
    await this.servico.alterarSenha(req.ator!, req.body.senhaAtual, req.body.senhaNova);
    return reply.status(204).send();
  };

  criarUsuario = async (req: FastifyRequest<Entrada<R['criarUsuario']>>, reply: FastifyReply) =>
    reply.status(201).send(await this.servico.criarUsuario(req.ator!, req.body));

  listarUsuarios = async (req: FastifyRequest) => this.servico.listarUsuarios(req.ator!);
}
