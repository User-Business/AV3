/**
 * Seed de desenvolvimento: `npm run db:seed` (ou `npx prisma db seed`).
 *
 * Os dados NÃO são inseridos direto nas tabelas: passam pelos mesmos serviços
 * que a API usa. Assim o seed também funciona como verificação de que as regras
 * de negócio do CLI foram transportadas para a nova arquitetura - inclusive os
 * cenários que DEVEM ser rejeitados (seção "cenários de validação").
 */
import 'dotenv/config';
import { criarServicos } from '../src/app.js';
import { carregarConfiguracao } from '../src/config.js';
import { criarPrismaClient } from '../src/database.js';
import { ATOR_SISTEMA, type Ator } from '../src/domain/autorizacao.js';
import { calcularDigitosVerificadores } from '../src/domain/cnpj.js';
import { dataCalendario } from '../src/domain/contrato.js';
import { ErroDominio } from '../src/domain/erros.js';
import { gerarHashLegadoSha256, gerarHashSenha } from '../src/domain/senha.js';
import type { DadosNovoEquipamento } from '../src/services/lote.service.js';
import type { EstadoFisico, StatusRastreamento, TipoEquipamento } from '../src/generated/prisma/enums.js';
import { ajustarModelosVidaUtil, idadeEmAnos, nivelEstado } from '../src/domain/analises.js';
import { ORDEM_ESTADO_FISICO, gerarCodigoBarras } from '../src/domain/equipamento.js';

const config = carregarConfiguracao({ ...process.env, JWT_SECRET: process.env.JWT_SECRET ?? 'x'.repeat(32) });
const prisma = criarPrismaClient(config.databaseUrl);
const s = criarServicos(prisma);

const DIA = 24 * 60 * 60 * 1000;
const diasAtras = (n: number) => new Date(Date.now() - n * DIA).toISOString();
const dataRelativa = (n: number) => dataCalendario(new Date(Date.now() + n * DIA));
const cnpj = (base12: string) => base12 + calcularDigitosVerificadores(base12);

