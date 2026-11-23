# greencode: relatório técnico da Atividade 3

**Camada analítica, API pública e processamento assíncrono**

Este relatório justifica as decisões tomadas para evoluir o monólito da Atividade 2. As decisões
anteriores (camadas, transações, concorrência otimista, autenticação JWT) estão em
[ARQUITETURA.md](ARQUITETURA.md) e continuam valendo.

---

## 1. Visão geral

A Atividade 3 **acrescenta** ao sistema existente, sem reescrevê-lo:

| Camada | O que entrou |
|---|---|
| `domain/` | `analises.ts` e `estatistica.ts` (cálculos puros), `chave-api.ts` (formato, hash e escopos) |
| `repositories/` | `analise`, `parceiro` e `tarefa`; os repositórios existentes ganharam consultas por organização |
| `services/` | `AnaliseService`, `ChaveApiService` e `RelatorioAssincronoService`; lote e equipamento passaram a registrar os dados que alimentam as análises |
| `infra/` (nova) | fila (BullMQ ou memória), armazenamento de arquivos, agendador node-cron |
| `http/` | rotas em três prefixos, plugin de chave de API, controllers e schemas novos |
| banco | uma migração nova, com backfill dos dados existentes a partir do journal |

As 39 verificações da Atividade 2 (testes unitários e jornada de integração) continuam passando
sem alteração de comportamento. A única mudança visível para quem já consumia a API é o
prefixo `/internal`, discutido na seção 3.1.

```
                 X-API-Key + escopo + limite                 JWT + papel
 parceiro ───────────► /api/v1/public ───┐      ┌──── /api/v1/internal ◄──────── front-end
                                         ▼      ▼
                                      services (regras, transações, autorização)
                                         │      │                ▲
             FilaTarefas (BullMQ|memória)│      │ repositories    │ node-cron (02:00)
                     ▲        ▼          │      ▼                 │
                POST relatório  worker ──┘   PostgreSQL ──────────┘
                                   │
                                   └──► armazenamento/relatorios (CSV/JSON) ──► download / webhook
```

## 2. Camada analítica

### 2.1 Dados de origem: o que precisou mudar no modelo

As três análises dependem de informações que a Atividade 2 não guardava de forma consultável:

| Análise | Dado necessário | Solução |
|---|---|---|
| Eficiência operacional | quando a triagem começou e terminou, e quem a concluiu | colunas `inicio_triagem_em`, `conclusao_triagem_em` e `responsavel_triagem` em `lotes`, preenchidas por `LoteService.alterarStatus` |
| Rentabilidade | quanto cada equipamento rendeu de fato | coluna `valor_recuperado` em `equipamentos`, informada ao passar para `PECAS_REAPROVEITADAS` ou `MATERIAL_RECICLAVEL` |
| Vida útil | série temporal do estado físico | tabela `historico_estado_fisico` (append-only, como `movimentacoes`), gravada na entrada do equipamento e a cada reavaliação |

Os dados que já existiam **não foram perdidos**. O journal da Atividade 2 registrava cada mudança
de status do lote e de estado físico (com os estados antes e depois), então a migração
reconstrói a partir dele os marcos de triagem e o histórico de estados. No banco populado pelo
seed da Atividade 2, isso gerou 15 pontos de histórico e os marcos dos três lotes que já tinham
passado pela triagem.

O banco também protege as regras novas: um CHECK impede `valor_recuperado` em equipamentos que
não foram reaproveitados ou reciclados, outro garante a coerência das datas de triagem, e um
trigger torna o histórico de estado imutável, com a mesma exceção de cascata usada em
`movimentacoes`.

### 2.2 Organização do código

Os cálculos ficam em `domain/analises.ts` como **funções puras**: recebem arrays e devolvem
métricas, sem banco nem HTTP, seguindo o mesmo princípio do `domain/` da Atividade 2. O
`AnaliseService` carrega os dados pelos repositórios, chama os cálculos e persiste o resultado.
As mesmas funções servem ao endpoint, ao agendador e ao relatório preditivo, e são testadas
isoladamente.

### 2.3 Os três insights

**Eficiência operacional.** Mede o tempo entre a entrada do lote e a conclusão da triagem,
agregado no geral, por operador e por mês (média, mediana, desvio padrão amostral e percentil 90).
Um grupo é marcado como **gargalo** quando tem pelo menos 3 lotes e mediana 25% acima da
mediana **dos demais lotes**. A regra passou por duas versões, testadas com os dados reais do seed:

