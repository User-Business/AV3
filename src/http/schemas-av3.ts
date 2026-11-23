/**
 * Contratos das rotas da Atividade 3 (camada analítica, administração de
 * parceiros e API pública). Mesmo princípio de schemas.ts: um schema valida a
 * entrada, filtra a saída e gera a documentação OpenAPI.
 */
import { Type, type TSchema } from 'typebox';
import {
  EscopoChave,
  EstadoFisico,
  FormatoRelatorio,
  PlanoAcesso,
  StatusLote,
  StatusRastreamento,
  StatusTarefa,
  TipoAnalise,
  TipoEquipamento,
} from '../generated/prisma/enums.js';
import { TIPOS_RELATORIO } from '../services/relatorio-assincrono.service.js';

function enumDe<T extends Record<string, string>>(objeto: T, descricao?: string) {
  const valores = Object.values(objeto) as T[keyof T][];
  return Type.Unsafe<T[keyof T]>({ type: 'string', enum: valores, ...(descricao ? { description: descricao } : {}) });
}
const Nulavel = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);

const STipoEquipamento = enumDe(TipoEquipamento);
const SEstadoFisico = enumDe(EstadoFisico, 'Do melhor (NOVO) para o pior (INSERVIVEL)');
const SStatusLote = enumDe(StatusLote);
const SStatusRastreamento = enumDe(StatusRastreamento);
const STipoAnalise = enumDe(TipoAnalise);
const SEscopo = enumDe(EscopoChave);
const SPlano = enumDe(PlanoAcesso, 'BASICO 60 req/min, PROFISSIONAL 300 req/min, CORPORATIVO 1200 req/min');
const SFormato = enumDe(FormatoRelatorio);
const SStatusTarefa = enumDe(StatusTarefa, 'PENDENTE → PROCESSANDO → CONCLUIDA | FALHOU');
const STipoRelatorio = Type.Unsafe<(typeof TIPOS_RELATORIO)[number]>({ type: 'string', enum: [...TIPOS_RELATORIO] });

const SData = Type.String({ format: 'date', description: 'YYYY-MM-DD', examples: ['2026-10-31'] });
const SDataHora = Type.String({ format: 'date-time' });
const SUuid = Type.String({ format: 'uuid' });
const SVersao = Type.Integer({ minimum: 0, description: 'Versão lida do recurso (concorrência otimista)' });
const ParamUuid = Type.Object({ id: SUuid });
const SLivre = Type.Object({}, { additionalProperties: true });

const erro = (descricao: string) => ({ ...Type.Ref('Erro'), description: descricao });
const ERROS = {
  400: erro('Requisição fora do contrato (VALIDACAO)'),
  401: erro('Credencial ausente, inválida, expirada ou revogada (NAO_AUTENTICADO)'),
  403: erro('Sem o papel ou o escopo necessário (SEM_PERMISSAO)'),
  404: erro('Recurso inexistente ou de outra organização (NAO_ENCONTRADO)'),
  409: erro('Duplicidade ou versão desatualizada (CONFLITO)'),
  410: erro('Relatório expirado (EXPIRADO)'),
  422: erro('Regra de negócio violada (REGRA_NEGOCIO)'),
  429: erro('Limite de requisições do plano excedido (LIMITE_EXCEDIDO)'),
} as const;
type CodigoErro = keyof typeof ERROS;
const erros = (...codigos: CodigoErro[]) => Object.fromEntries(codigos.map((c) => [c, ERROS[c]]));

const jwt = { security: [{ bearerAuth: [] }] };
const chaveApi = { security: [{ chaveApi: [] }] };

// =====================================================================
// Interna: camada analítica e relatórios assíncronos (JWT)
// =====================================================================

