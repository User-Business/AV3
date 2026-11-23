import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ExecucaoCompleta } from '../../repositories/analise.repository.js';
import type { AnaliseService } from '../../services/analise.service.js';
import type { EquipamentoService } from '../../services/equipamento.service.js';
import type { LoteService } from '../../services/lote.service.js';
import { tarefaDTO, type RelatorioAssincronoService } from '../../services/relatorio-assincrono.service.js';
import type { Entrada } from '../schemas.js';
import type { rotasPublicas } from '../schemas-av3.js';
import { enviarArquivo } from './analise.controller.js';

type R = typeof rotasPublicas;
const PREFIXO_PUBLICO = '/api/v1/public';

/**
 * API pública. O parceiro vem do hook de chave de API; os serviços restringem
 * tudo à organização dele. Os schemas de resposta filtram campos internos
 * (versão, nomes de operadores).
 */
export class PublicaController {
  constructor(
    private readonly lotes: LoteService,
    private readonly equipamentos: EquipamentoService,
    private readonly analises: AnaliseService,
    private readonly relatorios: RelatorioAssincronoService,
  ) {}

  rastreabilidade = async (req: FastifyRequest<Entrada<R['rastreabilidade']>>) =>
    this.equipamentos.rastrearParaParceiro(req.parceiro!, req.params.codigo);

  listarLotes = async (req: FastifyRequest<Entrada<R['listarLotes']>>) => this.lotes.listarParaParceiro(req.parceiro!, req.query);

  buscarLote = async (req: FastifyRequest<Entrada<R['buscarLote']>>) => this.lotes.buscarParaParceiro(req.parceiro!, req.params.id);

  criarLote = async (req: FastifyRequest<Entrada<R['criarLote']>>, reply: FastifyReply) =>
    reply.status(201).send(await this.lotes.criarPorParceiro(req.parceiro!, req.body));

  eficiencia = async (req: FastifyRequest) => {
    const execucao = await this.analises.eficienciaParaParceiro(req.parceiro!);
    let operador = 0;
    return {
      ...cabecalho(execucao),
      lotesAnalisados: execucao.amostras,
      grupos: execucao.metricasEficiencia.map((m) => ({
        ...m,
        // Nomes dos operadores internos não são expostos a parceiros
        rotulo: m.dimensao === 'OPERADOR' ? `Operador ${++operador}` : m.rotulo,
      })),
    };
  };

  rentabilidade = async (req: FastifyRequest<Entrada<R['rentabilidade']>>) => {
    const execucao = await this.analises.referenciaParaParceiro(req.parceiro!, 'RENTABILIDADE');
    const tipo = req.query.tipo;
    return {
      ...cabecalho(execucao),
      equipamentosAnalisados: execucao.amostras,
      grupos: execucao.metricasRentabilidade.filter((g) => !tipo || g.tipo === tipo),
    };
  };

  vidaUtil = async (req: FastifyRequest) => {
    const execucao = await this.analises.referenciaParaParceiro(req.parceiro!, 'VIDA_UTIL');
    return { ...cabecalho(execucao), observacoes: execucao.amostras, modelos: execucao.previsoesVidaUtil };
  };

  solicitarRelatorio = async (req: FastifyRequest<Entrada<R['solicitarRelatorio']>>, reply: FastifyReply) => {
    const tarefa = await this.relatorios.solicitarPorParceiro(req.parceiro!, {
      tipo: req.body.tipo,
      formato: req.body.formato ?? 'JSON',
      ...(req.body.webhookUrl ? { webhookUrl: req.body.webhookUrl } : {}),
    });
    const dto = tarefaDTO(tarefa, PREFIXO_PUBLICO);
    return reply.status(202).header('location', dto.links.status).send(dto);
  };

  consultarRelatorio = async (req: FastifyRequest<Entrada<R['consultarRelatorio']>>) =>
    tarefaDTO(await this.relatorios.consultarPorParceiro(req.parceiro!, req.params.id), PREFIXO_PUBLICO);

  baixarRelatorio = async (req: FastifyRequest<Entrada<R['baixarRelatorio']>>, reply: FastifyReply) => {
    const tarefa = await this.relatorios.consultarPorParceiro(req.parceiro!, req.params.id);
    return enviarArquivo(reply, tarefa, await this.relatorios.abrirDownload(tarefa));
  };
}

function cabecalho(e: ExecucaoCompleta) {
  return { execucaoId: e.id, geradaEm: e.geradaEm.toISOString() };
}
