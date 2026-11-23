/**
 * Contratos da API em JSON Schema (via TypeBox). O mesmo schema serve para:
 *  1. validar a entrada no Fastify (Ajv) antes de chegar ao controller;
 *  2. serializar a saída rapidamente (fast-json-stringify) e sem vazar campos;
 *  3. gerar a documentação OpenAPI/Swagger em /docs.
 */
import { Type, type Static, type TSchema } from 'typebox';
import {
  EstadoFisico,
  PapelUsuario,
  StatusLote,
  StatusRastreamento,
  TipoEquipamento,
} from '../generated/prisma/enums.js';

function enumDe<T extends Record<string, string>>(objeto: T, descricao?: string) {
  const valores = Object.values(objeto) as T[keyof T][];
  return Type.Unsafe<T[keyof T]>({ type: 'string', enum: valores, ...(descricao ? { description: descricao } : {}) });
}

const Nulavel = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

export const SPapel = enumDe(PapelUsuario);
export const SStatusLote = enumDe(StatusLote);
export const SStatusRastreamento = enumDe(StatusRastreamento);
export const STipoEquipamento = enumDe(TipoEquipamento);
export const SEstadoFisico = enumDe(EstadoFisico, 'Do melhor (NOVO) para o pior (INSERVIVEL)');

const SData = Type.String({ format: 'date', description: 'YYYY-MM-DD', examples: ['2026-01-31'] });
const SDataHora = Type.String({ format: 'date-time', examples: ['2026-10-01T14:30:00-03:00'] });
const SUuid = Type.String({ format: 'uuid' });
const SVersao = Type.Integer({
  minimum: 0,
  description: 'Versão lida do recurso (concorrência otimista). Se outra requisição alterou antes, a API responde 409.',
});
const SIdOuCodigo = Type.String({ minLength: 1, maxLength: 60, description: 'UUID ou código de negócio' });

// ------------------------------------------------------------------ erros
export const SErro = Type.Object(
  {
    erro: Type.Object({
      codigo: Type.String({ examples: ['REGRA_NEGOCIO'] }),
      mensagem: Type.String(),
      detalhes: Type.Optional(Type.Any()),
    }),
  },
  { $id: 'Erro', title: 'Erro' },
);

const respostasErro = {
  400: Type.Ref('Erro'),
  401: Type.Ref('Erro'),
  403: Type.Ref('Erro'),
  404: Type.Ref('Erro'),
  409: Type.Ref('Erro'),
  422: Type.Ref('Erro'),
};

// --------------------------------------------------------------- entidades
export const SUsuario = Type.Object({
  id: SUuid,
  usuario: Type.String(),
  papel: SPapel,
  ativo: Type.Boolean(),
  ultimoAcesso: Nulavel(SDataHora),
  versao: Type.Integer(),
});

export const SContratoEntrada = Type.Object({
  dataAssinatura: SData,
  dataVencimento: SData,
  clausulas: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 100 }),
  valorMensal: Type.String({ pattern: '^\\d{1,10}(\\.\\d{1,2})?$', description: 'Decimal em string, ex.: "1500.00"' }),
  renovacaoAutomatica: Type.Boolean({ default: false }),
});

export const SContrato = Type.Object({
  id: SUuid,
  organizacaoId: SUuid,
  dataAssinatura: SData,
  dataVencimento: SData,
  clausulas: Type.Array(Type.String()),
  valorMensal: Type.String(),
  renovacaoAutomatica: Type.Boolean(),
  vigente: Type.Boolean(),
  versao: Type.Integer(),
});

export const SOrganizacao = Type.Object({
  id: SUuid,
  codigo: Type.String(),
  razaoSocial: Type.String(),
  cnpj: Type.String(),
  inscricaoEstadual: Nulavel(Type.String()),
  enderecoCompleto: Type.String(),
  telefone: Nulavel(Type.String()),
  email: Type.String(),
  dataCadastro: SDataHora,
  ativo: Type.Boolean(),
  versao: Type.Integer(),
  contrato: Nulavel(SContrato),
});

