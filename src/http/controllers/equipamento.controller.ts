import type { FastifyRequest } from 'fastify';
import type { EquipamentoService } from '../../services/equipamento.service.js';
import type { Entrada, rotasEquipamento } from '../schemas.js';

type R = typeof rotasEquipamento;

export class EquipamentoController {
  constructor(private readonly servico: EquipamentoService) {}

  listar = async (req: FastifyRequest<Entrada<R['listar']>>) => this.servico.listar(req.ator!, req.query);

  rastrear = async (req: FastifyRequest<Entrada<R['rastrear']>>) => this.servico.rastrear(req.ator!, req.params.id);

  alterarStatus = async (req: FastifyRequest<Entrada<R['alterarStatus']>>) =>
    this.servico.atualizarStatus(req.ator!, req.params.id, req.body.versao, req.body.status, req.body.justificativa);

  alterarEstadoFisico = async (req: FastifyRequest<Entrada<R['alterarEstadoFisico']>>) =>
    this.servico.atualizarEstadoFisico(
      req.ator!,
      req.params.id,
      req.body.versao,
      req.body.estadoFisico,
      req.body.justificativa,
    );
}
