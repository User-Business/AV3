import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/prisma/client.js';

/**
 * Prisma 7 usa driver adapters: a conexão é feita pelo driver `pg` (JavaScript
 * puro) em vez de um query engine binário. Consequência prática para o
 * requisito de plataforma: não há binário nativo a escolher por sistema
 * operacional (o antigo `binaryTargets`), o mesmo node_modules funciona no
 * Windows e no Ubuntu.
 */
export function criarPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
}

/** Cliente "raiz" ou cliente de transação: os repositórios aceitam os dois. */
export type Db = PrismaClient | Prisma.TransactionClient;