export const rotasAnalise = {
  executar: {
    tags: ['Análises'],
    summary: 'Executa uma análise sob demanda e grava o resultado',
    description: 'Papéis: ADMINISTRADOR, AUDITOR, GESTOR_ALMOXARIFADO. Período e organização são opcionais.',
    ...jwt,
    body: Type.Object({
      tipo: STipoAnalise,
      organizacao: Type.Optional(Type.String({ minLength: 1, maxLength: 60, description: 'UUID ou código (ex.: BR001)' })),
      inicio: Type.Optional(SData),
      fim: Type.Optional(SData),
    }),
    response: { 201: SLivre, ...erros(400, 401, 403, 404) },
  },
  listar: {
    tags: ['Análises'],
    summary: 'Histórico de execuções analíticas',
    ...jwt,
    querystring: Type.Object({
      tipo: Type.Optional(STipoAnalise),
      limite: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    }),
    response: { 200: Type.Array(SLivre), ...erros(400, 401, 403) },
  },
  buscar: {
    tags: ['Análises'],
    summary: 'Resultado completo de uma execução (métricas por grupo)',
    ...jwt,
    params: ParamUuid,
    response: { 200: SLivre, ...erros(401, 403, 404) },
  },
  acuracia: {
    tags: ['Análises'],
    summary: 'Previsão × realização da vida útil (erro absoluto médio, em anos)',
    ...jwt,
    response: { 200: SLivre, ...erros(401, 403) },
  },
  solicitarRelatorio: {
    tags: ['Análises'],
    summary: 'Solicita relatório assíncrono de uma organização (202 + id da tarefa)',
    ...jwt,
    body: Type.Object({
      organizacao: Type.String({ minLength: 1, maxLength: 60, description: 'UUID ou código (ex.: BR001)' }),
      tipo: STipoRelatorio,
      formato: Type.Optional(SFormato),
    }),
    response: { 202: SLivre, ...erros(400, 401, 403, 404) },
  },
  consultarRelatorio: {
    tags: ['Análises'],
    summary: 'Status de uma tarefa de relatório',
    ...jwt,
    params: ParamUuid,
    response: { 200: SLivre, ...erros(401, 403, 404) },
  },
  baixarRelatorio: {
    tags: ['Análises'],
    summary: 'Download de relatório concluído',
    ...jwt,
    params: ParamUuid,
  },
};

// =====================================================================
// Admin: parceiros e chaves de API (JWT, ADMINISTRADOR)
// =====================================================================

const SChave = Type.Object({
  id: SUuid,
  prefixo: Type.String(),
  descricao: Nulavel(Type.String()),
  escopos: Type.Array(SEscopo),
  criadaEm: SDataHora,
  expiraEm: Nulavel(SDataHora),
  revogadaEm: Nulavel(SDataHora),
  ultimoUso: Nulavel(SDataHora),
});

export const rotasParceiro = {
  criar: {
    tags: ['Admin - Parceiros'],
    summary: 'Cadastra parceiro vinculado a uma organização',
    ...jwt,
    body: Type.Object({
      nome: Type.String({ minLength: 2, maxLength: 120 }),
      organizacao: Type.String({ minLength: 1, maxLength: 60, description: 'UUID ou código (ex.: BR001)' }),
      plano: Type.Optional(SPlano),
    }),
    response: { 201: SLivre, ...erros(400, 401, 403, 422) },
  },
  listar: {
    tags: ['Admin - Parceiros'],
    summary: 'Lista parceiros',
    ...jwt,
    response: { 200: Type.Array(SLivre), ...erros(401, 403) },
  },
  atualizar: {
    tags: ['Admin - Parceiros'],
    summary: 'Altera plano ou situação do parceiro',
    ...jwt,
    params: ParamUuid,
    body: Type.Object({ versao: SVersao, plano: Type.Optional(SPlano), ativo: Type.Optional(Type.Boolean()) }),
    response: { 200: SLivre, ...erros(400, 401, 403, 404, 409) },
  },
  emitirChave: {
    tags: ['Admin - Parceiros'],
    summary: 'Emite chave de API (o valor completo aparece uma única vez)',
    ...jwt,
    params: ParamUuid,
    body: Type.Object({
      escopos: Type.Array(SEscopo, { minItems: 1 }),
      descricao: Type.Optional(Type.String({ maxLength: 200 })),
      validadeDias: Type.Optional(Type.Integer({ minimum: 1, maximum: 730 })),
    }),
    response: {
      201: Type.Object({ ...SChave.properties, chave: Type.String({ description: 'gc_<prefixo>_<segredo> — guarde agora' }) }),
      ...erros(400, 401, 403, 404, 422),
    },
  },
  listarChaves: {
    tags: ['Admin - Parceiros'],
    summary: 'Lista as chaves do parceiro (sem o segredo)',
    ...jwt,
    params: ParamUuid,
    response: { 200: Type.Array(SChave), ...erros(401, 403, 404) },
  },
  revogarChave: {
    tags: ['Admin - Parceiros'],
    summary: 'Revoga uma chave de API (efeito imediato)',
    ...jwt,
    params: ParamUuid,
    response: { 204: Type.Null(), ...erros(401, 403, 404) },
  },
};

