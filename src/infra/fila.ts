import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';

/*
 * Fila de tarefas assíncronas. O restante do sistema depende apenas da
 * interface `FilaTarefas`; a implementação é escolhida na inicialização:
 *  - BullMQ + Redis (com REDIS_URL): distribuída, vários workers;
 *  - memória (sem Redis): uma instância, mesma política de retentativas.
 * O Redis não tem distribuição oficial para Windows; sem o fallback o sistema
 * não rodaria nativamente no Windows 10, exigido pela atividade.
 */

export type ProcessadorTarefa = (tarefaId: string, tentativa: number) => Promise<void>;

export interface FilaTarefas {
  readonly driver: 'bullmq' | 'memoria';
  publicar(tarefaId: string): Promise<void>;
  /** `processar` deve lançar erro para que a tarefa seja retentada. */
  consumir(processar: ProcessadorTarefa): Promise<void>;
  encerrar(): Promise<void>;
}

/** 3 tentativas com recuo exponencial: 5 s, 10 s, 20 s. */
export const POLITICA_RETENTATIVA = { tentativas: 3, atrasoBaseMs: 5_000 } as const;

export function atrasoRetentativa(tentativa: number): number {
  return POLITICA_RETENTATIVA.atrasoBaseMs * 2 ** (tentativa - 1);
}

/** Falha que não adianta repetir (ex.: tarefa inexistente). */
export class ErroDefinitivo extends Error {
  override readonly name = 'ErroDefinitivo';
}

const NOME_FILA = 'greencode-relatorios';

// ---------------------------------------------------------------------------

export class FilaMemoria implements FilaTarefas {
  readonly driver = 'memoria' as const;
  private readonly pendentes: { tarefaId: string; tentativa: number }[] = [];
  private readonly temporizadores = new Set<NodeJS.Timeout>();
  private processar: ProcessadorTarefa | undefined;
  private emExecucao = 0;
  private encerrada = false;

  constructor(private readonly concorrencia: number) {}

  async publicar(tarefaId: string): Promise<void> {
    this.pendentes.push({ tarefaId, tentativa: 1 });
    this.despachar();
  }

  async consumir(processar: ProcessadorTarefa): Promise<void> {
    this.processar = processar;
    this.despachar();
  }

  /**
   * Desligamento gracioso: espera as tarefas em andamento. As que ainda não
   * começaram continuam PENDENTE no banco e são republicadas no próximo início.
   */
  async encerrar(): Promise<void> {
    this.encerrada = true;
    for (const t of this.temporizadores) clearTimeout(t);
    this.temporizadores.clear();
    while (this.emExecucao > 0) await new Promise((r) => setTimeout(r, 50));
  }

  private despachar() {
    while (!this.encerrada && this.processar && this.emExecucao < this.concorrencia) {
      const item = this.pendentes.shift();
      if (!item) return;
      this.emExecucao++;
      void this.executar(item).finally(() => {
        this.emExecucao--;
        this.despachar();
      });
    }
  }

  private async executar(item: { tarefaId: string; tentativa: number }) {
    try {
      await this.processar!(item.tarefaId, item.tentativa);
    } catch (erro) {
      if (erro instanceof ErroDefinitivo || item.tentativa >= POLITICA_RETENTATIVA.tentativas) return;
      const t = setTimeout(() => {
        this.temporizadores.delete(t);
        this.pendentes.push({ tarefaId: item.tarefaId, tentativa: item.tentativa + 1 });
        this.despachar();
      }, atrasoRetentativa(item.tentativa));
      this.temporizadores.add(t);
    }
  }
}

// ---------------------------------------------------------------------------

export class FilaBullMQ implements FilaTarefas {
  readonly driver = 'bullmq' as const;
  private readonly conexao: Redis;
  private readonly fila: Queue;
  private worker: Worker | undefined;

  constructor(redisUrl: string, private readonly concorrencia: number) {
    // maxRetriesPerRequest = null é exigido pelo BullMQ
    this.conexao = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.fila = new Queue(NOME_FILA, {
      connection: this.conexao,
      defaultJobOptions: {
        attempts: POLITICA_RETENTATIVA.tentativas,
        backoff: { type: 'exponential', delay: POLITICA_RETENTATIVA.atrasoBaseMs },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async publicar(tarefaId: string): Promise<void> {
    // jobId = id da tarefa: publicar de novo a mesma tarefa não duplica o processamento
    await this.fila.add('gerar-relatorio', { tarefaId }, { jobId: tarefaId });
  }

  async consumir(processar: ProcessadorTarefa): Promise<void> {
    this.worker = new Worker(
      NOME_FILA,
      async (job) => {
        try {
          await processar(String(job.data.tarefaId), job.attemptsMade + 1);
        } catch (erro) {
          if (erro instanceof ErroDefinitivo) throw new UnrecoverableError(erro.message);
          throw erro;
        }
      },
      { connection: this.conexao.duplicate({ maxRetriesPerRequest: null }), concurrency: this.concorrencia },
    );
  }

  async encerrar(): Promise<void> {
    await this.worker?.close();
    await this.fila.close();
    await this.conexao.quit();
  }
}

export function criarFila(config: { redisUrl: string | undefined; filaConcorrencia: number }): FilaTarefas {
  return config.redisUrl ? new FilaBullMQ(config.redisUrl, config.filaConcorrencia) : new FilaMemoria(config.filaConcorrencia);
}
