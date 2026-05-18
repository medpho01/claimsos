-- Migration 039: case_embeddings table (Sprint 4, Wave 4B — Episodic Memory)
-- Date: 2026-05-18
--
-- The episodic memory store. One row per claim captures a dense semantic
-- embedding of the claim's "story so far" (procedure, diagnosis, key dates,
-- doc sections, amounts, outcomes, query history). The cockpit's
-- AdjudicationEngine / ReasoningAgent (wired in Wave 4C) retrieves the
-- top-k most similar prior cases at decision time so the model can reason
-- "this looks like the 5 closed cases where X happened".
--
-- Why a per-claim row (vs many embedding rows per claim):
--   - The retrieval grain is "find me cases like this one". A single
--     dense vector is the cheapest representation that hits that target.
--   - We re-embed when source_state_hash changes (i.e. the dossier
--     summary actually moved). Embedding cost is ~₹0.002/claim, but
--     unbounded re-embedding on every event would still be wasteful.
--   - source_summary is persisted alongside so we can (a) explain
--     retrievals ("we matched on this summary"), (b) re-embed locally
--     without re-reading the dossier when only the embedding model
--     version changes.
--
-- REQUIRES: pgvector extension installed on Postgres server.
--   Local dev:   `apt-get install postgresql-15-pgvector`
--                or use the `pgvector/pgvector` docker image (15-bullseye / 16-bookworm).
--   Production:  ensure RDS / Cloud SQL has pgvector enabled in the
--                instance parameter group (RDS: rds.allowed_extensions
--                must include 'vector'; then CREATE EXTENSION runs).
--
-- Index choice: ivfflat with 100 lists. ivfflat is the v0 pick because:
--   - It's part of pgvector core (no extra extension dependency).
--   - lists=100 is the canonical starting point for tables of 1k-100k rows;
--     re-tune (rule of thumb: sqrt(N) lists) when the table grows past
--     ~100k claims.
--   - HNSW is faster at recall but doubles memory and requires more
--     careful tuning; revisit when the table is large enough to justify it.
--
-- claim_id semantics: matches migrations 030/031/036 — FK to hospital.ipds(id),
-- ON DELETE CASCADE so removing an IPD cleans up its embedding.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS hospital.case_embeddings (
  claim_id            UUID PRIMARY KEY
                      REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- voyage-3 default dimension is 1024. If we later swap providers
  -- (or upgrade to voyage-3-large at 2048), the migration that
  -- changes dimension MUST drop+rebuild the index — pgvector doesn't
  -- allow ALTER COLUMN on the vector dim.
  embedding           vector(1024) NOT NULL,

  -- Which model / version produced this embedding. Carried separately
  -- from the column type because a re-embedding pass may want to keep
  -- the same dim but flag rows as "v1 prompt" vs "v0 prompt".
  embedding_model     VARCHAR(64)  NOT NULL DEFAULT 'voyage-3',
  embedding_version   VARCHAR(32)  NOT NULL DEFAULT 'v0',

  -- The text that was actually embedded. Kept verbatim so we can:
  --   (a) explain retrievals ("we matched because the summary said X"),
  --   (b) re-embed without re-reading the dossier when only the model
  --       version changes,
  --   (c) audit drift between the dossier and the embedded summary.
  source_summary      TEXT         NOT NULL,

  -- sha256 of source_summary. If the dossier moves but the summary
  -- still hashes the same, we skip the embed call (saves ₹0.002 +
  -- a Voyage round-trip). Indexed implicitly via the (claim_id,
  -- status, source_state_hash) lookup pattern in the service.
  source_state_hash   VARCHAR(64)  NOT NULL,

  -- Filterable metadata used by the retrieval WHERE clause BEFORE
  -- the vector ORDER BY, so cosine search runs on a small candidate
  -- set. Shape:
  --   {hospital_id, panel_id, insurer_id, procedure_class,
  --    diagnosis_class, claim_amount_range, outcome_category}
  -- All optional — retrieval falls back to global search if filters
  -- yield zero candidates.
  metadata            JSONB,

  embedded_at         TIMESTAMP    NOT NULL DEFAULT NOW(),

  -- 'fresh'   — vector reflects current dossier state, ok to retrieve.
  -- 'stale'   — dossier moved, re-embed scheduled. Still retrievable
  --             (better than nothing) but the backfill cron will rewrite it.
  -- 'pending' — embed job queued, not yet completed.
  -- 'failed'  — last embed attempt errored; metadata.last_error has detail.
  status              VARCHAR(32)  NOT NULL DEFAULT 'fresh'
                      CHECK (status IN ('fresh', 'stale', 'pending', 'failed'))
);

-- ─── Indexes ────────────────────────────────────────────────────────────
-- ivfflat for cosine similarity. Match the operator class to the metric
-- the service actually queries with (vector_cosine_ops ↔ <=> distance).
CREATE INDEX IF NOT EXISTS idx_case_embed_vec
  ON hospital.case_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- The backfill cron filters by status='stale'.
CREATE INDEX IF NOT EXISTS idx_case_embed_status
  ON hospital.case_embeddings (status);

-- Metadata filters in retrieval use jsonb @> '{...}' which is GIN-served.
CREATE INDEX IF NOT EXISTS idx_case_embed_metadata
  ON hospital.case_embeddings
  USING gin (metadata);

-- ─── Comments ───────────────────────────────────────────────────────────
COMMENT ON TABLE hospital.case_embeddings IS
  'Wave 4B episodic memory: one dense embedding per claim, used by the AdjudicationEngine / ReasoningAgent to retrieve top-k similar prior cases at decision time. Re-embedded only when source_state_hash changes.';

COMMENT ON COLUMN hospital.case_embeddings.claim_id IS
  'FK to hospital.ipds(id). One row per claim — re-embedding UPSERTs in place rather than appending.';

COMMENT ON COLUMN hospital.case_embeddings.embedding IS
  'voyage-3 dim=1024 dense vector. Cosine similarity (operator <=>) is the retrieval metric.';

COMMENT ON COLUMN hospital.case_embeddings.source_summary IS
  'The exact text that was embedded. Preserved for retrieval explanation, audit, and re-embedding when model versions change without dossier changes.';

COMMENT ON COLUMN hospital.case_embeddings.source_state_hash IS
  'sha256(source_summary). Embed call is skipped when this matches the existing row''s hash.';

COMMENT ON COLUMN hospital.case_embeddings.metadata IS
  'Filterable facets used as the prefilter in retrieval (cheap WHERE before expensive ORDER BY <=>). Keys: hospital_id, panel_id, insurer_id, procedure_class, diagnosis_class, claim_amount_range, outcome_category.';

COMMENT ON COLUMN hospital.case_embeddings.status IS
  'fresh|stale|pending|failed. The backfill cron picks up status=stale rows in batches.';

COMMIT;
