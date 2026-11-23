/**
 * Jornada completa via HTTP (app.inject) contra um PostgreSQL REAL.
 *
 * Requer DATABASE_URL_TEST apontando para um banco descartável, ex.:
 *   DATABASE_URL_TEST=postgresql://greencode:greencode@localhost:5432/greencode_test
 * As migrações são aplicadas automaticamente. Sem a variável, a suíte é pulada.
 * Os dados usam sufixos aleatórios, então a suíte pode rodar várias vezes.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { construirApp } from '../../src/app.js';
import { carregarConfiguracao } from '../../src/config.js';
import { criarPrismaClient } from '../../src/database.js';
import { calcularDigitosVerificadores } from '../../src/domain/cnpj.js';
import { dataCalendario } from '../../src/domain/contrato.js';
import { gerarHashLegadoSha256, gerarHashSenha } from '../../src/domain/senha.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { traduzirErro } from '../../src/http/plugins/tratamento-erros.js';

const URL_TESTE = process.env.DATABASE_URL_TEST;
const sufixo = randomBytes(3).toString('hex');
const DIA = 86_400_000;

describe('Jornada completa da API', { skip: !URL_TESTE && 'defina DATABASE_URL_TEST' }, () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const tokens: Record<string, string> = {};

  const chamar = async (metodo: string, url: string, papel?: string, corpo?: unknown) => {
    const resposta = await app.inject({
      method: metodo as 'GET',
      url: `/api/v1/internal${url}`,
      headers: papel ? { authorization: `Bearer ${tokens[papel]}` } : {},
      ...(corpo !== undefined ? { payload: corpo as object } : {}),
    });
    return { status: resposta.statusCode, corpo: resposta.body ? resposta.json() : undefined };
  };

  const novoCnpj = () => {
    const base = String(randomInt(10_000_000, 99_999_999)) + '0001';
    return base + calcularDigitosVerificadores(base);
  };
  const equipamento = (estado = 'BOM_ESTADO', tipo = 'NOTEBOOK') => ({
    tipo, marca: 'Dell', modelo: 'Latitude', anoFabricacao: 2020, estadoFisico: estado, pesoQuilogramas: 1.75,
  });

  before(async () => {
    execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: URL_TESTE }, stdio: 'ignore' });
    prisma = criarPrismaClient(URL_TESTE!);
    const config = carregarConfiguracao({
      ...process.env,
      DATABASE_URL: URL_TESTE,
      JWT_SECRET: 'segredo-de-teste-com-mais-de-32-caracteres!',
    });
    ({ app } = await construirApp({ config, prisma, logger: false }));

    const usuarios = [
      ['admin', 'ADMINISTRADOR'],
      ['almox', 'GESTOR_ALMOXARIFADO'],
      ['auditor', 'AUDITOR'],
    ] as const;
    for (const [nome, papel] of usuarios) {
      await prisma.usuario.create({
        data: { usuario: `${nome}_${sufixo}`, hashSenha: await gerarHashSenha('Teste@2026'), papel },
      });
      const r = await chamar('POST', '/auth/login', undefined, { usuario: `${nome}_${sufixo}`, senha: 'Teste@2026' });
      assert.equal(r.status, 200);
      tokens[nome] = r.corpo.token;
    }
  });

  after(async () => {
    await app?.close(); // também desconecta o Prisma (hook onClose)
  });

  let org: { id: string; codigo: string; cnpj: string };
  let lote: { id: string; versao: number; equipamentos: { id: string; versao: number; codigoBarrasInterno: string }[] };

  it('login com hash SHA-256 legado do CLI migra para bcrypt', async () => {
    await prisma.usuario.create({
      data: { usuario: `legado_${sufixo}`, hashSenha: gerarHashLegadoSha256('Legado@2026'), papel: 'AUDITOR' },
    });
    const r = await chamar('POST', '/auth/login', undefined, { usuario: `legado_${sufixo}`, senha: 'Legado@2026' });
    assert.equal(r.status, 200);
    const depois = await prisma.usuario.findUniqueOrThrow({ where: { usuario: `legado_${sufixo}` } });
    assert.match(depois.hashSenha, /^\$2[aby]\$12\$/);
  });

  it('cadastra organização com contrato na mesma transação; CNPJ duplicado = 409', async () => {
    const cnpj = novoCnpj();
    const corpo = {
      codigo: `T${sufixo}`,
      razaoSocial: 'Organização de Teste S.A.',
      cnpj,
      enderecoCompleto: 'Rua dos Testes, 100 - Centro',
      email: 'teste@exemplo.com',
      contrato: {
        dataAssinatura: dataCalendario(new Date(Date.now() - 30 * DIA)),
        dataVencimento: dataCalendario(new Date(Date.now() + 300 * DIA)),
        clausulas: ['Coleta mensal'],
        valorMensal: '999.90',
      },
    };
    const r = await chamar('POST', '/organizacoes', 'admin', corpo);
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.equal(r.corpo.contrato.vigente, true);
    org = r.corpo;

    const dup = await chamar('POST', '/organizacoes', 'admin', { ...corpo, codigo: `U${sufixo}` });
    assert.equal(dup.status, 409);
  });

  it('auditor não cria lote (403) e lote sem equipamentos é rejeitado (400)', async () => {
    const base = { organizacao: org.codigo, notaFiscal: `NF${sufixo}`, transportadora: 'T', dataEntrada: new Date().toISOString() };
    assert.equal((await chamar('POST', '/lotes', 'auditor', { ...base, equipamentos: [equipamento()] })).status, 403);
    assert.equal((await chamar('POST', '/lotes', 'almox', { ...base, equipamentos: [] })).status, 400);
  });

  it('cria lote com equipamentos, códigos de barras e movimentação de entrada', async () => {
    const r = await chamar('POST', '/lotes', 'almox', {
      organizacao: org.codigo,
      notaFiscal: `NF${sufixo}`,
      transportadora: 'TransRapida',
      dataEntrada: new Date(Date.now() - 2 * DIA).toISOString(),
      equipamentos: [equipamento('NOVO'), equipamento('INSERVIVEL', 'ROTEADOR'), equipamento('USADO_LEVE', 'MONITOR')],
    });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.equal(r.corpo.quantidadeEquipamentos, 3);
    assert.equal(r.corpo.pesoTotalQuilogramas, 5.25);
    assert.deepEqual(r.corpo.equipamentos.map((e: { posicaoNoLote: number }) => e.posicaoNoLote), [1, 2, 3]);
    lote = r.corpo;

    const rastreio = await chamar('GET', `/equipamentos/${lote.equipamentos[0]!.codigoBarrasInterno}/rastreio`, 'auditor');
    assert.equal(rastreio.status, 200);
    assert.equal(rastreio.corpo.movimentacoes.length, 1);
    assert.equal(rastreio.corpo.organizacao.codigo, org.codigo);
  });

  it('concorrência otimista: duas inclusões com a mesma versão -> uma 201 e uma 409', async () => {
    const [a, b] = await Promise.all([
      chamar('POST', `/lotes/${lote.id}/equipamentos`, 'almox', { versao: lote.versao, equipamento: equipamento() }),
      chamar('POST', `/lotes/${lote.id}/equipamentos`, 'almox', { versao: lote.versao, equipamento: equipamento() }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    const vencedor = a.status === 201 ? a : b;
    assert.equal(vencedor.corpo.quantidadeEquipamentos, 4);
    lote = vencedor.corpo;
  });

  it('remove equipamento de lote RECEBIDO (movimentações vão em cascata)', async () => {
    const ultimo = lote.equipamentos.at(-1)!;
    const r = await chamar('DELETE', `/lotes/${lote.id}/equipamentos/${ultimo.id}?versao=${lote.versao}`, 'almox');
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.equal(r.corpo.quantidadeEquipamentos, 3);
    lote = r.corpo;
  });

  it('versão desatualizada -> 409', async () => {
    const r = await chamar('PATCH', `/lotes/${lote.id}/status`, 'almox', { status: 'EM_TRIAGEM', versao: lote.versao - 1 });
    assert.equal(r.status, 409);
  });

  it('fluxo de triagem e desmonte respeita as regras', async () => {
    let r = await chamar('PATCH', `/lotes/${lote.id}/status`, 'almox', { status: 'EM_TRIAGEM', versao: lote.versao });
    assert.equal(r.status, 200);
    lote = r.corpo;
    assert.ok(lote.equipamentos.every((e) => (e as unknown as { statusRastreamento: string }).statusRastreamento === 'EM_TRIAGEM'));

    r = await chamar('PATCH', `/lotes/${lote.id}/status`, 'almox', { status: 'TRIAGEM_CONCLUIDA', versao: lote.versao });
    assert.equal(r.status, 422, 'há equipamentos sem classificação');

    const [nb, rot, mon] = lote.equipamentos as { id: string; versao: number }[];
    r = await chamar('PATCH', `/equipamentos/${nb!.id}/status`, 'almox', { status: 'AGUARDANDO_DESMONTE', versao: nb!.versao });
    assert.equal(r.status, 200);
    const nbVersao = r.corpo.versao;

    r = await chamar('PATCH', `/equipamentos/${nb!.id}/status`, 'almox', { status: 'EM_DESMONTE', versao: nbVersao });
    assert.equal(r.status, 422, 'desmonte antes da triagem completa do lote');

    r = await chamar('PATCH', `/equipamentos/${rot!.id}/status`, 'almox', { status: 'DESCARTE_SEGURO', versao: rot!.versao });
    assert.equal(r.status, 400, 'descarte exige justificativa');
    r = await chamar('PATCH', `/equipamentos/${rot!.id}/status`, 'almox', {
      status: 'DESCARTE_SEGURO', versao: rot!.versao, justificativa: 'Inservível',
    });
    assert.equal(r.status, 200);

    r = await chamar('PATCH', `/equipamentos/${mon!.id}/estado-fisico`, 'almox', { estadoFisico: 'DANIFICADO_LEVE', versao: mon!.versao });
    assert.equal(r.status, 400, 'queda de 2 categorias sem justificativa');
    r = await chamar('PATCH', `/equipamentos/${mon!.id}/estado-fisico`, 'almox', {
      estadoFisico: 'DANIFICADO_LEVE', versao: mon!.versao, justificativa: 'Tela trincada',
    });
    assert.equal(r.status, 200);
    r = await chamar('PATCH', `/equipamentos/${mon!.id}/status`, 'almox', { status: 'AGUARDANDO_DESMONTE', versao: r.corpo.versao });
    assert.equal(r.status, 200);

    const atual = await chamar('GET', `/lotes/${lote.id}`, 'almox');
    r = await chamar('PATCH', `/lotes/${lote.id}/status`, 'almox', { status: 'TRIAGEM_CONCLUIDA', versao: atual.corpo.versao });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));

    r = await chamar('PATCH', `/equipamentos/${nb!.id}/status`, 'almox', { status: 'EM_DESMONTE', versao: nbVersao });
    assert.equal(r.status, 200);

    const rastreio = await chamar('GET', `/equipamentos/${nb!.id}/rastreio`, 'auditor');
    assert.deepEqual(
      rastreio.corpo.movimentacoes.map((m: { destino: string }) => m.destino),
      ['AGUARDANDO_TRIAGEM', 'EM_TRIAGEM', 'AGUARDANDO_DESMONTE', 'EM_DESMONTE'],
    );
  });

  it('triggers do banco barram escrita direta inconsistente (defesa em profundidade)', async () => {
    const mov = await prisma.movimentacao.findFirstOrThrow({ where: { equipamento: { loteId: lote.id } } });
    await assert.rejects(
      prisma.movimentacao.update({ where: { id: mov.id }, data: { destino: 'ADULTERADO' } }),
      (e) => traduzirErro(e).status === 422 && /imutáveis/.test(traduzirErro(e).mensagem),
    );

    const eq = await prisma.equipamento.findFirstOrThrow({ where: { loteId: lote.id, statusRastreamento: 'AGUARDANDO_DESMONTE' } });
    await assert.rejects(
      prisma.equipamento.update({ where: { id: eq.id }, data: { statusRastreamento: 'BAIXA_DEFINITIVA' } }),
      (e) => traduzirErro(e).status === 422 && /Transição/.test(traduzirErro(e).mensagem),
    );

    // Lote sem equipamento: o constraint trigger diferido rejeita no COMMIT
    await assert.rejects(
      prisma.lote.create({
        data: { organizacaoId: org.id, dataEntrada: new Date(), notaFiscal: `VAZIO${sufixo}`, transportadora: 'T' },
      }),
      (e) => traduzirErro(e).status === 422,
    );
    assert.equal(await prisma.lote.count({ where: { notaFiscal: `VAZIO${sufixo}` } }), 0, 'nada foi persistido');
  });

  it('auditoria e relatórios: auditor lê, gestor não', async () => {
    const journal = await chamar('GET', `/auditoria/journal?entidade=Lote&entidadeId=${lote.id}`, 'auditor');
    assert.equal(journal.status, 200);
    assert.ok(journal.corpo.some((j: { operacao: string }) => j.operacao === 'CRIAR'));
    assert.equal((await chamar('GET', '/auditoria/journal', 'almox')).status, 403);

    const hoje = dataCalendario();
    const fin = await chamar('GET', `/relatorios/financeiro?inicio=${hoje}&fim=${hoje}`, 'auditor');
    assert.equal(fin.status, 200);
    const item = fin.corpo.contratos.find((c: { organizacao: { codigo: string } }) => c.organizacao.codigo === org.codigo);
    assert.equal(item.receitaEstimada, '33.33', '999.90 x 1 dia / 30');
  });

  it('logout revoga o token', async () => {
    assert.equal((await chamar('POST', '/auth/logout', 'admin')).status, 204);
    assert.equal((await chamar('GET', '/auth/eu', 'admin')).status, 401);
  });

  it('documentação OpenAPI disponível', async () => {
    const r = await app.inject({ method: 'GET', url: '/docs/json' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().paths['/api/v1/internal/lotes']);
  });
});
