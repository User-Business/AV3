import type { FastifyRequest } from 'fastify';
import type { RelatorioService } from '../../services/relatorio.service.js';
import type { Entrada, rotasRelatorio } from '../schemas.js';

type R = typeof rotasRelatorio;

export class RelatorioController {
  constructor(private readonly servico: RelatorioService) {}

  porStatus = async (req: FastifyRequest<Entrada<R['porStatus']>>) => this.servico.porStatus(req.ator!, req.query.status);

  porOrganizacao = async (req: FastifyRequest<Entrada<R['porOrganizacao']>>) =>
    this.servico.porOrganizacao(req.ator!, req.params.id, req.query.inicio, req.query.fim);

  financeiro = async (req: FastifyRequest<Entrada<R['financeiro']>>) =>
    this.servico.financeiro(req.ator!, req.query.inicio, req.query.fim);

  journal = async (req: FastifyRequest<Entrada<R['journal']>>) => this.servico.journal(req.ator!, req.query);
}