export const SEquipamentoEntrada = Type.Object({
  tipo: STipoEquipamento,
  marca: Type.String({ minLength: 1, maxLength: 100 }),
  modelo: Type.String({ minLength: 1, maxLength: 100 }),
  anoFabricacao: Type.Integer({ minimum: 1970, maximum: 2100 }),
  estadoFisico: SEstadoFisico,
  pesoQuilogramas: Type.Number({ exclusiveMinimum: 0, maximum: 5000 }),
});

export const SEquipamento = Type.Object({
  id: SUuid,
  codigoBarrasInterno: Type.String(),
  tipo: STipoEquipamento,
  marca: Type.String(),
  modelo: Type.String(),
  anoFabricacao: Type.Integer(),
  estadoFisico: SEstadoFisico,
  pesoQuilogramas: Type.Number(),
  loteId: SUuid,
  posicaoNoLote: Type.Integer(),
  statusRastreamento: SStatusRastreamento,
  depreciacao: Type.Number({ description: 'Fração já depreciada (0 a 1)' }),
  valorRecuperado: Nulavel(Type.String({ description: 'Valor obtido na recuperação (decimal em string)' })),
  versao: Type.Integer(),
});

const SOrgResumo = Type.Object({ codigo: Type.String(), razaoSocial: Type.String() });

export const SLote = Type.Object({
  id: SUuid,
  organizacaoId: SUuid,
  organizacao: SOrgResumo,
  dataEntrada: SDataHora,
  notaFiscal: Type.String(),
  transportadora: Type.String(),
  statusProcessamento: SStatusLote,
  observacoes: Nulavel(Type.String()),
  inicioTriagemEm: Nulavel(SDataHora),
  conclusaoTriagemEm: Nulavel(SDataHora),
  responsavelTriagem: Nulavel(Type.String()),
  pesoTotalQuilogramas: Type.Number(),
  quantidadeEquipamentos: Type.Integer(),
  versao: Type.Integer(),
  equipamentos: Type.Array(SEquipamento),
});

export const SLoteResumo = Type.Object({
  id: SUuid,
  organizacao: SOrgResumo,
  dataEntrada: SDataHora,
  notaFiscal: Type.String(),
  transportadora: Type.String(),
  statusProcessamento: SStatusLote,
  quantidadeEquipamentos: Type.Integer(),
  versao: Type.Integer(),
});

export const SMovimentacao = Type.Object({
  id: SUuid,
  dataHora: SDataHora,
  origem: Type.String(),
  destino: Type.String(),
  responsavel: Type.String(),
  observacao: Nulavel(Type.String()),
});

export const SRastreio = Type.Object({
  equipamento: SEquipamento,
  lote: Type.Object({
    id: SUuid,
    notaFiscal: Type.String(),
    dataEntrada: SDataHora,
    statusProcessamento: SStatusLote,
  }),
  organizacao: Type.Object({ id: SUuid, codigo: Type.String(), razaoSocial: Type.String() }),
  movimentacoes: Type.Array(SMovimentacao),
  historicoEstadoFisico: Type.Array(
    Type.Object({
      dataHora: SDataHora,
      estadoAnterior: Nulavel(SEstadoFisico),
      estadoNovo: SEstadoFisico,
      justificativa: Nulavel(Type.String()),
      responsavel: Type.String(),
    }),
  ),
});

const SLivre = Type.Object({}, { additionalProperties: true });

// ------------------------------------------------------------ helpers
const autenticado = { security: [{ bearerAuth: [] }] };

/** Tipo do request derivado do schema da rota (body/params/querystring). */
export type Entrada<S> = {
  Body: S extends { body: infer B extends TSchema } ? Static<B> : unknown;
  Params: S extends { params: infer P extends TSchema } ? Static<P> : unknown;
  Querystring: S extends { querystring: infer Q extends TSchema } ? Static<Q> : unknown;
};

