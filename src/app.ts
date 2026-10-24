import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Configuracao } from './config.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { pluginAutenticacao } from './http/plugins/autenticacao.js';
import { pluginTratamentoErros } from './http/plugins/tratamento-erros.js';
import { registrarRotas } from './http/rotas.js';
import { SErro } from './http/schemas.js';
import { UnidadeDeTrabalho } from './repositories/index.js';
import { AutenticacaoService } from './services/autenticacao.service.js';
import { EquipamentoService } from './services/equipamento.service.js';
import { LoteService } from './services/lote.service.js';
import { OrganizacaoService } from './services/organizacao.service.js';
import { RelatorioService } from './services/relatorio.service.js';

export interface Servicos {
  autenticacao: AutenticacaoService;
  organizacao: OrganizacaoService;
  lote: LoteService;
  equipamento: EquipamentoService;
  relatorio: RelatorioService;
}

/** Composição manual (injeção de dependência sem container): fácil de ler e de testar. */
export function criarServicos(prisma: PrismaClient): Servicos {
  const uow = new UnidadeDeTrabalho(prisma);
  return {
    autenticacao: new AutenticacaoService(uow),
    organizacao: new OrganizacaoService(uow),
    lote: new LoteService(uow),
    equipamento: new EquipamentoService(uow),
    relatorio: new RelatorioService(uow),
  };
}

export async function construirApp(opcoes: {
  config: Configuracao;
  prisma: PrismaClient;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const { config, prisma } = opcoes;

  const app = Fastify({
    logger: opcoes.logger === false ? false : { level: config.nivelLog },
    // Novas requisições recebem 503 enquanto o servidor encerra (graceful shutdown)
    return503OnClosing: true,
    ajv: { customOptions: { removeAdditional: true, coerceTypes: 'array', useDefaults: true } },
  });

  const servicos = criarServicos(prisma);

  await app.register(pluginTratamentoErros);
  await app.register(cors, { origin: config.corsOrigens, credentials: false });

  app.addSchema(SErro);
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'greencode API',
        version: '2.0.0',
        description:
          'API RESTful do greencode (logística reversa de eletrônicos). ' +
          'Autentique em POST /api/v1/auth/login e use o token no botão "Authorize".',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(pluginAutenticacao, {
    segredo: config.jwtSecret,
    expiraEm: config.jwtExpiraEm,
    servico: servicos.autenticacao,
  });

  // Liveness/readiness: confirma que o banco responde
  app.get('/health', { schema: { tags: ['Infra'], summary: 'Saúde do serviço' } }, async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', banco: 'ok', horario: new Date().toISOString() };
    } catch {
      return reply.status(503).send({ status: 'degradado', banco: 'indisponivel' });
    }
  });

  await app.register((api) => registrarRotas(api, servicos), { prefix: '/api/v1' });

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}
