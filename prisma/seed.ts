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
import type { StatusRastreamento } from '../src/generated/prisma/enums.js';

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

  console.log('\nSeed concluído. Credenciais de DESENVOLVIMENTO (troque em produção):');
  console.log('  admin/Admin@2026  cadastro/Cadastro@2026  almoxarifado/Almox@2026  auditor/Auditor@2026  legado/Legado@2026');
}

main()
  .catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
