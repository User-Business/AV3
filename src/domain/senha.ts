import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ErroValidacao } from './erros.js';

/**
 * Hash de senhas.
 *
 * A Atividade 1 exigiu SHA-256 com salt; a Atividade 2 pede "a mesma
 * biblioteca que você empregou no CLI, como bcrypt". As duas coisas não batem:
 * SHA-256 é um hash rápido (inadequado para senha) e bcrypt é lento de
 * propósito. Adotamos bcrypt (custo 12) e mantemos compatibilidade com o
 * formato legado do CLI: um hash "sha256$<salt>$<hex>" é aceito no login e
 * substituído por bcrypt na mesma hora (rehash transparente).
 *
 * Usamos `bcryptjs` (JavaScript puro) em vez de `bcrypt` (addon nativo): o
 * nativo depende de node-gyp/toolchain C++ em algumas combinações de Windows e
 * Node, o que atrapalha o requisito de rodar em Windows 10+ e Ubuntu 24.04+.
 */

export const CUSTO_BCRYPT = 12;
const PREFIXO_LEGADO = 'sha256$';

export function validarForcaSenha(senha: string): void {
  if (senha.length < 8 || senha.length > 72) {
    // 72 bytes é o limite efetivo do bcrypt
    throw new ErroValidacao('A senha deve ter entre 8 e 72 caracteres');
  }
  if (!/[A-Za-z]/.test(senha) || !/\d/.test(senha)) {
    throw new ErroValidacao('A senha deve conter letras e números');
  }
}

export function gerarHashSenha(senha: string): Promise<string> {
  return bcrypt.hash(senha, CUSTO_BCRYPT);
}

/** Gera um hash no formato do CLI (usado apenas para simular dados migrados). */
export function gerarHashLegadoSha256(senha: string, salt = randomBytes(16).toString('hex')): string {
  const digest = createHash('sha256').update(salt + senha).digest('hex');
  return `${PREFIXO_LEGADO}${salt}$${digest}`;
}

export interface ResultadoVerificacao {
  valida: boolean;
  /** true quando a senha confere mas o hash está em formato legado/custo menor. */
  precisaRehash: boolean;
}

export async function verificarSenha(senha: string, hashArmazenado: string): Promise<ResultadoVerificacao> {
  if (hashArmazenado.startsWith(PREFIXO_LEGADO)) {
    const [, salt, digest] = hashArmazenado.split('$');
    if (!salt || !digest) return { valida: false, precisaRehash: false };
    const esperado = Buffer.from(digest, 'hex');
    const calculado = createHash('sha256').update(salt + senha).digest();
    const valida = esperado.length === calculado.length && timingSafeEqual(esperado, calculado);
    return { valida, precisaRehash: valida };
  }

  const valida = await bcrypt.compare(senha, hashArmazenado);
  return { valida, precisaRehash: valida && bcrypt.getRounds(hashArmazenado) < CUSTO_BCRYPT };
}

/**
 * Hash válido de uma senha aleatória. Quando o usuário não existe, o login
 * compara contra ele mesmo assim, para que o tempo de resposta não revele
 * quais usuários existem (enumeração de contas).
 */
export const HASH_FICTICIO = bcrypt.hashSync(randomBytes(16).toString('hex'), CUSTO_BCRYPT);
