import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import type { Servicos } from '../app.js';
import { AutenticacaoController } from './controllers/autenticacao.controller.js';
import { EquipamentoController } from './controllers/equipamento.controller.js';
import { LoteController } from './controllers/lote.controller.js';
import { OrganizacaoController } from './controllers/organizacao.controller.js';
import { RelatorioController } from './controllers/relatorio.controller.js';
import { rotasAuth, rotasEquipamento, rotasLote, rotasOrganizacao, rotasRelatorio } from './schemas.js';

// Os controllers tipam o request a partir do próprio schema da rota; aqui só
// precisamos entregá-los ao Fastify.
const h = (handler: unknown) => handler as RouteHandlerMethod;

/** Todas as rotas da API v1. Cada rota: schema (validação + docs) -> preHandler -> controller. */
export async function registrarRotas(app: FastifyInstance, servicos: Servicos): Promise<void> {
  const auth = new AutenticacaoController(servicos.autenticacao, app);
  const org = new OrganizacaoController(servicos.organizacao);
  const lote = new LoteController(servicos.lote);
  const equip = new EquipamentoController(servicos.equipamento);
  const rel = new RelatorioController(servicos.relatorio);

  // Rota pública
  app.post('/auth/login', { schema: rotasAuth.login }, h(auth.login));

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
  });
}
