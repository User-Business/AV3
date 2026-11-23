# greencode: camada analítica e API pública (Atividade 3)

Plataforma de logística reversa de equipamentos eletrônicos. A Atividade 3 evolui o servidor
monolítico da Atividade 2 em três frentes:

1. **Camada analítica**: eficiência operacional, rentabilidade por tipo de equipamento e
   previsão de vida útil remanescente, executadas sob demanda ou agendadas (node-cron) e
   gravadas no banco para consulta histórica.
2. **API pública documentada** (`/api/v1/public`): chaves de API por parceiro com escopos,
   limite de requisições por plano e documentação OpenAPI interativa.
3. **Processamento assíncrono**: relatórios pesados em fila (BullMQ/Redis ou fila em memória),
   com retentativas, consulta de status (polling) e aviso por webhook.

**Pilha:** Node.js · TypeScript · Fastify 5 · Prisma ORM 7 · PostgreSQL · simple-statistics ·
node-cron · BullMQ/Redis · `@fastify/rate-limit` · Swagger/OpenAPI

Documentação de projeto:
- [docs/RELATORIO_TECNICO.md](docs/RELATORIO_TECNICO.md): decisões da Atividade 3 (biblioteca
  estatística, modelagem das tabelas analíticas, política de retentativas, evolução da arquitetura);
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): decisões da Atividade 2, que continuam valendo.

---

## Requisitos

| Item | Versão |
|---|---|
| Node.js | 20.19+, 22.12+ ou 24+ (exigência do Prisma 7) |
| PostgreSQL | 14+ (o `docker-compose.yml` sobe o 17) |
| Redis | opcional: habilita BullMQ, worker dedicado e rate limit compartilhado |
| Sistema operacional | Windows 10+ · Ubuntu 24.04.3+ e derivados |

Nenhuma dependência nativa precisa ser compilada. O Redis não tem versão oficial para Windows;
sem `REDIS_URL` o sistema usa a **fila em memória**, com a mesma política de retentativas, e
roda completo no Windows sem WSL nem Docker.

## Como rodar

```bash
# 1. Banco de dados e Redis (ou use um PostgreSQL já instalado e ajuste DATABASE_URL)
docker compose up -d

# 2. Variáveis de ambiente
cp .env.example .env              # Ubuntu
Copy-Item .env.example .env       # Windows PowerShell
#    -> troque JWT_SECRET e WEBHOOK_SECRET por valores aleatórios

# 3. Dependências
npm install

# 4. Gera o Prisma Client, aplica as migrações e popula o banco
npm run setup

# 5. Servidor em modo desenvolvimento
npm run dev
```

- Documentação interativa (Swagger): `http://localhost:3333/docs`
- API pública: `http://localhost:3333/api/v1/public`
- API interna: `http://localhost:3333/api/v1/internal` · administrativa: `/api/v1/admin`
- Saúde: `http://localhost:3333/health`

Produção: `npm run build && npm start`. Com Redis, os relatórios podem ser processados em
processos separados: `WORKER_EMBUTIDO=false` no servidor e `npm run start:worker` em quantas
instâncias forem necessárias.

### Credenciais criadas pelo seed (somente desenvolvimento)

| Usuário | Senha | Papel |
|---|---|---|
| admin | Admin@2026 | ADMINISTRADOR |
| cadastro | Cadastro@2026 | OPERADOR_CADASTRO |
| almoxarifado | Almox@2026 | GESTOR_ALMOXARIFADO |
| almox.ana · almox.bruno · almox.carla | Almox@2026 | GESTOR_ALMOXARIFADO (histórico analítico) |
| auditor | Auditor@2026 | AUDITOR |
| legado | Legado@2026 | AUDITOR (hash SHA-256 vindo do CLI; vira bcrypt no 1º login) |

O seed também cria o parceiro **Integração ERP Banco Horizonte** (organização BR001, plano
PROFISSIONAL) e **imprime no terminal uma chave de API** com todos os escopos. Use-a no botão
"Authorize" do `/docs` (campo `chaveApi`) ou no cabeçalho `X-API-Key`.

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | servidor com recarga automática (tsx watch) |
| `npm run build` / `npm start` | compila para `dist/` / roda o compilado |
| `npm run worker` / `npm run start:worker` | worker dedicado de relatórios (requer `REDIS_URL`) |
| `npm run typecheck` | checagem de tipos sem gerar arquivos |
| `npm run setup` | `prisma generate` + `migrate deploy` + `db seed` |
| `npm run db:migrate` | cria/aplica migração em desenvolvimento |
| `npm run db:seed` | popula o banco (ignora se já houver usuários) |
| `npm run db:reset` | **apaga** o banco e recria do zero |
| `npm test` | testes unitários + integração |
| `npm run test:unit` | só os testes de domínio (não precisam de banco) |

Os testes de integração usam um banco **descartável** informado em `DATABASE_URL_TEST`
(as migrações são aplicadas automaticamente). Sem a variável, a suíte é pulada:

```bash
# Ubuntu
DATABASE_URL_TEST="postgresql://greencode:greencode@localhost:5432/greencode_test" npm test
# Windows PowerShell
$env:DATABASE_URL_TEST="postgresql://greencode:greencode@localhost:5432/greencode_test"; npm test
```

