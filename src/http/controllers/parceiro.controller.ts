import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ChaveApiService } from '../../services/chave-api.service.js';
import type { Entrada } from '../schemas.js';
import type { rotasParceiro } from '../schemas-av3.js';

type R = typeof rotasParceiro;

/** Administração de parceiros e chaves de API (ADMINISTRADOR). */
export class ParceiroController {
  constructor(private readonly servico: ChaveApiService) {}

  criar = async (req: FastifyRequest<Entrada<R['criar']>>, reply: FastifyReply) =>
    reply.status(201).send(await this.servico.criarParceiro(req.ator!, req.body));

  listar = async (req: FastifyRequest) => this.servico.listarParceiros(req.ator!);

  atualizar = async (req: FastifyRequest<Entrada<R['atualizar']>>) => {
    const { versao, ...dados } = req.body;
    return this.servico.atualizarParceiro(req.ator!, req.params.id, versao, dados);
  };

  emitirChave = async (req: FastifyRequest<Entrada<R['emitirChave']>>, reply: FastifyReply) =>
    reply.status(201).send(await this.servico.emitir(req.ator!, req.params.id, req.body));

  listarChaves = async (req: FastifyRequest<Entrada<R['listarChaves']>>) => this.servico.listarChaves(req.ator!, req.params.id);

  revogarChave = async (req: FastifyRequest<Entrada<R['revogarChave']>>, reply: FastifyReply) => {
    await this.servico.revogar(req.ator!, req.params.id);
    return reply.status(204).send();
  };
}
