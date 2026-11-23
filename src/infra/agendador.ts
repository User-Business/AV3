import cron, { type ScheduledTask } from 'node-cron';
import type { AnaliseService } from '../services/analise.service.js';
import type { RelatorioAssincronoService, Registro } from '../services/relatorio-assincrono.service.js';

/**
 * Rotinas em segundo plano (node-cron):
 *  - recálculo diário das três análises sobre a base completa;
 *  - remoção dos relatórios com prazo de download vencido.
 * `noOverlap` impede que uma execução lenta se sobreponha à seguinte.
 */
export function iniciarAgendador(
  servicos: { analise: AnaliseService; relatorioAssincrono: RelatorioAssincronoService },
  config: { analisesCron: string; limpezaCron: string; fusoAgendador: string },
  log: Registro & { error(obj: object, msg?: string): void },
) {
  const tarefas: ScheduledTask[] = [];
  const agendar = (nome: string, expressao: string, rotina: () => Promise<void>) => {
    if (!expressao) return;
    if (!cron.validate(expressao)) throw new Error(`Expressão cron inválida para ${nome}: ${expressao}`);
    tarefas.push(
      cron.schedule(
        expressao,
        async () => {
          try {
            await rotina();
          } catch (erro) {
            log.error({ err: erro, rotina: nome }, 'falha em rotina agendada');
          }
        },
        { name: nome, timezone: config.fusoAgendador, noOverlap: true },
      ),
    );
  };

  agendar('analises-diarias', config.analisesCron, async () => {
    const inicio = Date.now();
    const execucoes = await servicos.analise.executarTodas('AGENDADA');
    log.info({ execucoes: execucoes.map((e) => e.id), ms: Date.now() - inicio }, 'análises agendadas concluídas');
  });
  agendar('limpeza-relatorios', config.limpezaCron, async () => {
    const removidos = await servicos.relatorioAssincrono.limparExpirados();
    if (removidos) log.info({ removidos }, 'relatórios expirados removidos');
  });

  return {
    async parar() {
      for (const t of tarefas) await t.stop();
    },
  };
}