1. *Média do grupo contra média geral*: um único lote da Atividade 2 que ficou 30 dias aguardando
   triagem (720 h) elevou a média geral a 79 h e escondeu o operador lento. A troca pela **mediana**
   resolve isso, porque um caso extremo não a desloca.
2. *Mediana do grupo contra mediana geral*: ainda falhava. O operador lento processa cerca de um
   terço dos lotes e puxa a referência geral na direção dele próprio. Comparar cada grupo com
   **os demais lotes** elimina esse efeito: o operador mais lento (mediana de 62 h contra cerca de
   40 h dos colegas) passou a ser sinalizado.

**Rentabilidade por tipo.** Agrega o valor efetivamente recuperado em três granularidades (tipo;
tipo e estado físico; tipo, marca e modelo) e calcula também o **valor por quilograma**, útil para
decidir a logística de coleta. O resultado é ordenado do maior para o menor retorno e funciona
como ranking de priorização.

**Vida útil remanescente.** O estado físico vira uma escala ordinal (0 = NOVO … 6 = INSERVIVEL)
e, para cada tipo de equipamento, é ajustada por **mínimos quadrados ordinários** a reta

```
nível = a + b · idade      b = Σ(x − x̄)(y − ȳ) / Σ(x − x̄)²      a = ȳ − b·x̄      R² = 1 − SQres/SQtot
```

A idade prevista de inservibilidade é `(6 − a) / b`. Para cada equipamento, a vida remanescente
parte do **estado atual** dele, e não apenas da idade: `(6 − nível_atual) / b`. Assim, um
equipamento mais conservado que a média do tipo recebe uma projeção maior. Com menos de 5
observações, ou sem tendência de degradação (`b ≤ 0`), o modelo usa **suavização exponencial
simples** (α = 0,3) da taxa nível/idade e marca o resultado como `suficiente = false`. Um R²
abaixo de 0,3 gera o alerta "ajuste fraco".

### 2.4 Escolha da biblioteca estatística

Foi adotada a **simple-statistics**, e não a mathjs:

- **Escopo adequado**: a necessidade é estatística descritiva e regressão de uma variável, que é
  exatamente o que ela oferece. A mathjs é uma álgebra computacional completa (matrizes, unidades,
  parser de expressões), muito maior, e quase nada dela seria usado.
- **Sem dependências e com tipos incluídos**, o que reduz superfície de ataque e atrito de
  instalação no Windows e no Ubuntu.
- **Funções puras** sobre `number[]`, sem estado global de configuração.

A regressão foi **escrita à mão** (`domain/estatistica.ts`) para deixar o método explícito e
calcular o R² junto. Os testes conferem o resultado contra `linearRegression` e `rSquared` da
própria biblioteca. Da simple-statistics vêm `mean`, `median`, `sampleStandardDeviation` e
`quantileSorted`. Um modelo com várias variáveis (idade, tipo e marca) justificaria a mathjs ou
um serviço dedicado de ciência de dados, mas não é o caso do volume atual.

### 2.5 Modelagem das tabelas analíticas

```
execucoes_analise (1) ──< metricas_eficiencia
                  (1) ──< metricas_rentabilidade
                  (1) ──< previsoes_vida_util
```

- **`execucoes_analise`** é o cabeçalho **imutável** de cada cálculo: tipo, origem (`AGENDADA`,
  `SOB_DEMANDA`, `API_PUBLICA`), escopo (organização; nulo = base completa), período, número de
  amostras, duração e um `resumo` em JSONB para leitura rápida. Nenhuma execução é sobrescrita,
  o que garante o histórico pedido pela atividade.
- As **métricas ficam em tabelas filhas tipadas**, e não em um único JSON, para que possam ser
  consultadas e indexadas em SQL. Exemplo: "como evoluiu a idade prevista de inservibilidade dos
  notebooks nas últimas 12 execuções?" é uma consulta simples a `previsoes_vida_util`.
- `ON DELETE CASCADE` nas filhas permite expurgar execuções antigas apagando só o cabeçalho.
- O índice `(tipo, gerada_em)` atende à consulta mais frequente: a execução mais recente de um tipo.

**Previsão × realização.** `GET /api/v1/internal/analises/vida-util/acuracia` cruza cada
equipamento que já se tornou inservível (`inservivel_em`) com a previsão da **última execução
anterior** a esse evento e calcula o erro absoluto médio, em anos, no geral e por tipo. Com a
execução histórica criada pelo seed, foram 47 comparações e erro médio de cerca de 1,2 ano. É
esse ciclo que permite refinar os modelos ao longo do tempo.

