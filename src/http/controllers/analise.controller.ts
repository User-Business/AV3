import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AnaliseService } from '../../services/analise.service.js';
import { tarefaDTO, type RelatorioAssincronoService } from '../../services/relatorio-assincrono.service.js';
import type { Entrada } from '../schemas.js';
import type { rotasAnalise } from '../schemas-av3.js';

type R = typeof rotasAnalise;
const PREFIXO_INTERNO = '/api/v1/internal';

/** Camada analítica e relatórios assíncronos para usuários internos (JWT). */
export class AnaliseController {
  constructor(
    private readonly analises: AnaliseService,
    private readonly relatorios: RelatorioAssincronoService,
  ) {}

  executar = async (req: FastifyRequest<Entrada<R['executar']>>, reply: FastifyReply) => {
    const { tipo, ...filtro } = req.body;
    return reply.status(201).send(await this.analises.executar(req.ator!, tipo, filtro));
  };

  listar = async (req: FastifyRequest<Entrada<R['listar']>>) => this.analises.listarExecucoes(req.ator!, req.query);

  buscar = async (req: FastifyRequest<Entrada<R['buscar']>>) => this.analises.buscarExecucao(req.ator!, req.params.id);

  acuracia = async (req: FastifyRequest) => this.analises.acuraciaVidaUtil(req.ator!);

  solicitarRelatorio = async (req: FastifyRequest<Entrada<R['solicitarRelatorio']>>, reply: FastifyReply) => {
    const tarefa = await this.relatorios.solicitarInterno(req.ator!, { ...req.body, formato: req.body.formato ?? 'JSON' });
    const dto = tarefaDTO(tarefa, PREFIXO_INTERNO);
    return reply.status(202).header('location', dto.links.status).send(dto);
  };

  consultarRelatorio = async (req: FastifyRequest<Entrada<R['consultarRelatorio']>>) =>
    tarefaDTO(await this.relatorios.consultarInterno(req.ator!, req.params.id), PREFIXO_INTERNO);

  baixarRelatorio = async (req: FastifyRequest<Entrada<R['baixarRelatorio']>>, reply: FastifyReply) => {
    const tarefa = await this.relatorios.consultarInterno(req.ator!, req.params.id);
    return enviarArquivo(reply, tarefa, await this.relatorios.abrirDownload(tarefa));
  };
}

export function enviarArquivo(
  reply: FastifyReply,
  tarefa: { id: string; tipo: string; formato: 'CSV' | 'JSON' },
  fluxo: NodeJS.ReadableStream,
) {
  const csv = tarefa.formato === 'CSV';
  return reply
    .header('content-type', csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
    .header('content-disposition', `attachment; filename="${tarefa.tipo.toLowerCase()}-${tarefa.id}.${csv ? 'csv' : 'json'}"`)
    .send(fluxo);
}
