// ↓ ↘ → + P
export const ASSINATURA_BUILD = 'HADOUKEN! ↓↘→+P';

export interface Configuracao {
  porta: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiraEm: string;
  corsOrigens: string[];
  nivelLog: string;
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
  };
}
