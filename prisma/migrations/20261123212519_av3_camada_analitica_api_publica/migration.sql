-- CreateEnum
CREATE TYPE "TipoAnalise" AS ENUM ('EFICIENCIA_OPERACIONAL', 'RENTABILIDADE', 'VIDA_UTIL');

-- CreateEnum
CREATE TYPE "OrigemExecucao" AS ENUM ('AGENDADA', 'SOB_DEMANDA', 'API_PUBLICA');

-- CreateEnum
CREATE TYPE "DimensaoEficiencia" AS ENUM ('GERAL', 'OPERADOR', 'MES');

-- CreateEnum
CREATE TYPE "MetodoPrevisao" AS ENUM ('MINIMOS_QUADRADOS', 'SUAVIZACAO_EXPONENCIAL');

-- CreateEnum
CREATE TYPE "PlanoAcesso" AS ENUM ('BASICO', 'PROFISSIONAL', 'CORPORATIVO');

-- CreateEnum
CREATE TYPE "EscopoChave" AS ENUM ('RASTREABILIDADE_LEITURA', 'LOTES_LEITURA', 'LOTES_ESCRITA', 'ANALISES_LEITURA', 'RELATORIOS_SOLICITAR');

-- CreateEnum
CREATE TYPE "StatusTarefa" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDA', 'FALHOU');

-- CreateEnum
CREATE TYPE "FormatoRelatorio" AS ENUM ('JSON', 'CSV');

-- AlterTable
ALTER TABLE "equipamentos" ADD COLUMN     "inservivel_em" TIMESTAMPTZ(3),
ADD COLUMN     "valor_recuperado" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "lotes" ADD COLUMN     "conclusao_triagem_em" TIMESTAMPTZ(3),
ADD COLUMN     "inicio_triagem_em" TIMESTAMPTZ(3),
ADD COLUMN     "parceiro_origem_id" UUID,
ADD COLUMN     "responsavel_triagem" VARCHAR(60);

