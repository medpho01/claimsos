# ClaimOS — Deployment Hardening: Seamless Migrations & Env

**Date:** 2026-09-13
**Goal:** make production deploys hiccup-free — every DB migration applied deterministically (from an empty DB or an existing one), and every required environment variable validated at boot instead of failing at first request/job.

**Companion:** [`E2E_ARCHITECTURE.md`](./E2E_ARCHITECTURE.md) (§1 topology).

---

## 1. Why deploys are fragile today

Two root problems, both observed live on prod (18 hospitals, 917 claims):

1. **Production's schema was created from a dump, not by running migrations.** `public.pgmigrations`/`hospital.pgmigrations` holds only ~18–22 sparse rows, so `migrate:up` can't be trusted to know what's applied. Schema drift (missing/mis-named columns) has repeatedly surfaced as runtime 500s — e.g. `ipd_doc` had legacy trailing-space columns (`"doc_metadata "`), `doctor_share_tokens` was absent, `panel_attribute_documents` was missing 3 columns. All were hand-patched (see `project_claimsos_prod_schema` memory).
2. **A from-scratch deploy is not automatable** because the genesis (`schema.sql`) is applied out-of-band and the migration set has non-idempotent + duplicate files.

## 2. Migration system — how it runs

- `package.json`: `migrate:up|down|create` → `node src/schema/run-migrations.cjs <verb>`.
- `run-migrations.cjs` composes `DATABASE_URL` from `POSTGRES_*` (auto-appends `sslmode=no-verify` for non-local/RDS hosts), then execs `node-pg-migrate -m migrations -j sql --schema hospital --create-schema --ignore-pattern '.*_rollback\.sql'`. Applied files tracked in `hospital.pgmigrations`.
- **The genesis is `Backend/src/schema/schema.sql`** — `SET search_path TO hospital`, `CREATE EXTENSION uuid-ossp`, `CREATE FUNCTION update_modified_column()`, and 13 core tables (users, hospitals, ipds, ipd_doc, doctors, panels, …). node-pg-migrate reads **only `migrations/`**, so `schema.sql` is **never applied by the automated path**. Migration `001` immediately `ALTER`s `ipd_doc` and uses `update_modified_column()` — so `migrate:up` against a truly empty DB **fails at 001**.

## 3. Fragile migrations (must fix for idempotent re-run / from-scratch)

**`CREATE TABLE` without `IF NOT EXISTS`:**
- `004_create_validator_verification_system.sql:8,53,101,146,188,236`
- `005_create_doctor_configuration_system.sql:9,52,97,139,160,201,302`
- `064_extraction_corrections.sql:27`

**`CREATE INDEX` without `IF NOT EXISTS`:** `002_core_new_tables_v2.sql` (32), `004_…` (26), `002_hospital_profile.sql` (20), `005_…` (20), `006_create_master_options_table.sql` (3), `064_…` (3).

**`CREATE TRIGGER` without guard:** 12 occurrences (e.g. `001_add_s3_support.sql:13`) — bare `CREATE TRIGGER` fails on re-run.

**Unguarded `DROP CONSTRAINT`:** `069_per_stage_evaluations_and_hypothesis.sql:32` (no `IF EXISTS`).

**Real destructive `DELETE FROM` seed-cleanup** (harmless on empty DB but assume specific rows): `010:38`, `022:41,47,53`, `023:119,126,132,135`, `026:28,32,36`.

**Messy history:** duplicate/`_fixed` variants (`002_core_fixed`, `002_core_new_tables_v2`, `002_hospital_profile`, `002b_fixed`, `002b_hospital_table_updates`, `002c_fixed`, `003_fixed`, `003b_fixed`) with overlapping objects; numbering gap 006→010 (007–009 live in `data-seeds/`). Running the overlapping `002*` set from scratch collides.

`prod-bootstrap-final.sql` is **not a clean-room installer** — it's a hand-written idempotent alignment script for the *existing* prod RDS whose Section 9 stamps 65 migration names into `pgmigrations` so `migrate:up` becomes a no-op picking up only #066+.