const ParamId = Type.Object({ id: SIdOuCodigo });
const ParamUuid = Type.Object({ id: SUuid });

// ======================================================================
// Rotas
// ======================================================================

export const rotasAuth = {
  login: {
    tags: ['Autenticação'],
    summary: 'Autentica e devolve um JWT (expira em 30 minutos)',
    body: Type.Object({
      usuario: Type.String({ minLength: 1, maxLength: 60, examples: ['admin'] }),
      senha: Type.String({ minLength: 1, maxLength: 200, examples: ['Admin@2026'] }),
    }),
    response: {
      200: Type.Object({ token: Type.String(), tipo: Type.Literal('Bearer'), expiraEm: Type.String(), usuario: Type.String(), papel: SPapel }),
      400: Type.Ref('Erro'),
      401: Type.Ref('Erro'),
    },
  },
  renovar: {
    tags: ['Autenticação'],
    summary: 'Emite um novo token com nova expiração',
    ...autenticado,
    response: {
      200: Type.Object({ token: Type.String(), tipo: Type.Literal('Bearer'), expiraEm: Type.String(), usuario: Type.String(), papel: SPapel }),
      401: Type.Ref('Erro'),
    },
  },
  logout: {
    tags: ['Autenticação'],
    summary: 'Revoga TODOS os tokens do usuário',
    ...autenticado,
    response: { 204: Type.Null(), 401: Type.Ref('Erro') },
  },
  eu: {
    tags: ['Autenticação'],
    summary: 'Dados do usuário autenticado',
    ...autenticado,
    response: { 200: Type.Object({ id: SUuid, usuario: Type.String(), papel: SPapel }), 401: Type.Ref('Erro') },
  },
  alterarSenha: {
    tags: ['Autenticação'],
    summary: 'Altera a própria senha (revoga os tokens existentes)',
    ...autenticado,
    body: Type.Object({
      senhaAtual: Type.String({ minLength: 1, maxLength: 200 }),
      senhaNova: Type.String({ minLength: 8, maxLength: 72 }),
    }),
    response: { 204: Type.Null(), ...respostasErro },
  },
  criarUsuario: {
    tags: ['Usuários'],
    summary: 'Cria usuário (ADMINISTRADOR)',
    ...autenticado,
    body: Type.Object({
      usuario: Type.String({ minLength: 3, maxLength: 60 }),
      senha: Type.String({ minLength: 8, maxLength: 72 }),
      papel: SPapel,
    }),
    response: { 201: SUsuario, ...respostasErro },
  },
  listarUsuarios: {
    tags: ['Usuários'],
    summary: 'Lista usuários (ADMINISTRADOR)',
    ...autenticado,
    response: { 200: Type.Array(SUsuario), ...respostasErro },
  },
};

