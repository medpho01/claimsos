-- ═══════════════════════════════════════════════════════════════════════
--  PROD BOOTSTRAP CONSOLIDATION  (2026-05-23)
-- ═══════════════════════════════════════════════════════════════════════
--
-- One-shot consolidation of migration files 011 + 012 + 020 + 027 + 029
-- + 031 + 035-039 + 043-045 + 060 + 061 + 064 + 065.
--
-- WHY: prod's DB was hand-built without node-pg-migrate. The original
-- migration files reference table shapes that diverged from prod over
-- time (most notably the panel_empanelments cashless-everywhere seeds).
-- Rather than refactor every migration to handle prod's specific state,
-- we mark all 65 existing migrations as "applied" in pgmigrations and
-- run this consolidation file which only contains the additive,
-- idempotent (IF NOT EXISTS) parts.
--
-- This file should be run ONCE on prod via pgAdmin or psql. After that
-- the schema is in a known-consistent state; future migrations land via
-- the normal `npm run migrate:up` flow starting from #066.
--
-- Skipped from the original migration set (data seeds, table renames,
-- CE-specific scaffolding that doesn't apply to prod's state):
--   003b_*, 013-018, 021-026, 028, 030, 032 (already created manually),
--   033, 034, 040-042, 046-059, 062, 063
--
-- ═══════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════
-- 011_user_refresh_tokens_device_id.sql
-- ════════════════════════════════════════════════════════════
-- Sprint 1 extra — Agent F's per-device refresh-token rotation currently
-- has to bcrypt-compare every row for a user on every refresh, because
-- token_hash is non-deterministic and there's no other unique key. Add
-- a `device_id` column + an index keyed on (user_id, device_id) so we
-- can fan a single indexed lookup instead of O(N) bcrypt comparisons.
--
-- The column is nullable for now — existing rows have no associated
-- device. New sessions created after deploy will populate it; the
-- refresh code is backwards-compatible (falls back to the bcrypt scan
-- when device_id is null). A follow-up migration can NOT NULL it once
-- the access-token claim carries a deviceId and every live session has
-- been re-issued.
--
-- user_agent is captured for the "active sessions" UI Agent F sketched
-- in the controller comments — not used yet, but cheap to record now
-- rather than do a backfill later.

BEGIN;

-- Add columns idempotently so a re-run after partial application is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'hospital'
      AND table_name = 'user_refresh_tokens'
      AND column_name = 'device_id'
  ) THEN
    ALTER TABLE hospital.user_refresh_tokens
      ADD COLUMN device_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'hospital'
      AND table_name = 'user_refresh_tokens'
      AND column_name = 'user_agent'
  ) THEN
    ALTER TABLE hospital.user_refresh_tokens
      ADD COLUMN user_agent TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'hospital'
      AND table_name = 'user_refresh_tokens'
      AND column_name = 'last_used_at'
  ) THEN
    ALTER TABLE hospital.user_refresh_tokens
      ADD COLUMN last_used_at TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

-- Index for the O(1) lookup path. Partial-unique on (user_id, device_id)
-- guarantees one live row per device per user — re-login from device X
-- rotates the existing row instead of accumulating duplicates.
CREATE INDEX IF NOT EXISTS idx_user_refresh_tokens_user_device
  ON hospital.user_refresh_tokens (user_id, device_id)
  WHERE device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_refresh_tokens_expires_at
  ON hospital.user_refresh_tokens (expires_at);

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 012_add_panel_code_column.sql
-- ════════════════════════════════════════════════════════════
-- Migration 012: Add stable `code` identifier to panels
-- Date: 2026-05-16
-- Description:
--   Adds a `code VARCHAR(50) UNIQUE` column to the existing panels table so we
--   have a stable, all-caps identifier for use in migrations, app config, and
--   logs. Names alone are not stable identifiers (typos, aliases, casing).
--
--   The SOP seed (migration 015) populates 49 panels with explicit codes. The
--   existing CE system panel (UUID 00000000-0000-0000-0000-000000000001) is
--   backfilled with code 'CASHLESS_EVERYWHERE'.

BEGIN;

ALTER TABLE hospital.panels
  ADD COLUMN IF NOT EXISTS code VARCHAR(50);

-- Backfill the existing CE system panel
UPDATE hospital.panels
SET code = 'CASHLESS_EVERYWHERE'
WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
  AND code IS NULL;

-- Any other existing panels (PMJAY etc.) need codes too. Generate from
-- the name where possible; admins can update manually.
UPDATE hospital.panels
SET code = UPPER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '_', 'g'))
WHERE code IS NULL
  AND name IS NOT NULL;

-- Enforce uniqueness going forward.
-- We use a UNIQUE constraint (not a partial unique index) so ON CONFLICT
-- (code) clauses in subsequent seed migrations can target it directly.
ALTER TABLE hospital.panels
  ADD CONSTRAINT panels_code_unique UNIQUE (code);

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 020_add_is_empanelled.sql
-- ════════════════════════════════════════════════════════════
-- Migration 020: Empanelment flag on (hospital × panel) + filing-route recompute
-- Date: 2026-05-17
-- Description:
--   Adds a single new panel_attribute_definitions row (`is_empanelled`) and
--   uses it to drive `ipds.claim_filing_route` derivation. Removes the need
--   for any new tables, columns, or panel_type values.
--
--   Rules:
--     is_empanelled = TRUE   → claim_filing_route = 'network'
--     is_empanelled = FALSE  → claim_filing_route = 'cashless_everywhere'
--
--   Backfill assumptions (per product owner, 2026-05-17):
--     - Default every (hospital × panel) to is_empanelled=FALSE.
--     - PMJAY is a government scheme that *only* operates through empanelment,
--       so any (hospital × PMJAY) row is by definition empanelled. Flip those
--       to TRUE.
--     - The CASHLESS_EVERYWHERE pseudo-panel rows are skipped — they're the
--       email-interface config holders, not real insurer relationships.
--
--   This supersedes migration 019's "default to network" backfill, which was
--   too generous. After this migration, the great majority of IPDs sit on
--   the CEW route, which matches the reality on the ground.

BEGIN;

-- 1) Definition: is_empanelled (boolean, operational)
INSERT INTO hospital.panel_attribute_definitions
  (key, label, data_type, category, is_required, sort_order, description)
VALUES (
  'is_empanelled',
  'Empanelled with this panel',
  'boolean',
  'operational',
  FALSE,
  59,  -- just before claim_submission_method (60)
  'TRUE = hospital has a direct contract with this insurer/TPA (Network route, portal/empanelled email). FALSE = hospital is not empanelled and files via Cashless Everywhere.'
)
ON CONFLICT (key) DO NOTHING;

-- 2) Seed: every existing hospital_panels row gets a default is_empanelled=FALSE
--    Skip the CEW pseudo-panel rows (those hold OAuth, not an insurer relationship).
WITH def AS (
  SELECT id FROM hospital.panel_attribute_definitions WHERE key = 'is_empanelled'
),
target_rows AS (
  SELECT hp.id AS hospital_panel_id, hp.hospital_id, hp.panel_id, def.id AS def_id
    FROM hospital.hospital_panels hp
    JOIN hospital.panels pn ON pn.id = hp.panel_id
    CROSS JOIN def
   WHERE pn.code <> 'CASHLESS_EVERYWHERE'
)
INSERT INTO hospital.panel_attributes
  (hospital_panel_id, hospital_id, panel_id, panel_attribute_definition_id, attribute_key, value_boolean)
SELECT hospital_panel_id, hospital_id, panel_id, def_id, 'is_empanelled', FALSE
  FROM target_rows
 ON CONFLICT DO NOTHING;

-- 3) PMJAY exception: any (hospital × PMJAY) row is empanelled by definition.
UPDATE hospital.panel_attributes pa
   SET value_boolean = TRUE,
       updated_at = NOW()
  FROM hospital.hospital_panels hp
  JOIN hospital.panels pn ON pn.id = hp.panel_id
 WHERE pa.hospital_panel_id = hp.id
   AND pa.attribute_key = 'is_empanelled'
   AND pn.code = 'PMJAY';

-- 4) Recompute IPD claim_filing_route from is_empanelled.
--    Supersedes migration 019's "everything to network" backfill.
UPDATE hospital.ipds i
   SET claim_filing_route = CASE WHEN pa.value_boolean THEN 'network'
                                 ELSE 'cashless_everywhere'
                            END,
       updated_at = NOW()
  FROM hospital.panel_attributes pa
 WHERE pa.hospital_panel_id = i.hospital_panel_id
   AND pa.attribute_key = 'is_empanelled';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 027_submission_events_and_interface_id.sql
-- ════════════════════════════════════════════════════════════
-- Migration 027: submission_events audit log + interface_id panel attribute
-- Date: 2026-05-17
--
-- A2 — submission_events: append-only log of every state transition on an
--      insurance_submission (drafted → queued → sending → sent | failed),
--      plus stage changes on the parent IPD. Replaces "reconstruct from app
--      logs" with a queryable history. Powers the audit-trail UI (P6).
--
-- A5 — interface_id panel attribute: links a (hospital × insurer) to which
--      hospital_interfaces row carries its email. Today the code picks "first
--      email interface for this hospital" implicitly — fine while there's only
--      one. The moment IHX portal lands or a hospital has two Gmails, this
--      attribute becomes the authoritative routing.
--
-- A7 (code-only): stage-aware notification titles read patient.stage —
--      no schema needed.

BEGIN;

