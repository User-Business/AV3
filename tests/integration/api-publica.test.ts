/**
 * Atividade 3: API pública, camada analítica e relatórios assíncronos, via
 * HTTP (app.inject) contra um PostgreSQL REAL. Mesmo requisito da jornada da
 * Atividade 2: DATABASE_URL_TEST apontando para um banco descartável.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../src/app.js';
import { carregarConfiguracao } from '../../src/config.js';
import { criarPrismaClient } from '../../src/database.js';
import { calcularDigitosVerificadores } from '../../src/domain/cnpj.js';
import { dataCalendario } from '../../src/domain/contrato.js';
import { gerarHashSenha } from '../../src/domain/senha.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { FilaMemoria } from '../../src/infra/fila.js';

const URL_TESTE = process.env.DATABASE_URL_TEST;
const sufixo = randomBytes(3).toString('hex');
const DIA = 86_400_000;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('API pública, análises e relatórios assíncronos', { skip: !URL_TESTE && 'defina DATABASE_URL_TEST' }, () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let fila: FilaMemoria;
  let diretorio: string;
  const tokens: Record<string, string> = {};
  const chaves: Record<string, string> = {};

  type Resposta = { status: number; corpo: any; headers: Record<string, unknown> };
  const chamar = async (
    metodo: string,
    url: string,
    opcoes: { token?: string; chave?: string; corpo?: unknown } = {},
  ): Promise<Resposta> => {
    const r = await app.inject({
      method: metodo as 'GET',
      url,
      headers: {
        ...(opcoes.token ? { authorization: `Bearer ${tokens[opcoes.token]}` } : {}),
        ...(opcoes.chave ? { 'x-api-key': opcoes.chave } : {}),
      },
      ...(opcoes.corpo !== undefined ? { payload: opcoes.corpo as object } : {}),
    });
    const json = (r.headers['content-type'] ?? '').toString().includes('application/json') && r.body;
    return { status: r.statusCode, corpo: json ? r.json() : r.body, headers: r.headers };
  };

  const novaOrganizacao = async (prefixo: string) => {
    const base = String(randomInt(10_000_000, 99_999_999)) + '0001';
    const r = await chamar('POST', '/api/v1/internal/organizacoes', {
      token: 'admin',
      corpo: {
        codigo: `${prefixo}${sufixo}`,
        razaoSocial: `Organização ${prefixo}`,
        cnpj: base + calcularDigitosVerificadores(base),
        enderecoCompleto: 'Rua dos Testes, 100 - Centro',
        email: 'teste@exemplo.com',
        contrato: {
          dataAssinatura: dataCalendario(new Date(Date.now() - 30 * DIA)),
          dataVencimento: dataCalendario(new Date(Date.now() + 300 * DIA)),
          clausulas: ['Coleta mensal'],
          valorMensal: '1000.00',
        },
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    return r.corpo as { id: string; codigo: string };
  };

  const equipamento = (tipo = 'NOTEBOOK', estado = 'USADO_LEVE') => ({
    tipo, marca: 'Dell', modelo: 'Latitude 5490', anoFabricacao: 2019, estadoFisico: estado, pesoQuilogramas: 1.9,
  });

  let org: { id: string; codigo: string };
  let outraOrg: { id: string; codigo: string };
  let parceiroId: string;
  let chaveCompletaId: string;

  before(async () => {
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: URL_TESTE }, stdio: 'ignore' });
    diretorio = mkdtempSync(path.join(tmpdir(), 'greencode-relatorios-'));
    prisma = criarPrismaClient(URL_TESTE!);
    const config = carregarConfiguracao({
      ...process.env,
      DATABASE_URL: URL_TESTE,
      JWT_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres!',
      DIRETORIO_RELATORIOS: diretorio,
      REDIS_URL: '',
    });
    fila = new FilaMemoria(2);
    let servicos;
    ({ app, servicos } = await construirApp({ config, prisma, fila, logger: false }));
    await fila.consumir(servicos.relatorioAssincrono.processar);

    for (const [nome, papel] of [['admin', 'ADMINISTRADOR'], ['almox', 'GESTOR_ALMOXARIFADO'], ['auditor', 'AUDITOR']] as const) {
      await prisma.usuario.create({ data: { usuario: `${nome}_${sufixo}`, hashSenha: await gerarHashSenha('Teste@2026'), papel } });
      const r = await chamar('POST', '/api/v1/internal/auth/login', { corpo: { usuario: `${nome}_${sufixo}`, senha: 'Teste@2026' } });
      assert.equal(r.status, 200);
      tokens[nome] = r.corpo.token;
    }
    org = await novaOrganizacao('P');
    outraOrg = await novaOrganizacao('Q');
  });

  after(async () => {
    await fila?.encerrar();
    await app?.close();
    if (diretorio) rmSync(diretorio, { recursive: true, force: true });
  });

  // ------------------------------------------------------------- admin

  it('somente ADMINISTRADOR gerencia parceiros; emite chave exibida uma única vez', async () => {
    const negado = await chamar('POST', '/api/v1/admin/parceiros', { token: 'auditor', corpo: { nome: 'Parceiro X', organizacao: org.codigo } });
    assert.equal(negado.status, 403);

    const parceiro = await chamar('POST', '/api/v1/admin/parceiros', {
      token: 'admin',
      corpo: { nome: `ERP ${sufixo}`, organizacao: org.codigo, plano: 'PROFISSIONAL' },
    });
    assert.equal(parceiro.status, 201, JSON.stringify(parceiro.corpo));
    parceiroId = parceiro.corpo.id;

    const completa = await chamar('POST', `/api/v1/admin/parceiros/${parceiroId}/chaves`, {
      token: 'admin',
      corpo: { escopos: ['RASTREABILIDADE_LEITURA', 'LOTES_LEITURA', 'LOTES_ESCRITA', 'ANALISES_LEITURA', 'RELATORIOS_SOLICITAR'], validadeDias: 30 },
    });
    assert.equal(completa.status, 201);
    assert.match(completa.corpo.chave, /^gc_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    chaves.completa = completa.corpo.chave;
    chaveCompletaId = completa.corpo.id;

    const leitura = await chamar('POST', `/api/v1/admin/parceiros/${parceiroId}/chaves`, {
      token: 'admin',
      corpo: { escopos: ['RASTREABILIDADE_LEITURA'] },
    });
    chaves.leitura = leitura.corpo.chave;

    const lista = await chamar('GET', `/api/v1/admin/parceiros/${parceiroId}/chaves`, { token: 'admin' });
    assert.equal(lista.corpo.length, 2);
    assert.ok(lista.corpo.every((c: object) => !('chave' in c) && !('hashSegredo' in c)), 'listagem não expõe segredo nem hash');
  });

  // ---------------------------------------------- credenciais e escopos

  it('sem chave ou com chave inválida: 401; sem escopo: 403 antes da validação do corpo', async () => {
    assert.equal((await chamar('GET', '/api/v1/public/lotes')).status, 401);
    assert.equal((await chamar('GET', '/api/v1/public/lotes', { chave: `gc_000000000000_${'A'.repeat(43)}` })).status, 401);
    const semEscopo = await chamar('POST', '/api/v1/public/lotes', { chave: chaves.leitura!, corpo: { invalido: true } });
    assert.equal(semEscopo.status, 403);
    assert.equal(semEscopo.corpo.erro.codigo, 'SEM_PERMISSAO');
  });

  // ------------------------------------------------- lotes e rastreio

  let loteId: string;
  let codigoNotebook: string;

  it('parceiro submete lote (atômico) e as regras da Atividade 2 continuam valendo', async () => {
    const corpo = {
      notaFiscal: `NFP${sufixo}`,
      transportadora: 'TransRapida',
      dataEntrada: new Date(Date.now() - 2 * DIA).toISOString(),
      equipamentos: [equipamento('NOTEBOOK', 'USADO_LEVE'), equipamento('ROTEADOR', 'INSERVIVEL')],
    };
    const r = await chamar('POST', '/api/v1/public/lotes', { chave: chaves.completa!, corpo });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.equal(r.headers['x-api-version'], '1.0.0');
    assert.ok(r.headers['x-ratelimit-limit']);
    assert.equal(r.corpo.quantidadeEquipamentos, 2);
    assert.ok(!('versao' in r.corpo), 'contrato público não expõe controle de versão');
    loteId = r.corpo.id;
    codigoNotebook = r.corpo.equipamentos[0].codigoBarrasInterno;

    assert.equal((await chamar('POST', '/api/v1/public/lotes', { chave: chaves.completa!, corpo })).status, 409);
    const antiga = await chamar('POST', '/api/v1/public/lotes', {
      chave: chaves.completa!,
      corpo: { ...corpo, notaFiscal: `NFX${sufixo}`, dataEntrada: new Date(Date.now() - 100 * DIA).toISOString() },
    });
    assert.equal(antiga.status, 400);
  });

  it('lista e detalha só lotes da própria organização (outra organização = 404)', async () => {
    const lista = await chamar('GET', '/api/v1/public/lotes?tamanho=10', { chave: chaves.completa! });
    assert.equal(lista.status, 200);
    assert.equal(lista.corpo.total, 1);

    const loteOutra = await chamar('POST', '/api/v1/internal/lotes', {
      token: 'almox',
      corpo: { organizacao: outraOrg.codigo, notaFiscal: `NFQ${sufixo}`, transportadora: 'T', dataEntrada: new Date().toISOString(), equipamentos: [equipamento()] },
    });
    assert.equal(loteOutra.status, 201);
    assert.equal((await chamar('GET', `/api/v1/public/lotes/${loteOutra.corpo.id}`, { chave: chaves.completa! })).status, 404);
    assert.equal((await chamar('GET', `/api/v1/public/lotes/${loteId}`, { chave: chaves.completa! })).status, 200);
  });

  it('operação interna registra marcos da triagem, estado físico e valor recuperado', async () => {
    let lote = (await chamar('GET', `/api/v1/internal/lotes/${loteId}`, { token: 'almox' })).corpo;
    lote = (await chamar('PATCH', `/api/v1/internal/lotes/${loteId}/status`, { token: 'almox', corpo: { status: 'EM_TRIAGEM', versao: lote.versao } })).corpo;
    assert.ok(lote.inicioTriagemEm);

    const [notebook, roteador] = lote.equipamentos;
    const queda = await chamar('PATCH', `/api/v1/internal/equipamentos/${notebook.id}/estado-fisico`, {
      token: 'almox',
      corpo: { estadoFisico: 'DANIFICADO_LEVE', versao: notebook.versao, justificativa: 'Tela trincada' },
    });
    assert.equal(queda.status, 200);
    let nb = (await chamar('PATCH', `/api/v1/internal/equipamentos/${notebook.id}/status`, { token: 'almox', corpo: { status: 'AGUARDANDO_DESMONTE', versao: queda.corpo.versao } })).corpo;
    await chamar('PATCH', `/api/v1/internal/equipamentos/${roteador.id}/status`, {
      token: 'almox',
      corpo: { status: 'DESCARTE_SEGURO', versao: roteador.versao, justificativa: 'Inservível' },
    });

    lote = (await chamar('GET', `/api/v1/internal/lotes/${loteId}`, { token: 'almox' })).corpo;
    lote = (await chamar('PATCH', `/api/v1/internal/lotes/${loteId}/status`, { token: 'almox', corpo: { status: 'TRIAGEM_CONCLUIDA', versao: lote.versao } })).corpo;
    assert.ok(lote.conclusaoTriagemEm);
    assert.equal(lote.responsavelTriagem, `almox_${sufixo}`);

    nb = (await chamar('PATCH', `/api/v1/internal/equipamentos/${nb.id}/status`, { token: 'almox', corpo: { status: 'EM_DESMONTE', versao: nb.versao } })).corpo;
    const valorErrado = await chamar('PATCH', `/api/v1/internal/equipamentos/${nb.id}/status`, {
      token: 'almox',
      corpo: { status: 'DESCARTE_SEGURO', versao: nb.versao, valorRecuperado: 10, justificativa: 'x' },
    });
    assert.equal(valorErrado.status, 400);
    const recuperado = await chamar('PATCH', `/api/v1/internal/equipamentos/${nb.id}/status`, {
      token: 'almox',
      corpo: { status: 'PECAS_REAPROVEITADAS', versao: nb.versao, valorRecuperado: 120.5 },
    });
    assert.equal(recuperado.status, 200, JSON.stringify(recuperado.corpo));
    assert.equal(recuperado.corpo.valorRecuperado, '120.50');
  });

  it('rastreabilidade pública traz movimentações e histórico de estado, sem nomes de operadores', async () => {
    const r = await chamar('GET', `/api/v1/public/rastreabilidade/${codigoNotebook}`, { chave: chaves.leitura! });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.equal(r.corpo.historicoEstadoFisico.length, 2);
    assert.equal(r.corpo.historicoEstadoFisico[1].estadoNovo, 'DANIFICADO_LEVE');
    assert.ok(r.corpo.movimentacoes.length >= 4);
    assert.ok(r.corpo.movimentacoes.every((m: object) => !('responsavel' in m)));
  });

  // --------------------------------------------------- camada analítica

  it('execuções analíticas sob demanda são persistidas e consultáveis', async () => {
    for (const tipo of ['EFICIENCIA_OPERACIONAL', 'RENTABILIDADE', 'VIDA_UTIL']) {
      const r = await chamar('POST', '/api/v1/internal/analises/execucoes', { token: 'auditor', corpo: { tipo, organizacao: org.codigo } });
      assert.equal(r.status, 201, JSON.stringify(r.corpo));
      const salvo = await chamar('GET', `/api/v1/internal/analises/execucoes/${r.corpo.id}`, { token: 'auditor' });
      assert.equal(salvo.corpo.tipo, tipo);
    }
    assert.equal((await chamar('POST', '/api/v1/internal/analises/execucoes', { token: 'auditor', corpo: { tipo: 'RENTABILIDADE', organizacao: 'NAOEXISTE' } })).status, 404);
    assert.equal((await chamar('GET', '/api/v1/internal/analises/vida-util/acuracia', { token: 'auditor' })).status, 200);
  });

  it('análises públicas: eficiência da organização (operadores anonimizados) e referências de mercado', async () => {
    const ef = await chamar('GET', '/api/v1/public/analises/eficiencia', { chave: chaves.completa! });
    assert.equal(ef.status, 200, JSON.stringify(ef.corpo));
    assert.equal(ef.corpo.lotesAnalisados, 1);
    const operadores = ef.corpo.grupos.filter((g: { dimensao: string }) => g.dimensao === 'OPERADOR');
    assert.deepEqual(operadores.map((g: { rotulo: string }) => g.rotulo), ['Operador 1']);

    const rent = await chamar('GET', '/api/v1/public/analises/rentabilidade?tipo=NOTEBOOK', { chave: chaves.completa! });
    assert.equal(rent.status, 200);
    assert.ok(rent.corpo.grupos.every((g: { tipo: string }) => g.tipo === 'NOTEBOOK'));

    const vida = await chamar('GET', '/api/v1/public/analises/vida-util', { chave: chaves.completa! });
    assert.equal(vida.status, 200);
    assert.ok(Array.isArray(vida.corpo.modelos));
  });

  // ------------------------------------------------ relatório assíncrono

  it('relatório assíncrono: 202 + Location, polling até CONCLUIDA e download CSV', async () => {
    const pedido = await chamar('POST', '/api/v1/public/relatorios', { chave: chaves.completa!, corpo: { tipo: 'RASTREABILIDADE', formato: 'CSV' } });
    assert.equal(pedido.status, 202, JSON.stringify(pedido.corpo));
    assert.equal(pedido.headers.location, pedido.corpo.links.status);

    let tarefa = pedido.corpo;
    for (let i = 0; i < 50 && !['CONCLUIDA', 'FALHOU'].includes(tarefa.status); i++) {
      await esperar(100);
      tarefa = (await chamar('GET', tarefa.links.status, { chave: chaves.completa! })).corpo;
    }
    assert.equal(tarefa.status, 'CONCLUIDA', JSON.stringify(tarefa));

    const arquivo = await chamar('GET', tarefa.links.download, { chave: chaves.completa! });
    assert.equal(arquivo.status, 200);
    assert.match(String(arquivo.headers['content-type']), /text\/csv/);
    const linhas = String(arquivo.corpo).trim().split('\r\n');
    assert.equal(linhas[0], 'codigoBarras;tipo;notaFiscal;dataEntrada;status;localAtual;ultimaMovimentacao');
    assert.equal(linhas.length, 3, 'cabeçalho + 2 equipamentos da organização');

    // Outro parceiro não enxerga a tarefa
    const outro = await chamar('POST', '/api/v1/admin/parceiros', { token: 'admin', corpo: { nome: `Outro ${sufixo}`, organizacao: outraOrg.codigo } });
    const chaveOutro = (await chamar('POST', `/api/v1/admin/parceiros/${outro.corpo.id}/chaves`, { token: 'admin', corpo: { escopos: ['RELATORIOS_SOLICITAR'] } })).corpo.chave;
    assert.equal((await chamar('GET', tarefa.links.status, { chave: chaveOutro })).status, 404);
  });

  // ------------------------------------------------- limite e revogação

  it('plano BASICO: acima de 60 requisições/min responde 429 LIMITE_EXCEDIDO', async () => {
    const basico = await chamar('POST', '/api/v1/admin/parceiros', { token: 'admin', corpo: { nome: `Básico ${sufixo}`, organizacao: org.codigo } });
    const chave = (await chamar('POST', `/api/v1/admin/parceiros/${basico.corpo.id}/chaves`, { token: 'admin', corpo: { escopos: ['LOTES_LEITURA'] } })).corpo.chave;
    // Em sequência, como um cliente real: com app.inject em Promise.all todas as
    // requisições chegam no mesmo tick e o store em memória do plugin conta
    // todas antes de avaliar a primeira
    const respostas: Resposta[] = [];
    for (let i = 0; i < 65; i++) respostas.push(await chamar('GET', '/api/v1/public/lotes?tamanho=1', { chave }));
    const bloqueadas = respostas.filter((r) => r.status === 429);
    assert.equal(respostas.slice(0, 60).every((r) => r.status === 200), true);
    assert.equal(bloqueadas.length, 5);
    assert.equal(bloqueadas[0]!.corpo.erro.codigo, 'LIMITE_EXCEDIDO');
  });

  it('chave revogada deixa de funcionar imediatamente', async () => {
    assert.equal((await chamar('DELETE', `/api/v1/admin/chaves/${chaveCompletaId}`, { token: 'admin' })).status, 204);
    const r = await chamar('GET', '/api/v1/public/lotes', { chave: chaves.completa! });
    assert.equal(r.status, 401);
    assert.match(r.corpo.erro.mensagem, /revogada/);
  });

  it('documentação OpenAPI inclui as rotas públicas e o esquema de chave de API', async () => {
    const r = await app.inject({ method: 'GET', url: '/docs/json' });
    const doc = r.json();
    assert.ok(doc.paths['/api/v1/public/relatorios']);
    assert.ok(doc.paths['/api/v1/admin/parceiros']);
    assert.deepEqual(doc.components.securitySchemes.chaveApi, { type: 'apiKey', in: 'header', name: 'X-API-Key' });
  });
});