## 4. Proposal — seamless deploys

### 4.1 Make the genesis a real migration
Add `000_genesis.sql` (first lexical migration) containing `schema.sql`'s contents, all with `IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `CREATE EXTENSION IF NOT EXISTS`. Now base-table creation is under node-pg-migrate ordering and `001+` find `ipd_doc` + `update_modified_column`. (Lower-effort alternative: a bootstrap wrapper that runs `psql -f schema.sql` then `migrate:up` — but codifying as `000` is version-tracked and cleaner.)

### 4.2 Idempotency sweep
Mechanical edits to the fragile files in §3:
- `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS` (004, 005, 064).
- `CREATE INDEX` → `CREATE INDEX IF NOT EXISTS` (002_core_new_tables_v2, 004, 002_hospital_profile, 005, 006, 064).
- `CREATE TRIGGER` → `DROP TRIGGER IF EXISTS … ; CREATE TRIGGER …` (all 12).
- `069:32` → `DROP CONSTRAINT IF EXISTS`.
- **Do NOT rename existing migration files** — prod's `pgmigrations` matches them by name. Make their *bodies* idempotent so a fresh DB runs them safely and an already-stamped prod skips them.

### 4.3 Resolve the duplicate `002*` set
Pick one canonical file per object; guard every object so re-creation is a no-op (don't delete/rename — see above). A from-scratch run then tolerates the overlap.

### 4.4 Reconcile prod's ledger (one-time)
Stamp what prod actually has so future `migrate:up` is trustworthy: extend the `prod-bootstrap-final.sql` stamp with the migrations hand-applied since (018 rename, doctor_share_tokens, panel_attribute_documents cols, field-schema/master_options seeds). After this, prefer `migrate:up` over hand-maintained bootstrap SQL.

### 4.5 Deploy order (per environment)
- **New empty DB:** ensure `pgmigrations` empty → run genesis + all migrations for real, lexical order.
- **Existing prod:** keep the stamp approach, then `migrate:up` applies only new migrations.
- **Both:** wrap as a one-shot gate before backend/worker start: `docker compose run --rm backend npm run migrate:up` (init-container or deploy step), and only start services if it exits 0.

### 4.6 CI guard
Fail the build if any file in `migrations/` contains `CREATE TABLE|INDEX|TRIGGER` without a guard or `DROP … ` without `IF EXISTS` — so idempotency never regresses.

## 5. Environment variables

### 5.1 Complete inventory (grouped)

**Postgres (all required):** `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` (validated); `POSTGRES_SSLMODE`, `DB_SSL` (`"true"`→`rejectUnauthorized:false`), `DATABASE_URL` (optional).

**Redis:** `REDIS_URL` only (**no** `REDIS_HOST`/`PORT`). Effectively **required for workers**, **not validated**, hard-defaults to `redis://localhost:6379` — in-container that silently fails to connect. In compose set `REDIS_URL=redis://redis:6379`.

**AWS/S3:** `AWS_REGION` (def `ap-south-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (def `''` → upload fails at runtime), `AWS_S3_BUCKET` (def `hospital-app-images`), plus a second bucket var `S3_BUCKET` used only by preauth PDF fill. All `.trim()`ed on read (trailing-space defense).

**Anthropic/LLM:** `ANTHROPIC_API_KEY` (**required for AI**, not validated — SDK throws at call time), legacy alias `CLAUDE_API_KEY`, `LLM_PROVIDER` (def `claude`), `LLM_MAX_CONCURRENT_HAIKU/SONNET`, `LLM_REPLAY_MODE/STRICT/DIR`, `VOYAGE_API_KEY`, `VOYAGE_MODEL`.

**JWT/auth (required, validated):** `ACCESS_TOKEN_SECRET` (min 32 chars), `ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_EXPIRY_DAYS`.

**Gmail/Google:** `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI` (required for Gmail features), `GOOGLE_DRIVE_ROOT_ID`, `PARENT`, `GOOGLE_SHEET_WEBHOOK_URL`, `GOOGLE_SHEET_SECRET_TOKEN`, `GMAIL_POLL_ENABLED`, `GMAIL_POLL_INTERVAL_SECONDS`, plus the AES key `ENC_KEY` (+ `ENC_KEY_PREVIOUS` for rotation) that encrypts stored tokens.

**App/server:** `NODE_ENV`, `PORT` (def 8000), `RUN_WORKERS` (`"false"`→API-only), `CORS_ORIGIN`, `FRONTEND_URL` vs `APP_BASE_URL` (two base-URL vars), `METRICS_TOKEN` (unset → `/metrics` 503), `LOG_LEVEL`, `APP_VERSION`.

**Feature flags (optional):** `AI_ANALYSIS_ENABLED`, `AI_ANALYSIS_ALLOWED_CLAIMS`, `INTELLIGENCE_ENRICHMENT`, `IDENTITY_GATE_ENABLED`, `EPISODIC_RETRIEVAL_MODE`, `PIPELINEV2_PAGE_READ_FIRST_TIER`, `OCR_VISION_FALLBACK_DISABLED`, `OCR_PREPROCESS_DISABLED`, the `*_CONCURRENCY` caps, and the reconciler/heartbeat toggles.

**Known quirks:** trailing-space values (hence the `.trim()`s and why `docker run --env-file` rejects them while Compose tolerates); duplicate names (`AWS_S3_BUCKET`/`S3_BUCKET`, `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY`, `FRONTEND_URL`/`APP_BASE_URL`); `REDIS_URL`-only; `DB_SSL` must be the literal string `"true"`.

### 5.2 Boot-time validation (harden `Utils/env.util.ts`)
The mechanism exists (Zod, prints all failures, `process.exit(1)`) but only covers Postgres + JWT. Extend:
1. **Add the silently-required vars:** `REDIS_URL` (required when `RUN_WORKERS!=='false'`, reject the `localhost` default in prod — highest-value fix), `ANTHROPIC_API_KEY` (required for worker/AI), `AWS_ACCESS_KEY_ID`/`SECRET` (required when S3 is the store), `ENC_KEY` (required for Gmail).
2. **Trim + reject whitespace** for all secret/URL vars (generalize the S3 `.trim()`), with a clear message — kills the trailing-space class.
3. **Role-aware:** branch on `RUN_WORKERS` — API needs JWT+Postgres+CORS; worker additionally needs `REDIS_URL`+`ANTHROPIC_API_KEY`+S3 creds. Print which role is validated.
4. **Duplicate-name checks:** ensure the canonical of each pair is set; warn on legacy alias.
5. **`--check-env` script** running `validateEnv()` standalone in CI/pre-deploy without booting.

## 6. Other robustness fixes (topology)
1. **Add healthchecks** to compose (backend `/health`, worker `/health/worker`, redis `redis-cli ping`) and make `depends_on` wait for `service_healthy`.
2. **Stop publishing Redis 6379 to the host** (internal network only).
3. Document the **`--force-recreate`** requirement after any `.env` edit (restart does not reload `env_file`).
4. Enforce **worker-scaling concurrency math** (divide `*_CONCURRENCY` / `LLM_MAX_CONCURRENT_*` by replica count) so multi-replica deploys don't exceed the Anthropic RPM/TPM ceiling.

## 7. Priority order
1. Boot-time env validation (`REDIS_URL`, `ANTHROPIC_API_KEY` first) + `.env` trim — cheap, prevents the most common silent failures.
2. `000_genesis.sql` + idempotency sweep + CI guard — makes from-scratch deploys deterministic.
3. Reconcile prod's `pgmigrations` — makes `migrate:up` trustworthy for the next-phase schema (rule sets, line-items).
4. Healthchecks + Redis exposure + scaling math.
