import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exigirPermissao, possuiPermissao, type Ator } from '../../src/domain/autorizacao.js';
import { calcularDigitosVerificadores, cnpjValido, normalizarCnpj } from '../../src/domain/cnpj.js';
import { Contrato, dataCalendario, paraDataSemHora } from '../../src/domain/contrato.js';
import {
  Equipamento,
  codigoBarrasValido,
  exigeJustificativaEstado,
  gerarCodigoBarras,
  type DadosEquipamento,
} from '../../src/domain/equipamento.js';
import { ErroNaoAutenticado, ErroRegraNegocio, ErroSemPermissao, ErroValidacao } from '../../src/domain/erros.js';
import { Lote, validarDataEntrada } from '../../src/domain/lote.js';
import { gerarHashLegadoSha256, gerarHashSenha, validarForcaSenha, verificarSenha } from '../../src/domain/senha.js';

describe('CNPJ', () => {
  it('aceita CNPJ numérico válido com e sem máscara', () => {
    assert.equal(cnpjValido('11.222.333/0001-81'), true);
    assert.equal(cnpjValido('11222333000181'), true);
  });

  it('aceita o CNPJ alfanumérico do exemplo oficial da Receita (12.ABC.345/01DE-35)', () => {
    assert.equal(cnpjValido('12.ABC.345/01DE-35'), true);
    assert.equal(calcularDigitosVerificadores('12ABC34501DE'), '35');
    assert.equal(cnpjValido('12abc34501de35'), true, 'minúsculas são normalizadas');
  });

  it('rejeita DV errado, sequência repetida, tamanho errado e letra no DV', () => {
    assert.equal(cnpjValido('11222333000182'), false);
    assert.equal(cnpjValido('00000000000000'), false);
    assert.equal(cnpjValido('1122233300018'), false);
    assert.equal(cnpjValido('12ABC34501DE3A'), false);
  });

  it('normaliza máscara', () => {
    assert.equal(normalizarCnpj('12.abc.345/01de-35'), '12ABC34501DE35');
  });
});

const baseEquip = (sobrescrever: Partial<DadosEquipamento> = {}): DadosEquipamento => ({
  id: 'e1',
  codigoBarrasInterno: 'GCNB0000000017',
  tipo: 'NOTEBOOK',
  marca: 'Dell',
  modelo: 'X',
  anoFabricacao: 2022,
  estadoFisico: 'BOM_ESTADO',
  pesoQuilogramas: 2,
  loteId: 'l1',
  posicaoNoLote: 1,
  statusRastreamento: 'AGUARDANDO_TRIAGEM',
  versao: 0,
  ...sobrescrever,
});

describe('Equipamento - estado físico', () => {
  it('exige justificativa a partir de 2 categorias de queda', () => {
    assert.equal(exigeJustificativaEstado('NOVO', 'BOM_ESTADO'), false);
    assert.equal(exigeJustificativaEstado('NOVO', 'USADO_LEVE'), true);
    assert.equal(exigeJustificativaEstado('NOVO', 'INSERVIVEL'), true);
    assert.equal(exigeJustificativaEstado('INSERVIVEL', 'NOVO'), false, 'melhora não exige');
  });

  it('bloqueia queda de 2+ sem justificativa e aceita com justificativa', () => {
    const e = Equipamento.restaurar(baseEquip({ estadoFisico: 'NOVO' }));
    assert.throws(() => e.alterarEstadoFisico('USADO_MODERADO'), ErroValidacao);
    assert.throws(() => e.alterarEstadoFisico('USADO_MODERADO', '   '), ErroValidacao);
    e.alterarEstadoFisico('USADO_MODERADO', 'Carcaça trincada');
    assert.equal(e.estadoFisico, 'USADO_MODERADO');
  });
});

