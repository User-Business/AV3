import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Configuracao } from './config.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { Armazenamento } from './infra/armazenamento.js';
import { FilaMemoria, type FilaTarefas } from './infra/fila.js';
import { pluginAutenticacao } from './http/plugins/autenticacao.js';
import { pluginChaveApi } from './http/plugins/chave-api.js';
import { pluginTratamentoErros } from './http/plugins/tratamento-erros.js';
import { VERSAO_API_PUBLICA, registrarRotas } from './http/rotas.js';
import { SErro } from './http/schemas.js';
import { UnidadeDeTrabalho } from './repositories/index.js';
import { AnaliseService } from './services/analise.service.js';
import { AutenticacaoService } from './services/autenticacao.service.js';
import { ChaveApiService } from './services/chave-api.service.js';
import { EquipamentoService } from './services/equipamento.service.js';
import { LoteService } from './services/lote.service.js';
import { OrganizacaoService } from './services/organizacao.service.js';
import { RelatorioAssincronoService, type Registro } from './services/relatorio-assincrono.service.js';
import { RelatorioService } from './services/relatorio.service.js';

export interface Servicos {
  autenticacao: AutenticacaoService;
  organizacao: OrganizacaoService;
  lote: LoteService;
  equipamento: EquipamentoService;
  relatorio: RelatorioService;
  // Atividade 3
  analise: AnaliseService;
  chaveApi: ChaveApiService;
  relatorioAssincrono: RelatorioAssincronoService;
}

const REGISTRO_SILENCIOSO: Registro = { info: () => undefined, warn: () => undefined };

/** Composição manual (injeção de dependência sem container): fácil de ler e de testar. */
export function criarServicos(
  prisma: PrismaClient,
  extras: { config?: Configuracao; fila?: FilaTarefas; log?: Registro } = {},
): Servicos {
  const uow = new UnidadeDeTrabalho(prisma);
  const analise = new AnaliseService(uow);
  const { config } = extras;
  return {
    autenticacao: new AutenticacaoService(uow),
    organizacao: new OrganizacaoService(uow),
    lote: new LoteService(uow),
    equipamento: new EquipamentoService(uow),
    relatorio: new RelatorioService(uow),
    analise,
    chaveApi: new ChaveApiService(uow),
    relatorioAssincrono: new RelatorioAssincronoService(
      uow,
      analise,
      extras.fila ?? new FilaMemoria(config?.filaConcorrencia ?? 1),
      new Armazenamento(config?.diretorioRelatorios ?? './armazenamento/relatorios'),
      {
        validadeHoras: config?.relatorioValidadeHoras ?? 72,
        webhookSecret: config?.webhookSecret ?? 'greencode',
        exigirHttps: config?.producao ?? false,
      },
      extras.log ?? REGISTRO_SILENCIOSO,
    ),
  };
}

export async function construirApp(opcoes: {
  config: Configuracao;
  prisma: PrismaClient;
  fila?: FilaTarefas;
  logger?: boolean;
}): Promise<{ app: FastifyInstance; servicos: Servicos }> {
  const { config, prisma } = opcoes;

  const app = Fastify({
    logger: opcoes.logger === false ? false : { level: config.nivelLog },
    // Novas requisições recebem 503 enquanto o servidor encerra (graceful shutdown)
    return503OnClosing: true,
    ajv: { customOptions: { removeAdditional: true, coerceTypes: 'array', useDefaults: true } },
  });

  const servicos = criarServicos(prisma, { config, ...(opcoes.fila ? { fila: opcoes.fila } : {}), log: app.log });

  await app.register(pluginTratamentoErros);
  await app.register(cors, { origin: config.corsOrigens, credentials: false });

  app.addSchema(SErro);
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'greencode API',
        version: VERSAO_API_PUBLICA,
        description: [
          'API do greencode (logística reversa de eletrônicos), organizada em três prefixos:',
          '',
          '- **`/api/v1/public`**: parceiros externos. Autenticação por chave de API no cabeçalho `X-API-Key` (botão "Authorize" → `chaveApi`), escopos por chave e limite de requisições por plano (BASICO 60/min, PROFISSIONAL 300/min, CORPORATIVO 1200/min).',
          '- **`/api/v1/internal`**: front-end e operação. Autentique em `POST /api/v1/internal/auth/login` e use o token em `bearerAuth`.',
          '- **`/api/v1/admin`**: parceiros e chaves de API (papel ADMINISTRADOR).',
          '',
          'Erros sempre no formato `{ "erro": { "codigo", "mensagem", "detalhes" } }`.',
          'Relatórios extensos são assíncronos: `POST` devolve `202` com o id da tarefa, acompanhado por polling ou webhook.',
        ].join('\n'),
      },
      tags: [
        { name: 'Pública - Rastreabilidade' },
        { name: 'Pública - Lotes' },
        { name: 'Pública - Análises' },
        { name: 'Pública - Relatórios' },
        { name: 'Admin - Parceiros' },
        { name: 'Análises', description: 'Camada analítica (uso interno)' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          chaveApi: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(pluginAutenticacao, {
    segredo: config.jwtSecret,
    expiraEm: config.jwtExpiraEm,
    servico: servicos.autenticacao,
  });
  await app.register(pluginChaveApi, { servico: servicos.chaveApi });

  // Liveness/readiness: confirma que o banco responde
  app.get('/health', { schema: { tags: ['Infra'], summary: 'Saúde do serviço' } }, async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', banco: 'ok', horario: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'degradado', banco: 'indisponivel' });
    }
  });

  await app.register((api) => registrarRotas(api, servicos, config), { prefix: '/api/v1' });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return { app, servicos };
}
