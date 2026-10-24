import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrganizacaoService } from '../../services/organizacao.service.js';
import type { Entrada, rotasOrganizacao } from '../schemas.js';

type R = typeof rotasOrganizacao;

export class OrganizacaoController {
  constructor(private readonly servico: OrganizacaoService) {}

  cadastrar = async (req: FastifyRequest<Entrada<R['cadastrar']>>, reply: FastifyReply) =>
    reply.status(201).send(await this.servico.cadastrar(req.ator!, req.body));

  listar = async (req: FastifyRequest<Entrada<R['listar']>>) =>
    this.servico.listar(req.ator!, req.query.ativo === undefined ? {} : { ativo: req.query.ativo });

  buscar = async (req: FastifyRequest<Entrada<R['buscar']>>) => this.servico.buscar(req.ator!, req.params.id);

  alterarEndereco = async (req: FastifyRequest<Entrada<R['alterarEndereco']>>) =>
    this.servico.alterarEndereco(req.ator!, req.params.id, req.body.versao, req.body.enderecoCompleto);

  desativar = async (req: FastifyRequest<Entrada<R['desativar']>>) =>
    this.servico.desativar(req.ator!, req.params.id, req.body.versao);

  definirContrato = async (req: FastifyRequest<Entrada<R['definirContrato']>>, reply: FastifyReply) =>
    reply.status(201).send(await this.servico.definirContrato(req.ator!, req.params.id, req.body));

  renovarContrato = async (req: FastifyRequest<Entrada<R['renovarContrato']>>) =>
    this.servico.renovarContrato(req.ator!, req.params.id, req.body.versao, req.body.novoVencimento);
}