> **npm 11+:** scripts de instalação vêm bloqueados por padrão. O `package.json` libera só
> `prisma`, `@prisma/engines` e `esbuild`, e nega `msgpackr-extract` (aceleração nativa
> opcional do BullMQ, que exigiria compilador C++; sem ela o BullMQ usa a versão em JavaScript).

## Exemplos de uso da API pública

```bash
CHAVE="gc_..."   # chave impressa pelo seed

# Rastreabilidade de um equipamento
curl localhost:3333/api/v1/public/rastreabilidade/GCNB0000000017 -H "x-api-key: $CHAVE"

# Submissão de lote (mesmas regras da operação interna)
curl -X POST localhost:3333/api/v1/public/lotes -H "x-api-key: $CHAVE" -H 'content-type: application/json' \
  -d '{"notaFiscal":"NF-9001","transportadora":"TransRapida","dataEntrada":"2026-11-20T09:00:00-03:00",
       "equipamentos":[{"tipo":"NOTEBOOK","marca":"Dell","modelo":"Latitude 5490","anoFabricacao":2019,
                        "estadoFisico":"USADO_LEVE","pesoQuilogramas":1.8}]}'

# Relatório preditivo assíncrono: 202 + id da tarefa
curl -X POST localhost:3333/api/v1/public/relatorios -H "x-api-key: $CHAVE" -H 'content-type: application/json' \
  -d '{"tipo":"PREDITIVO_VIDA_UTIL","formato":"CSV"}'
curl localhost:3333/api/v1/public/relatorios/<tarefaId> -H "x-api-key: $CHAVE"            # polling
curl localhost:3333/api/v1/public/relatorios/<tarefaId>/download -H "x-api-key: $CHAVE"   # arquivo
```

## Endpoints

### Pública: `/api/v1/public` (cabeçalho `X-API-Key`)

| Método | Rota | Escopo |
|---|---|---|
| GET | `/rastreabilidade/:codigoBarras` | RASTREABILIDADE_LEITURA |
| GET | `/lotes?pagina&tamanho&inicio&fim&status` · `/lotes/:id` | LOTES_LEITURA |
| POST | `/lotes` | LOTES_ESCRITA |
| GET | `/analises/eficiencia` · `/analises/rentabilidade?tipo` · `/analises/vida-util` | ANALISES_LEITURA |
| POST | `/relatorios` · GET `/relatorios/:id` · `/relatorios/:id/download` | RELATORIOS_SOLICITAR |

Limite por plano: BASICO 60, PROFISSIONAL 300, CORPORATIVO 1200 requisições/minuto.
Cada parceiro só enxerga dados da organização a que está vinculado.

### Administrativa: `/api/v1/admin` (JWT, ADMINISTRADOR)

| Método | Rota |
|---|---|
| GET/POST | `/parceiros` · PATCH `/parceiros/:id` |
| GET/POST | `/parceiros/:id/chaves` (a chave completa aparece só na criação) |
| DELETE | `/chaves/:id` (revogação imediata) |

### Interna: `/api/v1/internal` (JWT)

Todas as rotas da Atividade 2 (autenticação, usuários, organizações, lotes, equipamentos,
relatórios e auditoria), agora sob o prefixo `/internal`, mais:

| Método | Rota | Papéis |
|---|---|---|
| POST | `/analises/execucoes` | ADMIN, AUDITOR, GESTOR_ALMOXARIFADO |
| GET | `/analises/execucoes` · `/analises/execucoes/:id` · `/analises/vida-util/acuracia` | todos |
| POST | `/relatorios/assincronos` · GET `/relatorios/:id` · `/relatorios/:id/download` | ADMIN, AUDITOR |
| PATCH | `/equipamentos/:id/status` agora aceita `valorRecuperado` | ADMIN, GESTOR_ALMOXARIFADO |

Erros sempre no formato `{ "erro": { "codigo", "mensagem", "detalhes"? } }`:
400 validação · 401 não autenticado · 403 sem permissão/escopo · 404 não encontrado ·
409 conflito · 410 relatório expirado · 422 regra de negócio · 429 limite excedido.

## Estrutura

```
prisma/
  schema.prisma              modelos da Atividade 2 + tabelas analíticas, parceiros, tarefas
  migrations/*_init/         Atividade 2 (CHECKs, triggers, sequence)
  migrations/*_av3_*/        Atividade 3 + backfill a partir do journal
  seed.ts                    massa de dados, cenários de validação, histórico analítico
src/
  server.ts                  entrada: servidor, worker embutido, agendador, graceful shutdown
  worker.ts                  worker dedicado de relatórios (BullMQ)
  app.ts                     composição (DI manual) e plugins do Fastify
  domain/                    regras puras: análises, estatística, chaves de API, ...
  services/                  casos de uso: análises, chaves, relatórios assíncronos, ...
  repositories/              acesso a dados com Prisma Client + Unit of Work
  infra/                     fila (BullMQ | memória), armazenamento de arquivos, agendador
  http/                      schemas, controllers, rotas (/internal, /admin, /public), plugins
tests/
  unit/                      domínio, estatística, análises, chaves e fila
  integration/               jornada da Atividade 2 e API pública contra PostgreSQL real
```