### 2.6 Execução agendada e sob demanda

- O **node-cron** recalcula as três análises sobre a base completa todos os dias às 02:00
  (`ANALISES_CRON`, fuso `America/Sao_Paulo`), com `noOverlap`, para que uma execução lenta não se
  sobreponha à seguinte. Outra rotina, às 03:30, apaga os relatórios cujo prazo de download venceu.
- Os endpoints públicos reaproveitam a execução das últimas 24 h e só recalculam quando ela não
  existe. Assim, uma chamada de parceiro não dispara um cálculo completo a cada requisição.
- Usuários internos podem forçar uma execução, com período e organização opcionais.

## 3. API pública

### 3.1 Segregação e versionamento

| Prefixo | Público | Autenticação | Política |
|---|---|---|---|
| `/api/v1/public` | parceiros | `X-API-Key` + escopos | limite por plano; dados restritos à organização da chave |
| `/api/v1/internal` | front-end e operação | JWT | papéis da Atividade 1; limite de 10 tentativas/min no login |
| `/api/v1/admin` | gestão | JWT, papel ADMINISTRADOR | parceiros e chaves |

As rotas da Atividade 2 passaram de `/api/v1/...` para `/api/v1/internal/...`. Isso é uma quebra
de contrato, mas nesse momento a API interna ainda não tinha consumidores (o front-end não foi
construído), então a mudança tem custo zero e foi feita antes de existir alguém para quebrar. Cada
prefixo é um plugin Fastify encapsulado: os hooks de autenticação de um escopo não vazam para os
outros, e não é possível registrar uma rota pública "esquecendo" a chave de API.

**Versionamento**: a versão *major* fica na URL (`/v1`), e a versão semântica completa do contrato
vai em todas as respostas públicas, no cabeçalho `x-api-version: 1.0.0`. Mudanças compatíveis
(campos opcionais, rotas novas) incrementam *minor* ou *patch* dentro de `/v1`. Mudanças
incompatíveis criam `/api/v2`, que convive com a v1 durante um período de depreciação anunciado
nos cabeçalhos `Deprecation` e `Sunset` (RFC 8594). Os schemas de resposta da API pública são
próprios: o campo `versao` (bloqueio otimista interno) e os nomes de operadores nunca aparecem
para parceiros, mesmo que o modelo interno mude.

### 3.2 Chaves de API

O módulo fica no serviço de autenticação (`ChaveApiService` + `domain/chave-api.ts`), como pede o
enunciado.

- **Formato**: `gc_<prefixo de 12 hex>_<segredo de 32 bytes em base64url>`. O prefixo é público e
  indexado (localiza a chave); o segredo é exibido **uma única vez**, na emissão.
- **Armazenamento**: só o SHA-256 do segredo. A escolha difere da usada para senhas (bcrypt) por
  um motivo técnico: senhas de pessoas têm pouca entropia e precisam de hash lento contra força
  bruta; o segredo da chave tem 256 bits aleatórios, o que torna a força bruta inviável mesmo com
  hash rápido, e um hash lento só somaria latência a cada requisição. A comparação usa
  `timingSafeEqual`, e um prefixo inexistente passa pela mesma comparação, para que o tempo de
  resposta não revele quais prefixos existem.
- **Ciclo de vida**: validade opcional, revogação com efeito imediato e registro do último uso
  (gravado no máximo uma vez por minuto por chave, para não gerar uma escrita por requisição).
  Emissão e revogação ficam no journal.
- **Escopos** (`RASTREABILIDADE_LEITURA`, `LOTES_LEITURA`, `LOTES_ESCRITA`, `ANALISES_LEITURA`,
  `RELATORIOS_SOLICITAR`) refletem o contrato comercial. Um parceiro pode ter várias chaves com
  escopos diferentes, por exemplo uma só de leitura para um painel e outra de escrita para o ERP.
- **Verificação em dois pontos**: o escopo é checado no hook `preValidation` (antes da validação do
  corpo, para que quem não tem permissão receba 403 sem descobrir o formato esperado) e de novo no
  serviço, como na autorização por papéis da Atividade 2.

### 3.3 Isolamento entre clientes

Cada parceiro é vinculado a uma organização, e toda consulta pública filtra por ela. Um recurso de
outra organização responde **404**, e não 403, para não revelar que ele existe. Rentabilidade e
vida útil são referências de mercado calculadas sobre toda a base, mas expõem apenas agregados por
tipo, marca e modelo, sem nenhum identificador de cliente. Na eficiência, os operadores aparecem
como "Operador 1, 2…".

