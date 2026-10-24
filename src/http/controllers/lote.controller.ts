import type { FastifyReply, FastifyRequest } from 'fastify';
import type { LoteService } from '../../services/lote.service.js';
import type { Entrada, rotasLote } from '../schemas.js';

type R = typeof rotasLote;

export class LoteController {
  constructor(private readonly servico: LoteService) {}

  criar = async (req: FastifyRequest<Entrada<R['criar']>>, reply: FastifyReply) =>
    reply.status(201).send(await this.servico.criar(req.ator!, req.body));

  listar = async (req: FastifyRequest<Entrada<R['listar']>>) => this.servico.consultarPorPeriodo(req.ator!, req.query);

  buscar = async (req: FastifyRequest<Entrada<R['buscar']>>) => this.servico.buscar(req.ator!, req.params.id);

  relatorioTriagem = async (req: FastifyRequest<Entrada<R['relatorioTriagem']>>) =>
    this.servico.relatorioTriagem(req.ator!, req.params.id);

  adicionarEquipamento = async (req: FastifyRequest<Entrada<R['adicionarEquipamento']>>, reply: FastifyReply) =>
    reply
      .status(201)
      .send(await this.servico.adicionarEquipamento(req.ator!, req.params.id, req.body.versao, req.body.equipamento));

  removerEquipamento = async (req: FastifyRequest<Entrada<R['removerEquipamento']>>) =>
    this.servico.removerEquipamento(req.ator!, req.params.id, req.params.equipamentoId, req.query.versao);

  alterarStatus = async (req: FastifyRequest<Entrada<R['alterarStatus']>>) =>
    this.servico.alterarStatus(req.ator!, req.params.id, req.body.versao, req.body.status);
}