async function main() {
  if ((await prisma.usuario.count()) > 0) {
    console.log('Banco já populado. Use `npm run db:reset` para recriar do zero.');
    return;
  }

  // ------------------------------------------------------------- usuários
  // O primeiro administrador é criado direto (equivale ao provisionamento
  // inicial do CLI); os demais passam pelo serviço, com o admin como ator.
  const admin = await prisma.usuario.create({
    data: { usuario: 'admin', hashSenha: await gerarHashSenha('Admin@2026'), papel: 'ADMINISTRADOR' },
  });
  const ator: Ator = { id: admin.id, usuario: admin.usuario, papel: admin.papel };

  await s.autenticacao.criarUsuario(ator, { usuario: 'cadastro', senha: 'Cadastro@2026', papel: 'OPERADOR_CADASTRO' });
  await s.autenticacao.criarUsuario(ator, { usuario: 'almoxarifado', senha: 'Almox@2026', papel: 'GESTOR_ALMOXARIFADO' });
  await s.autenticacao.criarUsuario(ator, { usuario: 'auditor', senha: 'Auditor@2026', papel: 'AUDITOR' });
  // Usuário "migrado" do CLI com hash SHA-256: no primeiro login vira bcrypt
  await prisma.usuario.create({
    data: { usuario: 'legado', hashSenha: gerarHashLegadoSha256('Legado@2026'), papel: 'AUDITOR' },
  });
  console.log('✔ usuários: admin, cadastro, almoxarifado, auditor, legado (hash SHA-256 do CLI)');

  // -------------------------------------------------------- organizações
  const contratoVigente = (valor: string) => ({
    dataAssinatura: dataRelativa(-200),
    dataVencimento: dataRelativa(165),
    clausulas: [
      'Coleta mensal de equipamentos obsoletos nas unidades do cliente',
      'Emissão de certificado de destinação ambientalmente adequada (PNRS)',
      'Relatório trimestral de rastreabilidade',
    ],
    valorMensal: valor,
    renovacaoAutomatica: true,
  });

  await s.organizacao.cadastrar(ator, {
    codigo: 'BR001',
    razaoSocial: 'Banco Horizonte S.A.',
    cnpj: cnpj('112223330001'),
    inscricaoEstadual: 'ISENTO',
    enderecoCompleto: 'Av. Paulista, 1000 - Bela Vista, São Paulo/SP',
    telefone: '(11) 3000-1000',
    email: 'patrimonio@bancohorizonte.com.br',
    contrato: contratoVigente('12500.00'),
  });
  // CNPJ alfanumérico (formato emitido pela Receita a partir de julho/2026)
  await s.organizacao.cadastrar(ator, {
    codigo: 'BR002',
    razaoSocial: 'Hospital Santa Clara Ltda.',
    cnpj: cnpj('12ABC34501DE'),
    enderecoCompleto: 'Rua das Acácias, 250 - Centro, Belo Horizonte/MG',
    email: 'ti@hsantaclara.org.br',
    contrato: contratoVigente('4800.00'),
  });
  await s.organizacao.cadastrar(ator, {
    codigo: 'BR003',
    razaoSocial: 'Universidade Federal do Vale',
    cnpj: cnpj('334445550001'),
    enderecoCompleto: 'Campus Universitário, s/n - Petrolina/PE',
    email: 'almoxarifado@ufvale.edu.br',
    contrato: { ...contratoVigente('3200.00'), dataAssinatura: dataRelativa(-400), dataVencimento: dataRelativa(-30) },
  });
  await s.organizacao.cadastrar(ator, {
    codigo: 'BR004',
    razaoSocial: 'Varejo Bom Preço Ltda.',
    cnpj: cnpj('556667770001'),
    enderecoCompleto: 'Rua do Comércio, 45 - Centro, Curitiba/PR',
    email: 'compras@bompreco.com.br',
  });
  const inativa = await s.organizacao.cadastrar(ator, {
    codigo: 'BR005',
    razaoSocial: 'Telecom Antiga S.A.',
    cnpj: cnpj('778889990001'),
    enderecoCompleto: 'Av. das Comunicações, 900 - Recife/PE',
    email: 'contato@telecomantiga.com.br',
    contrato: contratoVigente('1000.00'),
  });
  await s.organizacao.desativar(ator, inativa.id, inativa.versao);
  console.log('✔ organizações: BR001 e BR002 (vigentes, BR002 com CNPJ alfanumérico), BR003 (vencido), BR004 (sem contrato), BR005 (inativa)');

  // ---------------------------------------------------------------- lotes
  const eq = (
    tipo: DadosNovoEquipamento['tipo'],
    marca: string,
    modelo: string,
    ano: number,
    estado: DadosNovoEquipamento['estadoFisico'],
    peso: number,
  ): DadosNovoEquipamento => ({ tipo, marca, modelo, anoFabricacao: ano, estadoFisico: estado, pesoQuilogramas: peso });

  // Lote 1: apenas recebido
  await s.lote.criar(ator, {
    organizacao: 'BR001',
    notaFiscal: 'NF-2026-000101',
    transportadora: 'TransRapida',
    dataEntrada: diasAtras(60),
    observacoes: 'Renovação do parque de terminais da agência central',
    equipamentos: [
      eq('COMPUTADOR_MESA', 'Dell', 'OptiPlex 7070', 2019, 'USADO_MODERADO', 6.8),
      eq('COMPUTADOR_MESA', 'Dell', 'OptiPlex 7070', 2019, 'USADO_LEVE', 6.8),
      eq('MONITOR', 'LG', '24MK430H', 2020, 'BOM_ESTADO', 3.1),
      eq('IMPRESSORA', 'HP', 'LaserJet M404', 2018, 'DANIFICADO_LEVE', 8.6),
    ],
  });

  // Lote 2: triagem concluída e desmonte em andamento
  let lote2 = await s.lote.criar(ator, {
    organizacao: 'BR001',
    notaFiscal: 'NF-2026-000187',
    transportadora: 'LogVerde',
    dataEntrada: diasAtras(30),
    equipamentos: [
      eq('NOTEBOOK', 'Lenovo', 'ThinkPad T480', 2018, 'USADO_MODERADO', 1.6),
      eq('NOTEBOOK', 'Lenovo', 'ThinkPad T480', 2018, 'DANIFICADO_GRAVE', 1.6),
      eq('SERVIDOR', 'Dell', 'PowerEdge R740', 2017, 'USADO_LEVE', 28.5),
      eq('ROTEADOR', 'Cisco', 'ISR 4331', 2016, 'INSERVIVEL', 5.2),
      eq('FONTE_ALIMENTACAO', 'APC', 'Back-UPS 1500', 2015, 'USADO_MODERADO', 12.0),
    ],
  });
  lote2 = await s.lote.alterarStatus(ator, lote2.id, lote2.versao, 'EM_TRIAGEM');
  const [nb1, nb2, srv, rot, fonte] = lote2.equipamentos;
  const versoes = new Map(lote2.equipamentos.map((e) => [e.id, e.versao]));
  const mover = async (id: string, status: StatusRastreamento, justificativa?: string) => {
    const r = await s.equipamento.atualizarStatus(ator, id, versoes.get(id)!, status, justificativa);
    versoes.set(id, r.versao);
  };
  await mover(nb1!.id, 'AGUARDANDO_DESMONTE');
  await mover(nb2!.id, 'AGUARDANDO_DESMONTE');
  await mover(srv!.id, 'AGUARDANDO_DESMONTE');
  await mover(rot!.id, 'DESCARTE_SEGURO', 'Placa-mãe com corrosão severa; sem componentes aproveitáveis');
  await mover(fonte!.id, 'AGUARDANDO_DESMONTE');
  lote2 = await s.lote.buscar(ator, lote2.id);
  lote2 = await s.lote.alterarStatus(ator, lote2.id, lote2.versao, 'TRIAGEM_CONCLUIDA');
  await mover(nb1!.id, 'EM_DESMONTE');
  await mover(nb1!.id, 'PECAS_REAPROVEITADAS', 'Memória RAM e SSD aprovados no teste');
  await mover(srv!.id, 'EM_DESMONTE');
  await mover(srv!.id, 'MATERIAL_RECICLAVEL');

  // Lote 3: ciclo completo até FINALIZADO
  let lote3 = await s.lote.criar(ator, {
    organizacao: 'BR002',
    notaFiscal: '000.452.118',
    transportadora: 'TransRapida',
    dataEntrada: diasAtras(10),
    equipamentos: [
      eq('MONITOR', 'Samsung', 'S22F350', 2016, 'DANIFICADO_LEVE', 2.9),
      eq('CABO_ESTRUTURADO', 'Furukawa', 'Cat6 305m', 2014, 'USADO_MODERADO', 10.5),
      eq('COMPUTADOR_MESA', 'Positivo', 'Master D580', 2017, 'INSERVIVEL', 5.9),
    ],
  });
  lote3 = await s.lote.alterarStatus(ator, lote3.id, lote3.versao, 'EM_TRIAGEM');
  for (const e of lote3.equipamentos) versoes.set(e.id, e.versao);
  const [mon, cabo, pc] = lote3.equipamentos;
  await mover(mon!.id, 'AGUARDANDO_DESMONTE');
  await mover(cabo!.id, 'AGUARDANDO_DESMONTE');
  await mover(pc!.id, 'DESCARTE_SEGURO', 'Gabinete e placa com dano por umidade');
  lote3 = await s.lote.buscar(ator, lote3.id);
  lote3 = await s.lote.alterarStatus(ator, lote3.id, lote3.versao, 'TRIAGEM_CONCLUIDA');
  await mover(mon!.id, 'EM_DESMONTE');
  await mover(mon!.id, 'MATERIAL_RECICLAVEL');
  await mover(cabo!.id, 'EM_DESMONTE');
  await mover(cabo!.id, 'MATERIAL_RECICLAVEL');
  lote3 = await s.lote.alterarStatus(ator, lote3.id, lote3.versao, 'ENCAMINHADO');
  for (const e of [mon!, cabo!, pc!]) await mover(e.id, 'BAIXA_DEFINITIVA');
  lote3 = await s.lote.buscar(ator, lote3.id);
  await s.lote.alterarStatus(ator, lote3.id, lote3.versao, 'FINALIZADO');

  // Lote 4: em triagem, com reclassificação de estado físico justificada
  let lote4 = await s.lote.criar(ator, {
    organizacao: 'BR002',
    notaFiscal: '000.452.377',
    transportadora: 'EcoCargo',
    dataEntrada: diasAtras(2),
    equipamentos: [
      eq('NOTEBOOK', 'Apple', 'MacBook Air A2337', 2021, 'BOM_ESTADO', 1.3),
      eq('IMPRESSORA', 'Epson', 'EcoTank L3250', 2022, 'NOVO', 3.9),
    ],
  });
  lote4 = await s.lote.alterarStatus(ator, lote4.id, lote4.versao, 'EM_TRIAGEM');
  const mac = lote4.equipamentos[0]!;
  await s.equipamento.atualizarEstadoFisico(
    ator, mac.id, mac.versao, 'DANIFICADO_LEVE',
    'Tela trincada identificada na triagem (queda de 3 categorias)',
  );
  console.log('✔ lotes: RECEBIDO, TRIAGEM_CONCLUIDA (desmonte em andamento), FINALIZADO e EM_TRIAGEM');

  // ------------------------------------------------- cenários de validação
  const deveFalhar = async (descricao: string, acao: () => Promise<unknown>) => {
    try {
      await acao();
      throw new Error(`ERA PARA FALHAR: ${descricao}`);
    } catch (erro) {
      if (!(erro instanceof ErroDominio)) throw erro;
      console.log(`  ✔ rejeitado (${erro.codigo}): ${descricao} -> ${erro.message}`);
    }
  };
  console.log('Cenários de validação (todos devem ser rejeitados):');
  const umEquip = [eq('MONITOR', 'AOC', 'X', 2020, 'BOM_ESTADO', 3)];
  await deveFalhar('lote para organização com contrato vencido', () =>
    s.lote.criar(ator, { organizacao: 'BR003', notaFiscal: 'X1', transportadora: 'T', dataEntrada: diasAtras(1), equipamentos: umEquip }));
  await deveFalhar('lote para organização sem contrato', () =>
    s.lote.criar(ator, { organizacao: 'BR004', notaFiscal: 'X2', transportadora: 'T', dataEntrada: diasAtras(1), equipamentos: umEquip }));
  await deveFalhar('lote para organização inativa', () =>
    s.lote.criar(ator, { organizacao: 'BR005', notaFiscal: 'X3', transportadora: 'T', dataEntrada: diasAtras(1), equipamentos: umEquip }));
  await deveFalhar('data de entrada futura', () =>
    s.lote.criar(ator, { organizacao: 'BR001', notaFiscal: 'X4', transportadora: 'T', dataEntrada: diasAtras(-2), equipamentos: umEquip }));
  await deveFalhar('data de entrada há mais de 90 dias', () =>
    s.lote.criar(ator, { organizacao: 'BR001', notaFiscal: 'X5', transportadora: 'T', dataEntrada: diasAtras(91), equipamentos: umEquip }));
  await deveFalhar('nota fiscal repetida para a mesma organização', () =>
    s.lote.criar(ator, { organizacao: 'BR001', notaFiscal: 'NF-2026-000101', transportadora: 'T', dataEntrada: diasAtras(1), equipamentos: umEquip }));
  await deveFalhar('CNPJ com dígito verificador errado', () =>
    s.organizacao.cadastrar(ator, { codigo: 'BR999', razaoSocial: 'Teste', cnpj: '11222333000182', enderecoCompleto: 'Rua Teste, 123 - Centro', email: 'a@b.com' }));
  await deveFalhar('CNPJ duplicado', () =>
    s.organizacao.cadastrar(ator, { codigo: 'BR998', razaoSocial: 'Teste', cnpj: cnpj('112223330001'), enderecoCompleto: 'Rua Teste, 123 - Centro', email: 'a@b.com' }));
  // A impressora já foi classificada para desmonte, mas o LOTE ainda está EM_TRIAGEM
  const impressora = await s.equipamento.atualizarStatus(
    ator, lote4.equipamentos[1]!.id, lote4.equipamentos[1]!.versao, 'AGUARDANDO_DESMONTE',
  );
  await deveFalhar('desmonte antes da triagem completa do lote', () =>
    s.equipamento.atualizarStatus(ator, impressora.id, impressora.versao, 'EM_DESMONTE'));
  await deveFalhar('queda de 2+ categorias de estado físico sem justificativa', async () => {
    const imp = (await s.lote.buscar(ator, lote4.id)).equipamentos[1]!;
    return s.equipamento.atualizarEstadoFisico(ator, imp.id, imp.versao, 'USADO_LEVE');
  });
  await deveFalhar('auditor tentando criar lote (sem permissão)', () =>
    s.lote.criar({ ...ATOR_SISTEMA, papel: 'AUDITOR' }, { organizacao: 'BR001', notaFiscal: 'X6', transportadora: 'T', dataEntrada: diasAtras(1), equipamentos: umEquip }));

  await popularHistoricoAnalitico(ator);

  console.log('\nSeed concluído. Credenciais de DESENVOLVIMENTO (troque em produção):');
  console.log('  admin/Admin@2026  cadastro/Cadastro@2026  almoxarifado/Almox@2026  auditor/Auditor@2026  legado/Legado@2026');
  console.log('  almox.ana / almox.bruno / almox.carla com senha Almox@2026');
}