### 3.4 Limite de requisições

`@fastify/rate-limit` com o **contador por parceiro**, e não por IP: um parceiro com vários
servidores divide uma única cota, e parceiros diferentes atrás do mesmo NAT não se prejudicam.
Planos: BASICO 60/min, PROFISSIONAL 300/min, CORPORATIVO 1200/min. As respostas trazem
`x-ratelimit-limit`/`remaining`, e o 429 segue o formato padrão de erro (`LIMITE_EXCEDIDO`). Com
`REDIS_URL`, o contador fica no Redis e vale para todas as instâncias.

Durante os testes, apareceu um detalhe do armazenamento em memória do plugin: ele devolve o mesmo
objeto de contador para requisições simultâneas. Quando 65 requisições são disparadas exatamente
no mesmo instante, todas leem o valor final e são bloqueadas. Com clientes reais, as requisições
chegam espaçadas e o comportamento é o esperado; com Redis, o incremento é atômico. O teste
automatizado envia as requisições em sequência, como um cliente faria.

### 3.5 Documentação

O `@fastify/swagger` gera o OpenAPI 3 a partir dos mesmos schemas que validam a entrada, então
**documentação e validação nunca divergem**. Em `/docs`, cada rota pública traz descrição, escopo
exigido, exemplos de corpo, esquema de resposta e os códigos de erro possíveis (400, 401, 403,
404, 409, 410, 422, 429). O botão "Authorize" aceita tanto a chave de API quanto o JWT.

## 4. Processamento assíncrono

```
POST /relatorios ─► grava tarefa (PENDENTE) ─► fila.publicar(id) ─► 202 + Location
worker: PROCESSANDO ─► gera arquivo por streaming ─► CONCLUIDA (+ webhook)
              └─ erro ─► PENDENTE (nova tentativa) … ─► FALHOU (+ webhook)
GET /relatorios/{id} → status (polling)     GET /relatorios/{id}/download → arquivo
```

- **O banco é a fonte da verdade**: a fila transporta só o id. O estado, as tentativas e o erro
  ficam em `tarefas_relatorio`, consultáveis mesmo se o Redis reiniciar.
- **Idempotência**: o `jobId` do BullMQ é o próprio id da tarefa (publicar duas vezes não duplica
  o processamento), e o processador ignora tarefas já concluídas ou falhas.
- **Streaming com cursor**: os equipamentos são lidos em páginas de 1000 (cursor por id) e escritos
  direto no arquivo, com memória constante para qualquer volume.
- **Escrita atômica**: o arquivo é gravado como `.parcial` e só é renomeado no fim, o mesmo
  princípio da escrita atômica do CLI da Atividade 1.
- **Validade**: o arquivo fica disponível por 72 h; depois disso o download responde 410.
- **CSV seguro**: separador `;` (padrão das planilhas em português), escape RFC 4180 e
  neutralização de células iniciadas por `= + - @`, contra injeção de fórmulas.

### 4.1 Política de retentativas

| Parâmetro | Valor | Justificativa |
|---|---|---|
| Tentativas | 3 | cobre falhas transitórias (queda momentânea do banco, disco cheio) sem insistir indefinidamente em uma falha estrutural |
| Recuo | exponencial: 5 s, 10 s, 20 s | dá tempo ao recurso para se recuperar sem sobrecarregar um banco já em dificuldade |
| Erro definitivo | sem nova tentativa (`UnrecoverableError` no BullMQ) | repetir não muda o resultado (ex.: tarefa inexistente) |
| Esgotamento | status `FALHOU`, erro registrado, webhook `relatorio.falhou` | o parceiro é avisado e pode solicitar de novo |

A política é definida uma vez (`POLITICA_RETENTATIVA`, em `infra/fila.ts`) e aplicada igualmente
pelos dois drivers. Os testes unitários a verificam com relógio simulado.

### 4.2 Polling e webhook

O parceiro escolhe: faz *polling* (o cabeçalho `Location` aponta para o status) ou informa
`webhookUrl` e recebe um POST ao término, assinado com **HMAC-SHA256** no cabeçalho
`X-Greencode-Assinatura`, o que permite comprovar a origem. A entrega tem timeout de 5 s, não segue
redirecionamentos e, em produção, exige HTTPS. É de melhor esforço; o polling continua disponível.

### 4.3 Dois drivers de fila

