import 'dotenv/config';
import { construirApp } from './app.js';
import { carregarConfiguracao } from './config.js';
import { criarPrismaClient } from './database.js';
import { iniciarAgendador } from './infra/agendador.js';
import { criarFila } from './infra/fila.js';

const TEMPO_MAXIMO_ENCERRAMENTO_MS = 10_000;

async function iniciar(): Promise<void> {
  const config = carregarConfiguracao();
  const prisma = criarPrismaClient(config.databaseUrl);
  const fila = criarFila(config);
  const { app, servicos } = await construirApp({ config, prisma, fila });

  // Fila em memória só pode ser consumida neste processo; com BullMQ o
  // consumo pode ficar em workers dedicados (npm run start:worker)
  if (config.workerEmbutido || fila.driver === 'memoria') {
    await fila.consumir(servicos.relatorioAssincrono.processar);
    const republicadas = await servicos.relatorioAssincrono.republicarInterrompidas();
    if (republicadas) app.log.info({ republicadas }, 'tarefas interrompidas republicadas na fila');
  }
  const agendador = iniciarAgendador(servicos, config, app.log);

  let encerrando = false;

  /**
   * Graceful shutdown: para de aceitar conexões, deixa as requisições em
   * andamento terminarem, fecha o pool do banco (hook onClose) e sai. Se
   * travar, força a saída após 10 s.
   *
   * Sinais por plataforma:
   *  - Ubuntu/systemd/Docker: SIGTERM (stop) e SIGINT (Ctrl+C)
   *  - Windows: não existe SIGTERM de verdade; Ctrl+C gera SIGINT e
   *    Ctrl+Break gera SIGBREAK. Por isso os três são tratados.
   */
  const encerrar = async (motivo: string, codigoSaida = 0) => {
    if (encerrando) return;
    encerrando = true;
    app.log.info({ motivo }, 'encerrando servidor...');
    const forcar = setTimeout(() => {
      app.log.error('encerramento excedeu o tempo limite; forçando saída');
      process.exit(1);
    }, TEMPO_MAXIMO_ENCERRAMENTO_MS);
    forcar.unref();
    try {
      // Ordem: para o agendador, deixa as requisições e as tarefas em andamento
      // terminarem e só então fecha o pool do banco (hook onClose do app)
      await agendador.parar();
      await fila.encerrar();
      await app.close();
      app.log.info('servidor encerrado com sucesso');
      process.exit(codigoSaida);
    } catch (erro) {
      app.log.error({ err: erro }, 'falha ao encerrar');
      process.exit(1);
    }
  };

  const sinais: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  if (process.platform === 'win32') sinais.push('SIGBREAK');
  for (const sinal of sinais) process.once(sinal, () => void encerrar(sinal));

  process.on('unhandledRejection', (erro) => {
    app.log.fatal({ err: erro }, 'promise rejeitada sem tratamento');
    void encerrar('unhandledRejection', 1);
  });
  process.on('uncaughtException', (erro) => {
    app.log.fatal({ err: erro }, 'exceção não capturada');
    void encerrar('uncaughtException', 1);
  });

  await app.listen({ port: config.porta, host: config.host });
  app.log.info(`documentação em http://localhost:${config.porta}/docs | fila: ${fila.driver}`);
}

iniciar().catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