-- CreateTable
CREATE TABLE "historico_estado_fisico" (
    "id" UUID NOT NULL,
    "equipamento_id" UUID NOT NULL,
    "data_hora" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado_anterior" "EstadoFisico",
    "estado_novo" "EstadoFisico" NOT NULL,
    "justificativa" TEXT,
    "responsavel" VARCHAR(60) NOT NULL,

    CONSTRAINT "historico_estado_fisico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execucoes_analise" (
    "id" UUID NOT NULL,
    "tipo" "TipoAnalise" NOT NULL,
    "origem" "OrigemExecucao" NOT NULL,
    "organizacao_id" UUID,
    "periodo_inicio" TIMESTAMPTZ(3),
    "periodo_fim" TIMESTAMPTZ(3),
    "amostras" INTEGER NOT NULL,
    "resumo" JSONB NOT NULL,
    "duracao_ms" INTEGER NOT NULL,
    "gerada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execucoes_analise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metricas_eficiencia" (
    "id" UUID NOT NULL,
    "execucao_id" UUID NOT NULL,
    "dimensao" "DimensaoEficiencia" NOT NULL,
    "chave" VARCHAR(60) NOT NULL,
    "rotulo" VARCHAR(100) NOT NULL,
    "quantidade_lotes" INTEGER NOT NULL,
    "media_horas" DOUBLE PRECISION NOT NULL,
    "mediana_horas" DOUBLE PRECISION NOT NULL,
    "desvio_padrao_horas" DOUBLE PRECISION NOT NULL,
    "percentil90_horas" DOUBLE PRECISION NOT NULL,
    "gargalo" BOOLEAN NOT NULL,

    CONSTRAINT "metricas_eficiencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metricas_rentabilidade" (
    "id" UUID NOT NULL,
    "execucao_id" UUID NOT NULL,
    "tipo" "TipoEquipamento" NOT NULL,
    "estado_fisico" "EstadoFisico",
    "marca" VARCHAR(100),
    "modelo" VARCHAR(100),
    "amostras" INTEGER NOT NULL,
    "valor_medio" DOUBLE PRECISION NOT NULL,
    "valor_mediano" DOUBLE PRECISION NOT NULL,
    "desvio_padrao" DOUBLE PRECISION NOT NULL,
    "valor_total" DOUBLE PRECISION NOT NULL,
    "valor_medio_por_kg" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "metricas_rentabilidade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "previsoes_vida_util" (
    "id" UUID NOT NULL,
    "execucao_id" UUID NOT NULL,
    "tipo" "TipoEquipamento" NOT NULL,
    "metodo" "MetodoPrevisao" NOT NULL,
    "amostras" INTEGER NOT NULL,
    "coeficiente_angular" DOUBLE PRECISION,
    "intercepto" DOUBLE PRECISION,
    "r2" DOUBLE PRECISION,
    "idade_inservivel_anos" DOUBLE PRECISION,
    "suficiente" BOOLEAN NOT NULL,
    "observacao" TEXT,

    CONSTRAINT "previsoes_vida_util_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parceiros" (
    "id" UUID NOT NULL,
    "nome" VARCHAR(120) NOT NULL,
    "organizacao_id" UUID NOT NULL,
    "plano" "PlanoAcesso" NOT NULL DEFAULT 'BASICO',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "versao" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "parceiros_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chaves_api" (
    "id" UUID NOT NULL,
    "parceiro_id" UUID NOT NULL,
    "prefixo" CHAR(12) NOT NULL,
    "hash_segredo" CHAR(64) NOT NULL,
    "descricao" VARCHAR(200),
    "escopos" "EscopoChave"[],
    "criada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMPTZ(3),
    "revogada_em" TIMESTAMPTZ(3),
    "ultimo_uso" TIMESTAMPTZ(3),

    CONSTRAINT "chaves_api_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tarefas_relatorio" (
    "id" UUID NOT NULL,
    "parceiro_id" UUID,
    "solicitante" VARCHAR(160) NOT NULL,
    "organizacao_id" UUID NOT NULL,
    "tipo" VARCHAR(40) NOT NULL,
    "formato" "FormatoRelatorio" NOT NULL,
    "status" "StatusTarefa" NOT NULL DEFAULT 'PENDENTE',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "max_tentativas" INTEGER NOT NULL DEFAULT 3,
    "erro" TEXT,
    "arquivo" VARCHAR(120),
    "tamanho_bytes" INTEGER,
    "webhook_url" VARCHAR(500),
    "criada_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "iniciada_em" TIMESTAMPTZ(3),
    "concluida_em" TIMESTAMPTZ(3),
    "expira_em" TIMESTAMPTZ(3),

    CONSTRAINT "tarefas_relatorio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historico_estado_fisico_equipamento_id_data_hora_idx" ON "historico_estado_fisico"("equipamento_id", "data_hora");

-- CreateIndex
CREATE INDEX "execucoes_analise_tipo_gerada_em_idx" ON "execucoes_analise"("tipo", "gerada_em");

-- CreateIndex
CREATE INDEX "metricas_eficiencia_execucao_id_idx" ON "metricas_eficiencia"("execucao_id");

-- CreateIndex
CREATE INDEX "metricas_rentabilidade_execucao_id_idx" ON "metricas_rentabilidade"("execucao_id");

-- CreateIndex
CREATE INDEX "previsoes_vida_util_execucao_id_idx" ON "previsoes_vida_util"("execucao_id");

-- CreateIndex
CREATE INDEX "previsoes_vida_util_tipo_idx" ON "previsoes_vida_util"("tipo");

-- CreateIndex
CREATE UNIQUE INDEX "chaves_api_prefixo_key" ON "chaves_api"("prefixo");

-- CreateIndex
CREATE INDEX "chaves_api_parceiro_id_idx" ON "chaves_api"("parceiro_id");

-- CreateIndex
CREATE INDEX "tarefas_relatorio_parceiro_id_criada_em_idx" ON "tarefas_relatorio"("parceiro_id", "criada_em");

-- CreateIndex
CREATE INDEX "tarefas_relatorio_status_idx" ON "tarefas_relatorio"("status");

-- CreateIndex
CREATE INDEX "equipamentos_tipo_idx" ON "equipamentos"("tipo");

-- CreateIndex
CREATE INDEX "lotes_conclusao_triagem_em_idx" ON "lotes"("conclusao_triagem_em");

-- AddForeignKey
ALTER TABLE "historico_estado_fisico" ADD CONSTRAINT "historico_estado_fisico_equipamento_id_fkey" FOREIGN KEY ("equipamento_id") REFERENCES "equipamentos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metricas_eficiencia" ADD CONSTRAINT "metricas_eficiencia_execucao_id_fkey" FOREIGN KEY ("execucao_id") REFERENCES "execucoes_analise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metricas_rentabilidade" ADD CONSTRAINT "metricas_rentabilidade_execucao_id_fkey" FOREIGN KEY ("execucao_id") REFERENCES "execucoes_analise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "previsoes_vida_util" ADD CONSTRAINT "previsoes_vida_util_execucao_id_fkey" FOREIGN KEY ("execucao_id") REFERENCES "execucoes_analise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parceiros" ADD CONSTRAINT "parceiros_organizacao_id_fkey" FOREIGN KEY ("organizacao_id") REFERENCES "organizacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chaves_api" ADD CONSTRAINT "chaves_api_parceiro_id_fkey" FOREIGN KEY ("parceiro_id") REFERENCES "parceiros"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tarefas_relatorio" ADD CONSTRAINT "tarefas_relatorio_parceiro_id_fkey" FOREIGN KEY ("parceiro_id") REFERENCES "parceiros"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Parte escrita à mão (o schema.prisma não expressa CHECK, triggers nem backfill)
-- =============================================================================

-- ---------------------------------------------------------------- CHECKs
ALTER TABLE "lotes"
  ADD CONSTRAINT "lotes_triagem_coerente_chk" CHECK (
    ("inicio_triagem_em" IS NULL OR "inicio_triagem_em" >= "data_entrada") AND
    ("conclusao_triagem_em" IS NULL OR ("inicio_triagem_em" IS NOT NULL AND "conclusao_triagem_em" >= "inicio_triagem_em"))
  );

ALTER TABLE "equipamentos"
  ADD CONSTRAINT "equipamentos_valor_recuperado_chk" CHECK ("valor_recuperado" IS NULL OR "valor_recuperado" >= 0),
  ADD CONSTRAINT "equipamentos_valor_somente_destino_chk" CHECK (
    "valor_recuperado" IS NULL OR
    "status_rastreamento" IN ('PECAS_REAPROVEITADAS', 'MATERIAL_RECICLAVEL', 'BAIXA_DEFINITIVA')
  );

ALTER TABLE "chaves_api"
  ADD CONSTRAINT "chaves_api_prefixo_chk" CHECK ("prefixo" ~ '^[0-9a-f]{12}$'),
  ADD CONSTRAINT "chaves_api_hash_chk" CHECK ("hash_segredo" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "chaves_api_escopos_chk" CHECK (cardinality("escopos") > 0);

ALTER TABLE "tarefas_relatorio"
  ADD CONSTRAINT "tarefas_tentativas_chk" CHECK ("tentativas" >= 0 AND "tentativas" <= "max_tentativas");

-- ------------------------------- histórico de estado físico: append-only
-- Mesma regra das movimentações: só a remoção em cascata (equipamento removido
-- de um lote ainda RECEBIDO) pode apagar linhas.
CREATE FUNCTION gc_historico_estado_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'GC006', MESSAGE = 'O histórico de estado físico é imutável (somente inserção)';
END $$;

CREATE TRIGGER "historico_estado_imutavel_trg"
  BEFORE UPDATE OR DELETE ON "historico_estado_fisico"
  FOR EACH ROW EXECUTE FUNCTION gc_historico_estado_imutavel();

-- ----------------------------------------- backfill dos dados da Atividade 2
-- O journal da Atividade 2 já registrava as mudanças de estado físico e de
-- status do lote; os dados existentes são reconstruídos a partir dele.

-- 1) Pontos de reavaliação de estado físico
INSERT INTO "historico_estado_fisico" ("id", "equipamento_id", "data_hora", "estado_anterior", "estado_novo", "justificativa", "responsavel")
SELECT gen_random_uuid(), j."entidade_id"::uuid, j."timestamp",
       (j."dados_antes" ->> 'estadoFisico')::"EstadoFisico",
       (j."dados_depois" ->> 'estadoFisico')::"EstadoFisico",
       j."dados_depois" ->> 'justificativa',
       j."usuario_responsavel"
FROM "journal_transacoes" j
JOIN "equipamentos" e ON e."id"::text = j."entidade_id"
WHERE j."entidade" = 'Equipamento' AND j."operacao" = 'ALTERAR_ESTADO_FISICO';

-- 2) Ponto inicial (estado na entrada): o "antes" da primeira reavaliação ou o estado atual
INSERT INTO "historico_estado_fisico" ("id", "equipamento_id", "data_hora", "estado_anterior", "estado_novo", "justificativa", "responsavel")
SELECT gen_random_uuid(), e."id", e."criado_em", NULL,
       COALESCE(
         (SELECT h."estado_anterior" FROM "historico_estado_fisico" h
           WHERE h."equipamento_id" = e."id" ORDER BY h."data_hora" ASC LIMIT 1),
         e."estado_fisico"),
       'Estado na entrada (migrado da Atividade 2)', 'sistema'
FROM "equipamentos" e;

-- 3) Data em que cada equipamento se tornou inservível
UPDATE "equipamentos" e SET "inservivel_em" = COALESCE(
  (SELECT MIN(h."data_hora") FROM "historico_estado_fisico" h
    WHERE h."equipamento_id" = e."id" AND h."estado_novo" = 'INSERVIVEL'),
  e."criado_em")
WHERE e."estado_fisico" = 'INSERVIVEL';

-- 4) Marcos da triagem dos lotes
UPDATE "lotes" l SET "inicio_triagem_em" = j."timestamp"
FROM "journal_transacoes" j
WHERE j."entidade" = 'Lote' AND j."entidade_id" = l."id"::text AND j."operacao" = 'ALTERAR_STATUS'
  AND j."dados_depois" ->> 'statusProcessamento' = 'EM_TRIAGEM';

UPDATE "lotes" l SET "conclusao_triagem_em" = j."timestamp", "responsavel_triagem" = j."usuario_responsavel"
FROM "journal_transacoes" j
WHERE j."entidade" = 'Lote' AND j."entidade_id" = l."id"::text AND j."operacao" = 'ALTERAR_STATUS'
  AND j."dados_depois" ->> 'statusProcessamento' = 'TRIAGEM_CONCLUIDA';