// =====================================================================
// Pública (/api/v1/public): parceiros, autenticados por X-API-Key
// =====================================================================

const SEquipamentoPublico = Type.Object({
  id: SUuid,
  codigoBarrasInterno: Type.String({ examples: ['GCNB0000000127'] }),
  tipo: STipoEquipamento,
  marca: Type.String(),
  modelo: Type.String(),
  anoFabricacao: Type.Integer(),
  estadoFisico: SEstadoFisico,
  pesoQuilogramas: Type.Number(),
  posicaoNoLote: Type.Integer(),
  statusRastreamento: SStatusRastreamento,
  valorRecuperado: Nulavel(Type.String({ description: 'Decimal em string, ex.: "120.50"' })),
});

const SLotePublico = Type.Object({
  id: SUuid,
  dataEntrada: SDataHora,
  notaFiscal: Type.String(),
  transportadora: Type.String(),
  statusProcessamento: SStatusLote,
  observacoes: Nulavel(Type.String()),
  conclusaoTriagemEm: Nulavel(SDataHora),
  pesoTotalQuilogramas: Type.Number(),
  quantidadeEquipamentos: Type.Integer(),
  equipamentos: Type.Array(SEquipamentoPublico),
});

const STarefa = Type.Object({
  tarefaId: SUuid,
  tipo: Type.String(),
  formato: SFormato,
  status: SStatusTarefa,
  tentativas: Type.Integer(),
  criadaEm: SDataHora,
  concluidaEm: Nulavel(SDataHora),
  expiraEm: Nulavel(SDataHora),
  tamanhoBytes: Nulavel(Type.Integer()),
  erro: Nulavel(Type.String()),
  links: Type.Object({ status: Type.String(), download: Nulavel(Type.String()) }),
});

const SGrupoEficiencia = Type.Object({
  dimensao: Type.String({ enum: ['GERAL', 'OPERADOR', 'MES'] }),
  rotulo: Type.String({ description: 'Operadores aparecem anonimizados (Operador 1, 2...)' }),
  quantidadeLotes: Type.Integer(),
  mediaHoras: Type.Number(),
  medianaHoras: Type.Number(),
  desvioPadraoHoras: Type.Number(),
  percentil90Horas: Type.Number(),
  gargalo: Type.Boolean(),
});

const SNumNulo = Nulavel(Type.Number());

const DESCRICAO_LIMITES =
  'Cabeçalhos de resposta: `x-ratelimit-limit`, `x-ratelimit-remaining` e `x-api-version`.';

