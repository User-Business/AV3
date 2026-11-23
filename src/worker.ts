import 'dotenv/config';
import pino from 'pino';
import { criarServicos } from './app.js';
import { carregarConfiguracao } from './config.js';
import { criarPrismaClient } from './database.js';
import { criarFila } from './infra/fila.js';

/**
 * Worker dedicado de relatórios: processa a fila BullMQ fora do servidor HTTP.
 * Várias instâncias podem rodar em paralelo (escala horizontal). Requer
 * REDIS_URL; sem Redis a fila é em memória e o próprio servidor a consome.
 */
async function iniciar(): Promise<void> {
  const config = carregarConfiguracao();
  const log = pino({ level: config.nivelLog });
  if (!config.redisUrl) {
    log.error('o worker dedicado requer REDIS_URL; sem Redis, use WORKER_EMBUTIDO=true no servidor');
    process.exit(1);
  }

  const prisma = criarPrismaClient(config.databaseUrl);
  const fila = criarFila(config);
  const servicos = criarServicos(prisma, { config, fila, log });
  await fila.consumir(servicos.relatorioAssincrono.processar);
  log.info({ concorrencia: config.filaConcorrencia }, 'worker de relatórios iniciado');

  const encerrar = async () => {
    log.info('encerrando worker...');
    await fila.encerrar();
    await prisma.$disconnect();
    process.exit(0);
  };
  const sinais: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  if (process.platform === 'win32') sinais.push('SIGBREAK');
  for (const sinal of sinais) process.once(sinal, () => void encerrar());
}

iniciar().catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
