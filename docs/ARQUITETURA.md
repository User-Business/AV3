# greencode: decisões de arquitetura (Atividade 2)

Este documento justifica as escolhas feitas na migração do greencode de CLI com arquivos
criptografados para um servidor monolítico com banco relacional. Para cada decisão ele registra
os trade-offs considerados e as alternativas rejeitadas.

---

## 1. Visão geral

```
            HTTP (JSON)                       Prisma Client              SQL
 cliente ───────────────► Controller ──► Service ──► Repository ──► PostgreSQL
 (SPA/curl)   schema       (HTTP)      (regras,    (consultas)     (constraints,
              JSON                     transação,                   triggers)
              Schema                   autorização)
                                          │
                                          ▼
                                       domain/  (entidades e regras puras)
```

| Camada | Responsabilidade | Não conhece |
|---|---|---|
| `http/` (controllers, rotas, schemas, plugins) | receber a requisição, validar o formato (JSON Schema), extrair o `Ator` do JWT, chamar o serviço e escolher o status HTTP | regras de negócio, Prisma |
| `services/` | casos de uso: autorização, fronteira de transação, journal de auditoria, orquestração | HTTP, Fastify |
| `domain/` | entidades (`Equipamento`, `Lote`, `Contrato`) e regras puras: máquinas de estado, CNPJ, depreciação, código de barras | HTTP, banco |
| `repositories/` | consultas Prisma e atualização com versão | regras de negócio |
| banco (migração) | integridade final: UNIQUE, FK, CHECK, triggers | — |

O ganho prático dessa separação aparece no `prisma/seed.ts`: ele usa **os mesmos serviços** sem
passar por HTTP. Uma futura interface CLI ou um consumidor de fila faria o mesmo.

**Alternativa rejeitada:** colocar a lógica direto nos handlers do Fastify. É mais rápido de
escrever, mas prende as regras ao HTTP e impede o reaproveitamento citado acima.

## 2. Fastify em vez de Express

- Validação nativa com **JSON Schema** (Ajv). Os schemas em `src/http/schemas.ts` validam a
  entrada, serializam a saída (o `fast-json-stringify` descarta campos não declarados, então não
  há vazamento acidental de `hashSenha`) e geram o **OpenAPI** em `/docs`. Uma fonte, três usos.
- Tratamento de erro centralizado (`setErrorHandler`) e arquitetura de plugins
  (`autenticacao`, `tratamento-erros`).
- Os schemas são escritos com **TypeBox**, e o tipo TypeScript do request sai do próprio schema
  (`Entrada<typeof rotasLote.criar>`), o que impede o tipo e a validação de divergirem.

**Alternativa rejeitada:** Express + Zod/Joi. Funciona, mas exige bibliotecas extras para
validação, serialização e documentação, que o Fastify já traz.

## 3. Persistência com Prisma 7 + PostgreSQL

### 3.1 Modelo

Relacionamentos pedidos na atividade e no diagrama UML:

| Relação | Multiplicidade | Como foi implementada |
|---|---|---|
| Organizacao → Contrato | 1 : 0..1 | FK `contratos.organizacao_id` com `@unique` (o lado "dono" da FK é o contrato) |
| Organizacao → Lote | 1 : 0..* | FK `lotes.organizacao_id` |
| Lote → Equipamento | 1 : **1..*** | FK + **constraint trigger diferida**: um lote sem equipamento não consegue ser commitado |
| Equipamento → Movimentacao | 1 : 0..* | FK com cascade (ver 3.3) |

- Arrays do modelo orientado a objetos (`Lote.equipamentos`, `Equipamento.historicoMovimentacao`,
  `Organizacao.contratoVigente`) viraram **relações**, não colunas. Esse é o *impedance mismatch*
  descrito na introdução da atividade.
- `Contrato.clausulas` é **JSONB**, como sugerido para dados semiestruturados.
- Dinheiro (`valorMensal`) e peso usam **Decimal**. O diagrama dizia `number`, mas
  `0.1 + 0.2 !== 0.3` em ponto flutuante, e um relatório financeiro não pode errar centavos.
- Foram acrescentados dois modelos que a lista da atividade não cita, mas que o próprio texto
  exige: `Usuario`, porque "verificar o hash da senha armazenado no **banco de dados**"
  pressupõe uma tabela de credenciais, e `JournalTransacao`, sucessor do journal do CLI.