// =============================================================================
// Atividade 3: histórico para a camada analítica e parceiro da API pública
// =============================================================================

/** Gerador pseudoaleatório com semente fixa: o seed produz sempre os mesmos dados. */
function criarAleatorio(semente: number) {
  let estado = semente;
  const proximo = () => {
    estado = (estado * 1103515245 + 12345) % 2147483648;
    return estado / 2147483648;
  };
  return {
    proximo,
    inteiro: (min: number, max: number) => Math.floor(proximo() * (max - min + 1)) + min,
    escolher: <T>(lista: readonly T[]): T => lista[Math.floor(proximo() * lista.length)]!,
  };
}

const CATALOGO: Record<TipoEquipamento, { modelos: [string, string][]; peso: [number, number]; degradacaoAnual: number; valorBase: number }> = {
  COMPUTADOR_MESA: { modelos: [['Dell', 'OptiPlex 7070'], ['HP', 'ProDesk 400'], ['Lenovo', 'ThinkCentre M720']], peso: [6, 9], degradacaoAnual: 0.75, valorBase: 180 },
  NOTEBOOK: { modelos: [['Lenovo', 'ThinkPad T480'], ['Dell', 'Latitude 5490'], ['HP', 'EliteBook 840']], peso: [1.4, 2.4], degradacaoAnual: 0.95, valorBase: 260 },
  MONITOR: { modelos: [['LG', '24MK430H'], ['Samsung', 'S22F350'], ['Dell', 'P2419H']], peso: [3, 5], degradacaoAnual: 0.6, valorBase: 70 },
  IMPRESSORA: { modelos: [['HP', 'LaserJet M404'], ['Brother', 'HL-L2350'], ['Epson', 'EcoTank L3250']], peso: [4, 12], degradacaoAnual: 1.0, valorBase: 45 },
  SERVIDOR: { modelos: [['Dell', 'PowerEdge R740'], ['HPE', 'ProLiant DL380'], ['Lenovo', 'ThinkSystem SR650']], peso: [18, 30], degradacaoAnual: 0.55, valorBase: 950 },
  ROTEADOR: { modelos: [['Cisco', 'ISR 4331'], ['MikroTik', 'RB4011'], ['TP-Link', 'ER605']], peso: [0.8, 5.5], degradacaoAnual: 0.7, valorBase: 60 },
  CABO_ESTRUTURADO: { modelos: [['Furukawa', 'Cat6 305m'], ['Nexans', 'Cat5e 305m']], peso: [9, 11], degradacaoAnual: 0.5, valorBase: 12 },
  FONTE_ALIMENTACAO: { modelos: [['APC', 'Back-UPS 1500'], ['Corsair', 'CV550'], ['SMS', 'Station II']], peso: [1, 12], degradacaoAnual: 0.85, valorBase: 25 },
};
const FATOR_VALOR: Record<EstadoFisico, number> = {
  NOVO: 1, BOM_ESTADO: 0.85, USADO_LEVE: 0.7, USADO_MODERADO: 0.55, DANIFICADO_LEVE: 0.4, DANIFICADO_GRAVE: 0.25, INSERVIVEL: 0.1,
};

