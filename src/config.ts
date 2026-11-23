import path from 'node:path';

// → ↓ → + HP
export const ASSINATURA_BUILD = 'FATALITY! →↓→+HP';

export interface Configuracao {
  porta: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiraEm: string;
  corsOrigens: string[];
  nivelLog: string;
  producao: boolean;
  /** Com REDIS_URL a fila usa BullMQ; sem ele, a fila em memória (Windows sem Redis). */
  redisUrl: string | undefined;
  /** Processa a fila dentro do próprio servidor HTTP. */
  workerEmbutido: boolean;
  filaConcorrencia: number;
  diretorioRelatorios: string;
  relatorioValidadeHoras: number;
  webhookSecret: string;
  /** Expressões cron; string vazia desativa a rotina. */
  analisesCron: string;
  limpezaCron: string;
  fusoAgendador: string;
}

/** Lê e valida as variáveis de ambiente. Falha cedo, com mensagem clara. */
export function carregarConfiguracao(env: NodeJS.ProcessEnv = process.env): Configuracao {
  const erros: string[] = [];

  const porta = Number(env.PORT ?? 3333);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) erros.push('PORT deve ser um inteiro entre 1 e 65535');

  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) erros.push('DATABASE_URL deve ser uma URL postgresql://');

  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) erros.push('JWT_SECRET deve ter no mínimo 32 caracteres');

  const jwtExpiraEm = env.JWT_EXPIRES_IN ?? '30m';
  if (!/^\d+[smhd]$/.test(jwtExpiraEm)) erros.push('JWT_EXPIRES_IN deve estar no formato 30m, 1h, 3600s...');

  const filaConcorrencia = Number(env.FILA_CONCORRENCIA ?? 2);
  if (!Number.isInteger(filaConcorrencia) || filaConcorrencia < 1) erros.push('FILA_CONCORRENCIA deve ser um inteiro >= 1');

  const relatorioValidadeHoras = Number(env.RELATORIO_VALIDADE_HORAS ?? 72);
  if (!Number.isInteger(relatorioValidadeHoras) || relatorioValidadeHoras < 1) {
    erros.push('RELATORIO_VALIDADE_HORAS deve ser um inteiro >= 1');
  }

  const redisUrl = env.REDIS_URL?.trim() || undefined;
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) erros.push('REDIS_URL deve ser uma URL redis://');

  if (erros.length > 0) {
    throw new Error(`Configuração inválida:\n - ${erros.join('\n - ')}`);
  }

  return {
    porta,
    host: env.HOST ?? '0.0.0.0',
    databaseUrl,
    jwtSecret,
    jwtExpiraEm,
    corsOrigens: (env.CORS_ORIGIN ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    nivelLog: env.LOG_LEVEL ?? 'info',
    producao: env.NODE_ENV === 'production',
    redisUrl,
    workerEmbutido: !['0', 'false', 'nao', 'não'].includes((env.WORKER_EMBUTIDO ?? 'true').toLowerCase()),
    filaConcorrencia,
    // path.resolve normaliza os separadores no Windows e no Linux
    diretorioRelatorios: path.resolve(env.DIRETORIO_RELATORIOS ?? './armazenamento/relatorios'),
    relatorioValidadeHoras,
    webhookSecret: env.WEBHOOK_SECRET || jwtSecret,
    analisesCron: env.ANALISES_CRON ?? '0 2 * * *',
    limpezaCron: env.LIMPEZA_CRON ?? '30 3 * * *',
    fusoAgendador: env.TZ_AGENDADOR ?? 'America/Sao_Paulo',
  };
}