describe('Equipamento - máquina de estados', () => {
  it('não permite pular a triagem', () => {
    const e = Equipamento.restaurar(baseEquip());
    assert.throws(() => e.atualizarStatus('EM_DESMONTE', undefined, 'TRIAGEM_CONCLUIDA'), ErroRegraNegocio);
  });

  it('desmonte só após a triagem completa do lote', () => {
    const e = Equipamento.restaurar(baseEquip({ statusRastreamento: 'AGUARDANDO_DESMONTE' }));
    assert.throws(() => e.atualizarStatus('EM_DESMONTE', undefined, 'EM_TRIAGEM'), /triagem completa/);
    assert.deepEqual(e.atualizarStatus('EM_DESMONTE', undefined, 'TRIAGEM_CONCLUIDA'), {
      origem: 'AGUARDANDO_DESMONTE',
      destino: 'EM_DESMONTE',
    });
  });

  it('descarte direto na triagem só para DANIFICADO_GRAVE/INSERVIVEL e com justificativa', () => {
    const bom = Equipamento.restaurar(baseEquip({ statusRastreamento: 'EM_TRIAGEM' }));
    assert.throws(() => bom.atualizarStatus('DESCARTE_SEGURO', 'x', 'EM_TRIAGEM'), ErroRegraNegocio);
    const ruim = Equipamento.restaurar(baseEquip({ statusRastreamento: 'EM_TRIAGEM', estadoFisico: 'INSERVIVEL' }));
    assert.throws(() => ruim.atualizarStatus('DESCARTE_SEGURO', undefined, 'EM_TRIAGEM'), ErroValidacao);
    ruim.atualizarStatus('DESCARTE_SEGURO', 'Corrosão', 'EM_TRIAGEM');
  });

  it('BAIXA_DEFINITIVA é terminal', () => {
    const e = Equipamento.restaurar(baseEquip({ statusRastreamento: 'BAIXA_DEFINITIVA' }));
    assert.throws(() => e.atualizarStatus('EM_TRIAGEM', undefined, 'FINALIZADO'), ErroRegraNegocio);
  });
});

describe('Equipamento - depreciação e código de barras', () => {
  it('depreciação combina idade e estado físico', () => {
    const ref = new Date('2026-06-01');
    const novo = Equipamento.restaurar(baseEquip({ anoFabricacao: 2026, estadoFisico: 'NOVO' }));
    assert.equal(novo.calcularDepreciacao(ref), 0);
    const velho = Equipamento.restaurar(baseEquip({ anoFabricacao: 2015, estadoFisico: 'NOVO' }));
    assert.equal(velho.calcularDepreciacao(ref), 1);
    const meiaVida = Equipamento.restaurar(baseEquip({ anoFabricacao: 2024, estadoFisico: 'USADO_LEVE' }));
    // residual = (1 - 2/5) * 0.8 = 0.48 -> depreciado 0.52
    assert.equal(meiaVida.calcularDepreciacao(ref), 0.52);
  });

  it('gera código com dígito verificador válido', () => {
    const codigo = gerarCodigoBarras('NOTEBOOK', 123);
    assert.match(codigo, /^GCNB000000123\d$/);
    assert.equal(codigoBarrasValido(codigo), true);
    assert.equal(codigoBarrasValido(codigo.slice(0, -1) + ((Number(codigo.at(-1)) + 1) % 10)), false);
  });

  it('valida dados de cadastro', () => {
    const agora = new Date('2026-10-18');
    assert.throws(() => Equipamento.validarNovo({ anoFabricacao: 2027, pesoQuilogramas: 1, marca: 'a', modelo: 'b' }, agora), ErroValidacao);
    assert.throws(() => Equipamento.validarNovo({ anoFabricacao: 2020, pesoQuilogramas: 0, marca: 'a', modelo: 'b' }, agora), ErroValidacao);
  });
});

describe('Lote', () => {
  const agora = new Date('2026-10-18T12:00:00Z');
  const DIA = 86_400_000;

  it('data de entrada: nem futura, nem mais de 90 dias atrás', () => {
    validarDataEntrada(new Date(agora.getTime() - 90 * DIA + 60_000), agora);
    assert.throws(() => validarDataEntrada(new Date(agora.getTime() + DIA), agora), /futuro/);
    assert.throws(() => validarDataEntrada(new Date(agora.getTime() - 91 * DIA), agora), /90 dias/);
  });

  it('não conclui triagem com equipamento pendente', () => {
    const lote = Lote.restaurar({ id: 'l', organizacaoId: 'o', statusProcessamento: 'EM_TRIAGEM', versao: 0 }, [
      { statusRastreamento: 'AGUARDANDO_DESMONTE', pesoQuilogramas: 1 },
      { statusRastreamento: 'EM_TRIAGEM', pesoQuilogramas: 1 },
    ]);
    assert.throws(() => lote.avancarStatus('TRIAGEM_CONCLUIDA'), /1 equipamento/);
  });

  it('não finaliza sem baixa definitiva de todos e não pula etapas', () => {
    const lote = Lote.restaurar({ id: 'l', organizacaoId: 'o', statusProcessamento: 'ENCAMINHADO', versao: 0 }, [
      { statusRastreamento: 'MATERIAL_RECICLAVEL', pesoQuilogramas: 1 },
    ]);
    assert.throws(() => lote.avancarStatus('FINALIZADO'), /baixa definitiva/);
    const recebido = Lote.restaurar({ id: 'l', organizacaoId: 'o', statusProcessamento: 'RECEBIDO', versao: 0 }, []);
    assert.throws(() => recebido.avancarStatus('FINALIZADO'), ErroRegraNegocio);
  });

  it('lote não pode ficar vazio e peso total é somado', () => {
    const lote = Lote.restaurar({ id: 'l', organizacaoId: 'o', statusProcessamento: 'RECEBIDO', versao: 0 }, [
      { statusRastreamento: 'AGUARDANDO_TRIAGEM', pesoQuilogramas: 1.1 },
    ]);
    assert.throws(() => lote.garantirPodeRemoverEquipamento(), /ao menos um/);
    assert.equal(lote.calcularPesoTotal(), 1.1);
  });
});

