# greencode: servidor monolítico (Atividade 2)

API RESTful do greencode, plataforma de logística reversa de equipamentos eletrônicos.
Esta versão substitui o CLI com arquivos criptografados (Atividade 1) por um servidor HTTP
monolítico com banco relacional.

**Pilha:** Node.js · TypeScript · Fastify 5 · Prisma ORM 7 · PostgreSQL · JWT (`@fastify/jwt`) · bcrypt · Swagger/OpenAPI

As decisões de arquitetura, os trade-offs e as alternativas rejeitadas estão em
[docs/ARQUITETURA.md](docs/ARQUITETURA.md).

---

## Requisitos

| Item | Versão |
|---|---|
| Node.js | 20.19+, 22.12+ ou 24+ (exigência do Prisma 7) |
| PostgreSQL | 14+ (o `docker-compose.yml` sobe o 17) |
| Sistema operacional | Windows 10+ · Ubuntu 24.04.3+ e derivados |

Nenhuma dependência nativa precisa ser compilada: `bcryptjs` é JavaScript puro e o Prisma 7
conversa com o banco pelo driver `pg` (sem query engine binário por sistema operacional).

## Como rodar

```bash
# 1. Banco de dados (ou use um PostgreSQL já instalado e ajuste DATABASE_URL)
docker compose up -d

# 2. Variáveis de ambiente
cp .env.example .env              # Ubuntu
Copy-Item .env.example .env       # Windows PowerShell
#    -> troque JWT_SECRET por um valor aleatório (o comando para gerar está no arquivo)

# 3. Dependências
npm install

# 4. Gera o Prisma Client, aplica as migrações e popula o banco
npm run setup

# 5. Servidor em modo desenvolvimento
npm run dev
```

- API: `http://localhost:3333/api/v1`
- Documentação interativa (Swagger): `http://localhost:3333/docs`
- Saúde: `http://localhost:3333/health`

Produção: `npm run build && npm start` (roda o JavaScript compilado em `dist/`).

### Usuários criados pelo seed (somente desenvolvimento)

| Usuário | Senha | Papel |
|---|---|---|
| admin | Admin@2026 | ADMINISTRADOR |
| cadastro | Cadastro@2026 | OPERADOR_CADASTRO |
| almoxarifado | Almox@2026 | GESTOR_ALMOXARIFADO |
| auditor | Auditor@2026 | AUDITOR |
| legado | Legado@2026 | AUDITOR (hash SHA-256 vindo do CLI; vira bcrypt no 1º login) |

## Scripts

| Script | O que faz |
|---|---|
| `npm run dev` | servidor com recarga automática (tsx watch) |
| `npm run build` / `npm start` | compila para `dist/` / roda o compilado |
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

> **npm 11+:** scripts de instalação vêm bloqueados por padrão. O `package.json` já traz
> `allowScripts` liberando só `prisma`, `@prisma/engines` e `esbuild`. Se o `npm install`
> avisar sobre outros pacotes, revise com `npm install-scripts ls`.

## Exemplo de uso

O comando do CLI `lote criar --org BR001 --nf 123456 --transp TransRapida` vira:

```bash
TOKEN=$(curl -s -X POST localhost:3333/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"usuario":"almoxarifado","senha":"Almox@2026"}' | jq -r .token)

curl -X POST localhost:3333/api/v1/lotes \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "organizacao": "BR001", "notaFiscal": "123456", "transportadora": "TransRapida",
    "dataEntrada": "2026-10-18T09:00:00-03:00",
    "equipamentos": [
      {"tipo":"NOTEBOOK","marca":"Dell","modelo":"Latitude 5490","anoFabricacao":2019,
       "estadoFisico":"USADO_LEVE","pesoQuilogramas":1.8}
    ]
  }'
```

Toda alteração recebe o campo `versao` lido antes (concorrência otimista). Se outra requisição
alterou o registro nesse meio-tempo, a resposta é **409**: recarregue e tente de novo.

## Endpoints (`/api/v1`)

| Método | Rota | Papéis |
|---|---|---|
| POST | `/auth/login` | público |
| POST | `/auth/renovar` · `/auth/logout` · GET `/auth/eu` · PUT `/auth/senha` | autenticado |
| GET/POST | `/usuarios` | ADMINISTRADOR |
| GET | `/organizacoes` · `/organizacoes/:idOuCodigo` | todos |
| POST | `/organizacoes` | ADMIN, OPERADOR_CADASTRO |
| PATCH | `/organizacoes/:id/endereco` | ADMIN, OPERADOR_CADASTRO |
| POST | `/organizacoes/:id/desativar` · `/contrato` · `/contrato/renovar` | ADMIN, OPERADOR_CADASTRO |
| GET | `/lotes?inicio&fim&status&organizacao` · `/lotes/:id` · `/lotes/:id/relatorio-triagem` | todos |
| POST | `/lotes` · `/lotes/:id/equipamentos` | ADMIN, GESTOR_ALMOXARIFADO |
| DELETE | `/lotes/:id/equipamentos/:equipamentoId?versao=` | ADMIN, GESTOR_ALMOXARIFADO |
| PATCH | `/lotes/:id/status` | ADMIN, GESTOR_ALMOXARIFADO |
| GET | `/equipamentos` · `/equipamentos/:idOuCodigoBarras/rastreio` | todos |
| PATCH | `/equipamentos/:id/status` · `/equipamentos/:id/estado-fisico` | ADMIN, GESTOR_ALMOXARIFADO |
| GET | `/relatorios/status` · `/relatorios/organizacoes/:id` · `/relatorios/financeiro` | ADMIN, AUDITOR |
| GET | `/auditoria/journal` | ADMIN, AUDITOR |

Erros sempre no formato `{ "erro": { "codigo", "mensagem", "detalhes"? } }`:
400 validação · 401 não autenticado · 403 sem permissão · 404 não encontrado ·
409 conflito (duplicidade/versão) · 422 regra de negócio.

## Estrutura

```
prisma/
  schema.prisma          modelos, enums, relacionamentos, índices
  migrations/*_init/     SQL gerado + SQL manual (CHECKs, triggers, sequence)
  seed.ts                massa de dados via serviços + cenários de validação
src/
  server.ts              entrada: porta por env, graceful shutdown
  app.ts                 composição (DI manual) e plugins do Fastify
  domain/                regras de negócio puras (sem HTTP e sem banco)
  services/              casos de uso: autorização, transações, journal
  repositories/          acesso a dados com Prisma Client + Unit of Work
  http/                  schemas (JSON Schema), controllers, rotas, plugins
tests/
  unit/                  regras de domínio
  integration/           jornada completa contra PostgreSQL real
```