- `Organizacao.codigo` (ex.: `BR001`) foi mantido porque o CLI identificava organizações assim
  (`lote criar --org BR001`).

### 3.2 O que o Prisma não expressa e foi escrito à mão na migração

O `schema.prisma` não tem sintaxe para CHECK, trigger nem sequence. A migração
`prisma/migrations/*_init/migration.sql` foi gerada com `prisma migrate dev --create-only` e
completada manualmente com:

| Recurso | Para quê |
|---|---|
| UNIQUE (`cnpj`, `codigo_barras_interno`, `(organizacao_id, nota_fiscal)`, `(lote_id, posicao_no_lote)`) | garantia definitiva de unicidade, mesmo com requisições simultâneas |
| CHECK (formato do CNPJ, período do contrato, valor ≥ 0, peso > 0, cláusulas não vazias...) | barrar valores impossíveis |
| Trigger de **transição de status** em `equipamentos` e `lotes` | repete a máquina de estados do domínio; inclui "desmonte só após triagem completa do lote" |
| Trigger de **remoção** de equipamento | só com o lote `RECEBIDO` |
| Constraint trigger **diferida** | multiplicidade 1..* de Lote → Equipamento, verificada no COMMIT |
| Trigger **append-only** em `movimentacoes` | histórico de rastreabilidade não pode ser alterado |
| Trigger de **retenção** no journal | imutável; DELETE só de registros com mais de 180 dias (política do CLI) |
| `SEQUENCE equipamento_codigo_seq` | numeração do código de barras sem corrida entre requisições |

Os triggers usam SQLSTATE próprios (`GC001`…`GC006`), que a API traduz para **422**.

**Trade-off:** as regras de status existem em dois lugares (TypeScript e PL/pgSQL). O domínio
dá mensagens claras e testes rápidos; o banco é a última linha de defesa contra escrita direta,
outro sistema ou um bug no serviço. O custo é manter os dois em sincronia, e o teste de
integração "triggers do banco barram escrita direta" cobre essa divergência.

### 3.3 Cascade em movimentações × imutabilidade

Movimentações são append-only, mas remover um equipamento cadastrado por engano (lote ainda
`RECEBIDO`) precisa levar o histórico junto. O trigger permite DELETE **apenas** quando vem em
cascata (`pg_trigger_depth() > 1`), e a remoção do equipamento, por sua vez, só é aceita com o
lote `RECEBIDO`.

### 3.4 Prisma 7 e driver adapters

O Prisma 7 se conecta pelo driver `pg` (`@prisma/adapter-pg`) em vez de um query engine em Rust.
Para o requisito de plataforma isso elimina a configuração de `binaryTargets`
(`windows`, `debian-openssl-3.0.x`...): o mesmo `node_modules` roda no Windows e no Ubuntu.
A URL do banco fica em `prisma.config.ts`, e não mais no `schema.prisma`.

## 4. Transações e concorrência

### 4.1 Fronteira da transação

O **serviço** decide o que é atômico, por meio de uma *Unit of Work*
(`UnidadeDeTrabalho.emTransacao`, que usa a `$transaction` interativa do Prisma). Operações
transacionais:

| Operação | O que vai junto |
|---|---|
| Criar lote | lote + N equipamentos + N movimentações de entrada + journal |
| Mudar status do equipamento | update + movimentação + journal |
| Iniciar triagem do lote | status do lote + todos os equipamentos → `EM_TRIAGEM` + movimentações + journal |
| Cadastrar organização | organização + contrato (opcional) + journal |
| Login com hash legado | rehash bcrypt + último acesso + journal |

O journal é gravado **na mesma transação** da alteração, então não existe alteração sem registro
de auditoria nem registro de auditoria de algo que foi desfeito.

### 4.2 Concorrência otimista (`versao`)

Todo modelo mutável tem `versao`. O update é condicional:

```ts
updateMany({ where: { id, versao }, data: { ...dados, versao: { increment: 1 } } })
// 0 linhas afetadas -> o registro existe? 409 (conflito) : 404
```

O cliente envia a versão que leu. Se outra requisição alterou o registro antes, ele recebe 409 em
vez de sobrescrever silenciosamente (*lost update*). O teste de integração dispara duas inclusões
simultâneas com a mesma versão e verifica que exatamente uma recebe 201 e a outra 409.