describe('Contrato', () => {
  const dados = {
    dataAssinatura: '2026-01-01',
    dataVencimento: '2026-12-31',
    clausulas: ['Coleta mensal'],
    valorMensal: '1500.00',
    renovacaoAutomatica: false,
  };

  it('vigência considera datas de calendário (inclusive o último dia)', () => {
    const c = Contrato.criar(dados);
    assert.equal(c.estaVigente('2026-12-31'), true);
    assert.equal(c.estaVigente('2027-01-01'), false);
  });

  it('"hoje" é calculado no fuso de Brasília, não em UTC', () => {
    // 31/12 às 23h em Brasília = 01/01 02h UTC
    assert.equal(dataCalendario(new Date('2027-01-01T02:00:00Z')), '2026-12-31');
  });

  it('renovação exige vencimento posterior e datas válidas', () => {
    const c = Contrato.criar(dados);
    assert.throws(() => c.renovar('2026-06-01'), ErroRegraNegocio);
    c.renovar('2027-12-31');
    assert.equal(c.valores.dataVencimento, '2027-12-31');
    assert.throws(() => paraDataSemHora('2026-02-30'), ErroValidacao);
  });

  it('rejeita período invertido, valor inválido e contrato sem cláusulas', () => {
    assert.throws(() => Contrato.criar({ ...dados, dataVencimento: '2025-01-01' }), ErroValidacao);
    assert.throws(() => Contrato.criar({ ...dados, valorMensal: '-1' }), ErroValidacao);
    assert.throws(() => Contrato.criar({ ...dados, clausulas: ['  '] }), ErroValidacao);
  });
});

describe('Senhas', () => {
  it('bcrypt: gera e verifica', async () => {
    const hash = await gerarHashSenha('Senha123');
    assert.match(hash, /^\$2[aby]\$12\$/);
    assert.deepEqual(await verificarSenha('Senha123', hash), { valida: true, precisaRehash: false });
    assert.equal((await verificarSenha('errada1', hash)).valida, false);
  });

  it('hash legado SHA-256 do CLI é aceito e marcado para rehash', async () => {
    const legado = gerarHashLegadoSha256('Legado@2026', 'abc123');
    assert.deepEqual(await verificarSenha('Legado@2026', legado), { valida: true, precisaRehash: true });
    assert.deepEqual(await verificarSenha('outra', legado), { valida: false, precisaRehash: false });
  });

  it('política de força de senha', () => {
    assert.throws(() => validarForcaSenha('curta1'), ErroValidacao);
    assert.throws(() => validarForcaSenha('semnumeros'), ErroValidacao);
    validarForcaSenha('Valida123');
  });
});

describe('Autorização', () => {
  const auditor: Ator = { id: '1', usuario: 'aud', papel: 'AUDITOR' };

  it('auditor só lê e gera relatórios', () => {
    assert.equal(possuiPermissao('AUDITOR', 'lote:ler'), true);
    assert.equal(possuiPermissao('AUDITOR', 'relatorio:gerar'), true);
    assert.equal(possuiPermissao('AUDITOR', 'lote:escrever'), false);
    assert.throws(() => exigirPermissao(auditor, 'organizacao:escrever'), ErroSemPermissao);
  });

  it('segregação entre operador de cadastro e gestor de almoxarifado', () => {
    assert.equal(possuiPermissao('OPERADOR_CADASTRO', 'organizacao:escrever'), true);
    assert.equal(possuiPermissao('OPERADOR_CADASTRO', 'lote:escrever'), false);
    assert.equal(possuiPermissao('GESTOR_ALMOXARIFADO', 'lote:escrever'), true);
    assert.equal(possuiPermissao('GESTOR_ALMOXARIFADO', 'organizacao:escrever'), false);
  });

  it('sem ator = não autenticado', () => {
    assert.throws(() => exigirPermissao(undefined, 'lote:ler'), ErroNaoAutenticado);
  });
});
