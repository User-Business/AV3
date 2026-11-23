import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linearRegression, rSquared } from 'simple-statistics';
import {
  ajustarModelosVidaUtil,
  calcularEficiencia,
  calcularRentabilidade,
  erroAbsolutoMedio,
  projetarVidaRemanescente,
  type LoteTriado,
} from '../../src/domain/analises.js';
import { decomporChave, exigirEscopo, gerarChave, segredoConfere, type ParceiroAutenticado } from '../../src/domain/chave-api.js';
import { ErroNaoAutenticado, ErroSemPermissao } from '../../src/domain/erros.js';
import { minimosQuadrados, resumir, suavizacaoExponencial } from '../../src/domain/estatistica.js';
import { ErroDefinitivo, FilaMemoria, atrasoRetentativa } from '../../src/infra/fila.js';
import { celulaCsv } from '../../src/services/relatorio-assincrono.service.js';

const proximo = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≉ ${b}`);

describe('Estatística', () => {
  it('mínimos quadrados recupera reta exata', () => {
    const r = minimosQuadrados([[0, 1], [1, 3], [2, 5], [3, 7]])!;
    proximo(r.coeficienteAngular, 2);
    proximo(r.intercepto, 1);
    proximo(r.r2, 1);
  });

  it('implementação manual coincide com a simple-statistics em dados ruidosos', () => {
    const pontos: [number, number][] = [[1, 0.8], [2, 2.1], [3, 2.4], [4, 4.2], [5, 4.6], [6, 6.3], [7, 6.4]];
    const nosso = minimosQuadrados(pontos)!;
    const ref = linearRegression(pontos);
    proximo(nosso.coeficienteAngular, ref.m);
    proximo(nosso.intercepto, ref.b);
    proximo(nosso.r2, rSquared(pontos, (x) => ref.m * x + ref.b));
  });

  it('sem variação em x ou com menos de 2 pontos não há reta', () => {
    assert.equal(minimosQuadrados([[2, 1], [2, 3]]), null);
    assert.equal(minimosQuadrados([[1, 1]]), null);
  });

  it('resumo descritivo', () => {
    const r = resumir([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.equal(r.media, 5);
    assert.equal(r.mediana, 4.5);
    proximo(r.desvioPadrao, 2.1381, 1e-4);
    assert.equal(resumir([3]).desvioPadrao, 0);
    assert.equal(resumir([]).n, 0);
  });

  it('suavização exponencial', () => {
    assert.equal(suavizacaoExponencial([]), null);
    assert.equal(suavizacaoExponencial([10, 20, 30], 0.5), 22.5);
    assert.throws(() => suavizacaoExponencial([1], 0));
  });
});

describe('Análises', () => {
  const lote = (horas: number, operador: string, mes = 2): LoteTriado => {
    const entrada = new Date(Date.UTC(2026, mes, 10));
    return { dataEntrada: entrada, conclusaoTriagemEm: new Date(entrada.getTime() + horas * 3_600_000), responsavelTriagem: operador };
  };

  it('eficiência agrupa por operador e mês e aponta o gargalo', () => {
    const grupos = calcularEficiencia([
      ...[20, 24, 22].map((h) => lote(h, 'ana')),
      ...[60, 70, 65].map((h) => lote(h, 'bruno')),
      ...[30, 28, 32].map((h) => lote(h, 'carla', 3)),
    ]);
    assert.equal(grupos[0]!.n, 9);
    assert.equal(grupos.find((g) => g.chave === 'bruno')!.gargalo, true);
    assert.equal(grupos.find((g) => g.chave === 'ana')!.gargalo, false);
    assert.deepEqual(grupos.filter((g) => g.dimensao === 'MES').map((g) => g.rotulo), ['mar/2026', 'abr/2026']);
  });

  it('grupo com menos de 3 lotes não é marcado como gargalo', () => {
    const grupos = calcularEficiencia([lote(10, 'a'), lote(10, 'a'), lote(10, 'a'), lote(100, 'b')]);
    assert.equal(grupos.find((g) => g.chave === 'b')!.gargalo, false);
  });

  it('rentabilidade em três granularidades, ordenada pelo valor médio', () => {
    const grupos = calcularRentabilidade([
      { tipo: 'SERVIDOR', estadoFisico: 'BOM_ESTADO', marca: 'Dell', modelo: 'R740', valor: 800, pesoKg: 20 },
      { tipo: 'SERVIDOR', estadoFisico: 'USADO_LEVE', marca: 'Dell', modelo: 'R740', valor: 600, pesoKg: 20 },
      { tipo: 'MONITOR', estadoFisico: 'BOM_ESTADO', marca: 'LG', modelo: '24MK', valor: 60, pesoKg: 4 },
    ]);
    const servidor = grupos.find((g) => g.tipo === 'SERVIDOR' && !g.estadoFisico && !g.marca)!;
    assert.equal(servidor.valorMedio, 700);
    assert.equal(servidor.valorMedioPorKg, 35);
    assert.equal(grupos[0]!.valorMedio, 800);
    assert.equal(grupos.at(-1)!.tipo, 'MONITOR');
  });

  it('vida útil por MQO projeta a idade de inservibilidade', () => {
    const [m] = ajustarModelosVidaUtil([1, 2, 3, 4, 5, 6].map((idade) => ({ tipo: 'NOTEBOOK' as const, idadeAnos: idade, nivel: 0.5 + 0.75 * idade })));
    assert.equal(m!.metodo, 'MINIMOS_QUADRADOS');
    assert.equal(m!.idadeInservivelAnos, 7.33);
    assert.equal(m!.r2, 1);
  });

  it('com poucas observações usa suavização exponencial', () => {
    const [m] = ajustarModelosVidaUtil([
      { tipo: 'ROTEADOR', idadeAnos: 2, nivel: 2 },
      { tipo: 'ROTEADOR', idadeAnos: 4, nivel: 4 },
    ]);
    assert.equal(m!.metodo, 'SUAVIZACAO_EXPONENCIAL');
    assert.equal(m!.suficiente, false);
    assert.equal(m!.idadeInservivelAnos, 6);
  });

  it('vida remanescente parte do estado atual; erro absoluto médio', () => {
    const ref = new Date(Date.UTC(2026, 0, 1));
    assert.equal(projetarVidaRemanescente({ coeficienteAngular: 0.5 }, 2, ref).anos, 8);
    assert.equal(projetarVidaRemanescente({ coeficienteAngular: 0.5 }, 6, ref).anos, 0);
    assert.equal(projetarVidaRemanescente(undefined, 2, ref).anos, null);
    assert.equal(erroAbsolutoMedio([{ previsto: 8, real: 7 }, { previsto: 5, real: 8 }]), 2);
  });
});

describe('Chaves de API', () => {
  it('gera no formato gc_<prefixo>_<segredo> e confere o segredo pelo hash', () => {
    const chave = gerarChave();
    const { prefixo, segredo } = decomporChave(chave.chaveCompleta);
    assert.equal(prefixo, chave.prefixo);
    assert.equal(segredoConfere(segredo, chave.hashSegredo), true);
    assert.equal(segredoConfere(segredo.replace(/.$/, segredo.endsWith('A') ? 'B' : 'A'), chave.hashSegredo), false);
  });

  it('formato inválido é rejeitado como não autenticado', () => {
    assert.throws(() => decomporChave(undefined), ErroNaoAutenticado);
    assert.throws(() => decomporChave('Bearer abc'), ErroNaoAutenticado);
  });

  it('escopo ausente gera SEM_PERMISSAO', () => {
    const parceiro: ParceiroAutenticado = { parceiroId: 'p', nome: 'n', organizacaoId: 'o', plano: 'BASICO', chaveId: 'c', escopos: ['LOTES_LEITURA'] };
    assert.doesNotThrow(() => exigirEscopo(parceiro, 'LOTES_LEITURA'));
    assert.throws(() => exigirEscopo(parceiro, 'LOTES_ESCRITA'), ErroSemPermissao);
  });
});

describe('Relatórios e fila', () => {
  it('CSV escapa separadores e neutraliza fórmulas', () => {
    assert.equal(celulaCsv(null), '');
    assert.equal(celulaCsv('a;b'), '"a;b"');
    assert.equal(celulaCsv('diz "oi"'), '"diz ""oi"""');
    assert.equal(celulaCsv('=SOMA(A1)'), "'=SOMA(A1)");
  });

  it('retentativa com recuo exponencial', () => {
    assert.deepEqual([1, 2, 3].map(atrasoRetentativa), [5_000, 10_000, 20_000]);
  });

  it('fila em memória respeita a concorrência', async () => {
    const fila = new FilaMemoria(2);
    let simultaneas = 0;
    let pico = 0;
    const feitas: string[] = [];
    await fila.consumir(async (id) => {
      pico = Math.max(pico, ++simultaneas);
      await new Promise((r) => setTimeout(r, 20));
      simultaneas--;
      feitas.push(id);
    });
    for (const id of ['a', 'b', 'c', 'd']) await fila.publicar(id);
    while (feitas.length < 4) await new Promise((r) => setTimeout(r, 5));
    await fila.encerrar();
    assert.equal(pico, 2);
  });

  it('falha transitória é retentada até 3 vezes; erro definitivo não', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const tentativas: Record<string, number[]> = { x: [], y: [] };
    const fila = new FilaMemoria(2);
    await fila.consumir(async (id, tentativa) => {
      tentativas[id]!.push(tentativa);
      throw id === 'x' ? new Error('banco indisponível') : new ErroDefinitivo('tarefa inexistente');
    });
    await fila.publicar('x');
    await fila.publicar('y');
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      t.mock.timers.tick(20_000);
    }
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(tentativas.x, [1, 2, 3]);
    assert.deepEqual(tentativas.y, [1]);
  });
});

describe('Análises - robustez do gargalo', () => {
  it('um lote isolado muito demorado não esconde o operador lento', () => {
    const lote = (horas: number, operador: string): LoteTriado => ({
      dataEntrada: new Date(Date.UTC(2026, 2, 1)),
      conclusaoTriagemEm: new Date(Date.UTC(2026, 2, 1) + horas * 3_600_000),
      responsavelTriagem: operador,
    });
    const grupos = calcularEficiencia([
      ...[24, 26, 28, 30].map((h) => lote(h, 'ana')),
      ...[60, 65, 70].map((h) => lote(h, 'bruno')),
      lote(720, 'admin'),
    ]);
    assert.equal(grupos.find((g) => g.chave === 'bruno')!.gargalo, true);
    assert.equal(grupos.find((g) => g.chave === 'admin')!.gargalo, false, 'só 1 lote: não sinaliza');
  });
});