- **BullMQ + Redis** (`REDIS_URL`): fila distribuída. Vários workers (`npm run start:worker`)
  podem rodar em processos ou máquinas diferentes.
- **Memória** (sem Redis): mesma interface e mesma política de retentativas, para uma instância.
  Ao iniciar, o servidor **republica as tarefas interrompidas**, então nada se perde em um
  reinício.

O segundo driver existe por causa do requisito de plataforma: o Redis **não tem distribuição
oficial para Windows**. Torná-lo obrigatório impediria a instalação nativa no Windows 10.

## 5. Compatibilidade de plataforma

Os cuidados da Atividade 2 foram mantidos (Prisma 7 sem binário por sistema operacional,
`bcryptjs`, scripts npm sem comandos de shell, `.gitattributes`, sinais `SIGINT`/`SIGTERM`/
`SIGBREAK`). Na Atividade 3, além disso:

- caminhos de arquivo montados só com `path`, com proteção contra *path traversal*;
- Redis opcional (seção 4.3);
- `msgpackr-extract`, a aceleração nativa opcional do BullMQ, foi negada no `allowScripts`, porque
  exigiria compilador C++ no Windows; o BullMQ usa a versão em JavaScript.

## 6. Evolução para centenas ou milhares de parceiros

Em ordem de necessidade:

1. **Separar API e workers** (já suportado): instâncias HTTP sem estado atrás de um balanceador
   (`WORKER_EMBUTIDO=false`) e workers dimensionados pelo tamanho da fila. O rate limit em Redis
   mantém as cotas corretas com várias instâncias.
2. **Armazenamento de objetos**: trocar o diretório local por um serviço compatível com S3 e
   entregar o download por URL pré-assinada. A classe `Armazenamento` já isola essa
   responsabilidade.
3. **Réplica de leitura**: análises e relatórios só leem dados; um segundo `PrismaClient` apontando
   para uma réplica tira essa carga do banco transacional.
4. **Pré-agregação incremental**: com milhões de equipamentos, em vez de recalcular tudo, manter
   visões materializadas por dia e tipo, atualizadas a cada evento.
5. **Filas por plano**: separar os relatórios do plano CORPORATIVO dos demais, para que um parceiro
   grande não ocupe todos os workers (recurso nativo do BullMQ).
6. **Webhooks confiáveis**: tabela de entregas com retentativas próprias e *dead-letter*, no lugar
   do melhor esforço atual.
7. **Gateway de API**: autenticação de chaves, limite e cache migram para um gateway, e o monólito
   fica com a lógica de negócio.
8. **Extração de serviços**: a camada analítica, que já é isolada e só lê dados, é a primeira
   candidata a virar um serviço independente, alimentado por eventos do núcleo transacional.

## 7. Testes e cenários de falha

`npm test` executa os testes unitários e os de integração contra um PostgreSQL real
(`DATABASE_URL_TEST`): os da Atividade 2, que continuam passando, e os novos da Atividade 3.

| Cenário | Resposta |
|---|---|
| Sem chave, chave inexistente, revogada ou expirada | 401 `NAO_AUTENTICADO` |
| Chave sem o escopo (antes da validação do corpo) | 403 `SEM_PERMISSAO` |
| Lote ou tarefa de outra organização ou parceiro | 404 |
| Data de entrada fora da janela de 90 dias | 400 |
| Nota fiscal repetida | 409 |
| `valorRecuperado` em destino que não gera receita | 400 |
| Download antes da conclusão / após a validade | 422 / 410 |
| Excesso de requisições do plano | 429 `LIMITE_EXCEDIDO` |
| Falha transitória na geração | até 3 tentativas com recuo; depois `FALHOU` |

## 8. Limitações conhecidas

- Os modelos de vida útil são lineares e de uma variável (idade). Isso é adequado ao volume atual,
  mas não captura efeitos de marca e modelo.
- Sem Redis, a fila e o rate limit valem só para a instância local. Com mais de uma instância em
  produção, o Redis é obrigatório.
- Os relatórios ficam em disco local; várias instâncias HTTP exigem armazenamento compartilhado
  (seção 6, item 2).
- O webhook exige HTTPS em produção, mas não bloqueia endereços de rede interna. Antes de abri-lo a
  parceiros não confiáveis, é preciso resolver o DNS e rejeitar faixas privadas (SSRF).
- O caminho BullMQ/Redis segue a mesma interface e a mesma política do driver em memória, mas os
  testes automatizados rodam com a fila em memória, para não exigir Redis no ambiente de testes.