export const rotasOrganizacao = {
  cadastrar: {
    tags: ['Organizações'],
    summary: 'Cadastra organização (com contrato opcional, na mesma transação)',
    ...autenticado,
    body: Type.Object({
      codigo: Type.String({ pattern: '^[A-Za-z0-9_-]{2,20}$', examples: ['BR001'] }),
      razaoSocial: Type.String({ minLength: 3, maxLength: 200 }),
      cnpj: Type.String({ minLength: 14, maxLength: 18, description: 'Com ou sem máscara; aceita CNPJ alfanumérico' }),
      inscricaoEstadual: Type.Optional(Type.String({ maxLength: 20 })),
      enderecoCompleto: Type.String({ minLength: 10, maxLength: 400 }),
      telefone: Type.Optional(Type.String({ maxLength: 20 })),
      email: Type.String({ format: 'email', maxLength: 200 }),
      contrato: Type.Optional(SContratoEntrada),
    }),
    response: { 201: SOrganizacao, ...respostasErro },
  },
  listar: {
    tags: ['Organizações'],
    summary: 'Lista organizações',
    ...autenticado,
    querystring: Type.Object({ ativo: Type.Optional(Type.Boolean()) }),
    response: { 200: Type.Array(SOrganizacao), ...respostasErro },
  },
  buscar: {
    tags: ['Organizações'],
    summary: 'Busca por id ou código',
    ...autenticado,
    params: ParamId,
    response: { 200: SOrganizacao, ...respostasErro },
  },
  alterarEndereco: {
    tags: ['Organizações'],
    summary: 'Altera o endereço',
    ...autenticado,
    params: ParamId,
    body: Type.Object({ enderecoCompleto: Type.String({ minLength: 10, maxLength: 400 }), versao: SVersao }),
    response: { 200: SOrganizacao, ...respostasErro },
  },
  desativar: {
    tags: ['Organizações'],
    summary: 'Desativa (exige todos os lotes finalizados)',
    ...autenticado,
    params: ParamId,
    body: Type.Object({ versao: SVersao }),
    response: { 200: SOrganizacao, ...respostasErro },
  },
  definirContrato: {
    tags: ['Organizações'],
    summary: 'Cria o contrato de uma organização que ainda não tem',
    ...autenticado,
    params: ParamId,
    body: SContratoEntrada,
    response: { 201: SContrato, ...respostasErro },
  },
  renovarContrato: {
    tags: ['Organizações'],
    summary: 'Renova o contrato (novo vencimento posterior ao atual)',
    ...autenticado,
    params: ParamId,
    body: Type.Object({ novoVencimento: SData, versao: SVersao }),
    response: { 200: SContrato, ...respostasErro },
  },
};

export const rotasLote = {
  criar: {
    tags: ['Lotes'],
    summary: 'Cria lote com seus equipamentos (transação única)',
    description:
      'Regras: organização ativa e com contrato vigente; dataEntrada não futura e no máximo 90 dias atrás; ' +
      'nota fiscal única por organização; ao menos um equipamento.',
    ...autenticado,
    body: Type.Object({
      organizacao: Type.String({ minLength: 1, maxLength: 60, description: 'UUID ou código (ex.: BR001)' }),
      notaFiscal: Type.String({ minLength: 1, maxLength: 60 }),
      transportadora: Type.String({ minLength: 1, maxLength: 200 }),
      dataEntrada: SDataHora,
      observacoes: Type.Optional(Type.String({ maxLength: 2000 })),
      equipamentos: Type.Array(SEquipamentoEntrada, { minItems: 1, maxItems: 500 }),
    }),
    response: { 201: SLote, ...respostasErro },
  },
  listar: {
    tags: ['Lotes'],
    summary: 'Consulta lotes por período de entrada',
    ...autenticado,
    querystring: Type.Object({
      inicio: SDataHora,
      fim: SDataHora,
      status: Type.Optional(SStatusLote),
      organizacao: Type.Optional(SIdOuCodigo),
    }),
    response: { 200: Type.Array(SLoteResumo), ...respostasErro },
  },
  buscar: {
    tags: ['Lotes'],
    summary: 'Detalhe do lote com equipamentos',
    ...autenticado,
    params: ParamUuid,
    response: { 200: SLote, ...respostasErro },
  },
  relatorioTriagem: {
    tags: ['Lotes'],
    summary: 'Resumo de triagem do lote',
    ...autenticado,
    params: ParamUuid,
    response: { 200: SLivre, ...respostasErro },
  },
  adicionarEquipamento: {
    tags: ['Lotes'],
    summary: 'Inclui equipamento (somente lote RECEBIDO)',
    ...autenticado,
    params: ParamUuid,
    body: Type.Object({ versao: SVersao, equipamento: SEquipamentoEntrada }),
    response: { 201: SLote, ...respostasErro },
  },
  removerEquipamento: {
    tags: ['Lotes'],
    summary: 'Remove equipamento (somente lote RECEBIDO; o lote não pode ficar vazio)',
    ...autenticado,
    params: Type.Object({ id: SUuid, equipamentoId: SUuid }),
    querystring: Type.Object({ versao: SVersao }),
    response: { 200: SLote, ...respostasErro },
  },
  alterarStatus: {
    tags: ['Lotes'],
    summary: 'Avança o status do lote',
    description: 'RECEBIDO -> EM_TRIAGEM -> TRIAGEM_CONCLUIDA -> ENCAMINHADO -> FINALIZADO',
    ...autenticado,
    params: ParamUuid,
    body: Type.Object({ status: SStatusLote, versao: SVersao }),
    response: { 200: SLote, ...respostasErro },
  },
};

