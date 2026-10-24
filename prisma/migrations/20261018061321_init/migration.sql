-- CreateEnum
CREATE TYPE "PapelUsuario" AS ENUM ('ADMINISTRADOR', 'OPERADOR_CADASTRO', 'GESTOR_ALMOXARIFADO', 'AUDITOR');

-- CreateEnum
CREATE TYPE "StatusLote" AS ENUM ('RECEBIDO', 'EM_TRIAGEM', 'TRIAGEM_CONCLUIDA', 'ENCAMINHADO', 'FINALIZADO');

-- CreateEnum
CREATE TYPE "TipoEquipamento" AS ENUM ('COMPUTADOR_MESA', 'NOTEBOOK', 'MONITOR', 'IMPRESSORA', 'SERVIDOR', 'ROTEADOR', 'CABO_ESTRUTURADO', 'FONTE_ALIMENTACAO');

-- CreateEnum
CREATE TYPE "EstadoFisico" AS ENUM ('NOVO', 'BOM_ESTADO', 'USADO_LEVE', 'USADO_MODERADO', 'DANIFICADO_LEVE', 'DANIFICADO_GRAVE', 'INSERVIVEL');

-- CreateEnum
CREATE TYPE "StatusRastreamento" AS ENUM ('AGUARDANDO_TRIAGEM', 'EM_TRIAGEM', 'AGUARDANDO_DESMONTE', 'EM_DESMONTE', 'PECAS_REAPROVEITADAS', 'MATERIAL_RECICLAVEL', 'DESCARTE_SEGURO', 'BAIXA_DEFINITIVA');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL,
    "usuario" VARCHAR(60) NOT NULL,
    "hash_senha" TEXT NOT NULL,
    "papel" "PapelUsuario" NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ultimo_acesso" TIMESTAMPTZ(3),
    "versao_token" INTEGER NOT NULL DEFAULT 0,
    "versao" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizacoes" (
    "id" UUID NOT NULL,
    "codigo" VARCHAR(20) NOT NULL,
    "razao_social" VARCHAR(200) NOT NULL,
    "cnpj" CHAR(14) NOT NULL,
    "inscricao_estadual" VARCHAR(20),
    "endereco_completo" VARCHAR(400) NOT NULL,
    "telefone" VARCHAR(20),
    "email" VARCHAR(200) NOT NULL,
    "data_cadastro" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "versao" INTEGER NOT NULL DEFAULT 0,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contratos" (
    "id" UUID NOT NULL,
    "organizacao_id" UUID NOT NULL,
    "data_assinatura" DATE NOT NULL,
    "data_vencimento" DATE NOT NULL,
    "clausulas" JSONB NOT NULL,
    "valor_mensal" DECIMAL(12,2) NOT NULL,
    "renovacao_automatica" BOOLEAN NOT NULL DEFAULT false,
    "versao" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contratos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lotes" (
    "id" UUID NOT NULL,
    "organizacao_id" UUID NOT NULL,
    "data_entrada" TIMESTAMPTZ(3) NOT NULL,
    "nota_fiscal" VARCHAR(60) NOT NULL,
    "transportadora" VARCHAR(200) NOT NULL,
    "status_processamento" "StatusLote" NOT NULL DEFAULT 'RECEBIDO',
    "observacoes" TEXT,
    "versao" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipamentos" (
    "id" UUID NOT NULL,
    "codigo_barras_interno" VARCHAR(20) NOT NULL,
    "tipo" "TipoEquipamento" NOT NULL,
    "marca" VARCHAR(100) NOT NULL,
    "modelo" VARCHAR(100) NOT NULL,
    "ano_fabricacao" INTEGER NOT NULL,
    "estado_fisico" "EstadoFisico" NOT NULL,
    "peso_quilogramas" DECIMAL(10,3) NOT NULL,
    "lote_id" UUID NOT NULL,
    "posicao_no_lote" INTEGER NOT NULL,
    "status_rastreamento" "StatusRastreamento" NOT NULL DEFAULT 'AGUARDANDO_TRIAGEM',
    "versao" INTEGER NOT NULL DEFAULT 0,
    "criado_em" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "equipamentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimentacoes" (
    "id" UUID NOT NULL,
    "equipamento_id" UUID NOT NULL,
    "data_hora" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "origem" VARCHAR(100) NOT NULL,
    "destino" VARCHAR(100) NOT NULL,
    "responsavel" VARCHAR(60) NOT NULL,
    "observacao" TEXT,
    "versao" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "movimentacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_transacoes" (
    "id" BIGSERIAL NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operacao" VARCHAR(40) NOT NULL,
    "entidade" VARCHAR(40) NOT NULL,
    "entidade_id" VARCHAR(60) NOT NULL,
    "dados_antes" JSONB,
    "dados_depois" JSONB,
    "usuario_responsavel" VARCHAR(60) NOT NULL,

    CONSTRAINT "journal_transacoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_usuario_key" ON "usuarios"("usuario");

-- CreateIndex
CREATE UNIQUE INDEX "organizacoes_codigo_key" ON "organizacoes"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "organizacoes_cnpj_key" ON "organizacoes"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "contratos_organizacao_id_key" ON "contratos"("organizacao_id");

-- CreateIndex
CREATE INDEX "lotes_data_entrada_idx" ON "lotes"("data_entrada");

-- CreateIndex
CREATE INDEX "lotes_status_processamento_idx" ON "lotes"("status_processamento");

-- CreateIndex
CREATE UNIQUE INDEX "lotes_organizacao_id_nota_fiscal_key" ON "lotes"("organizacao_id", "nota_fiscal");

-- CreateIndex
CREATE UNIQUE INDEX "equipamentos_codigo_barras_interno_key" ON "equipamentos"("codigo_barras_interno");

-- CreateIndex
CREATE INDEX "equipamentos_status_rastreamento_idx" ON "equipamentos"("status_rastreamento");

-- CreateIndex
CREATE UNIQUE INDEX "equipamentos_lote_id_posicao_no_lote_key" ON "equipamentos"("lote_id", "posicao_no_lote");

-- CreateIndex
CREATE INDEX "movimentacoes_equipamento_id_data_hora_idx" ON "movimentacoes"("equipamento_id", "data_hora");

-- CreateIndex
CREATE INDEX "journal_transacoes_entidade_entidade_id_idx" ON "journal_transacoes"("entidade", "entidade_id");

-- CreateIndex
CREATE INDEX "journal_transacoes_timestamp_idx" ON "journal_transacoes"("timestamp");

-- AddForeignKey
ALTER TABLE "contratos" ADD CONSTRAINT "contratos_organizacao_id_fkey" FOREIGN KEY ("organizacao_id") REFERENCES "organizacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lotes" ADD CONSTRAINT "lotes_organizacao_id_fkey" FOREIGN KEY ("organizacao_id") REFERENCES "organizacoes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipamentos" ADD CONSTRAINT "equipamentos_lote_id_fkey" FOREIGN KEY ("lote_id") REFERENCES "lotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimentacoes" ADD CONSTRAINT "movimentacoes_equipamento_id_fkey" FOREIGN KEY ("equipamento_id") REFERENCES "equipamentos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- SQL ESCRITO À MÃO (não gerado pelo Prisma)
--
-- O schema.prisma não expressa CHECK, triggers nem sequences. Esta parte foi
-- acrescentada com `prisma migrate dev --create-only` + edição manual. Ela é a
-- "última linha de defesa": mesmo que alguém escreva direto no banco (psql,
-- outro sistema, bug no serviço), estados inconsistentes não são persistidos.
-- Erros de regra usam SQLSTATE próprios (classe GC) para que a API os traduza.
-- =============================================================================

-- ---------------------------------------------------------------- CHECKs
ALTER TABLE "organizacoes"
  ADD CONSTRAINT "organizacoes_cnpj_formato_chk" CHECK ("cnpj" ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  ADD CONSTRAINT "organizacoes_email_chk" CHECK ("email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD CONSTRAINT "organizacoes_versao_chk" CHECK ("versao" >= 0);

ALTER TABLE "contratos"
  ADD CONSTRAINT "contratos_periodo_chk" CHECK ("data_vencimento" > "data_assinatura"),
  ADD CONSTRAINT "contratos_valor_chk" CHECK ("valor_mensal" >= 0),
  ADD CONSTRAINT "contratos_clausulas_chk"
    CHECK (jsonb_typeof("clausulas") = 'array' AND jsonb_array_length("clausulas") > 0),
  ADD CONSTRAINT "contratos_versao_chk" CHECK ("versao" >= 0);

ALTER TABLE "lotes"
  ADD CONSTRAINT "lotes_versao_chk" CHECK ("versao" >= 0);

ALTER TABLE "equipamentos"
  ADD CONSTRAINT "equipamentos_peso_chk" CHECK ("peso_quilogramas" > 0),
  ADD CONSTRAINT "equipamentos_ano_chk" CHECK ("ano_fabricacao" >= 1970),
  ADD CONSTRAINT "equipamentos_posicao_chk" CHECK ("posicao_no_lote" >= 1),
  ADD CONSTRAINT "equipamentos_codigo_chk" CHECK ("codigo_barras_interno" ~ '^GC[A-Z]{2}[0-9]{10}$'),
  ADD CONSTRAINT "equipamentos_versao_chk" CHECK ("versao" >= 0);

ALTER TABLE "usuarios"
  ADD CONSTRAINT "usuarios_versao_chk" CHECK ("versao" >= 0 AND "versao_token" >= 0);

-- ------------------------------------------------- sequence do código de barras
-- nextval() é atômico e não sofre corrida entre requisições simultâneas.
CREATE SEQUENCE "equipamento_codigo_seq" START 1 MAXVALUE 999999999 NO CYCLE;

-- ------------------------------------- máquina de estados do equipamento
CREATE FUNCTION gc_validar_equipamento() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status_lote "StatusLote";
  v_ok boolean;
BEGIN
  IF NEW."lote_id" <> OLD."lote_id" OR NEW."codigo_barras_interno" <> OLD."codigo_barras_interno" THEN
    RAISE EXCEPTION USING ERRCODE = 'GC001',
      MESSAGE = 'lote_id e codigo_barras_interno são imutáveis';
  END IF;

  IF NEW."status_rastreamento" IS DISTINCT FROM OLD."status_rastreamento" THEN
    v_ok := CASE OLD."status_rastreamento"
      WHEN 'AGUARDANDO_TRIAGEM'   THEN NEW."status_rastreamento" IN ('EM_TRIAGEM')
      WHEN 'EM_TRIAGEM'           THEN NEW."status_rastreamento" IN ('AGUARDANDO_DESMONTE', 'DESCARTE_SEGURO')
      WHEN 'AGUARDANDO_DESMONTE'  THEN NEW."status_rastreamento" IN ('EM_DESMONTE')
      WHEN 'EM_DESMONTE'          THEN NEW."status_rastreamento" IN ('PECAS_REAPROVEITADAS', 'MATERIAL_RECICLAVEL', 'DESCARTE_SEGURO')
      WHEN 'PECAS_REAPROVEITADAS' THEN NEW."status_rastreamento" IN ('BAIXA_DEFINITIVA')
      WHEN 'MATERIAL_RECICLAVEL'  THEN NEW."status_rastreamento" IN ('BAIXA_DEFINITIVA')
      WHEN 'DESCARTE_SEGURO'      THEN NEW."status_rastreamento" IN ('BAIXA_DEFINITIVA')
      ELSE false
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION USING ERRCODE = 'GC002',
        MESSAGE = format('Transição de status inválida: %s -> %s', OLD."status_rastreamento", NEW."status_rastreamento");
    END IF;

    IF NEW."status_rastreamento" = 'EM_DESMONTE' THEN
      SELECT "status_processamento" INTO v_status_lote FROM "lotes" WHERE "id" = NEW."lote_id";
      IF v_status_lote NOT IN ('TRIAGEM_CONCLUIDA', 'ENCAMINHADO') THEN
        RAISE EXCEPTION USING ERRCODE = 'GC003',
          MESSAGE = 'Desmonte só é permitido após a triagem completa do lote';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "equipamentos_validar_trg"
  BEFORE UPDATE ON "equipamentos"
  FOR EACH ROW EXECUTE FUNCTION gc_validar_equipamento();

-- Remoção física de equipamento só com o lote ainda RECEBIDO
CREATE FUNCTION gc_validar_remocao_equipamento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT "status_processamento" FROM "lotes" WHERE "id" = OLD."lote_id") <> 'RECEBIDO' THEN
    RAISE EXCEPTION USING ERRCODE = 'GC004',
      MESSAGE = 'Equipamentos só podem ser removidos de lotes RECEBIDO';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER "equipamentos_remocao_trg"
  BEFORE DELETE ON "equipamentos"
  FOR EACH ROW EXECUTE FUNCTION gc_validar_remocao_equipamento();

-- ------------------------------------------- máquina de estados do lote
CREATE FUNCTION gc_validar_lote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW."organizacao_id" <> OLD."organizacao_id" THEN
    RAISE EXCEPTION USING ERRCODE = 'GC001', MESSAGE = 'organizacao_id do lote é imutável';
  END IF;

  IF NEW."status_processamento" IS DISTINCT FROM OLD."status_processamento" THEN
    v_ok := CASE OLD."status_processamento"
      WHEN 'RECEBIDO'          THEN NEW."status_processamento" = 'EM_TRIAGEM'
      WHEN 'EM_TRIAGEM'        THEN NEW."status_processamento" = 'TRIAGEM_CONCLUIDA'
      WHEN 'TRIAGEM_CONCLUIDA' THEN NEW."status_processamento" = 'ENCAMINHADO'
      WHEN 'ENCAMINHADO'       THEN NEW."status_processamento" = 'FINALIZADO'
      ELSE false
    END;
    IF NOT v_ok THEN
      RAISE EXCEPTION USING ERRCODE = 'GC002',
        MESSAGE = format('Transição de lote inválida: %s -> %s', OLD."status_processamento", NEW."status_processamento");
    END IF;

    IF NEW."status_processamento" = 'TRIAGEM_CONCLUIDA' AND EXISTS (
      SELECT 1 FROM "equipamentos" WHERE "lote_id" = NEW."id"
        AND "status_rastreamento" IN ('AGUARDANDO_TRIAGEM', 'EM_TRIAGEM')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'GC003', MESSAGE = 'Há equipamentos sem classificação de triagem';
    END IF;

    IF NEW."status_processamento" = 'FINALIZADO' AND EXISTS (
      SELECT 1 FROM "equipamentos" WHERE "lote_id" = NEW."id" AND "status_rastreamento" <> 'BAIXA_DEFINITIVA'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'GC003', MESSAGE = 'Há equipamentos sem baixa definitiva';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "lotes_validar_trg"
  BEFORE UPDATE ON "lotes"
  FOR EACH ROW EXECUTE FUNCTION gc_validar_lote();

-- ------------------------- multiplicidade 1..* : lote sem equipamento não commita
-- Constraint trigger DIFERIDA: a verificação roda no COMMIT, então dentro da
-- transação o lote pode ser inserido antes dos equipamentos.
CREATE FUNCTION gc_lote_tem_equipamento() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_lote uuid;
BEGIN
  IF TG_TABLE_NAME = 'lotes' THEN
    v_lote := NEW."id";
  ELSE
    v_lote := OLD."lote_id";
  END IF;
  IF EXISTS (SELECT 1 FROM "lotes" WHERE "id" = v_lote)
     AND NOT EXISTS (SELECT 1 FROM "equipamentos" WHERE "lote_id" = v_lote) THEN
    RAISE EXCEPTION USING ERRCODE = 'GC005', MESSAGE = 'Um lote deve conter ao menos um equipamento';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "lotes_minimo_equipamento_trg"
  AFTER INSERT ON "lotes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gc_lote_tem_equipamento();

CREATE CONSTRAINT TRIGGER "equipamentos_minimo_por_lote_trg"
  AFTER DELETE ON "equipamentos" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gc_lote_tem_equipamento();

-- ------------------------------------------- movimentações: append-only
CREATE FUNCTION gc_movimentacao_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Única exceção: DELETE em cascata vindo da remoção do equipamento (que por
  -- sua vez só é permitida com o lote RECEBIDO). Em cascata, a profundidade de
  -- trigger é > 1 porque a ação referencial também é um trigger.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'GC006', MESSAGE = 'Movimentações são imutáveis (somente inserção)';
END $$;

CREATE TRIGGER "movimentacoes_imutavel_trg"
  BEFORE UPDATE OR DELETE ON "movimentacoes"
  FOR EACH ROW EXECUTE FUNCTION gc_movimentacao_imutavel();

-- ------------------------------ journal: imutável e retenção mínima de 180 dias
CREATE FUNCTION gc_journal_retencao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = 'GC006', MESSAGE = 'O journal de transações é imutável';
  END IF;
  IF OLD."timestamp" > now() - interval '180 days' THEN
    RAISE EXCEPTION USING ERRCODE = 'GC006',
      MESSAGE = 'Registros do journal devem ser retidos por no mínimo 180 dias';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER "journal_retencao_trg"
  BEFORE UPDATE OR DELETE ON "journal_transacoes"
  FOR EACH ROW EXECUTE FUNCTION gc_journal_retencao();
