import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7: a URL de conexão sai do schema.prisma e passa a ser lida aqui.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
