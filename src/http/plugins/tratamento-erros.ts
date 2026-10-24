import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import { ErroDominio } from '../../domain/erros.js';

const STATUS_POR_CODIGO: Record<string, number> = {
  VALIDACAO: 400,
  NAO_AUTENTICADO: 401,
  SEM_PERMISSAO: 403,
  NAO_ENCONTRADO: 404,
  CONFLITO: 409,
  REGRA_NEGOCIO: 422,
};

/** SQLSTATE próprios lançados pelos triggers da migração (classe GC). */
const SQLSTATE_GREENCODE = /\b(GC00\d)\b/;

interface CorpoErro {
  status: number;
  codigo: string;
  mensagem: string;
  detalhes?: unknown;
}

/**
 * Traduz qualquer erro para um formato único: { erro: { codigo, mensagem, detalhes } }.
 * Erros inesperados viram 500 sem expor stack trace ao cliente (fica só no log).
 */
export function traduzirErro(erro: unknown): CorpoErro {
  if (erro instanceof ErroDominio) {
    return {
      status: STATUS_POR_CODIGO[erro.codigo] ?? 400,
      codigo: erro.codigo,
      mensagem: erro.message,
      ...(erro.detalhes !== undefined ? { detalhes: erro.detalhes } : {}),
    };
  }

  const fe = erro as FastifyError;
  if (fe?.validation) {
    return { status: 400, codigo: 'VALIDACAO', mensagem: 'Requisição inválida', detalhes: fe.validation };
  }

  if (erro instanceof Prisma.PrismaClientKnownRequestError) {
    if (erro.code === 'P2002') {
      return {
        status: 409,
        codigo: 'CONFLITO',
        mensagem: 'Registro duplicado: viola uma restrição de unicidade',
        detalhes: erro.meta,
      };
    }
    if (erro.code === 'P2025') {
      return { status: 404, codigo: 'NAO_ENCONTRADO', mensagem: 'Registro não encontrado' };
    }
    if (erro.code === 'P2034') {
      return { status: 409, codigo: 'CONFLITO', mensagem: 'Conflito de concorrência; tente novamente' };
    }
  }

  // Erros vindos dos triggers/CHECKs do PostgreSQL (defesa em profundidade)
  const texto = erro instanceof Error ? erro.message : String(erro);
  const sqlstate = SQLSTATE_GREENCODE.exec(texto)?.[1] ?? extrairSqlState(erro);
  if (sqlstate?.startsWith('GC')) {
    return { status: 422, codigo: 'REGRA_NEGOCIO', mensagem: extrairMensagemBanco(erro, texto) };
  }
  if (sqlstate === '23514') {
    return { status: 422, codigo: 'REGRA_NEGOCIO', mensagem: 'Violação de restrição (CHECK) no banco de dados' };
  }

  if (typeof fe?.statusCode === 'number' && fe.statusCode < 500) {
    return { status: fe.statusCode, codigo: fe.code ?? 'REQUISICAO_INVALIDA', mensagem: fe.message };
  }

  return { status: 500, codigo: 'ERRO_INTERNO', mensagem: 'Erro interno do servidor' };
}

/** O driver adapter expõe o erro original do `pg` em `cause`/`meta`. */
function extrairSqlState(erro: unknown): string | undefined {
  const visitar = (e: unknown, profundidade: number): string | undefined => {
    if (!e || typeof e !== 'object' || profundidade > 4) return undefined;
    const o = e as Record<string, unknown>;
    for (const chave of ['code', 'originalCode']) {
      const v = o[chave];
      if (typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v)) return v;
    }
    return visitar(o.cause, profundidade + 1) ?? visitar(o.meta, profundidade + 1) ?? visitar(o.driverAdapterError, profundidade + 1);
  };
  return visitar(erro, 0);
}

function extrairMensagemBanco(erro: unknown, fallback: string): string {
  const visitar = (e: unknown, profundidade: number): string | undefined => {
    if (!e || typeof e !== 'object' || profundidade > 4) return undefined;
    const o = e as Record<string, unknown>;
    if (typeof o.originalMessage === 'string') return o.originalMessage;
    return visitar(o.cause, profundidade + 1) ?? visitar(o.meta, profundidade + 1) ?? visitar(o.driverAdapterError, profundidade + 1);
  };
  return visitar(erro, 0) ?? fallback.split('\n').pop()!.trim();
}

export const pluginTratamentoErros = fp(
  async (app) => {
    app.setErrorHandler((erro, request, reply) => {
      const { status, codigo, mensagem, detalhes } = traduzirErro(erro);
      if (status >= 500) {
        request.log.error({ err: erro }, 'erro não tratado');
      } else {
        request.log.info({ codigo, mensagem }, 'requisição rejeitada');
      }
      return reply.status(status).send({ erro: { codigo, mensagem, ...(detalhes !== undefined ? { detalhes } : {}) } });
    });

    app.setNotFoundHandler((request, reply) =>
      reply.status(404).send({
        erro: { codigo: 'ROTA_NAO_ENCONTRADA', mensagem: `Rota ${request.method} ${request.url} não existe` },
      }),
    );
  },
  { name: 'greencode-tratamento-erros' },
);