export const rotasPublicas = {
  rastreabilidade: {
    tags: ['Pública - Rastreabilidade'],
    summary: 'Histórico completo de um equipamento',
    description: `Movimentações e evolução do estado físico. Só equipamentos da organização da chave são visíveis. Escopo: \`RASTREABILIDADE_LEITURA\`. ${DESCRICAO_LIMITES}`,
    ...chaveApi,
    params: Type.Object({
      codigo: Type.String({ pattern: '^[A-Za-z]{4}\\d{10}$', description: 'Código de barras interno', examples: ['GCNB0000000127'] }),
    }),
    response: {
      200: Type.Object({
        equipamento: SEquipamentoPublico,
        lote: Type.Object({ id: SUuid, notaFiscal: Type.String(), dataEntrada: SDataHora, statusProcessamento: SStatusLote }),
        movimentacoes: Type.Array(
          Type.Object({ dataHora: SDataHora, origem: Type.String(), destino: Type.String(), observacao: Nulavel(Type.String()) }),
        ),
        historicoEstadoFisico: Type.Array(
          Type.Object({ dataHora: SDataHora, estadoAnterior: Nulavel(SEstadoFisico), estadoNovo: SEstadoFisico }),
        ),
      }),
      ...erros(400, 401, 403, 404, 429),
    },
  },
  listarLotes: {
    tags: ['Pública - Lotes'],
    summary: 'Lista os lotes da organização (paginado)',
    description: 'Escopo: `LOTES_LEITURA`. Filtros opcionais por período de entrada e status.',
    ...chaveApi,
    querystring: Type.Object({
      pagina: Type.Integer({ minimum: 1, default: 1 }),
      tamanho: Type.Integer({ minimum: 1, maximum: 100, default: 20 }),
      inicio: Type.Optional(SData),
      fim: Type.Optional(SData),
      status: Type.Optional(SStatusLote),
    }),
    response: {
      200: Type.Object({
        pagina: Type.Integer(),
        tamanho: Type.Integer(),
        total: Type.Integer(),
        itens: Type.Array(
          Type.Object({
            id: SUuid,
            dataEntrada: SDataHora,
            notaFiscal: Type.String(),
            transportadora: Type.String(),
            statusProcessamento: SStatusLote,
            quantidadeEquipamentos: Type.Integer(),
            conclusaoTriagemEm: Nulavel(SDataHora),
          }),
        ),
      }),
      ...erros(400, 401, 403, 429),
    },
  },
  buscarLote: {
    tags: ['Pública - Lotes'],
    summary: 'Detalha um lote e seus equipamentos',
    description: 'Escopo: `LOTES_LEITURA`.',
    ...chaveApi,
    params: ParamUuid,
    response: { 200: SLotePublico, ...erros(400, 401, 403, 404, 429) },
  },
  criarLote: {
    tags: ['Pública - Lotes'],
    summary: 'Submete um novo lote com seus equipamentos',
    description:
      'Cria lote e equipamentos de forma atômica (tudo ou nada). Mesmas regras da operação interna: data de entrada não futura nem anterior a 90 dias, nota fiscal única por organização, contrato vigente, de 1 a 500 equipamentos. Escopo: `LOTES_ESCRITA`.',
    ...chaveApi,
    body: Type.Object(
      {
        notaFiscal: Type.String({ minLength: 1, maxLength: 60 }),
        transportadora: Type.String({ minLength: 1, maxLength: 200 }),
        dataEntrada: SDataHora,
        observacoes: Type.Optional(Type.String({ maxLength: 2000 })),
        equipamentos: Type.Array(
          Type.Object({
            tipo: STipoEquipamento,
            marca: Type.String({ minLength: 1, maxLength: 100 }),
            modelo: Type.String({ minLength: 1, maxLength: 100 }),
            anoFabricacao: Type.Integer({ minimum: 1970, maximum: 2100 }),
            estadoFisico: SEstadoFisico,
            pesoQuilogramas: Type.Number({ exclusiveMinimum: 0, maximum: 5000 }),
          }),
          { minItems: 1, maxItems: 500 },
        ),
      },
      {
        examples: [
          {
            notaFiscal: 'NF-2026-009001',
            transportadora: 'TransRapida',
            dataEntrada: '2026-11-20T09:30:00-03:00',
            equipamentos: [
              { tipo: 'NOTEBOOK', marca: 'Dell', modelo: 'Latitude 5490', anoFabricacao: 2019, estadoFisico: 'USADO_MODERADO', pesoQuilogramas: 1.9 },
              { tipo: 'MONITOR', marca: 'LG', modelo: '24MK430H', anoFabricacao: 2018, estadoFisico: 'DANIFICADO_LEVE', pesoQuilogramas: 3.2 },
            ],
          },
        ],
      },
    ),
    response: { 201: SLotePublico, ...erros(400, 401, 403, 404, 409, 422, 429) },
  },
  eficiencia: {
    tags: ['Pública - Análises'],
    summary: 'Eficiência operacional dos lotes da organização',
    description:
      'Horas entre a entrada do lote e a conclusão da triagem, no geral, por operador (anonimizado) e por mês. Grupos com 3+ lotes e mediana 25% acima da mediana dos demais lotes são marcados como gargalo. Resultado reaproveitado por até 24 h. Escopo: `ANALISES_LEITURA`.',
    ...chaveApi,
    response: {
      200: Type.Object({ execucaoId: SUuid, geradaEm: SDataHora, lotesAnalisados: Type.Integer(), grupos: Type.Array(SGrupoEficiencia) }),
      ...erros(401, 403, 429),
    },
  },
  rentabilidade: {
    tags: ['Pública - Análises'],
    summary: 'Rentabilidade de recuperação por tipo de equipamento',
    description:
      'Referência de mercado agregada sobre toda a base (sem identificar clientes): valor médio, mediano e por kg recuperado, por tipo, por tipo+estado e por tipo+marca+modelo, do maior para o menor retorno. Escopo: `ANALISES_LEITURA`.',
    ...chaveApi,
    querystring: Type.Object({ tipo: Type.Optional(STipoEquipamento) }),
    response: {
      200: Type.Object({
        execucaoId: SUuid,
        geradaEm: SDataHora,
        equipamentosAnalisados: Type.Integer(),
        grupos: Type.Array(
          Type.Object({
            tipo: STipoEquipamento,
            estadoFisico: Nulavel(SEstadoFisico),
            marca: Nulavel(Type.String()),
            modelo: Nulavel(Type.String()),
            amostras: Type.Integer(),
            valorMedio: Type.Number(),
            valorMediano: Type.Number(),
            desvioPadrao: Type.Number(),
            valorTotal: Type.Number(),
            valorMedioPorKg: Type.Number(),
          }),
        ),
      }),
      ...erros(400, 401, 403, 429),
    },
  },
  vidaUtil: {
    tags: ['Pública - Análises'],
    summary: 'Modelos preditivos de vida útil por tipo de equipamento',
    description:
      'Mínimos quadrados sobre nível_estado = a + b·idade (0 = NOVO ... 6 = INSERVIVEL); idade prevista de inservibilidade = (6 − a) / b. Com menos de 5 observações, suavização exponencial da taxa de degradação. Escopo: `ANALISES_LEITURA`.',
    ...chaveApi,
    response: {
      200: Type.Object({
        execucaoId: SUuid,
        geradaEm: SDataHora,
        observacoes: Type.Integer(),
        modelos: Type.Array(
          Type.Object({
            tipo: STipoEquipamento,
            metodo: Type.String({ enum: ['MINIMOS_QUADRADOS', 'SUAVIZACAO_EXPONENCIAL'] }),
            amostras: Type.Integer(),
            coeficienteAngular: SNumNulo,
            intercepto: SNumNulo,
            r2: SNumNulo,
            idadeInservivelAnos: SNumNulo,
            suficiente: Type.Boolean(),
            observacao: Nulavel(Type.String()),
          }),
        ),
      }),
      ...erros(401, 403, 429),
    },
  },
  solicitarRelatorio: {
    tags: ['Pública - Relatórios'],
    summary: 'Solicita a geração assíncrona de um relatório',
    description: [
      'Responde na hora com **202 Accepted** e o id da tarefa (cabeçalho `Location`).',
      'Acompanhe por *polling* em `GET /relatorios/{id}` ou informe `webhookUrl` para receber um POST ao término, assinado com HMAC-SHA256 no cabeçalho `X-Greencode-Assinatura`.',
      '',
      '- `PREDITIVO_VIDA_UTIL`: vida remanescente projetada de cada equipamento ativo;',
      '- `RENTABILIDADE_EQUIPAMENTOS`: valor recuperado por equipamento;',
      '- `RASTREABILIDADE`: status e localização atual de todos os equipamentos.',
      '',
      'Falhas transitórias: até 3 tentativas com recuo exponencial (5 s, 10 s, 20 s). Escopo: `RELATORIOS_SOLICITAR`.',
    ].join('\n'),
    ...chaveApi,
    body: Type.Object(
      {
        tipo: STipoRelatorio,
        formato: Type.Optional(SFormato),
        webhookUrl: Type.Optional(Type.String({ format: 'uri', maxLength: 500 })),
      },
      { examples: [{ tipo: 'PREDITIVO_VIDA_UTIL', formato: 'CSV', webhookUrl: 'https://parceiro.example.com/webhooks/greencode' }] },
    ),
    response: { 202: STarefa, ...erros(400, 401, 403, 429) },
  },
  consultarRelatorio: {
    tags: ['Pública - Relatórios'],
    summary: 'Consulta o status de uma tarefa de relatório',
    ...chaveApi,
    params: ParamUuid,
    response: { 200: STarefa, ...erros(400, 401, 403, 404, 429) },
  },
  baixarRelatorio: {
    tags: ['Pública - Relatórios'],
    summary: 'Baixa o arquivo de um relatório concluído',
    description: 'CSV (separador `;`) ou JSON. O arquivo expira após `expiraEm` (410).',
    ...chaveApi,
    params: ParamUuid,
    response: { ...erros(400, 401, 403, 404, 410, 422, 429) },
  },
};