/**
 * Lotes processados nos últimos 12 meses, importados como histórico. Ficam fora
 * da janela de 90 dias da regra de entrada (que vale para novos registros), por
 * isso são gravados direto no banco - mas respeitando CHECKs e triggers.
 */
async function popularHistoricoAnalitico(ator: Ator) {
  const aleatorio = criarAleatorio(20261123);
  const operadores = ['almox.ana', 'almox.bruno', 'almox.carla'];
  for (const usuario of operadores) {
    await s.autenticacao.criarUsuario(ator, { usuario, senha: 'Almox@2026', papel: 'GESTOR_ALMOXARIFADO' });
  }
  // Ritmo médio de triagem (horas) por operador; almox.bruno é o gargalo proposital
  const ritmo: Record<string, number> = { 'almox.ana': 28, 'almox.bruno': 72, 'almox.carla': 40 };
  const organizacoes = await prisma.organizacao.findMany({ where: { codigo: { in: ['BR001', 'BR002'] } } });
  const tipos = Object.keys(CATALOGO) as TipoEquipamento[];
  const agora = Date.now();
  let equipamentos = 0;

  for (let i = 0; i < 40; i++) {
    const org = organizacoes[i % organizacoes.length]!;
    const operador = aleatorio.escolher(operadores);
    const dataEntrada = new Date(agora - aleatorio.inteiro(95, 365) * DIA);
    const inicioTriagem = new Date(dataEntrada.getTime() + aleatorio.inteiro(1, 6) * 3_600_000);
    const conclusao = new Date(inicioTriagem.getTime() + ritmo[operador]! * (0.6 + aleatorio.proximo() * 0.8) * 3_600_000);

    const itens = [];
    for (let p = 1; p <= aleatorio.inteiro(6, 12); p++) {
      const tipo = aleatorio.escolher(tipos);
      const catalogo = CATALOGO[tipo];
      const [marca, modelo] = aleatorio.escolher(catalogo.modelos);
      const anoFabricacao = aleatorio.inteiro(2016, 2025);
      const idade = Math.max(0, (dataEntrada.getTime() - Date.UTC(anoFabricacao, 6, 1)) / (365.25 * DIA));
      const nivelEntrada = Math.min(6, Math.max(0, Math.round(catalogo.degradacaoAnual * idade + (aleatorio.proximo() - 0.5) * 1.6)));
      // Parte dos equipamentos é reavaliada na triagem: mais pontos para a regressão
      const reavaliado = nivelEntrada < 6 && aleatorio.proximo() < 0.4;
      const nivelFinal = reavaliado ? Math.min(6, nivelEntrada + aleatorio.inteiro(1, 2)) : nivelEntrada;
      const estadoEntrada = ORDEM_ESTADO_FISICO[nivelEntrada]!;
      const estadoFinal = ORDEM_ESTADO_FISICO[nivelFinal]!;

      let status: StatusRastreamento = 'AGUARDANDO_DESMONTE';
      if (estadoFinal === 'INSERVIVEL' || estadoFinal === 'DANIFICADO_GRAVE') status = 'DESCARTE_SEGURO';
      else {
        const sorteio = aleatorio.proximo();
        status = sorteio < 0.4 ? 'PECAS_REAPROVEITADAS' : sorteio < 0.8 ? 'MATERIAL_RECICLAVEL' : 'AGUARDANDO_DESMONTE';
      }
      const valorRecuperado = status === 'PECAS_REAPROVEITADAS' || status === 'MATERIAL_RECICLAVEL'
        ? Math.round(catalogo.valorBase * FATOR_VALOR[estadoFinal] * (0.75 + aleatorio.proximo() * 0.5) * 100) / 100
        : null;

      const [{ valor }] = await prisma.$queryRaw<{ valor: bigint }[]>`SELECT nextval('equipamento_codigo_seq') AS valor` as [{ valor: bigint }];
      itens.push({
        codigoBarrasInterno: gerarCodigoBarras(tipo, Number(valor)),
        tipo,
        marca,
        modelo,
        anoFabricacao,
        estadoFisico: estadoFinal,
        pesoQuilogramas: Math.round((catalogo.peso[0] + aleatorio.proximo() * (catalogo.peso[1] - catalogo.peso[0])) * 1000) / 1000,
        posicaoNoLote: p,
        statusRastreamento: status,
        valorRecuperado,
        inservivelEm: estadoFinal === 'INSERVIVEL' ? (reavaliado ? conclusao : dataEntrada) : null,
        criadoEm: dataEntrada,
        historicoEstados: {
          create: [
            { dataHora: dataEntrada, estadoNovo: estadoEntrada, responsavel: 'importacao', justificativa: 'Estado na entrada' },
            ...(reavaliado
              ? [{ dataHora: conclusao, estadoAnterior: estadoEntrada, estadoNovo: estadoFinal, responsavel: operador, justificativa: 'Reavaliação técnica na triagem' }]
              : []),
          ],
        },
        movimentacoes: {
          create: [
            { dataHora: dataEntrada, origem: `ORGANIZACAO:${org.codigo}`, destino: 'AGUARDANDO_TRIAGEM', responsavel: 'importacao' },
            { dataHora: conclusao, origem: 'EM_TRIAGEM', destino: status, responsavel: operador },
          ],
        },
      });
    }

    await prisma.lote.create({
      data: {
        organizacaoId: org.id,
        dataEntrada,
        notaFiscal: `HIST-2026-${String(i + 1).padStart(4, '0')}`,
        transportadora: aleatorio.escolher(['TransRapida', 'LogVerde', 'EcoCargo']),
        observacoes: 'Histórico importado para a camada analítica',
        statusProcessamento: aleatorio.proximo() < 0.5 ? 'ENCAMINHADO' : 'TRIAGEM_CONCLUIDA',
        inicioTriagemEm: inicioTriagem,
        conclusaoTriagemEm: conclusao,
        responsavelTriagem: operador,
        criadoEm: dataEntrada,
        equipamentos: { create: itens },
      },
    });
    equipamentos += itens.length;
  }
  console.log(`✔ histórico analítico: 40 lotes e ${equipamentos} equipamentos dos últimos 12 meses (operadores almox.ana, almox.bruno, almox.carla)`);

  // Execução de vida útil "do passado" (só com dados até 180 dias atrás): base
  // para a comparação previsão x realização (GET /internal/analises/vida-util/acuracia)
  const corte = new Date(agora - 180 * DIA);
  const historicos = await prisma.historicoEstadoFisico.findMany({
    where: { dataHora: { lt: corte } },
    select: { dataHora: true, estadoNovo: true, equipamento: { select: { tipo: true, anoFabricacao: true } } },
  });
  const modelos = ajustarModelosVidaUtil(
    historicos.map((h) => ({
      tipo: h.equipamento.tipo,
      idadeAnos: idadeEmAnos(h.equipamento.anoFabricacao, h.dataHora),
      nivel: nivelEstado(h.estadoNovo),
    })),
  );
  await prisma.execucaoAnalise.create({
    data: {
      tipo: 'VIDA_UTIL',
      origem: 'AGENDADA',
      amostras: historicos.length,
      resumo: { observacao: 'Execução histórica (dados até 180 dias atrás)' },
      duracaoMs: 0,
      geradaEm: corte,
      previsoesVidaUtil: { create: modelos },
    },
  });
  const atuais = await s.analise.executarTodas('AGENDADA');
  console.log(`✔ análises: execução histórica de vida útil + ${atuais.length} execuções atuais (eficiência, rentabilidade, vida útil)`);

  // Parceiro de demonstração da API pública
  const parceiro = await s.chaveApi.criarParceiro(ator, { nome: 'Integração ERP Banco Horizonte', organizacao: 'BR001', plano: 'PROFISSIONAL' });
  const chave = await s.chaveApi.emitir(ator, parceiro.id, {
    escopos: ['RASTREABILIDADE_LEITURA', 'LOTES_LEITURA', 'LOTES_ESCRITA', 'ANALISES_LEITURA', 'RELATORIOS_SOLICITAR'],
    descricao: 'Chave de demonstração (seed)',
  });
  console.log(`✔ parceiro "${parceiro.nome}" (BR001, plano PROFISSIONAL)`);
  console.log(`  chave de API de DESENVOLVIMENTO (use em X-API-Key ou no botão Authorize do /docs):\n  ${chave.chave}`);
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