Na inclusão de equipamento, o UPDATE da versão do lote também funciona como **trava de linha**
até o fim da transação, o que serializa o cálculo de `posicaoNoLote`.

**Alternativas rejeitadas:**
- *Lock pessimista (`SELECT ... FOR UPDATE`) em toda leitura:* segura conexões e não detecta o
  caso "o usuário editou uma tela aberta há 10 minutos".
- *Isolamento SERIALIZABLE global:* exige retry em toda operação e custa mais sob carga.
- *ETag/If-Match em vez de `versao` no corpo:* é mais "REST puro" e seria a evolução natural.
  Optou-se pelo campo no corpo por ser explícito na documentação Swagger e simples para o SPA.

`Movimentacao` também tem `versao` (a atividade pede o campo "em cada modelo"), mas como a tabela
é append-only o valor nunca muda. O comentário no schema registra isso.

## 5. Autenticação e autorização

### 5.1 bcrypt × SHA-256 (inconsistência entre as atividades)

A Atividade 1 especificou **SHA-256 com salt**. A Atividade 2 pede "a **mesma** biblioteca que
você empregou no CLI, **como bcrypt**". As duas instruções se contradizem, e SHA-256 é um hash
rápido, inadequado para senhas porque facilita força bruta.

**Decisão:** bcrypt (custo 12) para todas as senhas novas e **migração transparente**. Um hash
legado `sha256$<salt>$<hex>` importado do CLI é aceito no login e substituído por bcrypt na
mesma transação (operação `LOGIN_REHASH` no journal). Ninguém precisa redefinir senha.

Foi usado o `bcryptjs` (JavaScript puro) em vez do `bcrypt` (addon nativo), porque o nativo pode
exigir node-gyp e toolchain C++ no Windows, o que atrapalha o requisito de plataforma. O custo
é ficar ~30% mais lento, irrelevante para login.

### 5.2 JWT

- `@fastify/jwt`, HS256, expiração de **30 minutos** (mesma política de sessão do CLI) e
  `POST /auth/renovar` no lugar de `Sessao.renovar()`.
- Claims: `sub` (id), `usuario`, `papel` e `tv` (versão do token).
- **Revogação:** JWT puro não tem logout. Cada requisição faz uma busca por chave primária do
  usuário, confere se ele continua ativo e se `tv` bate com `usuarios.versao_token`. Logout e troca
  de senha incrementam a versão e invalidam todos os tokens já emitidos.
  **Trade-off:** perde-se o "100% stateless" em troca de revogação imediata e de bloqueio de
  usuário desativado. O custo é uma consulta indexada por requisição.
- O login compara a senha mesmo quando o usuário não existe (contra um hash fictício) e devolve
  sempre "Usuário ou senha inválidos", para que nem o tempo de resposta nem a mensagem revelem
  quais contas existem.

### 5.3 Autorização no serviço

O texto pede que "os serviços de negócio consultem o papel do usuário". Os serviços recebem um
`Ator` e chamam `exigirPermissao(ator, 'lote:escrever')`. A matriz de permissões fica em
`src/domain/autorizacao.ts` e reproduz a segregação da Atividade 1: o auditor só lê, o operador
de cadastro cuida de organizações e contratos, e o gestor de almoxarifado cuida de lotes e
equipamentos.

## 6. Regras de negócio herdadas do CLI

| Regra | Onde |
|---|---|
| CNPJ com dígitos verificadores, **incluindo o CNPJ alfanumérico** (IN RFB 2.229/2024, emitido desde jul/2026). Testado contra o exemplo oficial `12.ABC.345/01DE-35` | `domain/cnpj.ts` |
| CNPJ único | serviço (mensagem clara) + UNIQUE (garantia sob concorrência) |
| Data de entrada do lote: não futura e no máximo 90 dias atrás | `domain/lote.ts` |
| Desmonte só após triagem completa | `domain/equipamento.ts` + trigger |
| Justificativa ao cair **duas ou mais** categorias de estado físico | `domain/equipamento.ts` |
| Journal com retenção mínima de 180 dias | tabela + trigger |

Pontos de interpretação:
- **"Duas categorias abaixo"** foi lido como "duas **ou mais**". Ler como "exatamente duas"
  deixaria uma queda de três categorias sem justificativa.