export const rotasEquipamento = {
  listar: {
    tags: ['Equipamentos'],
    summary: 'Lista equipamentos (máx. 200)',
    ...autenticado,
    querystring: Type.Object({
      status: Type.Optional(SStatusRastreamento),
      tipo: Type.Optional(STipoEquipamento),
      loteId: Type.Optional(SUuid),
    }),
    response: { 200: Type.Array(SEquipamento), ...respostasErro },
  },
  rastrear: {
    tags: ['Equipamentos'],
    summary: 'Rastreabilidade completa por id ou código de barras',
    ...autenticado,
    params: ParamId,
    response: { 200: SRastreio, ...respostasErro },
  },
  alterarStatus: {
    tags: ['Equipamentos'],
    summary: 'Altera o status de rastreamento (gera movimentação)',
    ...autenticado,
    params: ParamUuid,
    body: Type.Object({
      status: SStatusRastreamento,
      versao: SVersao,
      justificativa: Type.Optional(Type.String({ maxLength: 2000 })),
      valorRecuperado: Type.Optional(
        Type.Number({ minimum: 0, maximum: 9_999_999_999, description: 'Valor obtido (R$); só em PECAS_REAPROVEITADAS ou MATERIAL_RECICLAVEL' }),
      ),
    }),
    response: { 200: SEquipamento, ...respostasErro },
  },
  alterarEstadoFisico: {
    tags: ['Equipamentos'],
    summary: 'Altera o estado físico (queda de 2+ categorias exige justificativa)',
    ...autenticado,
    params: ParamUuid,
    body: Type.Object({
      estadoFisico: SEstadoFisico,
      versao: SVersao,
      justificativa: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    response: { 200: SEquipamento, ...respostasErro },
  },
};

export const rotasRelatorio = {
  porStatus: {
    tags: ['Relatórios'],
    summary: 'Equipamentos por status de rastreamento',
    ...autenticado,
    querystring: Type.Object({ status: Type.Optional(SStatusRastreamento) }),
    response: {
      200: Type.Array(Type.Object({ status: SStatusRastreamento, quantidade: Type.Integer(), pesoTotalQuilogramas: Type.Number() })),
      ...respostasErro,
    },
  },
  porOrganizacao: {
    tags: ['Relatórios'],
    summary: 'Lotes e equipamentos de uma organização no período',
    ...autenticado,
    params: ParamId,
    querystring: Type.Object({ inicio: SDataHora, fim: SDataHora }),
    response: { 200: SLivre, ...respostasErro },
  },
  financeiro: {
    tags: ['Relatórios'],
    summary: 'Receita contratual estimada no período',
    ...autenticado,
    querystring: Type.Object({ inicio: SData, fim: SData }),
    response: { 200: SLivre, ...respostasErro },
  },
  journal: {
    tags: ['Auditoria'],
    summary: 'Journal de transações (ADMINISTRADOR e AUDITOR)',
    ...autenticado,
    querystring: Type.Object({
      entidade: Type.Optional(Type.String({ maxLength: 40 })),
      entidadeId: Type.Optional(Type.String({ maxLength: 60 })),
      inicio: Type.Optional(SDataHora),
      fim: Type.Optional(SDataHora),
      limite: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 100 })),
    }),
    response: { 200: Type.Array(SLivre), ...respostasErro },
  },
};
