import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { Redis } from 'ioredis';
import type { Servicos } from '../app.js';
import type { Configuracao } from '../config.js';
import { LIMITE_POR_PLANO, exigirEscopo } from '../domain/chave-api.js';
import { ErroLimiteExcedido } from '../domain/erros.js';
import type { EscopoChave } from '../generated/prisma/enums.js';
import { AnaliseController } from './controllers/analise.controller.js';
import { AutenticacaoController } from './controllers/autenticacao.controller.js';
import { EquipamentoController } from './controllers/equipamento.controller.js';
import { LoteController } from './controllers/lote.controller.js';
import { OrganizacaoController } from './controllers/organizacao.controller.js';
import { ParceiroController } from './controllers/parceiro.controller.js';
import { PublicaController } from './controllers/publica.controller.js';
import { RelatorioController } from './controllers/relatorio.controller.js';
import { rotasAuth, rotasEquipamento, rotasLote, rotasOrganizacao, rotasRelatorio } from './schemas.js';
import { rotasAnalise, rotasParceiro, rotasPublicas } from './schemas-av3.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Escopo de chave de API exigido pela rota pública. */
    escopo?: EscopoChave;
  }
}

/** Versão semântica do contrato público; quebra de contrato gera /api/v2. */
export const VERSAO_API_PUBLICA = '1.0.0';

// Os controllers tipam o request a partir do próprio schema da rota; aqui só
// precisamos entregá-los ao Fastify.
const h = (handler: unknown) => handler as RouteHandlerMethod;

/**
 * API v1 em três prefixos, com políticas de segurança distintas:
 *  - /internal: front-end e operação (JWT + papéis), rotas da Atividade 2;
 *  - /admin: gestão de parceiros e chaves (JWT, ADMINISTRADOR);
 *  - /public: parceiros externos (chave de API + escopos + limite por plano).
 */
export async function registrarRotas(app: FastifyInstance, servicos: Servicos, config: Configuracao): Promise<void> {
  await app.register((interna) => registrarRotasInternas(interna, servicos), { prefix: '/internal' });
  await app.register((admin) => registrarRotasAdmin(admin, servicos), { prefix: '/admin' });
  await app.register((publica) => registrarRotasPublicas(publica, servicos, config), { prefix: '/public' });
}