- **"Triagem completa"** foi lido como triagem completa **do lote** (`TRIAGEM_CONCLUIDA`). Para
  chegar lá, cada equipamento também precisa ter saído de `EM_TRIAGEM`, então as duas leituras
  são atendidas.
- Regras novas, coerentes com o domínio: lote só para organização **ativa com contrato
  vigente**; nota fiscal única por organização; descarte direto na triagem só para equipamentos
  `DANIFICADO_GRAVE`/`INSERVIVEL` e com justificativa.
- **Fuso horário:** vigência de contrato usa a data de calendário em `America/Sao_Paulo`.
  Calcular "hoje" em UTC faria um contrato que vence em 31/12 aparecer como vencido às 21h do
  próprio dia 31.

## 7. Seed e migração de dados

`prisma/seed.ts` popula o banco **passando pelos serviços**. Assim o seed também verifica que as
regras foram transportadas: ele cria lotes em todos os estágios (recebido, em triagem, em
desmonte, finalizado), organizações em situações diferentes (vigente, CNPJ alfanumérico,
contrato vencido, sem contrato, inativa) e, ao final, executa 11 cenários que **devem** ser
rejeitados, imprimindo o motivo de cada um.

Dados reais do CLI seriam importados por um script que decifra os arquivos AES-256 e chama os
mesmos serviços. As senhas chegam no formato `sha256$...` e migram sozinhas (seção 5.1).

## 8. Compatibilidade de plataforma (Windows 10+ / Ubuntu 24.04.3+)

| Risco | Tratamento |
|---|---|
| Addon nativo (bcrypt, query engine) | `bcryptjs` e Prisma 7 com driver `pg`, sem binários nativos por SO |
| Sinais de encerramento | Windows não envia SIGTERM real: tratamos `SIGINT` (Ctrl+C), `SIGTERM` (systemd/Docker) e `SIGBREAK` (Ctrl+Break no Windows) |
| Scripts npm | nenhum `rm -rf`, `export VAR=` ou aspas simples; tudo via ferramentas Node |
| Quebras de linha | `.gitattributes` com `eol=lf`, para o SQL e os scripts não quebrarem ao alternar entre SOs |
| Banco | `docker-compose.yml` idêntico nos dois (Docker Desktop/WSL2 no Windows) |
| Caminhos | nenhum caminho absoluto ou separador `\`/`/` fixo no código |

### Graceful shutdown

`src/server.ts`: ao receber um sinal, o Fastify para de aceitar conexões (novas requisições
recebem 503), espera as que estão em andamento, fecha o pool do Prisma (hook `onClose`) e sai.
Se travar por mais de 10 s, a saída é forçada. A porta vem de `PORT`.

## 9. Limites do monólito e evolução

O monólito é a escolha certa agora: um deploy, depuração simples e transações ACID locais entre
lote, equipamentos e movimentações. A estrutura em camadas deixa as fronteiras prontas para a
divisão se ela for necessária. Os sinais de que o monólito chegou ao limite seriam:

- **relatórios pesados competindo com transações**: a primeira resposta é uma réplica de leitura,
  e depois processamento assíncrono com fila (tema da Atividade 3);
- **parceiros externos** consumindo a API: chave de API, rate limit e versionamento separado
  entre API pública e interna (a rota já está sob `/api/v1`);
- **equipes independentes** em módulos distintos, como cadastro, almoxarifado e financeiro: os
  serviços atuais são os candidatos naturais a microsserviços, mas aí as transações locais viram
  sagas ou eventos, o que só compensa com escala real.

## 10. Testes

- `tests/unit`: 27 testes de domínio (CNPJ, máquinas de estado, justificativa, depreciação,
  contratos e fuso, senhas e hash legado, permissões).
- `tests/integration`: jornada completa via HTTP contra PostgreSQL real: login legado com rehash,
  cadastro com contrato, 403 por papel, criação de lote, **corrida de concorrência real (201/409)**,
  remoção com cascata, versão desatualizada, fluxo completo de triagem e desmonte com todas as
  regras, triggers barrando escrita direta, constraint diferida (lote vazio não persiste),
  auditoria, relatório financeiro em Decimal, logout revogando token e OpenAPI publicado.