-- ─── A2: submission_events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.submission_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_submission_id  UUID NOT NULL REFERENCES hospital.insurance_submissions(id) ON DELETE CASCADE,
  ipd_id                   UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id              UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  -- High-level event kind. Open enum, controlled by app code:
  --   'drafted' | 'queued' | 'sending' | 'sent' | 'failed' | 'replayed'
  --   'stage_changed' | 'inbound_matched' | 'inbound_unmatched'
  --   'notification_sent' | 'notification_failed'
  event_type               VARCHAR(40) NOT NULL,
  -- Free-form payload — event-kind specific:
  --   'stage_changed':       { from, to, by }
  --   'sent':                { gmail_message_id, gmail_thread_id, sent_at }
  --   'failed':              { failure_reason, attempts }
  --   'inbound_matched':     { inbound_id, match_method, confidence }
  --   'notification_sent':   { whatsapp_group_id }
  payload                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Who or what triggered it (user UUID, 'system', 'worker', etc.)
  actor                    VARCHAR(64),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_se_submission ON hospital.submission_events (insurance_submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_se_ipd        ON hospital.submission_events (ipd_id, created_at);
CREATE INDEX IF NOT EXISTS idx_se_type       ON hospital.submission_events (event_type, created_at);

COMMENT ON TABLE hospital.submission_events IS 'Append-only audit log of every lifecycle event on an insurance_submission. Source of truth for "what happened when, by whom?" — feeds the patient-detail audit trail UI.';

-- ─── A5: interface_id panel attribute ─────────────────────────────────────
-- New panel_attribute_definition with data_type='single_select'. Options are
-- resolved at FE/BE read time against hospital.hospital_interfaces — the
-- meta-system doesn't enforce FKs to non-master tables, that's app-level.
INSERT INTO hospital.panel_attribute_definitions
  (key, label, data_type, category, is_required, sort_order, description)
VALUES (
  'interface_id',
  'Comms Interface',
  'single_select',
  'operational',
  FALSE,
  58, -- before is_empanelled (sort_order 59) so it groups with routing config
  'Which hospital_interfaces row handles email/portal for this insurer. When NULL, code falls back to "first email interface for this hospital" (compatibility default).'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 029_llm_cost_accounting.sql
-- ════════════════════════════════════════════════════════════
-- Migration 029: LLM cost accounting tables
-- Date: 2026-05-18
--
-- Sprint 4 — LLM Bridge + Cost Meter
--
-- Persists the cost telemetry the LLM bridge emits for every model call,
-- the per-hospital cost caps that gate further spend, and an alert table
-- that ops/the dashboard can read to surface "near cap" / "over cap"
-- warnings.
--
-- Tables:
--   llm_cost_log         — append-only, one row per LLM call. Source of
--                          truth for "what did claim X cost?" and "what
--                          did hospital Y spend today?"
--   hospital_cost_caps   — per-hospital daily/monthly cap overrides.
--                          Effective-dated so caps can change mid-month
--                          without losing the prior threshold.
--   cost_alerts          — audit of every cap-threshold crossing.
--                          Resolved when spend falls back under the
--                          threshold OR the next period rolls over.
--
-- Indexing strategy:
--   - llm_cost_log queries by claim_id (per-claim spend), by hospital_id
--     filtered to a time window (daily/monthly spend), and by task in a
--     time window (which prompts are getting expensive).
--   - cost_alerts queries by (hospital_id, alert_kind) for the dashboard
--     "active alerts" widget.

BEGIN;

-- ─── llm_cost_log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.llm_cost_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- claim_id is the IPD id (one IPD == one claim in the current data
  -- model). NULLable because some calls aren't tied to a claim — e.g.
  -- hospital onboarding helpers, inbound classification for an email
  -- we haven't matched yet.
  claim_id                 UUID REFERENCES hospital.ipds(id) ON DELETE SET NULL,
  hospital_id              UUID REFERENCES hospital.hospitals(id) ON DELETE SET NULL,
  -- Short identifier for the calling task (e.g. 'attr_extract.policy_number',
  -- 'discharge_summary.parse'). Indexed for per-task spend reports.
  task                     VARCHAR(64) NOT NULL,
  provider                 VARCHAR(32) NOT NULL,    -- 'anthropic', 'bedrock', ...
  model                    VARCHAR(64) NOT NULL,    -- resolved model id from response
  prompt_version           VARCHAR(32) NOT NULL,    -- caller-supplied; enables A/B
  -- Token counts split into uncached / cached input so we can audit
  -- cache hit rate and reconstruct cost from rates if needed.
  tokens_input_uncached    INTEGER NOT NULL DEFAULT 0,
  tokens_input_cached      INTEGER NOT NULL DEFAULT 0,
  tokens_output            INTEGER NOT NULL DEFAULT 0,
  latency_ms               INTEGER NOT NULL DEFAULT 0,
  -- INR with 4 decimal places — single calls can be ₹0.0008 and the
  -- rounding error matters when summed across thousands of calls/month.
  cost_inr                 NUMERIC(10, 4) NOT NULL DEFAULT 0,
  succeeded                BOOLEAN NOT NULL DEFAULT TRUE,
  -- For failed rows: the error message / class. Truncated to 1KB at
  -- write time by the service.
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-claim spend lookup (checkBudget hot path).
CREATE INDEX IF NOT EXISTS idx_llm_cost_claim
  ON hospital.llm_cost_log (claim_id, created_at)
  WHERE claim_id IS NOT NULL;

-- Per-hospital, time-windowed spend (daily/monthly cap checks).
CREATE INDEX IF NOT EXISTS idx_llm_cost_hospital_time
  ON hospital.llm_cost_log (hospital_id, created_at DESC)
  WHERE hospital_id IS NOT NULL;

-- Per-task spend reports (which prompt versions are expensive).
CREATE INDEX IF NOT EXISTS idx_llm_cost_task_time
  ON hospital.llm_cost_log (task, created_at DESC);

COMMENT ON TABLE hospital.llm_cost_log IS
  'Append-only ledger of every LLM call: tokens, latency, cost in INR. Source of truth for per-claim/per-hospital LLM spend.';

-- ─── hospital_cost_caps ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.hospital_cost_caps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id         UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  daily_cap_inr       NUMERIC(12, 2) NOT NULL,
  monthly_cap_inr     NUMERIC(12, 2) NOT NULL,
  -- Effective-dated so caps can be raised mid-month without losing the
  -- prior threshold (audit). Lookup picks the row whose window contains
  -- now(); falls back to code defaults (₹3000/day, ₹50000/month) if
  -- nothing matches.
  effective_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hcc_hospital_effective
  ON hospital.hospital_cost_caps (hospital_id, effective_from DESC);

COMMENT ON TABLE hospital.hospital_cost_caps IS
  'Per-hospital daily / monthly LLM spend caps with an effective window. Defaults (₹3000/day, ₹50000/month) apply when no row matches.';

-- ─── cost_alerts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.cost_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id     UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  -- 'claim_soft' | 'claim_hard' | 'hospital_daily_soft' | 'hospital_daily_hard'
  -- | 'hospital_monthly_soft' | 'hospital_monthly_hard'
  alert_kind      VARCHAR(40) NOT NULL,
  threshold_inr   NUMERIC(12, 2) NOT NULL,
  current_inr     NUMERIC(12, 2) NOT NULL,
  fired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL while the alert is active; set when the cost falls back under
  -- the threshold OR the period rolls over.
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cost_alerts_hospital_kind
  ON hospital.cost_alerts (hospital_id, alert_kind, fired_at DESC);

COMMENT ON TABLE hospital.cost_alerts IS
  'Audit of every cost-cap threshold crossing. Active rows (resolved_at IS NULL) feed the "near cap / over cap" dashboard widget.';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 031_claim_dossiers.sql
-- ════════════════════════════════════════════════════════════
-- Migration 031: claim_dossiers projection table (Sprint 3, Wave 1)
-- Date: 2026-05-18
--
-- The ClaimDossier is the denormalised "right-now" view of a single insurance
-- claim. It is a read-side projection — every column is derivable from a fold
-- of hospital.submission_events (and, at bootstrap, the parent
-- insurance_submissions/ipds rows). The projection is rebuilt asynchronously by
-- Backend/src/Workers/claimDossierProjector.queue.ts whenever a new event is
-- written for the claim.
--
-- Why a projection at all?
--   - The UI's "claim cockpit" needs sectioned documents, open obligations,
--     latest adjudication, KB linkage, and full timeline in one read. A live
--     SELECT-and-join across 8+ tables on every page load is wasteful and
--     awkward — projecting once on write, reading flat on the hot path, is the
--     standard CQRS shape.
--   - The projection is *recomputable*. last_event_id + last_event_at + version
--     let us detect skew vs the event log and trigger a rebuild without losing
--     ground.
--
-- claim_id semantics:
--   For Wave 1 we identify a "claim" with hospital.insurance_submissions.id.
--   A single IPD can have multiple insurance_submissions (pre-auth, enhancement,
--   final bill — each a fresh row keyed by resubmission_of_id chain). For the
--   moment we project at the *IPD* grain — one dossier per patient admission,
--   accumulating state across all submissions/filings within that IPD. This
--   matches Lane A (030)'s decision to FK submission_events.claim_id and
--   stage_transitions.claim_id to hospital.ipds(id) as well.
--   ON DELETE CASCADE so an IPD delete cleans up its projection.

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_dossiers (
  claim_id                   UUID PRIMARY KEY
                             REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- ─── Replay markers ───────────────────────────────────────────────────
  -- The most recent submission_events row folded into this projection.
  -- Used by the projector to (a) skip re-applying events older than what's
  -- already baked in, and (b) detect drift between projection and event log.
  last_event_id              UUID,
  last_event_at              TIMESTAMPTZ,
  version                    INT NOT NULL DEFAULT 0,

  -- ─── Denormalised "now" ───────────────────────────────────────────────
  current_stage              VARCHAR(100),
  current_panel_id           UUID,
  current_insurer_id         UUID,
  -- {name, uhid, room, primary_diagnosis, procedure}
  patient_summary            JSONB,
  -- {claimed, pre_auth_approved, enhancement_approved, final_approved, deducted}
  amounts                    JSONB,

  -- ─── Document bundle, sectioned by canonical doc_category code ────────
  -- Shape: { discharge_summary: [section_id, ...], investigations: [...] }
  doc_sections_by_category   JSONB,
  -- Stage-keyed map of {required, present, missing} per upcoming step.
  doc_sufficiency_per_stage  JSONB,

  -- ─── Interaction history ──────────────────────────────────────────────
  -- Ordered array of {kind, at, actor, salient}. Truncated client-side; this
  -- column holds the full ribbon for the audit-trail panel.
  events_summary             JSONB,
  inbound_emails             JSONB,
  outbound_submissions       JSONB,

  -- ─── Open obligations ─────────────────────────────────────────────────
  active_queries             JSONB,
  pending_actions            JSONB,

  -- ─── AI's view of the case ────────────────────────────────────────────
  -- Latest AdjudicationReport — full shape lives in code (Sprint 5 lane).
  active_adjudication        JSONB,
  ai_drafts_pending          JSONB,

  -- ─── KB linkage ───────────────────────────────────────────────────────
  -- Pattern UUIDs the case currently matches (insurer × diagnosis × tariff).
  matched_kb_patterns        UUID[],
  -- 'fresh' | 'stale' | 'pending' — embedding for similarity search lives in
  -- a separate pgvector table introduced later; this column tracks freshness.
  case_embedding_state       VARCHAR(32),

  -- ─── Closure ──────────────────────────────────────────────────────────
  closed_at                  TIMESTAMPTZ,
  closure_outcome            VARCHAR(64),  -- 'settled' | 'rejected' | 'withdrawn'
  retrospective_summary      JSONB,

  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cd_current_stage
  ON hospital.claim_dossiers (current_stage);

CREATE INDEX IF NOT EXISTS idx_cd_closed_at
  ON hospital.claim_dossiers (closed_at);

CREATE INDEX IF NOT EXISTS idx_cd_current_panel
  ON hospital.claim_dossiers (current_panel_id);

CREATE INDEX IF NOT EXISTS idx_cd_matched_kb_patterns
  ON hospital.claim_dossiers USING GIN (matched_kb_patterns);

-- ─── Comments ────────────────────────────────────────────────────────────
COMMENT ON TABLE  hospital.claim_dossiers IS
  'Denormalised projection of a single insurance claim built by folding hospital.submission_events. CQRS read model — recomputable end-to-end via claimDossierProjector. Source of truth remains the event log; this table optimises the cockpit read path.';

COMMENT ON COLUMN hospital.claim_dossiers.claim_id IS
  'FK to hospital.insurance_submissions(id). Projects at the submission grain for Wave 1; a future hospital.claims aggregate may re-key.';

COMMENT ON COLUMN hospital.claim_dossiers.last_event_id IS
  'Most recent submission_events.id folded into this projection. Combined with last_event_at it gates idempotent re-application of the same event.';

COMMENT ON COLUMN hospital.claim_dossiers.version IS
  'Monotonic counter bumped on every successful projection write. Used for optimistic-concurrency hints to readers and to spot regressions.';

COMMENT ON COLUMN hospital.claim_dossiers.doc_sections_by_category IS
  'JSONB map { <doc_category_code>: <section_id[]> } — derived from section_classified events. Drives the sectioned-documents view.';

COMMENT ON COLUMN hospital.claim_dossiers.events_summary IS
  'Ordered ribbon of { kind, at, actor, salient } objects — one per event, oldest first. The full audit trail UI renders from this.';

COMMENT ON COLUMN hospital.claim_dossiers.active_adjudication IS
  'Latest AdjudicationReport blob (Sprint 5 vocabulary). Overwritten by every adjudication_run event.';

COMMENT ON COLUMN hospital.claim_dossiers.case_embedding_state IS
  '''fresh'' | ''stale'' | ''pending''. Embedding vectors live in a separate pgvector table once that lane lands; this flag tells the similarity worker whether to recompute.';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 035_stage_requirements.sql
-- ════════════════════════════════════════════════════════════
-- Migration 035: Stage Requirements (Sprint 3, Wave 3A — Rules Engine)
-- Date: 2026-05-18
--
-- The Rules Engine evaluates "is this claim ready to move to target_stage X?"
-- by checking whether the dossier satisfies a configurable set of stage
-- requirements. This migration introduces the catalogue of those rules.
--
-- Design notes:
--
--   * One table — `hospital.stage_requirements` — holds both the rule
--     metadata and its scope cascade. We deliberately avoid splitting rules
--     vs scopes vs versions into separate tables; a rule version is the
--     atomic editable unit, and a rule applies to a *single* scope vector
--     (global, panel, insurer, procedure, diagnosis_class). To author a
--     rule that should fire under multiple scopes, seed multiple rows.
--
--   * `rule_key` is a stable, human-readable identifier. Versions of the same
--     logical rule reuse the same key and bump `version`. UNIQUE(rule_key,
--     version) prevents accidental duplicates.
--
--   * `target_stage` references master_options(code) for category='ipd_stage'
--     (migration 024) by convention only — no FK, because master_options uses
--     a composite (category, code) primary key and stage codes are curated.
--
--   * Insurer scoping is currently mapped to `panels` — there is no separate
--     insurers table in this schema (panels = insurer/TPA entities, and
--     hospital_panels is the per-hospital join). `scope_insurer_id` therefore
--     FK's to panels(id); flag it for review when a real insurer dimension
--     is introduced.
--
--   * The CHECK constraint enforces "rule must declare at least one scope" —
--     a rule with every scope NULL/false would never apply.
--
-- Single transaction; ON CONFLICT clauses make seed re-runs idempotent.

BEGIN;

-- ============================================================================
-- A. hospital.stage_requirements
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.stage_requirements (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable human-readable identifier. Versions share key, bump version.
  rule_key                 VARCHAR(128) NOT NULL,

  -- master_options(code) for category='ipd_stage'. No FK (master_options has
  -- a composite key); curated as convention.
  target_stage             VARCHAR(100) NOT NULL,

  -- master_options(code) for category='doc_category'. NULL allowed only when
  -- required_fields is non-null (see CHECK constraint below).
  required_doc_category    VARCHAR(100),

  -- Alternative / additional check for specific extracted fields. Shape is
  -- a JSON array of { field_key: string, allowed_categories?: string[] }.
  required_fields          JSONB,

  severity                 VARCHAR(16) NOT NULL,

  -- Scope cascade — at least one must be set / true (see CHECK below).
  scope_global             BOOLEAN NOT NULL DEFAULT false,
  scope_panel_id           UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
  -- No separate insurer table currently — panels also represents insurers/
  -- TPAs. FK to panels(id) for parity; when a true insurer table is added,
  -- migrate this column.
  scope_insurer_id         UUID REFERENCES hospital.panels(id) ON DELETE CASCADE,
  scope_procedure_code     VARCHAR(100),
  scope_diagnosis_class    VARCHAR(100),

  active                   BOOLEAN NOT NULL DEFAULT true,
  version                  INT NOT NULL DEFAULT 1,
  effective_from           TIMESTAMP NOT NULL DEFAULT NOW(),
  effective_to             TIMESTAMP,
  created_by               UUID,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_stage_requirements_key_version UNIQUE (rule_key, version),

  CONSTRAINT chk_stage_requirements_severity
    CHECK (severity IN ('blocking', 'warning', 'info')),

  -- "rule must declare at least one scope"
  CONSTRAINT chk_stage_requirements_scope_present CHECK (
    scope_global = true
    OR scope_panel_id        IS NOT NULL
    OR scope_insurer_id      IS NOT NULL
    OR scope_procedure_code  IS NOT NULL
    OR scope_diagnosis_class IS NOT NULL
  ),

  -- "rule must declare at least one expected artefact" — either a required
  -- doc category, or a required_fields JSON, or both.
  CONSTRAINT chk_stage_requirements_artefact_present CHECK (
    required_doc_category IS NOT NULL
    OR required_fields    IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_stage_requirements_target_stage
  ON hospital.stage_requirements (target_stage);
CREATE INDEX IF NOT EXISTS idx_stage_requirements_panel_stage
  ON hospital.stage_requirements (scope_panel_id, target_stage)
  WHERE scope_panel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stage_requirements_global_stage
  ON hospital.stage_requirements (scope_global, target_stage)
  WHERE scope_global = true;
CREATE INDEX IF NOT EXISTS idx_stage_requirements_active
  ON hospital.stage_requirements (active)
  WHERE active = true;

COMMENT ON TABLE hospital.stage_requirements IS
  'Configurable requirements that gate transitioning a claim into a target stage. Evaluated by RulesEngine.evaluate(). One row per (rule_key, version, scope vector).';

-- ============================================================================
-- B. Seed v1 rules — Sadbhawana / PMJAY pre-auth, query, discharge flow
-- ============================================================================
-- All seeds are system-authored (created_by = NULL). We use ON CONFLICT
-- (rule_key, version) DO NOTHING so re-running this migration against a
-- partially-seeded environment is safe.

-- pre_auth.requires.diagnosis_summary -------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'pre_auth.requires.diagnosis_summary',
  'preauth_submitted',
  'diagnosis_summary',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- pre_auth.requires.procedure_estimate ------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'pre_auth.requires.procedure_estimate',
  'preauth_submitted',
  'procedure_estimate',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- pre_auth.requires.consent -----------------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'pre_auth.requires.consent',
  'preauth_submitted',
  'consent',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- pre_auth.warns.oncologist_consent_if_oncology ---------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity,
  scope_global, scope_diagnosis_class
) VALUES (
  'pre_auth.warns.oncologist_consent_if_oncology',
  'preauth_submitted',
  'oncologist_consent',
  'warning',
  false,
  'oncology'
) ON CONFLICT (rule_key, version) DO NOTHING;

-- query_reply.requires.requested_doc --------------------------------------
-- v1 implementation: assert that an insurer_response (or other follow-up doc)
-- is present when responding to a query. A richer "the doc the insurer
-- *asked for* is present" check will land once query-letter extraction is in.
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'query_reply.requires.requested_doc',
  'preauth_query_responded',
  'insurer_response',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- discharge_filing.requires.discharge_slip --------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'discharge_filing.requires.discharge_slip',
  'discharge_submitted',
  'discharge_slip',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- discharge_filing.requires.final_bill ------------------------------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity, scope_global
) VALUES (
  'discharge_filing.requires.final_bill',
  'discharge_submitted',
  'final_bill',
  'blocking',
  true
) ON CONFLICT (rule_key, version) DO NOTHING;

-- discharge_filing.requires.ot_notes_and_photos_if_surgical ---------------
INSERT INTO hospital.stage_requirements (
  rule_key, target_stage, required_doc_category, severity,
  scope_global, scope_diagnosis_class
) VALUES (
  'discharge_filing.requires.ot_notes_and_photos_if_surgical',
  'discharge_submitted',
  'ot_notes_and_photos',
  'warning',
  false,
  'surgical'
) ON CONFLICT (rule_key, version) DO NOTHING;

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 036_adjudication_reports.sql
-- ════════════════════════════════════════════════════════════
-- Migration 036: adjudication_reports table (Sprint 3, Wave 3B)
-- Date: 2026-05-18
--
-- The AdjudicationReport is the engine's structured opinion on a single
-- claim at a single target stage. Each run folds (RulesEngine result +
-- dossier snapshot + future KB/episodic matches + future ReasoningAgent
-- narrative) into a row that the cockpit reads to render "what AI thinks
-- of this case right now".
--
-- Why a table (vs caching in claim_dossiers.active_adjudication)?
--   - We need *history*. Auditors and ops want to see how the engine's
--     opinion shifted as the dossier matured (doc came in → score
--     jumped, query was raised → action flipped to request_doc, etc.).
--   - We need *cache by input hash*. Re-running adjudication for the
--     same dossier_state_hash must be a free no-op; the dossier hash
--     gates that.
--   - The blob on claim_dossiers.active_adjudication remains the
--     "latest" pointer (rendered hot), but the canonical timeline of
--     reports lives here.
--
-- claim_id semantics: hospital.ipds(id), matching migrations 030/031.
-- ON DELETE CASCADE so deleting an IPD cleans up its reports.
--
-- Versioning: rules_version + engine_version are baked into the dedup
-- key so a rules-engine version bump intentionally invalidates the
-- cache and forces a re-run on the next call.

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.adjudication_reports (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id             UUID NOT NULL
                       REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- Stage the engine evaluated the claim's readiness *for*. e.g.
  -- 'pre_auth', 'query_reply', 'enhancement', 'discharge_filing'.
  target_stage         VARCHAR(100) NOT NULL,

  -- Headline numbers ────────────────────────────────────────────────
  -- readiness_score in 0..100 (rules engine returns 0..1; the engine
  -- service scales it before insert so the column reads naturally for
  -- humans / FE).
  readiness_score      INT NOT NULL CHECK (readiness_score BETWEEN 0 AND 100),
  -- Coarse bucket derived from readiness_score for fast filtering on
  -- the dashboard ("how many claims are blocked right now?").
  readiness_bucket     VARCHAR(32) NOT NULL
                       CHECK (readiness_bucket IN ('ready', 'almost', 'blocked')),
  -- Action the cockpit should encourage. Derived from bucket + the
  -- shape of blocking_gaps/warnings/active_queries.
  recommended_action   VARCHAR(64) NOT NULL
                       CHECK (recommended_action IN (
                         'file_now', 'request_doc', 'review',
                         'wait', 'escalate_to_human'
                       )),

  -- Engine output detail ────────────────────────────────────────────
  -- RulesEngine.evaluate().blocking_gaps — each is a structured
  -- {rule_id, message, severity, ...} object the FE renders verbatim.
  blocking_gaps        JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings             JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Wave 4 (ReasoningAgent) will populate predicted_outcome with
  -- {amount, p_query, p_deduction, expected_deductions}. In v0 we
  -- leave it NULL — the FE knows to hide that card when null.
  predicted_outcome    JSONB,

  -- {rule_ids:[], pattern_ids:[], case_ids:[]} — pointers to the
  -- evidence the engine used. v0 fills rule_ids only; pattern_ids
  -- and case_ids stay empty until KB / episodic lanes land.
  citations            JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Stubbed in v0 (empty arrays). Populated by the KB-similarity
  -- and episodic-memory passes in later waves.
  kb_matches           JSONB NOT NULL DEFAULT '[]'::jsonb,
  episodic_refs        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ReasoningAgent's narrative — Wave 4 fills this in. NULL in v0.
  reasoning            TEXT,

  -- Cache / lineage ─────────────────────────────────────────────────
  -- sha256 of stable JSON over the dossier-shaped inputs the engine
  -- relies on. Used to short-circuit re-runs: same inputs → return
  -- the existing row instead of re-evaluating.
  dossier_state_hash   VARCHAR(64) NOT NULL,
  rules_version        VARCHAR(32) NOT NULL DEFAULT 'v1',
  engine_version       VARCHAR(32) NOT NULL DEFAULT 'v0',

  generated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  -- 'engine' for queue-driven runs, 'manual_replay' for force=true
  -- runs initiated from the controller.
  generated_by         VARCHAR(32) DEFAULT 'engine'
);

-- "Latest report for a claim" — the cockpit's hot read path.
CREATE INDEX IF NOT EXISTS idx_ar_claim_generated
  ON hospital.adjudication_reports (claim_id, generated_at DESC);

-- Cache lookup by hashed input — must be cheap because every run
-- starts with this probe.
CREATE INDEX IF NOT EXISTS idx_ar_cache_lookup
  ON hospital.adjudication_reports (claim_id, target_stage, dossier_state_hash);

-- Dashboard "what's blocked across the floor" filter.
CREATE INDEX IF NOT EXISTS idx_ar_readiness_bucket
  ON hospital.adjudication_reports (readiness_bucket);

-- Idempotency: same (claim, stage, dossier state, rules, engine)
-- collapses to the existing row. The engine service uses
-- ON CONFLICT DO NOTHING + a follow-up SELECT to read back.
ALTER TABLE hospital.adjudication_reports
  ADD CONSTRAINT uq_ar_dedup
  UNIQUE (claim_id, target_stage, dossier_state_hash, rules_version, engine_version);

-- ─── Comments ────────────────────────────────────────────────────────────
COMMENT ON TABLE  hospital.adjudication_reports IS
  'Engine-produced opinion on a claim at a target stage: readiness score, blocking gaps, warnings, recommended action, and (future) reasoning. Cached by dossier_state_hash so identical inputs return the same row.';

COMMENT ON COLUMN hospital.adjudication_reports.claim_id IS
  'FK to hospital.ipds(id). One IPD has many adjudication runs over its lifetime — the history is the audit trail of the engine''s evolving opinion.';

COMMENT ON COLUMN hospital.adjudication_reports.readiness_score IS
  '0..100 (rules engine returns 0..1; engine service scales).';

COMMENT ON COLUMN hospital.adjudication_reports.dossier_state_hash IS
  'sha256 hex over stable JSON of the dossier fields the engine actually reads. Re-running with the same hash returns the cached row.';

COMMENT ON COLUMN hospital.adjudication_reports.predicted_outcome IS
  '{amount, p_query, p_deduction, expected_deductions} — null in v0. Wave 4 ReasoningAgent populates this.';

COMMENT ON COLUMN hospital.adjudication_reports.kb_matches IS
  'Wave 4 KB pattern matches. Empty array in v0.';

COMMENT ON COLUMN hospital.adjudication_reports.episodic_refs IS
  'Wave 4 episodic-memory case refs. Empty array in v0.';

COMMENT ON COLUMN hospital.adjudication_reports.reasoning IS
  'Wave 4 ReasoningAgent narrative. Null in v0.';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 037_claim_actions.sql
-- ════════════════════════════════════════════════════════════
-- Migration 037: Claim Actions (Sprint 3, Wave 3C — Action Engine)
-- Date: 2026-05-18
--
-- The Action Engine consumes AdjudicationReports produced by the Adjudication
-- Engine (Wave 3B) and turns "recommended_action + blocking_gaps" into
-- concrete, dispatchable units of work (Kratika's inbox + WhatsApp pings to
-- panel groups). Each unit is a row in hospital.claim_actions.
--
-- Why one table for both WhatsApp and in-app:
--
--   * The lifecycle is identical — pending → dispatched → acked/declined.
--     Splitting by transport (claim_actions_whatsapp + claim_actions_inapp)
--     would duplicate state machinery; the dispatcher branches on
--     `target_kind` at delivery time and writes back to the same row.
--
--   * The FE's "Action Queue" (Kratika's inbox) needs a single list view
--     across transports — "show me everything pending for this user" — and
--     a UNION on two tables would lose query planner sympathy on the
--     status filter.
--
--   * Idempotency. Re-running adjudication for the same claim mustn't spam
--     the panel group with the same "missing discharge summary" message.
--     The partial UNIQUE (claim_id, idempotency_key) lets the engine compute
--     a deterministic key (hash of claim + kind + target + gap) and use
--     ON CONFLICT DO NOTHING to swallow duplicates cheaply.
--
-- One transaction; all DDL is idempotent (IF NOT EXISTS).

BEGIN;

-- ============================================================================
-- A. hospital.claim_actions
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.claim_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Canonical claim grain: hospital.ipds.id. ON DELETE CASCADE because if
  -- the claim is hard-deleted, its outstanding actions are no longer
  -- meaningful (in practice we soft-delete claims, but the FK matters for
  -- test fixtures + future cleanup tooling).
  claim_id             UUID NOT NULL
                       REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- 'request_doc' | 'notify_ops' | 'approval_request' | 'follow_up_sla'.
  -- VARCHAR rather than enum so adding kinds in future migrations is a
  -- one-line change.
  kind                 VARCHAR(64) NOT NULL,

  -- Routing — how to deliver this action.
  --   'whatsapp_group' → target_value = whatsapp group id (UltraMsg chat id)
  --   'whatsapp_user'  → target_value = E.164 phone number
  --   'in_app_user'    → target_value = user id (also written to target_user_id)
  --   'in_app_role'    → target_value = role name ('ops_head', 'approver', ...)
  target_kind          VARCHAR(32) NOT NULL,
  target_value         VARCHAR(255) NOT NULL,

  -- Denormalised pointer to the user when target_kind = 'in_app_user'.
  -- Lets us index "pending actions for user X" cheaply. NULL for the
  -- WhatsApp / role variants. NOT a FK — users live in a different schema
  -- and the FK churn isn't worth the referential strictness here.
  target_user_id       UUID,

  -- Free-form payload: { title, summary, deep_link, ...kind-specific }.
  -- The dispatcher renders this into the WhatsApp body / in-app card.
  payload              JSONB NOT NULL,

  -- Lifecycle. 'pending' = inserted, not yet dispatched.
  --            'dispatched' = delivered (WhatsApp sent / in-app row written).
  --            'acked' = user acknowledged / approved.
  --            'declined' = user rejected with a reason.
  --            'expired' = SLA passed without a response.
  --            'failed' = dispatch hit a terminal error after retries.
  status               VARCHAR(32) NOT NULL DEFAULT 'pending',

  -- Who decided this action should exist. 'adjudication_engine' = system,
  -- 'manual' = a human created it through the future UI. source_report_id
  -- points at the AdjudicationReport when source = 'adjudication_engine'.
  source               VARCHAR(64) NOT NULL,
  source_report_id     UUID,

  -- Dedup key — computed by the engine as
  --   sha256(claim_id + kind + target_value + gap_or_warning_id).
  -- NULL allowed for manually-authored actions (no dedup needed).
  -- The partial UNIQUE index below enforces uniqueness only when set.
  idempotency_key      VARCHAR(128),

  -- Dispatch / ack bookkeeping. Nullable until the relevant transition.
  dispatched_at        TIMESTAMP,
  acked_at             TIMESTAMP,
  acked_by             UUID,
  ack_response         JSONB,
  declined_at          TIMESTAMP,
  declined_by          UUID,
  decline_reason       TEXT,
  dispatch_error       TEXT,

  created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_claim_actions_kind
    CHECK (kind IN ('request_doc','notify_ops','approval_request','follow_up_sla')),
  CONSTRAINT chk_claim_actions_target_kind
    CHECK (target_kind IN ('whatsapp_group','whatsapp_user','in_app_user','in_app_role')),
  CONSTRAINT chk_claim_actions_status
    CHECK (status IN ('pending','dispatched','acked','declined','expired','failed'))
);

-- ---- Indexes --------------------------------------------------------------
-- Drive the three hot reads:
--   1. "All actions for this claim" — claim detail / dossier rollup.
--   2. "All pending actions of a given kind" — engine retry sweeps.
--   3. "My inbox" — Kratika's action queue for the logged-in user.

CREATE INDEX IF NOT EXISTS idx_claim_actions_claim
  ON hospital.claim_actions (claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_actions_status_kind
  ON hospital.claim_actions (status, kind);

CREATE INDEX IF NOT EXISTS idx_claim_actions_pending_user
  ON hospital.claim_actions (target_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_claim_actions_user_recent
  ON hospital.claim_actions (target_user_id, created_at DESC);

-- Partial UNIQUE for idempotency: same (claim, key) cannot be inserted
-- twice. Re-runs of adjudication that produce the same recommendation
-- collapse silently via ON CONFLICT DO NOTHING in the engine.
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_actions_claim_idempotency
  ON hospital.claim_actions (claim_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE hospital.claim_actions IS
  'Concrete units of work produced by the Action Engine. One row per (claim, recommendation, target). Lifecycle: pending → dispatched → acked|declined|expired|failed.';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 038_kb_patterns.sql
-- ════════════════════════════════════════════════════════════
-- Migration 038: Knowledge-Base Patterns (Sprint 3, Wave 4A — KB Pattern Miner + Matcher)
-- Date: 2026-05-18
--
-- The Knowledge Base is the system's structured library of learned regularities
-- mined from closed claims. Each row in `hospital.kb_patterns` is a candidate
-- or live pattern that — when its `condition` matches a new claim's dossier —
-- emits a `prediction` (insurer query likely, deduction likely, expected
-- approval ratio, etc.) the ReasoningAgent (Wave 4C) can cite alongside the
-- rule-engine output.
--
-- Why a relational table (not a vector store):
--
--   * Patterns are STRUCTURED predicates over the dossier shape — not free-
--     text snippets. A vector store gives us approximate similarity but loses
--     the property we actually need: "for THIS panel × procedure_class, when
--     doc X is missing, query rate is 0.78 (n=42)". We mine those numbers in
--     SQL and want indexed JSONB matching to surface them.
--
--   * Auditability. A human reviewer (Kratika) needs to read the matched
--     pattern, see the evidence_claim_ids it was mined from, and either
--     promote it to 'live' or demote it. That's a row, not a vector.
--
--   * Cheap re-mining. A nightly cron re-runs the v0 SQL strategies and
--     ON CONFLICT-bumps `evidence_count` + `last_seen_at` for patterns we
--     re-discover. The unique signature column makes that O(1).
--
-- One transaction; all DDL idempotent (IF NOT EXISTS / ADD CONSTRAINT
-- IF NOT EXISTS).

BEGIN;

-- ============================================================================
-- A. hospital.kb_patterns
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.kb_patterns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References master_options.code where category = 'kb_pattern_type'.
  -- VARCHAR (not FK) because master_options is a soft vocabulary table and
  -- the rest of the codebase references it by code-string, not by row id.
  pattern_type         VARCHAR(64) NOT NULL,

  -- Short human-readable name. The miner generates a deterministic title
  -- from the strategy (e.g. "Sadbhawana: missing implant_invoice → query 78%").
  title                VARCHAR(255) NOT NULL,
  description          TEXT,

  -- Scope narrows where the pattern applies. Shape:
  --   { global?:bool, panel_id?, insurer_id?, procedure_code?,
  --     diagnosis_class?, hospital_id? }
  -- A pattern with global=true matches every claim. Others use JSONB
  -- containment against the candidate claim's scope-vector at match time.
  scope                JSONB NOT NULL,

  -- The matchable predicate. Shape:
  --   { kind: 'doc_missing' | 'doc_present' | 'amount_in_range'
  --       | 'past_outcome_seq' | 'stage_dwell' | ..., params: {...} }
  -- The matcher service interprets `kind` and dispatches to a typed handler.
  -- Unknown kinds are skipped (warning logged) so a newer matcher version
  -- can ignore patterns produced by a future miner without crashing.
  condition            JSONB NOT NULL,

  -- The prediction emitted when condition matches. Shape:
  --   { kind: 'query_likely' | 'deduction_likely' | 'approval_likely'
  --       | 'amount_cut_pct' | ..., params, point_estimate?, distribution? }
  -- ReasoningAgent (Wave 4C) blends these into its narrative; cockpit may
  -- render the point_estimate inline.
  prediction           JSONB NOT NULL,

  -- Mined confidence, 0..1. For v0 SQL miners this is the support rate
  -- (e.g. fraction of matching closed claims where the predicted outcome
  -- occurred). LLM-mined patterns (later) populate this themselves.
  confidence           NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),

  -- How many closed claims back this pattern up. Re-mining bumps this.
  evidence_count       INT NOT NULL DEFAULT 0,

  -- A bounded list (capped at ~50 by the miner) of supporting claim ids so a
  -- reviewer can spot-check why this pattern was raised. Not the full set —
  -- evidence_count is the canonical population size.
  evidence_claim_ids   UUID[] NOT NULL DEFAULT '{}',

  -- Mining lineage. last_seen_at is bumped on every re-mining that
  -- re-discovers the row; mined_at is set once at insert.
  mined_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Lifecycle:
  --   candidate — freshly mined, waiting for a human review
  --   live      — promoted by a reviewer; eligible for matching
  --   demoted   — explicitly disabled by a reviewer
  --   archived  — superseded / no longer reproducible
  status               VARCHAR(32) NOT NULL DEFAULT 'candidate'
                       CHECK (status IN ('candidate','live','demoted','archived')),

  -- Review trail. Not FK to users — users live in a different schema and we
  -- don't want the cascade churn.
  reviewed_by          UUID,
  reviewed_at          TIMESTAMP,
  promotion_reason     TEXT,
  demotion_reason      TEXT,

  -- Version of the miner that produced this row. Bump when the SQL strategy
  -- changes meaningfully so older rows can be retired.
  miner_version        VARCHAR(32) NOT NULL DEFAULT 'v0',
  -- Reserved for LLM-mined patterns (later sprints). NULL for SQL v0.
  prompt_version       VARCHAR(32),

  -- Dedup signature. Generated column (md5 over the stable identity of a
  -- pattern: type + scope + condition). The UNIQUE index on this column is
  -- the target of ON CONFLICT in the miner — re-discovering the same pattern
  -- bumps evidence_count, doesn't insert a new row.
  pattern_signature    TEXT
    GENERATED ALWAYS AS (
      md5(
        pattern_type ||
        '|' || COALESCE(scope::text, '') ||
        '|' || COALESCE(condition::text, '')
      )
    ) STORED
);

-- ---- Indexes --------------------------------------------------------------
-- Hot reads: matcher loads all live patterns, scoped by master_options.code,
-- intersected with the candidate claim's scope.

CREATE INDEX IF NOT EXISTS idx_kb_patterns_type
  ON hospital.kb_patterns (pattern_type);

CREATE INDEX IF NOT EXISTS idx_kb_patterns_status
  ON hospital.kb_patterns (status);

CREATE INDEX IF NOT EXISTS idx_kb_patterns_type_status
  ON hospital.kb_patterns (pattern_type, status);

-- JSONB containment lookups: matcher does `scope @> '{"panel_id":...}'`,
-- miner does `condition @> '{"kind":...}'`.
CREATE INDEX IF NOT EXISTS idx_kb_patterns_scope_gin
  ON hospital.kb_patterns USING gin (scope);

CREATE INDEX IF NOT EXISTS idx_kb_patterns_condition_gin
  ON hospital.kb_patterns USING gin (condition);

-- Unique on the generated signature: same (type, scope, condition) →
-- one row. Miner uses ON CONFLICT (pattern_signature) DO UPDATE to bump
-- evidence_count + last_seen_at.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_patterns_signature
  ON hospital.kb_patterns (pattern_signature);

COMMENT ON TABLE hospital.kb_patterns IS
  'Knowledge-Base patterns mined from closed claims. condition JSONB is the matcher predicate; prediction JSONB is the emitted forecast. Lifecycle: candidate → live (after human review) → demoted/archived.';

COMMENT ON COLUMN hospital.kb_patterns.pattern_signature IS
  'Generated md5 over (pattern_type, scope, condition). Drives the unique index that lets the miner ON CONFLICT-bump existing patterns without duplicating.';

COMMENT ON COLUMN hospital.kb_patterns.evidence_claim_ids IS
  'Sample of supporting claim ids (capped ~50 by the miner). evidence_count is the canonical population — this array is for spot-checking only.';

-- ============================================================================
-- B. hospital.kb_pattern_matches
-- ============================================================================
-- Append-only log of "this pattern fired on that claim at this moment".
-- Used by:
--   * The eval harness (Wave 5) to compute pattern precision once claims
--     close: actual_outcome filled in, prediction_correct computed.
--   * The cockpit pattern-card to show "we've matched 14 prior claims with
--     this exact pattern, 11 of them were eventually queried" provenance.

CREATE TABLE IF NOT EXISTS hospital.kb_pattern_matches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  pattern_id               UUID NOT NULL
                           REFERENCES hospital.kb_patterns(id) ON DELETE CASCADE,

  -- Canonical claim grain: hospital.ipds(id).
  claim_id                 UUID NOT NULL
                           REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- The adjudication run whose ReasoningAgent surfaced this match (Wave 4C
  -- writes this). NULL when a pattern is matched outside an adjudication
  -- (e.g. background eval sweep). ON DELETE SET NULL — losing the report
  -- shouldn't lose the match-feedback row.
  adjudication_report_id   UUID
                           REFERENCES hospital.adjudication_reports(id)
                           ON DELETE SET NULL,

  matched_at               TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Populated by the kb-pattern-feedback worker when the parent claim
  -- transitions to a terminal closure_outcome. Shape mirrors the
  -- prediction's `kind`, e.g. { query_raised: true, deduction_pct: 0.18 }.
  actual_outcome           JSONB,

  -- Boolean verdict: did `prediction` agree with `actual_outcome`? The
  -- feedback worker derives this from the prediction kind. NULL while the
  -- claim is still open.
  prediction_correct       BOOLEAN,

  -- When the feedback row was filled in (claim closed). NULL while open.
  resolved_at              TIMESTAMP
);

-- ---- Indexes --------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_claim
  ON hospital.kb_pattern_matches (claim_id);

CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_pattern
  ON hospital.kb_pattern_matches (pattern_id);

-- Partial index over unresolved rows — the feedback worker scans this on
-- every claim_closed event. Most matches resolve eventually so the partial
-- predicate keeps the index small.
CREATE INDEX IF NOT EXISTS idx_kb_pattern_matches_unresolved
  ON hospital.kb_pattern_matches (claim_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE hospital.kb_pattern_matches IS
  'Log of every (pattern, claim) firing. Filled in at firing time; actual_outcome + prediction_correct populated by the kb-pattern-feedback worker once the claim closes. Drives precision/recall metrics.';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 039_episodic_memory.sql
-- ════════════════════════════════════════════════════════════
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

-- ════════════════════════════════════════════════════════════
-- 043_claim_harmonised_episodes.sql
-- ════════════════════════════════════════════════════════════
-- Migration 043: claim_harmonised_episodes + harmonisation_corrections
-- Date: 2026-05-18
-- Wave 7 — Harmonisation Layer
--
-- Stores a per-claim, derived "canonical medical episode" — a JSONB instance
-- of the claimsos.canonical.medical_episode.v2 schema (see
-- canonical-medical-documents/ReferenceStructure.json). The harmoniser fuses
-- the dossier projection (Wave 1), the per-document segmented sections
-- (Wave 2A), and the per-section extracted fields (Wave 2B) into ONE
-- normalised episode shape that:
--
--   - Adjudication, KB pattern matching, prediction, and downstream
--     insurer-facing exports all read from a single canonical artifact
--     instead of re-stitching the dossier + sections + extractions on
--     every call.
--   - Carries per-field provenance (which section_id sourced which
--     JSONPath) so the cockpit can surface "this diagnosis came from
--     section ABC, with 0.92 LLM confidence" — and so corrections close
--     a tight loop back to the source extraction row.
--
-- Cache discipline:
--   - dossier_state_hash is the harmonisation cache key. Same hash +
--     same prompt_version + status='fresh' = no LLM call required.
--   - Re-running .harmonise() on an unchanged dossier is a ~₹0 no-op.
--   - When a human applies a correction we DO NOT re-run the LLM;
--     we patch the episode JSONB at the json_path in place and log
--     the human override on harmonisation_corrections (the learning
--     loop in a later wave can fold these back into prompts /
--     extraction tuning).
--
-- claim grain: hospital.ipds(id). One harmonised episode per IPD.
-- ON DELETE CASCADE wipes the artifact when the IPD is removed.

BEGIN;

-- ─── claim_harmonised_episodes ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.claim_harmonised_episodes (
  claim_id            UUID PRIMARY KEY
                      REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- Validated instance of medical_episode.v2. Nullable in 'failed' /
  -- 'pending' states; required for 'fresh' / 'stale' / 'partial' /
  -- 'corrected'. We don't enforce NOT NULL at the DB level because
  -- the pending row is written BEFORE the LLM call and the failure
  -- update writes the row without an episode.
  episode             JSONB NOT NULL,

  -- Schema + prompt version stamps. A bump on either invalidates the
  -- cache and forces re-harmonisation on the next call.
  schema_version      VARCHAR(64)  NOT NULL DEFAULT 'claimsos.canonical.medical_episode.v2',
  prompt_version      VARCHAR(32)  NOT NULL DEFAULT 'harmoniser.v1',

  -- Overall confidence 0..1. The LLM self-reports per-field; we
  -- aggregate (average of per-field confidence) into this single
  -- headline number for cockpit chips.
  confidence          NUMERIC(4,3),

  -- Provenance map: { "$.diagnosis.primary_diagnosis.icd_code":
  --                    { "source_section_id": "...", "confidence":
  --                      0.92, "llm_inferred": false } }
  -- For v1 the map is sparse — fields directly extracted from a known
  -- section carry the section_id; LLM-inferred / synthesised fields
  -- carry source_section_id=null + llm_inferred=true.
  provenance          JSONB,

  -- Cache key — hash of (current_stage, doc_sections_by_category,
  -- amounts, active_queries, section_ids set). See
  -- harmonisation.service.ts::computeDossierStateHash for the exact
  -- input vector. When the dossier moves materially the hash flips
  -- and the next harmonise() call re-runs the LLM.
  dossier_state_hash  VARCHAR(64) NOT NULL,

  -- Cost / token accounting. cost_inr is the per-call INR the LLM
  -- bridge billed for this run; cumulative spend lives in
  -- llm_cost_log keyed on claim_id. We carry the per-run numbers on
  -- the row for quick "what did this one cost" lookups in the UI.
  cost_inr            NUMERIC(10,4),
  tokens_used         INT,
  llm_provider        VARCHAR(64),
  llm_model           VARCHAR(128),

  generated_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  -- last_corrected_at is touched by applyCorrection() — it is NOT
  -- touched by .harmonise() since a fresh run starts from the LLM
  -- output (which has no human corrections).
  last_corrected_at   TIMESTAMP,

  -- Lifecycle:
  --   fresh     — generated against current dossier_state_hash, no
  --               human corrections layered on.
  --   stale     — dossier moved past the hash this row was generated
  --               for; the cockpit knows to render a "needs refresh"
  --               chip. (We don't auto-mark stale today; harmonise()
  --               just regenerates on hash miss.)
  --   pending   — the LLM call is in flight (write happens before
  --               provider.extract()).
  --   failed    — the LLM returned, but Zod validation failed, or
  --               the budget guard blocked us. error_message has
  --               details.
  --   partial   — Zod validated only against HarmonisedEpisodePartial
  --               (the lenient subset). Adjudication can still
  --               consume this — diagnosis + patient + timeline are
  --               present — but optional sub-structures are missing.
  --   corrected — human applyCorrection() touched the episode JSONB
  --               at least once since the LLM produced it.
  status              VARCHAR(32) NOT NULL DEFAULT 'fresh',
  error_message       TEXT,

  CONSTRAINT chk_claim_harmonised_status
    CHECK (status IN ('fresh', 'stale', 'pending', 'failed', 'partial', 'corrected'))
);

CREATE INDEX IF NOT EXISTS idx_claim_harmonised_episodes_status
  ON hospital.claim_harmonised_episodes (status);

CREATE INDEX IF NOT EXISTS idx_claim_harmonised_episodes_generated_at
  ON hospital.claim_harmonised_episodes (generated_at DESC);

COMMENT ON TABLE hospital.claim_harmonised_episodes IS
  'Wave 7 — derived canonical medical_episode.v2 JSON per IPD. One row per claim. dossier_state_hash gates re-harmonisation; corrections do not invalidate the cache.';

-- ─── harmonisation_corrections ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospital.harmonisation_corrections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            UUID NOT NULL
                      REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- JSONPath expression targeting the field the human overrode.
  -- e.g. '$.diagnosis.primary_diagnosis.icd_code'. v1 only supports
  -- the simple dotted-form JSONPath ($.a.b.c with array indices
  -- via $.a[0].b); complex predicates ($..[?(@.foo==1)]) are NOT
  -- supported by the patcher and applyCorrection() will reject
  -- them.
  json_path           TEXT NOT NULL,

  -- What the AI had emitted at that path. Captured for the audit
  -- trail (so a future learning loop can pattern-mine "AI emits X
  -- but human always corrects to Y"). NULL when the AI had no
  -- value at that path (i.e. the human is adding a new field).
  ai_value            JSONB,

  -- The human-supplied value. NOT NULL: if a human wants to delete
  -- a field, they pass JSON null and we set it to null — distinct
  -- from omitting the column.
  human_value         JSONB NOT NULL,

  -- User id of the corrector. Nullable for system-applied
  -- corrections (e.g. a future reconciliation pass against a
  -- ground-truth source).
  corrected_by        UUID,
  reason              TEXT,

  corrected_at        TIMESTAMP NOT NULL DEFAULT NOW(),

  -- True once the patch has actually been merged into
  -- claim_harmonised_episodes.episode. applyCorrection() flips
  -- this to true within the same transaction it writes the
  -- correction row. False rows indicate either a patcher failure
  -- (logged, manual recovery required) or a queued correction
  -- awaiting an in-flight harmonisation.
  applied_to_episode  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_harmonisation_corrections_claim
  ON hospital.harmonisation_corrections (claim_id, corrected_at DESC);

COMMENT ON TABLE hospital.harmonisation_corrections IS
  'Wave 7 — audit trail of human edits to claim_harmonised_episodes.episode. Corrections are applied to the canonical JSON in place and logged here; cache hash is NOT invalidated.';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 044_insurer_rule_sets.sql
-- ════════════════════════════════════════════════════════════
-- Migration 044: Insurer Rule Sets (Wave 8 — Rules Engine v2)
-- Date: 2026-05-18
--
-- The Rules Engine v2 evaluates a configurable, insurer-scoped rule set
-- against a harmonised medical episode (Wave 7's hospital.claim_harmonised_episodes).
-- Unlike Wave 3A's stage_requirements (doc-category gating), v2 rules use
-- JSONPath / calculation / lookup / custom-function logic to validate clinical
-- content against insurer rule books (see canonical-medical-documents-main/insuranceRulesEx.json).
--
-- Design notes:
--
--   * A "rule set" is the unit of versioning + distribution. It targets an
--     (insurer_code x treatment x specialty) tuple. The engine resolves the
--     most-specific applicable rule set per claim at evaluation time.
--   * Each rule belongs to exactly one rule set (FK CASCADE). Cross-set rule
--     reuse is intentionally NOT supported — keeps versioning clean.
--   * `validation_logic` is JSONB carrying { logic_type, json_path?,
--     operator?, expected_value?, calculation_formula?, custom_function?,
--     lookup_table_ref? }. The engine reads this and dispatches.
--   * Companion tables (document_requirements / financial_limits / los_benchmarks)
--     materialise the auxiliary sections of insuranceRulesEx.json. They are
--     queried by custom functions (e.g. validate_room_eligibility,
--     validate_los_against_benchmark) — NOT directly by the engine loop.
--   * claim_rule_evaluations stores one row per (claim_id, rule_set_id,
--     rule_id) — UPSERT keyed there. Re-evaluation overwrites prior result.
--   * rule_overrides is the operator escape hatch: mark_passed / mark_skipped /
--     accept_deduction with reason + actor. The engine honors overrides in
--     read-paths (latest evaluations are LEFT JOINed against overrides).
--   * No FK from insurer_code -> master_options (composite key over there);
--     curated as convention, matching the Wave 3A pattern.
--   * v1 (stage_requirements) runs alongside v2 — do NOT touch it.

BEGIN;

-- ============================================================================
-- A. hospital.insurer_rule_sets
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_rule_sets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id             VARCHAR(128) UNIQUE NOT NULL,
  rule_set_name           VARCHAR(255) NOT NULL,
  version                 VARCHAR(32)  NOT NULL DEFAULT '1.0',
  effective_from          DATE,
  effective_till          DATE,
  insurer_code            VARCHAR(64),
  applicable_treatments   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  applicable_specialties  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status                  VARCHAR(32)  NOT NULL DEFAULT 'live',
  created_by              UUID,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_irs_status CHECK (status IN ('draft', 'live', 'deprecated'))
);

CREATE INDEX IF NOT EXISTS idx_irs_insurer_code
  ON hospital.insurer_rule_sets (insurer_code);
CREATE INDEX IF NOT EXISTS idx_irs_status
  ON hospital.insurer_rule_sets (status);

COMMENT ON TABLE hospital.insurer_rule_sets IS
  'Wave 8 Rules Engine v2 — top-level rule set (insurer x treatment x specialty). Resolved per-claim by RulesEngineV2.evaluate().';

-- ============================================================================
-- B. hospital.insurance_rules
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurance_rules (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id                   UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  rule_id                       VARCHAR(64) NOT NULL,
  rule_name                     VARCHAR(255) NOT NULL,
  rule_description              TEXT,
  category                      VARCHAR(64) NOT NULL,
  severity                      VARCHAR(16) NOT NULL,
  impact                        VARCHAR(32) NOT NULL,
  enabled                       BOOLEAN NOT NULL DEFAULT true,
  mandatory                     BOOLEAN NOT NULL DEFAULT false,
  validation_logic              JSONB NOT NULL,
  failure_message               TEXT,
  remediation_guidance          TEXT,
  required_documents            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  estimated_deduction_amount    NUMERIC(12,2),
  query_template                TEXT,
  order_index                   INT NOT NULL DEFAULT 999,
  created_at                    TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_insurance_rules_set_rule UNIQUE (rule_set_id, rule_id),
  CONSTRAINT chk_ir_category CHECK (category IN (
    'POLICY_ELIGIBILITY', 'DOCUMENT_COMPLETENESS', 'CLINICAL_APPROPRIATENESS',
    'FINANCIAL_LIMITS', 'PROCEDURAL_COMPLIANCE', 'TEMPORAL_VALIDITY'
  )),
  CONSTRAINT chk_ir_severity CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  CONSTRAINT chk_ir_impact   CHECK (impact   IN ('CLAIM_REJECTION', 'DEDUCTION', 'QUERY', 'WARNING', 'INFO'))
);

CREATE INDEX IF NOT EXISTS idx_ir_set ON hospital.insurance_rules (rule_set_id);
CREATE INDEX IF NOT EXISTS idx_ir_enabled ON hospital.insurance_rules (rule_set_id, enabled) WHERE enabled = true;

COMMENT ON TABLE hospital.insurance_rules IS
  'Wave 8 — individual validation rules within a rule set. validation_logic is { logic_type, json_path?, operator?, expected_value?, calculation_formula?, custom_function?, lookup_table_ref? }.';

-- ============================================================================
-- C. hospital.insurer_document_requirements
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_document_requirements (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id           UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  document_type         VARCHAR(64) NOT NULL,
  required_when         TEXT,
  mandatory             BOOLEAN NOT NULL DEFAULT true,
  stage                 VARCHAR(32),
  quality_requirements  JSONB,

  CONSTRAINT chk_idr_stage CHECK (stage IS NULL OR stage IN ('PRE_AUTH', 'ENHANCEMENT', 'FINAL_CLAIM', 'QUERY_RESPONSE'))
);

CREATE INDEX IF NOT EXISTS idx_idr_set ON hospital.insurer_document_requirements (rule_set_id);

COMMENT ON TABLE hospital.insurer_document_requirements IS
  'Wave 8 — per rule set, the catalogue of document types expected at each submission stage.';

-- ============================================================================
-- D. hospital.insurer_financial_limits
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_financial_limits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id  UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  limit_kind   VARCHAR(64) NOT NULL,
  config       JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ifl_set ON hospital.insurer_financial_limits (rule_set_id);

COMMENT ON TABLE hospital.insurer_financial_limits IS
  'Wave 8 — per rule set, financial caps (room_rent / icu_charges / implant_caps / etc). Shape varies; config is JSONB.';

-- ============================================================================
-- E. hospital.insurer_los_benchmarks
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.insurer_los_benchmarks (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id                     UUID NOT NULL REFERENCES hospital.insurer_rule_sets(id) ON DELETE CASCADE,
  procedure_code                  VARCHAR(128),
  procedure_name                  VARCHAR(255),
  expected_los_days               NUMERIC,
  expected_icu_days               NUMERIC,
  tolerance_days                  NUMERIC,
  justification_required_beyond   NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_ilb_set ON hospital.insurer_los_benchmarks (rule_set_id);
CREATE INDEX IF NOT EXISTS idx_ilb_proc ON hospital.insurer_los_benchmarks (rule_set_id, procedure_code);

COMMENT ON TABLE hospital.insurer_los_benchmarks IS
  'Wave 8 — per rule set, expected LOS / ICU days per procedure. Looked up by validate_los_against_benchmark.';

-- ============================================================================
-- F. hospital.claim_rule_evaluations  (per-claim, per-rule outcome ledger)
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.claim_rule_evaluations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id            UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  rule_set_id         UUID NOT NULL,
  rule_id             VARCHAR(64) NOT NULL,
  status              VARCHAR(16) NOT NULL,
  severity            VARCHAR(16) NOT NULL,
  impact              VARCHAR(32) NOT NULL,
  evidence            JSONB,
  message             TEXT,
  deduction_estimate  NUMERIC(12,2),
  evaluated_at        TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_cre_claim_set_rule UNIQUE (claim_id, rule_set_id, rule_id),
  CONSTRAINT chk_cre_status CHECK (status IN ('PASS', 'FAIL', 'SKIP', 'ERROR'))
);

CREATE INDEX IF NOT EXISTS idx_cre_claim ON hospital.claim_rule_evaluations (claim_id);
CREATE INDEX IF NOT EXISTS idx_cre_claim_status ON hospital.claim_rule_evaluations (claim_id, status);
CREATE INDEX IF NOT EXISTS idx_cre_rule_set ON hospital.claim_rule_evaluations (rule_set_id);

COMMENT ON TABLE hospital.claim_rule_evaluations IS
  'Wave 8 — most-recent per-rule outcome for a claim. UPSERT keyed on (claim_id, rule_set_id, rule_id).';

-- ============================================================================
-- G. hospital.rule_overrides
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.rule_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id        UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  rule_set_id     UUID NOT NULL,
  rule_id         VARCHAR(64) NOT NULL,
  action          VARCHAR(32) NOT NULL,
  reason          TEXT NOT NULL,
  overridden_by   UUID NOT NULL,
  overridden_at   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ro_action CHECK (action IN ('mark_passed', 'mark_skipped', 'accept_deduction'))
);

CREATE INDEX IF NOT EXISTS idx_ro_claim ON hospital.rule_overrides (claim_id);
CREATE INDEX IF NOT EXISTS idx_ro_claim_rule ON hospital.rule_overrides (claim_id, rule_set_id, rule_id);

COMMENT ON TABLE hospital.rule_overrides IS
  'Wave 8 — operator escape hatch. Latest override per (claim, rule_set, rule) wins.';

-- ============================================================================
-- H. Seed: ICICI_LOMBARD_CARDIAC_V1
-- ============================================================================

INSERT INTO hospital.insurer_rule_sets (
  rule_set_id, rule_set_name, version, effective_from,
  insurer_code, applicable_treatments, applicable_specialties, status
) VALUES (
  'ICICI_LOMBARD_CARDIAC_V1',
  'ICICI Lombard - Cardiac Treatment Rules',
  '1.0', '2026-01-01',
  'ICICI_LOMBARD',
  ARRAY['MEDICAL_MANAGEMENT', 'SURGICAL'],
  ARRAY['CARDIOLOGY', 'CARDIOTHORACIC_SURGERY'],
  'live'
) ON CONFLICT (rule_set_id) DO NOTHING;

-- Rules
INSERT INTO hospital.insurance_rules (
  rule_set_id, rule_id, rule_name, rule_description, category, severity, impact,
  mandatory, validation_logic, failure_message, remediation_guidance,
  required_documents, estimated_deduction_amount, query_template, order_index
)
SELECT s.id, v.rule_id, v.rule_name, v.rule_description, v.category, v.severity, v.impact,
       v.mandatory, v.validation_logic::jsonb, v.failure_message, v.remediation_guidance,
       v.required_documents, v.estimated_deduction_amount, v.query_template, v.order_index
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('CARDIAC_001', 'ECG Required for Cardiac Admission',
   'All cardiac admissions must have ECG report within 24 hours of admission',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[?(@.phase_code==\"EMERGENCY_PRESENTATION\" || @.phase_code==\"ADMISSION\")].diagnostics_performed[?(@.diagnostic_meta.category==\"CARDIAC\" && @.diagnostic_meta.test_name_normalized==\"ELECTROCARDIOGRAM_12_LEAD\")]","operator":"EXISTS"}',
   'ECG report not found for cardiac admission',
   'Please upload ECG report taken within 24 hours of admission',
   ARRAY['ECG_REPORT']::TEXT[], NULL::NUMERIC,
   'ECG report is mandatory for cardiac admission. Please provide ECG report taken at the time of admission.', 10),
  ('CARDIAC_002', 'Cardiac Enzymes for ACS Diagnosis',
   'Acute Coronary Syndrome diagnosis must be supported by elevated cardiac enzymes (Troponin/CKMB)',
   'CLINICAL_APPROPRIATENESS', 'HIGH', 'QUERY', true,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_cardiac_enzymes_for_acs"}',
   'ACS diagnosis not supported by cardiac enzyme elevation',
   'Provide cardiac enzyme (Troponin/CKMB) reports showing elevation, or revise diagnosis',
   ARRAY['PATHOLOGY_REPORTS']::TEXT[], NULL::NUMERIC, NULL, 20),
  ('CARDIAC_003', 'ICU Stay Justification for Medical Management',
   'ICU stay >3 days for medical management requires clinical justification',
   'CLINICAL_APPROPRIATENESS', 'MEDIUM', 'QUERY', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_icu_stay_cardiac_medical_mgmt"}',
   'ICU stay exceeds 3 days without adequate justification',
   'Provide daily progress notes explaining clinical necessity for prolonged ICU stay',
   ARRAY['ICU_CHARTS','DAILY_PROGRESS_NOTES']::TEXT[], 5000::NUMERIC, NULL, 30),
  ('CARDIAC_004', 'Room Rent Eligibility Check',
   'Verify room category matches policy eligibility',
   'FINANCIAL_LIMITS', 'HIGH', 'DEDUCTION', true,
   '{"logic_type":"CUSTOM","custom_function":"validate_room_eligibility"}',
   'Room category exceeds policy eligibility',
   'Room rent will be capped as per policy limits with proportionate deduction',
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 40),
  ('CARDIAC_005', 'Pre-existing Disease Declaration',
   'Check if cardiac condition existed before policy inception',
   'POLICY_ELIGIBILITY', 'CRITICAL', 'CLAIM_REJECTION', true,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_pre_existing_condition"}',
   'Cardiac condition appears to be pre-existing and not declared',
   'Provide evidence that condition was not present at policy inception or wait for waiting period completion',
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 50)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1'
ON CONFLICT (rule_set_id, rule_id) DO NOTHING;

-- Document requirements
INSERT INTO hospital.insurer_document_requirements (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT s.id, v.dt, v.rw, v.mn, v.st, v.qr::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('ADMISSION_FORM',    NULL,                                                       true,  'PRE_AUTH',    '{"must_be_signed":true,"must_be_stamped":true,"must_be_dated":true}'),
  ('ECG_REPORT',        'diagnosis.primary_diagnosis.icd_code LIKE ''I2%''',         true,  'PRE_AUTH',    NULL),
  ('PATHOLOGY_REPORTS', 'diagnosis.primary_diagnosis.diagnosis_name CONTAINS ACS',   true,  'FINAL_CLAIM', NULL),
  ('ECHO_REPORT',       'procedures contain ECHO',                                   false, 'FINAL_CLAIM', NULL),
  ('DISCHARGE_SUMMARY', NULL,                                                       true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_stamped":true,"must_be_dated":true}'),
  ('FINAL_BILL',        NULL,                                                       true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_stamped":true}')
) AS v(dt, rw, mn, st, qr)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1';

-- Financial limits
INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT s.id, v.k, v.c::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('room_rent',         '{"limit_type":"PERCENTAGE_OF_SI","percentage":2,"proportionate_deduction":true}'),
  ('icu_charges',       '{"limit_per_day":10000,"max_days_covered":7}'),
  ('consumables_limit', '{"limit_type":"PERCENTAGE_OF_BILL","percentage":15}')
) AS v(k, c)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1';

-- LOS benchmarks
INSERT INTO hospital.insurer_los_benchmarks (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT s.id, v.pc, v.pn, v.elos, v.eicu, v.tol, v.jrb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('MEDICAL_MGMT_ACS', 'Medical Management - Acute Coronary Syndrome', 5::NUMERIC, 2::NUMERIC, 2::NUMERIC, 7::NUMERIC),
  ('CABG',             'Coronary Artery Bypass Graft',                 10::NUMERIC, 3::NUMERIC, 3::NUMERIC, 13::NUMERIC)
) AS v(pc, pn, elos, eicu, tol, jrb)
WHERE s.rule_set_id = 'ICICI_LOMBARD_CARDIAC_V1';

-- ============================================================================
-- I. Seed: STAR_HEALTH_ORTHOPEDIC_V1
-- ============================================================================

INSERT INTO hospital.insurer_rule_sets (
  rule_set_id, rule_set_name, version, effective_from,
  insurer_code, applicable_treatments, applicable_specialties, status
) VALUES (
  'STAR_HEALTH_ORTHOPEDIC_V1',
  'Star Health - Orthopedic Surgery Rules',
  '1.0', '2026-01-01',
  'STAR_HEALTH',
  ARRAY['SURGICAL'],
  ARRAY['ORTHOPEDICS'],
  'live'
) ON CONFLICT (rule_set_id) DO NOTHING;

INSERT INTO hospital.insurance_rules (
  rule_set_id, rule_id, rule_name, rule_description, category, severity, impact,
  mandatory, validation_logic, failure_message, remediation_guidance,
  required_documents, estimated_deduction_amount, query_template, order_index
)
SELECT s.id, v.rule_id, v.rule_name, v.rule_description, v.category, v.severity, v.impact,
       v.mandatory, v.validation_logic::jsonb, v.failure_message, v.remediation_guidance,
       v.required_documents, v.estimated_deduction_amount, v.query_template, v.order_index
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('ORTHO_001', 'X-Ray Mandatory for Joint Surgery',
   'Pre-operative X-ray is mandatory for all joint surgeries',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[?(@.phase_code==\"PRE_OPERATIVE\")].diagnostics_performed[?(@.diagnostic_meta.category==\"RADIOLOGY\")]","operator":"EXISTS"}',
   'Pre-operative X-ray not found for joint surgery', NULL,
   ARRAY['XRAY_IMAGES']::TEXT[], NULL::NUMERIC, NULL, 10),
  ('ORTHO_002', 'Implant Sticker Mandatory',
   'Implant sticker with batch number and serial number is mandatory for all implant surgeries',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.images[?(@.image_type==\"IMPLANT_STICKER\")]","operator":"EXISTS"}',
   'Implant sticker not uploaded',
   'Please upload clear photo of implant sticker showing batch number, serial number, and manufacturer details',
   ARRAY['IMPLANT_STICKER']::TEXT[], NULL::NUMERIC, NULL, 20),
  ('ORTHO_003', 'Implant Bill Original Required',
   'Original implant bill from manufacturer/authorized dealer required',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.bills[?(@.bill_type==\"IMPLANT_BILL\")]","operator":"EXISTS"}',
   'Original implant bill not provided', NULL,
   ARRAY['IMPLANT_INVOICE']::TEXT[], 50000::NUMERIC, NULL, 30),
  ('ORTHO_004', 'Post-Operative X-Ray Required',
   'Post-operative X-ray mandatory to confirm implant position',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[?(@.phase_code==\"POST_OPERATIVE\")].diagnostics_performed[?(@.diagnostic_meta.category==\"RADIOLOGY\")]","operator":"EXISTS"}',
   'Post-operative X-ray not found', NULL,
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 40),
  ('ORTHO_005', 'Implant Cost Cap',
   'Implant cost capped at Rs. 1,50,000 for knee/hip replacement',
   'FINANCIAL_LIMITS', 'MEDIUM', 'DEDUCTION', false,
   '{"logic_type":"SIMPLE_COMPARISON","json_path":"$.financial_summary.breakdown.implant_charges.total_implant_cost","operator":"LESS_THAN_OR_EQUAL","expected_value":150000}',
   'Implant cost exceeds policy cap of Rs. 1,50,000',
   'Implant cost will be capped at Rs. 1,50,000 as per policy terms',
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 50),
  ('ORTHO_006', 'Physiotherapy Coverage',
   'Post-operative physiotherapy covered only if medically documented',
   'CLINICAL_APPROPRIATENESS', 'LOW', 'DEDUCTION', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_physiotherapy_prescription"}',
   'Physiotherapy charges require doctor''s prescription and progress notes', NULL,
   ARRAY[]::TEXT[], NULL::NUMERIC, NULL, 60)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1'
ON CONFLICT (rule_set_id, rule_id) DO NOTHING;

INSERT INTO hospital.insurer_document_requirements (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT s.id, v.dt, v.rw, v.mn, v.st, v.qr::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('XRAY_IMAGES',     NULL,                                       true,  'PRE_AUTH',    NULL),
  ('OT_NOTES',        NULL,                                       true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_dated":true}'),
  ('ANESTHESIA_NOTES',NULL,                                       true,  'FINAL_CLAIM', NULL),
  ('IMPLANT_STICKER', 'procedures_performed contains implant',    true,  'FINAL_CLAIM', NULL),
  ('IMPLANT_INVOICE', 'procedures_performed contains implant',    true,  'FINAL_CLAIM', NULL),
  ('CLINICAL_PHOTOS', 'wound complications exist',                false, 'FINAL_CLAIM', NULL)
) AS v(dt, rw, mn, st, qr)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1';

INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT s.id, v.k, v.c::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('room_rent',         '{"limit_type":"FIXED_AMOUNT","limit_amount":5000,"proportionate_deduction":true}'),
  ('implant_caps',      '[{"implant_type":"KNEE_REPLACEMENT","max_amount":150000,"requires_preauth":true},{"implant_type":"HIP_REPLACEMENT","max_amount":150000,"requires_preauth":true},{"implant_type":"SPINAL_IMPLANT","max_amount":100000,"requires_preauth":true}]'),
  ('consumables_limit', '{"limit_type":"PERCENTAGE_OF_BILL","percentage":20}')
) AS v(k, c)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1';

INSERT INTO hospital.insurer_los_benchmarks (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT s.id, v.pc, v.pn, v.elos, v.eicu, v.tol, v.jrb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('TOTAL_KNEE_REPLACEMENT', 'Total Knee Replacement', 7::NUMERIC, 0::NUMERIC, 2::NUMERIC, 9::NUMERIC),
  ('TOTAL_HIP_REPLACEMENT',  'Total Hip Replacement',  8::NUMERIC, 0::NUMERIC, 2::NUMERIC, 10::NUMERIC)
) AS v(pc, pn, elos, eicu, tol, jrb)
WHERE s.rule_set_id = 'STAR_HEALTH_ORTHOPEDIC_V1';

-- ============================================================================
-- J. Seed: SADBHAWANA_PMJAY_THR_V1 (distilled from KhatoonTHR.json)
-- ============================================================================

INSERT INTO hospital.insurer_rule_sets (
  rule_set_id, rule_set_name, version, effective_from,
  insurer_code, applicable_treatments, applicable_specialties, status
) VALUES (
  'SADBHAWANA_PMJAY_THR_V1',
  'Sadbhawana / PMJAY - Total Hip Replacement Rules',
  '1.0', '2026-01-01',
  'PMJAY',
  ARRAY['SURGICAL'],
  ARRAY['ORTHOPEDICS'],
  'live'
) ON CONFLICT (rule_set_id) DO NOTHING;

INSERT INTO hospital.insurance_rules (
  rule_set_id, rule_id, rule_name, rule_description, category, severity, impact,
  mandatory, validation_logic, failure_message, remediation_guidance,
  required_documents, estimated_deduction_amount, query_template, order_index
)
SELECT s.id, v.rule_id, v.rule_name, v.rule_description, v.category, v.severity, v.impact,
       v.mandatory, v.validation_logic::jsonb, v.failure_message, v.remediation_guidance,
       v.required_documents, v.estimated_deduction_amount, v.query_template, v.order_index
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('PMJAY_THR_001', 'Pre-operative X-ray Required',
   'Hip X-ray taken before THR is mandatory for PMJAY claims',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.clinical_timeline[*].diagnostics_performed[?(@.diagnostic_meta.category==\"RADIOLOGY\")]","operator":"EXISTS"}',
   'Pre-operative hip X-ray not found',
   'Upload pre-op X-ray of the hip joint clearly showing pathology',
   ARRAY['XRAY_IMAGES']::TEXT[], NULL::NUMERIC,
   'Pre-op X-ray is required to validate THR procedure. Please share dated film.', 10),
  ('PMJAY_THR_002', 'Implant Sticker Mandatory',
   'Implant sticker with batch / lot / serial must be present',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.images[?(@.image_type==\"IMPLANT_STICKER\")]","operator":"EXISTS"}',
   'Implant sticker missing',
   'Upload clear image of implant sticker. Full implant cost otherwise deducted.',
   ARRAY['IMPLANT_STICKER']::TEXT[], NULL::NUMERIC, NULL, 20),
  ('PMJAY_THR_003', 'Implant Invoice Mandatory',
   'Original implant invoice from authorised dealer required',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'DEDUCTION', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.bills[?(@.bill_type==\"IMPLANT_BILL\")]","operator":"EXISTS"}',
   'Original implant invoice not provided', NULL,
   ARRAY['IMPLANT_INVOICE']::TEXT[], 30000::NUMERIC, NULL, 30),
  ('PMJAY_THR_004', 'OT Notes Signed and Dated',
   'Operative notes must be signed by surgeon and dated',
   'DOCUMENT_COMPLETENESS', 'HIGH', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.notes[?(@.note_type==\"OT_NOTES\" && @.signed==true)]","operator":"EXISTS"}',
   'OT notes not signed/dated',
   'Surgeon to sign and date OT notes, then re-upload.',
   ARRAY['OT_NOTES']::TEXT[], NULL::NUMERIC, NULL, 40),
  ('PMJAY_THR_005', 'Anesthesia Notes Required',
   'Anesthesia chart and notes required',
   'DOCUMENT_COMPLETENESS', 'MEDIUM', 'QUERY', false,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.notes[?(@.note_type==\"ANESTHESIA_NOTES\")]","operator":"EXISTS"}',
   'Anesthesia notes not found', NULL,
   ARRAY['ANESTHESIA_NOTES']::TEXT[], NULL::NUMERIC, NULL, 50),
  ('PMJAY_THR_006', 'Discharge Summary Signed',
   'Discharge summary must be signed by the treating doctor',
   'DOCUMENT_COMPLETENESS', 'CRITICAL', 'QUERY', true,
   '{"logic_type":"EXISTENCE_CHECK","json_path":"$.documents.notes[?(@.note_type==\"DISCHARGE_SUMMARY\" && @.signed==true)]","operator":"EXISTS"}',
   'Discharge summary missing or unsigned', NULL,
   ARRAY['DISCHARGE_SUMMARY']::TEXT[], NULL::NUMERIC, NULL, 60),
  ('PMJAY_THR_007', 'Final Bill Within Package',
   'Final billed amount must be within PMJAY package cap',
   'FINANCIAL_LIMITS', 'HIGH', 'DEDUCTION', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_pmjay_package_match"}',
   'Final bill exceeds PMJAY package amount', NULL,
   ARRAY['FINAL_BILL']::TEXT[], NULL::NUMERIC, NULL, 70),
  ('PMJAY_THR_008', 'LOS Within Tolerance',
   'Length of stay must be within procedure benchmark + tolerance',
   'TEMPORAL_VALIDITY', 'MEDIUM', 'QUERY', false,
   '{"logic_type":"COMPLEX_CONDITION","custom_function":"validate_los_against_benchmark"}',
   'LOS exceeds benchmark', NULL,
   ARRAY['DAILY_PROGRESS_NOTES']::TEXT[], NULL::NUMERIC, NULL, 80)
) AS v(rule_id, rule_name, rule_description, category, severity, impact, mandatory,
        validation_logic, failure_message, remediation_guidance, required_documents,
        estimated_deduction_amount, query_template, order_index)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1'
ON CONFLICT (rule_set_id, rule_id) DO NOTHING;

INSERT INTO hospital.insurer_document_requirements (rule_set_id, document_type, required_when, mandatory, stage, quality_requirements)
SELECT s.id, v.dt, v.rw, v.mn, v.st, v.qr::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('XRAY_IMAGES',       NULL, true,  'PRE_AUTH',    NULL),
  ('OT_NOTES',          NULL, true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_dated":true}'),
  ('ANESTHESIA_NOTES',  NULL, false, 'FINAL_CLAIM', NULL),
  ('IMPLANT_STICKER',   NULL, true,  'FINAL_CLAIM', NULL),
  ('IMPLANT_INVOICE',   NULL, true,  'FINAL_CLAIM', NULL),
  ('DISCHARGE_SUMMARY', NULL, true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_dated":true}'),
  ('FINAL_BILL',        NULL, true,  'FINAL_CLAIM', '{"must_be_signed":true,"must_be_stamped":true}')
) AS v(dt, rw, mn, st, qr)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1';

INSERT INTO hospital.insurer_financial_limits (rule_set_id, limit_kind, config)
SELECT s.id, v.k, v.c::jsonb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('package_cap',  '{"limit_type":"FIXED_AMOUNT","procedure_code":"THR","limit_amount":90000}'),
  ('implant_caps', '[{"implant_type":"HIP_REPLACEMENT","max_amount":60000,"requires_preauth":true}]')
) AS v(k, c)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1';

INSERT INTO hospital.insurer_los_benchmarks (rule_set_id, procedure_code, procedure_name, expected_los_days, expected_icu_days, tolerance_days, justification_required_beyond)
SELECT s.id, v.pc, v.pn, v.elos, v.eicu, v.tol, v.jrb
FROM hospital.insurer_rule_sets s
CROSS JOIN (VALUES
  ('THR',                   'Total Hip Replacement (PMJAY package)', 8::NUMERIC, 0::NUMERIC, 2::NUMERIC, 10::NUMERIC),
  ('TOTAL_HIP_REPLACEMENT', 'Total Hip Replacement',                 8::NUMERIC, 0::NUMERIC, 2::NUMERIC, 10::NUMERIC)
) AS v(pc, pn, elos, eicu, tol, jrb)
WHERE s.rule_set_id = 'SADBHAWANA_PMJAY_THR_V1';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 045_ai_corrections.sql
-- ════════════════════════════════════════════════════════════
-- Migration 045: AI Corrections — Unified Audit + Mining Input (Wave 10)
-- Date: 2026-05-18
--
-- Wave 10 — Correction-to-KB Pipeline.
--
-- The system already records "human edited what the AI did" across four
-- domain-specific surfaces:
--
--   * hospital.document_section_corrections   (Wave 2 — section split / merge / reclassify)
--   * hospital.email_intelligence_corrections (Wave 2 — AI draft field overrides)
--   * hospital.harmonisation_corrections      (Wave 7 — JSONPath-keyed episode edits)
--   * hospital.rule_overrides                 (Wave 8 — rule_overreach overrides)
--
-- Each lives at the grain of its own writer because the writers care about
-- shape-specific columns (section_id, draft_id, json_path, rule_id, ...).
-- That's fine for the original write path, but the *mining* path wants a
-- single denormalised stream it can group by and threshold against.
--
-- hospital.ai_corrections is that stream: every domain-specific correction
-- ALSO inserts a row here, with:
--
--   * surface       — discriminates the source table
--   * target_id     — varies (section_id / draft_id / rule_id / json_path)
--   * target_kind   — secondary discriminator (e.g. 'discharge_slip')
--   * ai_value      — what the AI said
--   * human_value   — what the human corrected to
--   * reason        — free-text human note (often NULL for non-rule overrides)
--   * applied_to_kb — flipped to true once the row is consumed by the miner,
--                     so a re-mining run doesn't re-mine the same evidence
--   * mined_pattern_id — back-link to kb_patterns.id when the row contributed
--
-- We deliberately don't UNION ALL the four source tables in a view because
-- the original writers may need to evolve their schemas without breaking the
-- mining pipeline. A persisted denormalised table also gives us cheap
-- partial indexes on applied_to_kb=false.
--
-- The kb_patterns table also gets an evidence_correction_ids UUID[] so a
-- promoted pattern can be drilled back to the raw human edits.

BEGIN;

-- ============================================================================
-- A. hospital.ai_corrections
-- ============================================================================

CREATE TABLE IF NOT EXISTS hospital.ai_corrections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which source surface emitted the correction. Open enum — adding a new
  -- surface in a future wave just needs an ALTER on the CHECK.
  surface               VARCHAR(64) NOT NULL
                        CHECK (surface IN (
                          'document_category',
                          'extraction_field',
                          'harmonised_field',
                          'rule_override',
                          'ai_draft_field',
                          'audit_call_wrong'
                        )),

  -- Optional: claim grain. Not all surfaces have a claim_id (e.g. a
  -- standalone audit-call-wrong row before a claim is matched). When set,
  -- delete-claim cascades wipe the correction trail.
  claim_id              UUID REFERENCES hospital.ipds(id) ON DELETE CASCADE,

  -- The natural id of the target whose correction we're recording. Type
  -- varies by surface — VARCHAR is the lowest common denominator. The
  -- miner reads this opaquely (group-by) and doesn't try to FK-validate.
  target_id             VARCHAR(128),

  -- Additional discriminator within a surface (e.g. 'discharge_slip' for
  -- document_category, the field_path for ai_draft_field, the rule_id for
  -- rule_override, etc). The miner uses (surface, target_kind) as its
  -- primary grouping key for most strategies.
  target_kind           VARCHAR(64),

  ai_value              JSONB,
  human_value           JSONB NOT NULL,
  reason                TEXT,

  corrected_by          UUID NOT NULL,
  corrected_at          TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Mining lineage. applied_to_kb flips to true once the miner has consumed
  -- the row (either contributed to a candidate or rolled into the count of
  -- an existing candidate). mined_pattern_id points at the resulting
  -- kb_patterns row when one was generated.
  applied_to_kb         BOOLEAN NOT NULL DEFAULT false,
  mined_pattern_id      UUID
);

-- ---- Indexes --------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_ai_corrections_surface
  ON hospital.ai_corrections (surface);

CREATE INDEX IF NOT EXISTS idx_ai_corrections_claim
  ON hospital.ai_corrections (claim_id);

-- Hot path for the miner: "give me every unmined row by surface". Partial
-- index keeps it small — most rows are eventually mined.
CREATE INDEX IF NOT EXISTS idx_ai_corrections_unmined
  ON hospital.ai_corrections (corrected_at DESC)
  WHERE applied_to_kb = false;

CREATE INDEX IF NOT EXISTS idx_ai_corrections_surface_kind
  ON hospital.ai_corrections (surface, target_kind);

COMMENT ON TABLE hospital.ai_corrections IS
  'Wave 10 — unified, denormalised stream of every human correction over an AI output. Source surfaces still own their domain tables; this is the mining input.';

COMMENT ON COLUMN hospital.ai_corrections.surface IS
  'document_category | extraction_field | harmonised_field | rule_override | ai_draft_field | audit_call_wrong';

COMMENT ON COLUMN hospital.ai_corrections.target_id IS
  'Natural id of the corrected target (section_id, draft_id, rule_id, json_path, ...). Opaque to the miner — used only for group-by.';

COMMENT ON COLUMN hospital.ai_corrections.applied_to_kb IS
  'true once a miner run has consumed this row. Re-mining skips applied rows so evidence is not double-counted.';

-- ============================================================================
-- B. hospital.kb_patterns — back-link to source corrections
-- ============================================================================
-- When a candidate is mined from corrections we want to be able to render
-- the raw human edits that justified it on the review screen. We store a
-- bounded list (same cap as evidence_claim_ids) of ai_corrections.id rows.

ALTER TABLE hospital.kb_patterns
  ADD COLUMN IF NOT EXISTS evidence_correction_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN hospital.kb_patterns.evidence_correction_ids IS
  'Wave 10 — for correction-driven patterns (category_confusion / harmonisation_drift / rule_overreach / extraction_field_pattern), the ai_corrections.id rows that justified this pattern.';

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 060_claim_ai_runs.sql
-- ════════════════════════════════════════════════════════════
-- ============================================================================
-- claim_ai_runs — the AI pipeline's claim-level run cursor
-- ============================================================================
-- Background (May 20, 2026):
--   The intelligence pipeline is a chain of Bull workers (bundle classifier
--   → section dedup → extractor → harmoniser → adjudication). Each worker
--   writes its outputs to the DB asynchronously as it finishes. The
--   frontend has historically polled `document_sections` directly to
--   render the Claim AI Summary > Documents tab — which means it sees
--   partial state every time it polls, and that partial state KEEPS
--   CHANGING for the 2-5 minutes it takes the pipeline to finish all
--   docs. Result: documents appear, sections shift, the "extracted" count
--   ticks upward on every refresh. Users reasonably interpret this as
--   "the analysis is unstable / unreliable".
--
--   The fix is a claim-level run cursor: one row inserted at the start of
--   each `Run AI Analysis` click, updated as the pipeline progresses,
--   marked `succeeded` only when ALL docs are done. The FE polls this
--   row and gates the Documents tab on its terminal state. Mid-run, it
--   shows a single progress card instead of a flickering half-built
--   table.
--
--   This migration is the first step of the 7-step pipeline re-arch
--   tracked in ADR-2026-05-20. Subsequent steps add a per-doc phase
--   ledger, split orientation/quality into their own phases, and move
--   file-level dedup ahead of classify. Step 1 alone is enough to stop
--   the flicker.

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.claim_ai_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id         UUID NOT NULL,
  triggered_by     UUID,                              -- user_id, NULL for system-triggered runs
  triggered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Run lifecycle:
  --   queued      → orchestrator accepted the request, workers not yet active
  --   running     → at least one phase is in flight
  --   succeeded   → all phases finished with no per-doc failures
  --   partial     → all phases finished, but ≥1 doc failed (docs_failed > 0)
  --   failed      → the run itself crashed (orchestrator-level error)
  --   superseded  → a newer Run AI click for the same claim_id took over
  status           TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','running','succeeded','partial','failed','superseded')),

  -- Coarse phase indicator for the FE progress banner. Granular per-doc
  -- detail will land in doc_phase_ledger (Step 3 of the rearch). Today
  -- this is good enough for "Processing… Classify phase 2/5".
  phase            TEXT
                       CHECK (phase IS NULL OR phase IN (
                         'quality','orient','dedup','classify','extract','harmonise','done'
                       )),

  -- Progress counters. `total_docs` is set once at start; `docs_completed`
  -- and `docs_failed` advance as workers finish. The FE renders
  -- "{docs_completed}/{total_docs} documents" until status flips terminal.
  total_docs       INT NOT NULL DEFAULT 0,
  docs_completed   INT NOT NULL DEFAULT 0,
  docs_failed      INT NOT NULL DEFAULT 0,

  -- Cumulative LLM cost for this run. Useful for the audit log + future
  -- per-run cost telemetry. NULL until at least one billed call lands.
  cost_inr         NUMERIC(10,4),

  -- Terminal timestamps. `finished_at` is set when status flips terminal
  -- (succeeded/partial/failed/superseded). Audit trail: every run row
  -- is retained per the ADR decision — no auto-cleanup.
  finished_at      TIMESTAMPTZ,
  error            TEXT,                              -- orchestrator-level error if status='failed'

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The FE's "current run" lookup: latest row for a given claim_id. We sort
-- by triggered_at DESC, so this composite index serves both that query
-- and historical audit lookups for a claim.
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_claim_triggered
  ON hospital.claim_ai_runs (claim_id, triggered_at DESC);

-- For supersession: when a new run starts, we need to find any
-- still-running runs for this claim. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_claim_ai_runs_active
  ON hospital.claim_ai_runs (claim_id)
  WHERE status IN ('queued','running');

-- updated_at touch trigger so the orchestrator + worker writes don't need
-- to remember to bump it explicitly.
CREATE OR REPLACE FUNCTION hospital.claim_ai_runs_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_claim_ai_runs_touch_updated_at ON hospital.claim_ai_runs;
CREATE TRIGGER trg_claim_ai_runs_touch_updated_at
  BEFORE UPDATE ON hospital.claim_ai_runs
  FOR EACH ROW
  EXECUTE FUNCTION hospital.claim_ai_runs_touch_updated_at();

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 061_doc_phase_ledger.sql
-- ════════════════════════════════════════════════════════════
-- ============================================================================
-- doc_phase_ledger — per-doc, per-phase audit trail for the AI pipeline
-- ============================================================================
-- Step P6 of the May 20, 2026 pipeline re-architecture (companion to
-- migration 060 which added claim_ai_runs).
--
-- Background:
--   claim_ai_runs gives us a CLAIM-level cursor: "Run R is at phase=classify,
--   docs_completed=5/12". That's enough for the FE to render a coarse
--   progress banner, but not enough to answer:
--     - WHICH 5 docs are done? Which 7 are still in flight?
--     - When the run finished, did any doc fail quality gate or get
--       skipped via file-dedup?
--     - What was the OCR rotation chosen for each doc? Was vision used?
--   The status endpoint's aggregator-only design (claimAiRun.recomputeFromState)
--   reads document_sections to count progress — that's a roll-up, not a
--   per-doc audit trail.
--
--   doc_phase_ledger is the audit trail. ONE row per (doc_id, run_id,
--   phase) tuple. Workers write a row at the start of each phase (status=
--   running) and finish it (status=done | skipped | failed) when they
--   exit. The evidence JSONB carries phase-specific outcomes — rotation
--   angle, OCR confidence, dedup pointer, extractor model used, etc.
--
--   Phases enumerated:
--     ingest    → quality gate + OCR + orientation + pHash compute (Phase 1)
--     classify  → bundle classifier (Phase 2)
--     dedup     → section dedup pass (Phase 3) — claim-level not per-doc,
--                  but we record one row per doc with the outcome
--     extract   → docExtractor (Phase 4)
--     harmonise → claim harmoniser (Phase 5) — also claim-level
--
-- Why per (doc, run, phase) tuple:
--   - Re-runs are first-class. Run #1 might have failed a doc at extract;
--     Run #2 (force) succeeds. We want both rows preserved for audit.
--   - The (doc, run, phase) composite key naturally idempotent — workers
--     can UPSERT and the row is unique.
--
-- What the FE gets out of this:
--   /claims/:id/status returns the LATEST run row from claim_ai_runs
--   plus a roll-up of doc_phase_ledger for that run. FE renders:
--     "Doc 5/12 · OCR ✓ (rotated 90°) · Classifying…"

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.doc_phase_ledger (
  doc_id            UUID NOT NULL,
  run_id            UUID NOT NULL REFERENCES hospital.claim_ai_runs(id) ON DELETE CASCADE,
  phase             TEXT NOT NULL CHECK (phase IN (
                      'ingest','classify','dedup','extract','harmonise'
                    )),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                      'pending','running','done','skipped','failed'
                    )),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,

  -- Free-form per-phase outcomes. Shape conventions (documented here,
  -- not enforced by schema):
  --   ingest:    { quality_score?: number, mime?: string, page_count?: number,
  --                rotation_pages?: [{page: 5, angle: 90}, ...],
  --                ocr_avg_confidence?: number, needs_human_review?: boolean }
  --   classify:  { sections_created: number, fell_back_to_segmenter?: boolean,
  --                llm_cost_inr?: number, classifier_version?: string }
  --   dedup:     { groups_found: number, sections_deduped: number,
  --                methods: ['text_exact', 'phash_v1'] }
  --   extract:   { section_count: number, sections_extracted: number,
  --                sections_no_schema?: number, llm_cost_inr?: number }
  --   harmonise: { episode_status: string, cost_inr?: number,
  --                source_documents_count?: number }
  evidence          JSONB,

  -- Surfaces in the FE when status='failed' so reviewers know why a
  -- doc was kicked from a phase without diving into worker logs.
  error             TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (doc_id, run_id, phase)
);

-- Run roll-up: "all phases for run R" — used by status endpoint.
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_run
  ON hospital.doc_phase_ledger (run_id, phase);

-- Per-doc lookup across runs (audit trail for a single doc over time).
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_doc
  ON hospital.doc_phase_ledger (doc_id, run_id);

-- Stall detection: "any phase in 'running' state for >5 minutes" needs
-- to be queryable cheaply. Partial index on running rows only.
CREATE INDEX IF NOT EXISTS idx_doc_phase_ledger_running
  ON hospital.doc_phase_ledger (started_at)
  WHERE status = 'running';

-- updated_at touch trigger — same pattern as claim_ai_runs.
CREATE OR REPLACE FUNCTION hospital.doc_phase_ledger_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_doc_phase_ledger_touch_updated_at ON hospital.doc_phase_ledger;
CREATE TRIGGER trg_doc_phase_ledger_touch_updated_at
  BEFORE UPDATE ON hospital.doc_phase_ledger
  FOR EACH ROW
  EXECUTE FUNCTION hospital.doc_phase_ledger_touch_updated_at();

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 064_extraction_corrections.sql
-- ════════════════════════════════════════════════════════════
-- ============================================================================
-- extraction_corrections — reviewer overrides of AI-emitted extraction values
-- ============================================================================
-- Background (May 21, 2026):
--   ai_corrections (mig 045) is the GLOBAL correction firehose used by the
--   KB miner: surface-tagged, hashed-into-patterns, and frequently re-
--   classified. Useful for prompt iteration but lossy for accuracy math —
--   you can't cleanly compute "% of patient_context.first_name values
--   reviewers changed for hospital X in the last 30 days" because the
--   `target_kind` field is overloaded across surfaces and the field-path
--   isn't queryable.
--
--   This table is the per-claim, field-grained ledger that the FE reviewer
--   UI writes into on every override. Three downstream consumers:
--     1. Hospital accuracy dashboards (per-hospital, per-field rollups)
--     2. Few-shot training data for the next extractor iteration
--     3. Systemic-error detection — (hospital_id, field_path) pairs that
--        get corrected > N times signal a prompt bug worth fixing
--
--   Out of scope for THIS migration: the FE writes (separate downstream
--   task) and any back-propagation into ai_corrections. Both tables co-
--   exist — ai_corrections stays the KB miner's input, extraction_
--   corrections stays the accuracy ledger.

BEGIN;

CREATE TABLE hospital.extraction_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES hospital.ipds(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  -- the target of the correction
  target_kind TEXT NOT NULL CHECK (target_kind IN (
    'section_extracted_field',
    'harmonised_episode_field',
    'canonical_patient',
    'foreign_document_flag',
    'id_conflict'
  )),
  section_id UUID REFERENCES hospital.document_sections(id) ON DELETE SET NULL,
  -- json-pointer-ish path into either extracted_fields or episode, e.g.
  -- "patient_context.first_name" or "diagnosis.primary_diagnosis.diagnosis_name"
  field_path TEXT NOT NULL,
  -- what the AI emitted (JSONB so we capture object/string/number/null faithfully)
  ai_value JSONB,
  -- what the reviewer corrected it to
  corrected_value JSONB,
  -- free-form reviewer note explaining WHY
  reason TEXT,
  -- audit
  reviewer_id UUID,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- did this correction get rolled back later? (e.g. another reviewer disagreed)
  superseded_at TIMESTAMPTZ,
  superseded_by UUID
);

CREATE INDEX idx_extr_corrections_claim ON hospital.extraction_corrections(claim_id);
CREATE INDEX idx_extr_corrections_hospital_field ON hospital.extraction_corrections(hospital_id, field_path);
CREATE INDEX idx_extr_corrections_recent ON hospital.extraction_corrections(reviewed_at DESC) WHERE superseded_at IS NULL;

COMMIT;

-- ════════════════════════════════════════════════════════════
-- 065_hospital_format_profiles.sql
-- ════════════════════════════════════════════════════════════
-- ============================================================================
-- 065 — Hospital format profiles + Document format library  (Phase 3, May 21, 2026)
-- ============================================================================
-- Two related capabilities for scalable extraction:
--
-- A. hospital_format_profiles  (few-shot learning per hospital)
--    Reviewers correct extractor mistakes via the extraction_corrections
--    ledger (mig 064). When enough corrections converge on a consistent
--    pattern for (hospital, doc_category, field), we precipitate that
--    pattern out as a "format profile" — a short, prompt-ready hint that
--    can be injected into the extractor system prompt for ALL future
--    documents from that hospital. This lets accuracy improve organically
--    as a hospital's claim stream accumulates without re-training the LLM.
--
-- B. document_format_library  (pHash-based layout fingerprinting)
--    Many docs from the same hospital share an EXACT layout (e.g. the
--    Jigyasa coronary-angiography report v2). The pHash of the first
--    canonical section's first page fingerprints that layout. We keep a
--    library of known formats per hospital so we can later fast-path
--    extraction for known formats (deterministic field-position reads,
--    hospital-specific extractor routes). This migration just BUILDS the
--    library — routing on matches comes in a later iteration.
--
-- Both tables are additive — no destructive operations. Idempotent on
-- replay (CREATE TABLE IF NOT EXISTS).

BEGIN;

-- ──────────────────────────────────────────────────────────────────────
-- A. hospital_format_profiles
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hospital.hospital_format_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  doc_category VARCHAR(100) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  -- Short natural-language hint about how this hospital formats this field.
  -- Read by the extractor prompt assembly; goes into the user message as a
  -- HOSPITAL_FORMAT_HINTS bullet.
  extraction_hint TEXT NOT NULL,
  -- Verbatim quote from a past document and the reviewer-corrected value.
  -- Used as the "few-shot example" half of the hint. Optional — purely
  -- text-narrative profiles can omit these.
  example_quote TEXT,
  example_value TEXT,
  -- Bookkeeping: how many distinct reviewer corrections this profile was
  -- aggregated from. Higher = more reliable. The aggregator bumps this
  -- on each rebuild; the prompt assembler sorts DESC by confidence so
  -- the most-reliable hints survive the 1500-token cap.
  source_correction_count INT DEFAULT 0,
  confidence NUMERIC(4,3) DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hospital_id, doc_category, field_name)
);

CREATE INDEX IF NOT EXISTS idx_hfp_hospital_cat
  ON hospital.hospital_format_profiles(hospital_id, doc_category);

-- ──────────────────────────────────────────────────────────────────────
-- B. document_format_library
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS hospital.document_format_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  doc_category VARCHAR(100),
  -- Human-readable label, e.g. "Jigyasa Coronary Angiography Report v1".
  -- Initially auto-generated ("<hospital>:<category>:<short_hash>"); admins
  -- can rename via the format-library admin UI.
  format_label TEXT NOT NULL,
  -- Representative pHash of the layout. For now, the first page of the
  -- first canonical section, which is enough to fingerprint most
  -- single-page forms (admission slip, discharge slip, lab report header).
  representative_phash TEXT NOT NULL,
  -- Sample document_section IDs that exemplify this format (kept for
  -- human review of misclassifications and for the later deterministic
  -- extractor to bootstrap field positions). Capped at ~10 entries by
  -- the service to keep the row small.
  sample_section_ids UUID[] DEFAULT '{}',
  -- Hand-curated field bounding boxes per format. Populated later for
  -- hot formats; this migration leaves it NULL.
  field_positions JSONB,
  occurrence_count INT DEFAULT 0,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hospital_id, representative_phash)
);

CREATE INDEX IF NOT EXISTS idx_dfl_phash
  ON hospital.document_format_library(representative_phash);
CREATE INDEX IF NOT EXISTS idx_dfl_hospital_cat
  ON hospital.document_format_library(hospital_id, doc_category);

COMMIT;