async function registrarRotasInternas(app: FastifyInstance, servicos: Servicos): Promise<void> {
  const auth = new AutenticacaoController(servicos.autenticacao, app);
  const org = new OrganizacaoController(servicos.organizacao);
  const lote = new LoteController(servicos.lote);
  const equip = new EquipamentoController(servicos.equipamento);
  const rel = new RelatorioController(servicos.relatorio);
  const analise = new AnaliseController(servicos.analise, servicos.relatorioAssincrono);

  // Sem limite global na API interna; só rotas com config.rateLimit (login)
  await app.register(rateLimit, { global: false });

  // Rota sem JWT; limite por IP contra força bruta de senhas
  app.post('/auth/login', { schema: rotasAuth.login, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, h(auth.login));

  // Daqui para baixo, tudo exige JWT válido
  await app.register(async (privado) => {
    privado.addHook('preHandler', privado.autenticar);

    privado.post('/auth/renovar', { schema: rotasAuth.renovar }, h(auth.renovar));
    privado.post('/auth/logout', { schema: rotasAuth.logout }, h(auth.logout));
    privado.get('/auth/eu', { schema: rotasAuth.eu }, h(auth.eu));
    privado.put('/auth/senha', { schema: rotasAuth.alterarSenha }, h(auth.alterarSenha));
    privado.get('/usuarios', { schema: rotasAuth.listarUsuarios }, h(auth.listarUsuarios));
    privado.post('/usuarios', { schema: rotasAuth.criarUsuario }, h(auth.criarUsuario));

    privado.get('/organizacoes', { schema: rotasOrganizacao.listar }, h(org.listar));
    privado.post('/organizacoes', { schema: rotasOrganizacao.cadastrar }, h(org.cadastrar));
    privado.get('/organizacoes/:id', { schema: rotasOrganizacao.buscar }, h(org.buscar));
    privado.patch('/organizacoes/:id/endereco', { schema: rotasOrganizacao.alterarEndereco }, h(org.alterarEndereco));
    privado.post('/organizacoes/:id/desativar', { schema: rotasOrganizacao.desativar }, h(org.desativar));
    privado.post('/organizacoes/:id/contrato', { schema: rotasOrganizacao.definirContrato }, h(org.definirContrato));
    privado.post('/organizacoes/:id/contrato/renovar', { schema: rotasOrganizacao.renovarContrato }, h(org.renovarContrato));

    privado.get('/lotes', { schema: rotasLote.listar }, h(lote.listar));
    privado.post('/lotes', { schema: rotasLote.criar }, h(lote.criar));
    privado.get('/lotes/:id', { schema: rotasLote.buscar }, h(lote.buscar));
    privado.get('/lotes/:id/relatorio-triagem', { schema: rotasLote.relatorioTriagem }, h(lote.relatorioTriagem));
    privado.patch('/lotes/:id/status', { schema: rotasLote.alterarStatus }, h(lote.alterarStatus));
    privado.post('/lotes/:id/equipamentos', { schema: rotasLote.adicionarEquipamento }, h(lote.adicionarEquipamento));
    privado.delete('/lotes/:id/equipamentos/:equipamentoId', { schema: rotasLote.removerEquipamento }, h(lote.removerEquipamento));

    privado.get('/equipamentos', { schema: rotasEquipamento.listar }, h(equip.listar));
    privado.get('/equipamentos/:id/rastreio', { schema: rotasEquipamento.rastrear }, h(equip.rastrear));
    privado.patch('/equipamentos/:id/status', { schema: rotasEquipamento.alterarStatus }, h(equip.alterarStatus));
    privado.patch('/equipamentos/:id/estado-fisico', { schema: rotasEquipamento.alterarEstadoFisico }, h(equip.alterarEstadoFisico));

    privado.get('/relatorios/status', { schema: rotasRelatorio.porStatus }, h(rel.porStatus));
    privado.get('/relatorios/organizacoes/:id', { schema: rotasRelatorio.porOrganizacao }, h(rel.porOrganizacao));
    privado.get('/relatorios/financeiro', { schema: rotasRelatorio.financeiro }, h(rel.financeiro));
    privado.get('/auditoria/journal', { schema: rotasRelatorio.journal }, h(rel.journal));

    // Atividade 3: camada analítica e relatórios assíncronos
    privado.post('/analises/execucoes', { schema: rotasAnalise.executar }, h(analise.executar));
    privado.get('/analises/execucoes', { schema: rotasAnalise.listar }, h(analise.listar));
    privado.get('/analises/execucoes/:id', { schema: rotasAnalise.buscar }, h(analise.buscar));
    privado.get('/analises/vida-util/acuracia', { schema: rotasAnalise.acuracia }, h(analise.acuracia));
    privado.post('/relatorios/assincronos', { schema: rotasAnalise.solicitarRelatorio }, h(analise.solicitarRelatorio));
    privado.get('/relatorios/:id', { schema: rotasAnalise.consultarRelatorio }, h(analise.consultarRelatorio));
    privado.get('/relatorios/:id/download', { schema: rotasAnalise.baixarRelatorio }, h(analise.baixarRelatorio));
  });
}

async function registrarRotasAdmin(app: FastifyInstance, servicos: Servicos): Promise<void> {
  const parceiro = new ParceiroController(servicos.chaveApi);
  app.addHook('preHandler', app.autenticar);

  app.get('/parceiros', { schema: rotasParceiro.listar }, h(parceiro.listar));
  app.post('/parceiros', { schema: rotasParceiro.criar }, h(parceiro.criar));
  app.patch('/parceiros/:id', { schema: rotasParceiro.atualizar }, h(parceiro.atualizar));
  app.get('/parceiros/:id/chaves', { schema: rotasParceiro.listarChaves }, h(parceiro.listarChaves));
  app.post('/parceiros/:id/chaves', { schema: rotasParceiro.emitirChave }, h(parceiro.emitirChave));
  app.delete('/chaves/:id', { schema: rotasParceiro.revogarChave }, h(parceiro.revogarChave));
}

async function registrarRotasPublicas(app: FastifyInstance, servicos: Servicos, config: Configuracao): Promise<void> {
  const pub = new PublicaController(servicos.lote, servicos.equipamento, servicos.analise, servicos.relatorioAssincrono);

  // 1) Chave de API em todas as rotas deste escopo
  app.addHook('onRequest', app.autenticarParceiro);
  // 2) Escopo verificado ANTES da validação do corpo: sem permissão = 403,
  //    sem revelar o formato esperado. Os serviços conferem de novo.
  app.addHook('preValidation', async (req) => {
    const escopo = req.routeOptions.config.escopo;
    if (escopo) exigirEscopo(req.parceiro, escopo);
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-api-version', VERSAO_API_PUBLICA);
  });

  // 3) Limite por parceiro (não por IP), conforme o plano. Com Redis o
  //    contador é compartilhado entre instâncias do servidor.
  const redis = config.redisUrl ? new Redis(config.redisUrl, { maxRetriesPerRequest: 1 }) : undefined;
  if (redis) app.addHook('onClose', async () => void (await redis.quit()));
  await app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    nameSpace: 'greencode-rl-',
    ...(redis ? { redis } : {}),
    keyGenerator: (req) => req.parceiro?.parceiroId ?? req.ip,
    max: (req) => (req.parceiro ? LIMITE_POR_PLANO[req.parceiro.plano] : 30),
    errorResponseBuilder: (_req, ctx) =>
      new ErroLimiteExcedido(`Limite de ${ctx.max} requisições por minuto excedido`, { limite: ctx.max, tenteNovamenteEm: ctx.after }),
  });

  const com = (escopo: EscopoChave) => ({ config: { escopo } });

  app.get('/rastreabilidade/:codigo', { schema: rotasPublicas.rastreabilidade, ...com('RASTREABILIDADE_LEITURA') }, h(pub.rastreabilidade));
  app.get('/lotes', { schema: rotasPublicas.listarLotes, ...com('LOTES_LEITURA') }, h(pub.listarLotes));
  app.get('/lotes/:id', { schema: rotasPublicas.buscarLote, ...com('LOTES_LEITURA') }, h(pub.buscarLote));
  app.post('/lotes', { schema: rotasPublicas.criarLote, ...com('LOTES_ESCRITA') }, h(pub.criarLote));
  app.get('/analises/eficiencia', { schema: rotasPublicas.eficiencia, ...com('ANALISES_LEITURA') }, h(pub.eficiencia));
  app.get('/analises/rentabilidade', { schema: rotasPublicas.rentabilidade, ...com('ANALISES_LEITURA') }, h(pub.rentabilidade));
  app.get('/analises/vida-util', { schema: rotasPublicas.vidaUtil, ...com('ANALISES_LEITURA') }, h(pub.vidaUtil));
  app.post('/relatorios', { schema: rotasPublicas.solicitarRelatorio, ...com('RELATORIOS_SOLICITAR') }, h(pub.solicitarRelatorio));
  app.get('/relatorios/:id', { schema: rotasPublicas.consultarRelatorio, ...com('RELATORIOS_SOLICITAR') }, h(pub.consultarRelatorio));
  app.get('/relatorios/:id/download', { schema: rotasPublicas.baixarRelatorio, ...com('RELATORIOS_SOLICITAR') }, h(pub.baixarRelatorio));
}
