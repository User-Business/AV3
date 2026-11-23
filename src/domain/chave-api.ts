import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { PlanoAcesso, type EscopoChave } from '../generated/prisma/enums.js';
import { ErroNaoAutenticado, ErroSemPermissao } from './erros.js';

/*
 * Chaves de API dos parceiros. Formato entregue: gc_<prefixo>_<segredo>
 *  - prefixo: 12 hexadecimais, público e indexado (localiza a chave);
 *  - segredo: 32 bytes aleatórios em base64url; só o SHA-256 é persistido.
 *
 * Senhas de pessoas usam bcrypt (baixa entropia, precisam de hash lento). O
 * segredo da chave tem 256 bits de entropia: força bruta é inviável mesmo com
 * hash rápido, e um hash lento só somaria latência a cada requisição.
 */

const FORMATO = /^gc_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface ChaveGerada {
  prefixo: string;
  segredo: string;
  hashSegredo: string;
  chaveCompleta: string;
}

export function hashSegredo(segredo: string): string {
  return createHash('sha256').update(segredo).digest('hex');
}

export function gerarChave(): ChaveGerada {
  const prefixo = randomBytes(6).toString('hex');
  const segredo = randomBytes(32).toString('base64url');
  return { prefixo, segredo, hashSegredo: hashSegredo(segredo), chaveCompleta: `gc_${prefixo}_${segredo}` };
}

export function decomporChave(chave: string | undefined): { prefixo: string; segredo: string } {
  const partes = chave ? FORMATO.exec(chave.trim()) : null;
  if (!partes?.[1] || !partes[2]) throw new ErroNaoAutenticado('Chave de API ausente ou em formato inválido');
  return { prefixo: partes[1], segredo: partes[2] };
}

/** Comparação em tempo constante (não vaza, pelo tempo, quantos caracteres conferem). */
export function segredoConfere(segredo: string, hashArmazenado: string): boolean {
  const esperado = Buffer.from(hashArmazenado, 'hex');
  const recebido = Buffer.from(hashSegredo(segredo), 'hex');
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}

/** Parceiro autenticado: equivalente ao Ator dos usuários internos. */
export interface ParceiroAutenticado {
  parceiroId: string;
  nome: string;
  organizacaoId: string;
  plano: PlanoAcesso;
  chaveId: string;
  escopos: readonly EscopoChave[];
}

export function exigirEscopo(parceiro: ParceiroAutenticado | undefined, escopo: EscopoChave): asserts parceiro is ParceiroAutenticado {
  if (!parceiro) throw new ErroNaoAutenticado('Chave de API necessária');
  if (!parceiro.escopos.includes(escopo)) throw new ErroSemPermissao(`A chave de API não possui o escopo ${escopo}`);
}

/** Limite de requisições por minuto de cada plano comercial. */
export const LIMITE_POR_PLANO: Readonly<Record<PlanoAcesso, number>> = {
  [PlanoAcesso.BASICO]: 60,
  [PlanoAcesso.PROFISSIONAL]: 300,
  [PlanoAcesso.CORPORATIVO]: 1200,
};
