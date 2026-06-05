# Stage-Aware Adjudication Engine — Phased Implementation Plan

**Audience:** Engineering (staff/architect review). **Scope:** Planning only — no code, no repo writes.
**Repo root:** `/Users/maverick/Documents/Finclarity-Tech/claimsos` (all paths absolute or under `Backend/src/`).
**Date:** 2026-06-02. **Next free migration number (verified):** `067` (highest existing is `066_derived_page.sql`).

---

## 1. Goal, Design Baseline, and What Must Be Frozen Before M0

### 1.1 Goal

Turn today's two disjoint, mostly-unmounted rule surfaces (Wave 3A document-presence + Wave 8 content rules) and a naive stage default into **one stage-aware adjudication engine** that:

1. **Deterministically resolves context** `{scheme, route, insurer, stage, case_type}` per submission with **zero ground-ops tagging**, replacing today's `inferTargetStage(null,…) → 'preauth_submitted'` fallback (`adjudicationEngine.service.ts:566-568, 149,167`).
2. **Tags every `document_section` with its stage** and preserves per-document-type field provenance.
3. Runs **one stage-scoped rules engine** selected by `{scheme, route, insurer, stage, case_type}`, executing two rule families (document-sufficiency + content) over a **pluggable evaluator-kind registry** where rules are **data**.
4. Emits a **4-layer hypothesis** per `(claim, stage)`: (1) documents+stage, (2) content/fields, (3) rules applied + pass/fail + cited evidence, (4) readiness score + recommended action.
5. Captures **per-layer human feedback with root-cause attribution** that authors the rule library (deterministic fixes) or feeds the replay eval harness (model fixes).
6. Gates **graduated autonomy per slice (panel × stage × case_type) and per layer**, with the auto-submit action gated separately from assessment.

### 1.2 Design baseline (carried from the brief — the starting point, not frozen)

- Auto-Context resolver as **Stage 0**: admission/panel record + empanelment are the source of truth for scheme/route/insurer; doc-mix + timeline + dates for stage; procedures/episode_type for case_type. LLM/derived signals are **cross-checks only**.
- Stage-aware document understanding tagging each `document_section`.
- **One** engine, two rule families, polymorphic `kind`-dispatched evaluators (deterministic in-process; semantic/vision via constrained single-purpose evaluators with structured output + confidence, cached).
- Boundary: **pipeline INTERPRETS** (facts + rule inputs); **rules/decision layer ADJUDICATES**. No whole-claim veto inside the pipeline.
- Human-in-the-loop flywheel + rule-miner; graduated autonomy controller.
- Versioned rule-set CRUD + admin UI (today: SQL-migration-only — a scaling blocker).

### 1.3 Open decisions that MUST be frozen before M0

These are genuine forks; building before they are decided causes rework or a migration churn. Each has a recommended default.

| # | Decision to freeze | Why it blocks | Recommended default |
|---|---|---|---|
| F1 | **Engine consolidation strategy**: fold Wave 3A `stage_requirements` into Wave 8 `insurance_rules` as new evaluator kinds, vs. keep two engines and orchestrate. | Determines whether 3A rows migrate into `insurance_rules` and whether `claim_rule_evaluations` is the single persistence path. The whole evaluator-kind registry and the per-stage UPSERT key depend on this. | **Fold into one engine.** Wave 8 (`rulesEngineV2.service.ts`) is the strictly more general substrate (pluggable `logic_type` dispatch `:432`, persistence `:593-633`, overrides, versioned `status` lifecycle). 3A presence checks become `DOCUMENT_PRESENCE` / `REQUIRED_FIELDS` kinds. Wave 3A engine is left in place, dark, until parity is proven (see M5). |
| F2 | **Stage taxonomy is the join key everywhere** — confirm the 19 `master_options(category='ipd_stage')` codes (migration `024:27-46`) are the canonical stage vocabulary used by `document_sections.stage`, rule-set selection, and per-stage evaluation history. | If stage codes diverge across tables, every join and the cache key break. | Adopt the 19 ipd_stage codes as the **single** stage vocabulary; FK/validate all new stage columns against `master_options(category='ipd_stage')` exactly as `ipds.stage` does. |
| F3 | **`scheme` and `case_type` vocabularies.** `scheme` ≈ panel code (`PMJAY`, `CASHLESS_EVERYWHERE`); `route` = `ipds.claim_filing_route` CHECK (`cashless_everywhere`\|`network`, migration 017); `insurer` = `panel_id` (panels double as insurers — no insurers table). `case_type` candidate = `episode.meta.episode_type`. | These five fields are the rule-pack selection key and the `claim_context` columns. Their domains must be fixed before the selection schema lands. | `scheme` = `master_options(category='scheme')` seeded from observed panel codes; `route` = reuse the 017 CHECK enum; `insurer` = `panel_id` (UUID); `case_type` = new `master_options(category='case_type')` seeded from `episode_type` values. Freeze all four as `master_options` categories so they are data, not code. |
| F4 | **Confidence + abstention contract for semantic/vision evaluators.** What confidence floor demotes a kind result to `SKIP`/`needs_review` rather than `PASS`/`FAIL`? Is confidence a single float or per-field? | The evaluator-kind contract (§4) and the readiness scorer both consume it; changing it later reshapes `claim_rule_evaluations`. | Single `confidence ∈ [0,1]` per evaluation + a per-kind `min_confidence` threshold stored on the rule; below threshold ⇒ `status='SKIP'` with `evidence.reason='low_confidence'`. Never let a low-confidence semantic result drive an auto action. |
| F5 | **Provenance granularity.** "Preserve per-document-type field provenance" — store provenance as (a) a column on `document_sections.extracted_fields` entries, or (b) a separate provenance table. | Layer-2 of the hypothesis and feedback root-cause both read provenance; the shape is load-bearing for the flywheel. | Keep provenance **inline** in `document_sections.extracted_fields` (already JSONB, `032:84`) as `{value, source_section_id, source_document_id, confidence}` per field; do **not** only fuse into one episode. No new table in M1. |
| F6 | **Cache-key semantics for stage.** `hashDossierState(dossier, target_stage)` (`adjudicationEngine.service.ts:571, 192-208`) already hashes `current_panel_id` + `current_insurer_id`. Does resolved `{scheme,route,case_type}` enter the hash? | If context fields are not in the hash, a context correction won't invalidate the cached report. | Yes — the **entire resolved context vector** enters the cache key, plus the rule-pack version. A context override therefore forces re-adjudication (consistent with the "re-run = from scratch" memory). |
| F7 | **Autonomy gating metric + asymmetric cost weights.** Exact definition of "joint correctness" and the false-auto-file penalty. | The graduation controller (M8) cannot be built without the metric definition; but it does **not** block the deterministic spine. | Freeze before M8, **not** before M0. Default: per-slice precision on the recommended-action layer, with false-auto-file weighted ≫ false-hold; auto-submit gated on a separate, stricter threshold than assessment. |

> **F1–F6 must be frozen before M0.** F7 must be frozen before M8.

---

## 2. Target Architecture Component Map

Boundary rule applied throughout: **everything in §2.1–§2.3 produces facts/inputs (INTERPRET). §2.4–§2.6 consume them to ADJUDICATE.** No component left of the boundary may veto a claim.

```
┌──────────────────────── INTERPRET (pipeline) ─────────────────────────┐   ┌──── ADJUDICATE (decision layer) ────┐
│                                                                        │   │                                     │
│  [A] Auto-Context Resolver (Stage 0)                                   │   │  [C] Unified Stage-Scoped Rules     │
│      → claim_context{scheme,route,insurer,stage,case_type,confidence}  │   │      Engine + Evaluator-Kind        │
│                                                                        │   │      Registry                       │
│  [B] Stage-Aware Document Understanding                                │   │      → claim_rule_evaluations       │
│      → document_sections.stage + inline field provenance               │   │        (per claim,stage,rule)       │
│                                                                        │   │                                     │
└────────────────────────────────────────────────────────────────────────┘   │  [D] 4-Layer Hypothesis Assembler   │
                                                                               │      → claim_hypothesis              │
   [E] Feedback / Flywheel  ◄── per-layer feedback + root-cause ──────────────┤  [F] Graduation / Autonomy          │
       (rule-miner, replay harness)                                            │      Controller (per slice×layer)   │
   [G] Authoring CRUD (versioned rule-set lifecycle + admin UI)                └─────────────────────────────────────┘
```

### [A] Auto-Context Resolver (Stage 0) — INTERPRET

**Responsibility:** Deterministically resolve `{scheme, route, insurer, stage, case_type}` + a per-field `confidence` and `source`, persist to `claim_context`. LLM/derived signals are recorded as cross-checks (`agreed`/`disagreed`) but never override the deterministic source of truth.

**Slot into existing code:**
- **Primary call site:** `adjudicationEngine.service.ts` `run()` — insert the resolver **after** `getDossier` (`:561`) and **before** target_stage resolution (`:566-568`). Replace the `input.target_stage ?? inferTargetStage(...)` line with `resolved.stage` (resolver still honors an explicit `input.target_stage` override).
- **Populate hook:** `intelligenceOrchestrator.service.ts:352-387` — run/refresh context between Step 3 (`rebuildFromEvents`) and Step 4 (`engine.run`). `analyzeClaim` (`:79`) is the operator entrypoint.
- **Fix the unpopulated upstream:** today `current_insurer_id` is always null (`claimDossier.service.ts:154-155`); `current_stage` is null after a rebuild because `bootstrapShell` (`:131-164`) never copies `ipds.stage`; `doc_sufficiency_per_stage` is declared but never folded (`projector:101-107`). The resolver is the new single owner of these, reading deterministic signals (§ Recon-B-4): `ipds.panel_id`/`hospital_panel_id`, `ipds.claim_filing_route` (017), `panel_attributes.is_empanelled` (020), `dossier.doc_sections_by_category` (`projector:315-334`), `events_summary` timeline (`projector:189-202`), admission/discharge datetimes, `episode.meta.episode_type`, `procedures`.

**Boundary:** produces context facts only; does not pass/fail anything.

### [B] Stage-Aware Document Understanding — INTERPRET

**Responsibility:** Tag each `document_section` with the stage it belongs to and keep per-document-type field provenance (do not collapse everything into one fused episode).

**Slot into existing code:**
- New `document_sections.stage VARCHAR(40)` validated against `master_options(category='ipd_stage')`, added alongside `category` (`032:74`) via migration 067, with a partial index paralleling `idx_document_sections_claim_category` (`032:121-123`).
- The classifier/segmenter that writes `category` (Wave 7 pipeline; `section_classified` fold at `projector:315-334`) is extended to also emit `stage`. Stage tag is **deterministic-first** (doc category → stage map, same logic `inferTargetStage` uses at `:155-162`), with the semantic classifier as a cross-check only.
- Provenance stays inline in `document_sections.extracted_fields` (JSONB, `032:84`) per F5.

**Boundary:** tags and provenance are facts; no adjudication.

### [C] Unified Stage-Scoped Rules Engine + Evaluator-Kind Registry — ADJUDICATE

**Responsibility:** Select **one** rule pack by `{scheme, route, insurer, stage, case_type}` and evaluate two rule families (document-sufficiency + content) through a kind-dispatched registry. Deterministic kinds run in-process; semantic/vision kinds call constrained single-purpose evaluators with structured output + `confidence`, cached. Every outcome cites evidence.

**Slot into existing code (all verified):**
- **Selection:** extend `resolveRuleSet` (`rulesEngineV2.service.ts:357-400`). Today the key is insurer × treatment × specialty (SQL prefilter `:358-366`, scoring `:371-389`). Add `scheme`, `route`, `stage`, `case_type` as additional SQL gates + score terms, mirroring the existing treatment/specialty filter exactly.
- **Context:** extend `ClaimContext` (`:149-156`, confirmed: `{claim_id, hospital_id, insurer_code, episode_type, specialties, episode}`) to carry the **dossier snapshot** (`doc_sections_by_category`, `current_panel_id/insurer_id`) and the resolved context vector + `target_stage`, loaded in one `loadClaimContext` pass (`:266-347`).
- **Dispatch:** the `evaluateRule` switch keyed on `logicType` (`:423-553`, default → ERROR `:541-546`, confirmed) is the registry. New kinds plug in as new `case` arms returning `{status, evidence, message}`:
  - Deterministic (in-process): `DOCUMENT_PRESENCE`, `REQUIRED_FIELDS` (port the pure logic from `rulesEngine.service.ts:407-443`), `FUZZY_NAME`, `TEMPORAL_WINDOW`, plus existing `SIMPLE_COMPARISON/RANGE_CHECK/PATTERN_MATCH/EXISTENCE_CHECK/CALCULATION/LOOKUP_TABLE`.
  - Semantic/vision (constrained, cached, confidence-bearing): `LLM_COHERENCE`, `EVIDENCE_CHECK`. These wrap single-purpose evaluators behind the existing `deps`-injection pattern (the engine already accepts injected evaluators, e.g. `this.expr`, `this.jsonpath`, `deps.customFunctions` `:218`), so they stay testable and replay-cacheable.
- **`kind` as a first-class column:** today the kind lives inside `validation_logic.logic_type` (no DB CHECK). Promote it to `insurance_rules.kind VARCHAR` (migration 067/068) for indexable selection and authoring, keeping `validation_logic` for kind-specific params. `chk_ir_category` (`044:90-93`) is a CHECK on `category` only — a new **category** needs a migration; a new **kind** does not (no DB CHECK), so kinds stay cheap to add.
- **Cost discipline:** every semantic/vision evaluator call must `recordCall` and respect `CLAIM_HARD_LIMIT_INR=15`; deterministic kinds are free and run first (short-circuit before any LLM kind).

**Boundary:** this is the adjudicator. It reads facts from [A]/[B], never mutates them.

### [D] 4-Layer Hypothesis Assembler — ADJUDICATE (assembly/scoring)

**Responsibility:** Compose the per-`(claim,stage)` hypothesis: (1) documents+stage, (2) content/fields+provenance, (3) rules applied + pass/fail + cited evidence, (4) readiness score + recommended action.

**Slot into existing code:** extend `summarise` (`rulesEngineV2.service.ts:635-693`) and `RulesV2Result` (`:65-99`, confirmed: `readiness_score:number|null`, `applicable`, `no_match`). The assembler wraps the engine result with layers 1–2 (from [A]/[B]) and produces layer 4 from layer 3. Persist to new `claim_hypothesis` (per claim,stage,rule-pack version). Keep the existing `readiness_score=null` "no rule pack" semantics from `emptyResult` (`:695-722`).

**Boundary:** recommended action is a recommendation; auto-submit is gated separately in [F].

### [E] Feedback / Flywheel — spans the boundary

**Responsibility:** Pin granular feedback **per layer** with root-cause attribution. Deterministic fixes (wrong/missing rule, wrong context) are instant + permanent and **author the rule library**; model fixes (extraction) are batched into the replay eval harness. A rule-miner promotes stable human-override patterns into deterministic rules.

**Slot into existing code:**
- Extend the override ledger `hospital.rule_overrides` (`044:194-211`) with a `layer` and `root_cause` axis (migration), or a sibling `rule_feedback` table keyed per layer.
- Context corrections write back to `claim_context` (cross-check disagreement becomes a labeled correction).
- Extraction corrections already have a home: `064_extraction_corrections.sql` + `hospital_format_profiles` (065) — model fixes route there and are validated by the **replay benchmark** (`Services/pipelineV2/harness/run.ts`, `regression.ts`) — the FREE AI-quality gate (`LLM_REPLAY_MODE=replay`).
- Rule-miner is an offline job reading `rule_overrides`/`rule_feedback`, proposing draft rules into the authoring lifecycle ([G]).

**Boundary:** deterministic feedback edits the adjudication layer (rules/context); model feedback edits the interpret layer (extraction). Root-cause attribution is what routes each correctly.

### [F] Graduation / Autonomy Controller — ADJUDICATE (action gating)

**Responsibility:** Per slice (panel × stage × case_type) **and** per layer, advance supervised → shadow → auto+audit → full-auto, gated on **joint correctness** with asymmetric error cost (low false-auto-file rate). Auto-**submit** gated separately and more strictly than auto-**assess**. Revertible on drift.

**Slot into existing code:** new `graduation_metrics` + `slice_autonomy_state` tables; the controller reads accumulated `claim_hypothesis` outcomes vs. feedback. The engine and orchestrator consult `slice_autonomy_state` before taking any automated action; default state for every slice is `supervised`.

**Boundary:** this is the only component permitted to trigger an automated external action, and only the submit-gate may file.

### [G] Authoring CRUD (versioned) — control plane

**Responsibility:** Versioned rule-set + rule CRUD with admin UI; replace SQL-migration-only authoring (current scaling blocker).

**Slot into existing code:** attach to `rulesV2.controller.ts`/`rulesV2.routes.ts` (currently unmounted, read-only `listRuleSets`/`getRuleSet` at `rulesV2.controller.ts:158-229`). Add `POST/PUT/DELETE /insurer-rule-sets` and `…/:id/rules`, gated by `Auth.checkSuperAdminOrAdmin` (copy the Wave 3A pattern in `stageRequirements.routes.ts:38-58`, which already has full versioned CRUD and `created_by` from `req.user.id`). Lifecycle = `insurer_rule_sets.status` draft→live→deprecated (`044:43-51`); selection already filters `status='live'`. Register both routers in `Backend/src/index.ts` (today neither is mounted).

---

## 3. Data-Model Deltas

All migrations reversible (up/down), `node-pg-migrate` via `node src/schema/run-migrations.cjs up`. Numbering continues from **067**. New stage columns validate against `master_options(category='ipd_stage')` (the 024 vocabulary). One migration per coherent concern so each can roll back independently.

### Migration 067 — `067_claim_context_and_section_stage.sql`
Foundation for Stage 0 + stage-aware docs. Lands first so the spine has somewhere to write.

- **`hospital.claim_context`** (new) — one row per `(claim_id, stage)` snapshot of the resolved context.
  - `id UUID PK`, `claim_id UUID FK→ipds(id) ON DELETE CASCADE`,
  - `scheme VARCHAR(60)`, `route VARCHAR(40)` (reuse 017 CHECK domain), `insurer_panel_id UUID`, `stage VARCHAR(40)` (= ipd_stage code), `case_type VARCHAR(60)`,
  - `confidence JSONB` (per-field `{value, source, confidence, crosscheck:'agreed'|'disagreed'|'absent'}`),
  - `resolver_version VARCHAR`, `resolved_at TIMESTAMPTZ`, `created_at/updated_at`.
  - Unique `(claim_id, stage)`; index `(claim_id)`.
  - **down:** `DROP TABLE`.
- **`hospital.document_sections.stage VARCHAR(40)`** (alter; null-allowed, FK-validated against ipd_stage in app, mirroring `ipds.stage`). Partial index `idx_document_sections_claim_stage (claim_id, stage)` paralleling `032:121-123`. **down:** drop index + column.
- New `master_options` rows: categories `scheme`, `case_type` (seeded from observed panel codes / `episode_type`). **down:** delete seeded rows.

### Migration 068 — `068_rule_kind_and_stage_selection.sql`
Makes the engine stage-scoped and kind-dispatched.

- **`hospital.insurer_rule_sets`** (alter): `applicable_stages TEXT[]`, `applicable_schemes TEXT[]`, `applicable_routes TEXT[]`, `applicable_panel_ids UUID[]`, `case_type VARCHAR(60)` — additional selection gates added next to the table at `044:39-55`. NULL/empty = wildcard, matching the existing insurer NULL-or-match semantics. **down:** drop columns.
- **`hospital.insurance_rules`** (alter): `kind VARCHAR(40)` promoted out of `validation_logic.logic_type` (backfill from existing rows), `min_confidence NUMERIC NULL` (per F4), `rule_family VARCHAR(20)` (`doc_sufficiency`\|`content`). No CHECK on `kind` (keeps new kinds migration-free). **down:** drop columns.
- Indexes on the new selection arrays (GIN) to keep `resolveRuleSet` prefilter cheap. **down:** drop indexes.

### Migration 069 — `069_per_stage_evaluation_history.sql`
Lets one claim be evaluated at multiple stages without collapse.

- **`hospital.claim_rule_evaluations`** (alter): add `stage VARCHAR(40)` and `rule_set_version VARCHAR`; **change the unique key** from `(claim_id, rule_set_id, rule_id)` (`uq_cre_claim_set_rule`, `044:166-188`) to `(claim_id, stage, rule_set_id, rule_id)`. Add `confidence NUMERIC NULL`, `evaluator_version VARCHAR`. The UPSERT in `persistEvaluations` (`:593-633`, `ON CONFLICT … DO UPDATE` `:605`) updates to the new key. Status CHECK stays `PASS|FAIL|SKIP|ERROR`. **down:** restore old unique key, drop columns (data-lossy on stage — document in down).
- **`hospital.claim_hypothesis`** (new) — assembled 4-layer output, one row per `(claim_id, stage, rule_set_version)`: `layers JSONB` (1–3 evidence), `readiness_score NUMERIC NULL`, `recommended_action VARCHAR`, `applicable BOOLEAN`, `assembler_version`, timestamps. Unique `(claim_id, stage, rule_set_version)`. **down:** `DROP TABLE`.

### Migration 070 — `070_feedback_rootcause.sql`
Flywheel substrate.

- **`hospital.rule_overrides`** (alter, base at `044:194-211`): add `layer VARCHAR(20)` (`documents`\|`content`\|`rules`\|`action`), `root_cause VARCHAR(40)` (`missing_rule`\|`wrong_rule`\|`wrong_context`\|`extraction_error`), `disposition VARCHAR(20)` (`instant_rule_edit`\|`batched_model_fix`\|`mined`). **down:** drop columns.
- **`hospital.context_corrections`** (new) — labeled context overrides feeding the resolver eval: `claim_id`, `field`, `old_value`, `new_value`, `corrected_by`, `created_at`. **down:** `DROP TABLE`.

### Migration 071 — `071_autonomy.sql`
Autonomy control plane (lands just before M8, not before the spine).

- **`hospital.slice_autonomy_state`** (new): `slice_key` = `(panel_id, stage, case_type)`, `layer VARCHAR(20)`, `state VARCHAR(20)` (`supervised`\|`shadow`\|`auto_audit`\|`full_auto`), `submit_gate_state VARCHAR(20)` (separate), `updated_by`, `updated_at`. Default seeded `supervised`. **down:** `DROP TABLE`.
- **`hospital.graduation_metrics`** (new): rolling per-slice/per-layer joint-correctness counters, false-auto-file count, sample size, window. **down:** `DROP TABLE`.

### Migration 072 — `072_rule_set_authoring_audit.sql`
Backs versioned CRUD ([G]).

- **`hospital.rule_set_audit`** (new): append-only `(rule_set_id, version, action, actor, diff JSONB, at)` for draft→live→deprecated transitions. Reuses existing `insurer_rule_sets.version/status/effective_from/effective_till/created_by` (`044:43-51`); no schema change to that table needed. **down:** `DROP TABLE`.

> Stage column type/domain is identical everywhere (`VARCHAR(40)` ≡ ipd_stage) per F2, so `claim_context.stage`, `document_sections.stage`, `claim_rule_evaluations.stage`, `claim_hypothesis.stage`, and `insurer_rule_sets.applicable_stages[]` all join cleanly.

---

## 4. Key TypeScript Interfaces (signature sketches only — no implementation)

```ts
// ── [A] Auto-Context Resolver ───────────────────────────────────────────────
type Stage = string;        // master_options(category='ipd_stage') code
type Scheme = string;       // master_options(category='scheme')
type Route = 'cashless_everywhere' | 'network';   // 017 CHECK domain
type CaseType = string;     // master_options(category='case_type')

type FieldSource = 'admission_record' | 'empanelment' | 'doc_mix'
                 | 'timeline' | 'dates' | 'procedures' | 'derived';

interface ResolvedField<T> {
  value: T | null;
  source: FieldSource;            // deterministic source of truth
  confidence: number;             // [0,1]
  crosscheck: 'agreed' | 'disagreed' | 'absent';  // LLM/derived signal vs. SoT
}

interface ClaimContext {          // the {scheme,route,insurer,stage,case_type} vector
  claim_id: string;
  scheme: ResolvedField<Scheme>;
  route: ResolvedField<Route>;
  insurer_panel_id: ResolvedField<string>;
  stage: ResolvedField<Stage>;
  case_type: ResolvedField<CaseType>;
  resolver_version: string;
}

interface AutoContextResolver {
  // Deterministic; reads dossier + ipds + empanelment + doc-mix. No veto, no LLM SoT.
  resolve(input: { claim_id: string; dossier: DossierSnapshot }): Promise<ClaimContext>;
}

// ── [C] Evaluator-kind contract (one arm of the evaluateRule switch) ─────────
type RuleStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';
type RuleKind =
  | 'DOCUMENT_PRESENCE' | 'REQUIRED_FIELDS' | 'FUZZY_NAME' | 'TEMPORAL_WINDOW'
  | 'SIMPLE_COMPARISON' | 'RANGE_CHECK' | 'PATTERN_MATCH' | 'EXISTENCE_CHECK'
  | 'CALCULATION' | 'LOOKUP_TABLE' | 'COMPLEX_CONDITION' | 'CUSTOM'
  | 'LLM_COHERENCE' | 'EVIDENCE_CHECK';   // semantic/vision; cached, confidence-bearing

interface EvaluatorInput {
  rule: RuleRow;                 // existing RuleRow shape (rulesEngineV2:132-147) + kind, min_confidence
  ruleSet: RuleSetRow;
  ctx: EvalContext;              // episode + dossier snapshot + resolved ClaimContext
}
interface EvaluatorResult {      // matches today's evaluateRule return (:425-427)
  status: RuleStatus;
  evidence: unknown;             // MUST cite source_section_id / document_id / json_path
  message: string | null;
  confidence?: number;           // required for LLM_COHERENCE / EVIDENCE_CHECK
}
interface Evaluator {
  readonly kind: RuleKind;
  readonly deterministic: boolean;   // deterministic kinds run first, free, no recordCall
  evaluate(input: EvaluatorInput): Promise<EvaluatorResult>;
}
type EvaluatorRegistry = Record<RuleKind, Evaluator>;

// ── Rule-pack selector (extends resolveRuleSet :357-400) ─────────────────────
interface RulePackSelectorKey {
  scheme: Scheme | null; route: Route | null; insurer_panel_id: string | null;
  stage: Stage; case_type: CaseType | null;
  // legacy axes retained for scoring: treatment/episode_type, specialties[]
  episode_type: string | null; specialties: string[];
}
interface RulePackSelector {
  resolve(key: RulePackSelectorKey): Promise<RuleSetRow | null>;  // most-specific wins; null = no_match
}

// ── [D] 4-layer hypothesis output (per claim, stage) ─────────────────────────
interface ClaimHypothesis {
  claim_id: string; stage: Stage; rule_set_version: string | null;
  layer1_documents: { stage: Stage; sections: Array<{ section_id: string; category: string; stage: Stage }> };
  layer2_content:   { fields: Record<string, { value: unknown; source_section_id: string; document_id: string; confidence: number }> };
  layer3_rules:     { applicable: boolean; evaluations: RuleEvaluation[] };  // existing shape :50-63
  layer4_decision:  { readiness_score: number | null; recommended_action: string; applicable: boolean; no_match?: boolean };
  assembler_version: string;
}
```

---

## 5. Milestones M0..M9

Sequencing principle: **deterministic spine first, then semantic evaluators, then any autonomy.** Each milestone is a vertical slice that ships value and is independently revertible. Type-check bar on every milestone: **zero NEW errors on edited lines** (pinned isolated TS 5.4.5 / Node 22 against `Backend/tsconfig.json`, proven on `git diff -U0`); never `tsc` build gate. AI-quality gate = the FREE replay benchmark + regression gate. All new behavior behind a flag, default off; all migrations reversible.

---

### M0 — Freeze + scaffolding (no behavior change)
- **Goal:** Lock F1–F6; land the foundation migration; wire feature-flag plumbing; mount the (still read-only) v2 routes so the surface exists.
- **Components:** none active yet.
- **New/changed files:** `Backend/src/schema/migrations/067_claim_context_and_section_stage.sql`; flag constants (new `Backend/src/config/featureFlags.ts` or existing config); register `rulesV2.routes.ts` + `stageRequirements.routes.ts` in `Backend/src/index.ts`.
- **Migrations:** 067.
- **Flag:** `STAGE_AWARE_ADJ` (master, default off).
- **Exit criteria:** 067 up/down both clean against a scratch DB (NOT `finclarity_prod`); replay regression baseline unchanged; zero new type errors on edited lines; F1–F6 decisions recorded.
- **Rollback:** `migrate:down` to 066; unregister routes.

### M1 — Auto-Context Resolver (Stage 0), shadow-only
- **Goal:** Deterministically resolve `{scheme,route,insurer,stage,case_type}` and persist to `claim_context`; **shadow** — compute and log, do NOT yet feed adjudication.
- **Components:** [A]. Fixes the three unpopulated upstreams (`current_insurer_id`, rebuilt `current_stage`, `doc_sufficiency_per_stage`).
- **New/changed files:** `Services/autoContextResolver.service.ts` (new); call from `intelligenceOrchestrator.service.ts:352-387` between Step 3 and Step 4; minimal read-extension to `claimDossier.service.ts:131-164`. Standalone pure-function assertion harness for the resolver (host node_modules incomplete — no DB/LLM in the unit harness).
- **Migrations:** none (uses 067).
- **Flag:** `STAGE_AWARE_ADJ.resolver_shadow`.
- **Exit criteria:** on the replay corpus, resolver `stage` matches `inferTargetStage` where the latter is correct, and produces a non-default stage where `inferTargetStage` falls back to `'preauth_submitted'`; `insurer_panel_id` populated for all empanelled claims; per-field confidence + crosscheck recorded; zero new type errors.
- **Rollback:** flag off → resolver not invoked; `claim_context` rows are inert.

### M2 — Stage-aware document tagging + provenance
- **Goal:** Tag every `document_section` with `stage`; persist inline field provenance.
- **Components:** [B].
- **New/changed files:** extend the Wave-7 classifier/segmenter (`section_classified` producer; fold at `projector:315-334`); deterministic doc-category→stage map (shared with resolver). Pure-function harness for the stage-tag map.
- **Migrations:** uses 067 (`document_sections.stage`).
- **Flag:** `STAGE_AWARE_ADJ.section_stage`.
- **Exit criteria:** stage tags present on replay-corpus sections; tag agreement with resolver stage ≥ frozen threshold; provenance present on extracted fields; **replay regression gate green (no HIT→MISS field-accuracy regression)**; zero new type errors.
- **Rollback:** flag off → tagging skipped; `stage` column stays null (harmless).

### M3 — Unified engine: deterministic kinds + stage-scoped selection (Wave 3A fold, shadow)
- **Goal:** Land the evaluator-kind registry with **deterministic kinds only** (`DOCUMENT_PRESENCE`, `REQUIRED_FIELDS`, `FUZZY_NAME`, `TEMPORAL_WINDOW`) and stage/scheme/route/case_type selection. Run **in shadow** beside the live engines.
- **Components:** [C] (deterministic subset).
- **New/changed files:** `rulesEngineV2.service.ts` — extend `ClaimContext` (`:149-156`) with dossier snapshot + resolved context; extend `loadClaimContext` (`:266-347`); extend `resolveRuleSet` (`:357-400`) with new gates/score terms; add deterministic `case` arms to the `evaluateRule` switch (`:432`) porting `rulesEngine.service.ts:407-443`; extract an `EvaluatorRegistry` module. Migrate Wave-3A `stage_requirements` rows into `insurance_rules` (data migration script, draft status). Pure-function harnesses per kind.
- **Migrations:** 068 (kind/selection), 069 (per-stage evaluation key + `claim_hypothesis`).
- **Flag:** `STAGE_AWARE_ADJ.unified_engine_shadow`.
- **Exit criteria:** shadow engine reproduces Wave-3A presence outcomes on the corpus (parity report); per-stage evaluations persist without collapsing (069 key works); selection picks the most-specific stage-scoped pack; zero new type errors; replay gate green.
- **Rollback:** flag off → shadow engine not invoked; migrated rules sit in `draft` (never selected, since selection filters `status='live'`).

### M4 — 4-layer hypothesis assembler (read path live)
- **Goal:** Assemble + persist `claim_hypothesis` from [A]+[B]+[C]; expose read API. Assessment visible to operators; **no automated action**.
- **Components:** [D]; read endpoints on `rulesV2.controller.ts`.
- **New/changed files:** `Services/hypothesisAssembler.service.ts` (new); extend `summarise` (`:635-693`); `GET /claims/:claimId/hypothesis` in `rulesV2.controller.ts`.
- **Migrations:** uses 069 (`claim_hypothesis`).
- **Flag:** `STAGE_AWARE_ADJ.hypothesis_read`.
- **Exit criteria:** hypothesis renders all 4 layers with cited evidence (`source_section_id`/`document_id`); `readiness_score=null` correctly distinguishes no-match from 100%; zero new type errors.
- **Rollback:** flag off → endpoint 404/feature-gated; no writes beyond inert `claim_hypothesis` rows.

### M5 — Cutover: unified engine becomes the live adjudication path
- **Goal:** Switch `adjudicationEngine.run()` to consume resolver context + unified engine result; promote migrated Wave-3A rules `draft→live`; retire the separate `stageRequirements.evaluate` call path (engine left dark for rollback).
- **Components:** [A]+[C]+[D] live; [B] feeding.
- **New/changed files:** `adjudicationEngine.service.ts` — replace `:566-568` with `resolved.stage`; feed resolved context into `rules.evaluate({…})` (`:607-613`) and into `hashDossierState` per F6 (`:571`).
- **Migrations:** none (rule-set status flip is data, via [G] in M7 or a one-off promote).
- **Flag:** `STAGE_AWARE_ADJ.live` (per-slice rollout supported).
- **Exit criteria:** on the replay corpus, live unified engine ≥ parity with the prior split path on document-sufficiency; cost per claim ≤ `CLAIM_HARD_LIMIT_INR` (still deterministic-only, so ~0 LLM); cache invalidation correct on context override (F6); zero new type errors.
- **Rollback:** flag back to shadow; demote rules to `draft`; old path resumes.

### M6 — Semantic / vision evaluator kinds (`LLM_COHERENCE`, `EVIDENCE_CHECK`)
- **Goal:** Add constrained single-purpose semantic/vision kinds with structured output + confidence + caching, gated by `min_confidence` (F4). First introduction of LLM into adjudication.
- **Components:** [C] (semantic subset).
- **New/changed files:** evaluator modules behind `deps`-injection (mirroring `this.expr`/`this.jsonpath`); add the two `case` arms to the switch; ensure every call `recordCall`s and respects `CLAIM_HARD_LIMIT_INR`. Replay-cache integration so the harness can run them FREE.
- **Migrations:** uses 068 (`min_confidence`).
- **Flag:** `STAGE_AWARE_ADJ.semantic_kinds` (per-slice).
- **Exit criteria:** semantic kinds run under `LLM_REPLAY_MODE=replay` in the harness; low-confidence ⇒ `SKIP` (never auto-PASS/FAIL); per-claim cost capped; regression gate green; zero new type errors.
- **Rollback:** flag off → switch arms return `SKIP` (engine already tolerates skipped kinds); deterministic spine unaffected.

### M7 — Authoring CRUD + admin UI + feedback capture
- **Goal:** Versioned rule-set/rule CRUD (draft→live→deprecated) replacing SQL-only authoring; per-layer feedback capture with root-cause.
- **Components:** [G], [E] (capture half).
- **New/changed files:** `rulesV2.controller.ts`/`rulesV2.routes.ts` — `POST/PUT/DELETE /insurer-rule-sets` + `…/:id/rules`, `Auth.checkSuperAdminOrAdmin` (copy `stageRequirements.routes.ts:38-58`); feedback endpoints writing `rule_overrides` (+layer/root_cause) and `context_corrections`; admin UI (frontend workspace).
- **Migrations:** 070 (feedback root-cause), 072 (authoring audit).
- **Flag:** `STAGE_AWARE_ADJ.authoring`.
- **Exit criteria:** create/edit/version a rule pack end-to-end without a migration; deterministic feedback (wrong/missing rule, wrong context) edits the live library instantly; model feedback routes to `extraction_corrections` (064); audit trail recorded; zero new type errors.
- **Rollback:** flag off → endpoints gated; authoring reverts to migration-only (no data loss).

### M8 — Graduation / autonomy controller (assess auto-audit; submit still manual)
- **Goal:** Per-slice × per-layer state machine; allow `auto_audit` for the **assessment** layer where joint-correctness + asymmetric-cost gates pass. **Auto-submit stays manual.** Requires F7 frozen.
- **Components:** [F].
- **New/changed files:** `Services/autonomyController.service.ts` (new); engine/orchestrator consult `slice_autonomy_state` before any automated step; metrics roll-up job writing `graduation_metrics`.
- **Migrations:** 071.
- **Flag:** `STAGE_AWARE_ADJ.autonomy_assess`.
- **Exit criteria:** no slice advances past `supervised` without meeting the frozen joint-correctness threshold; false-auto-file rate provably below cap on backtest; drift auto-reverts a slice to `supervised`; zero new type errors.
- **Rollback:** flag off → all slices forced `supervised`.

### M9 — Rule-miner + auto-submit gate (separate, strict)
- **Goal:** Mine stable human-override patterns into draft deterministic rules; enable the separately-gated `auto-submit` action for slices that clear the stricter submit threshold.
- **Components:** [E] (miner), [F] (submit gate).
- **New/changed files:** `Jobs/ruleMiner.job.ts` (offline, reads `rule_overrides`, proposes drafts into [G]); submit-gate check in the orchestrator distinct from the assess gate.
- **Migrations:** none (uses 071 `submit_gate_state`).
- **Flag:** `STAGE_AWARE_ADJ.auto_submit` (per-slice, strict, default off).
- **Exit criteria:** miner proposals land as `draft` only (human promotes); auto-submit fires only for slices in `full_auto` submit-gate state with false-auto-file rate below the stricter cap; full audit trail; revertible on drift; zero new type errors.
- **Rollback:** flag off → no automated submission; miner output is inert drafts.

---

## 6. Dependency DAG + Rollout / Flagging Strategy

### 6.1 Dependency DAG (text)

```
F1..F6 (freeze) ─┐
                 ▼
              M0 (067, scaffolding, mount routes)
                 │
        ┌────────┼─────────┐
        ▼        ▼          │
  M1 (resolver) M2 (doc     │
        │        stage+prov)│
        └────┬───┘          │
             ▼              │
  M3 (unified engine: deterministic kinds + selection; 068, 069)
             │
             ▼
  M4 (hypothesis assembler; read-only)
             │
             ▼
  M5 (live cutover; resolver+engine+assembler drive run())
        ┌────┴───────────────┐
        ▼                     ▼
  M6 (semantic/vision    M7 (authoring CRUD + feedback capture; 070, 072)
      kinds)                  │
        │                     │
        └──────────┬──────────┘
                   ▼
   F7 (freeze) ─► M8 (autonomy: assess auto-audit; 071)
                   │
                   ▼
                M9 (rule-miner + separate auto-submit gate)
```

Critical path: **M0 → M1/M2 → M3 → M4 → M5** (the deterministic spine). M6 (LLM) and M7 (authoring) are parallelizable after M5. M8 needs F7 + M5 + M7. M9 needs M7 (authoring, for mined drafts) + M8 (gate states).

### 6.2 Rollout / flagging strategy

- **Single master flag** `STAGE_AWARE_ADJ` with per-milestone sub-flags (`.resolver_shadow`, `.section_stage`, `.unified_engine_shadow`, `.hypothesis_read`, `.live`, `.semantic_kinds`, `.authoring`, `.autonomy_assess`, `.auto_submit`). All default **off**; nothing changes adjudication behavior until `.live`.
- **Shadow-before-live for every interpret/adjudicate change** (M1, M3 run in shadow and emit parity reports against the existing path before M5 cutover). The FREE replay benchmark (`Services/pipelineV2/harness/run.ts`) + regression gate (`regression.ts`, hard-fails on field-accuracy HIT→MISS) is the AI-quality gate at each step; re-bless baseline only on intended changes (`HARNESS_UPDATE_BASELINE=1`).
- **Per-slice rollout** keyed on `(panel_id, stage, case_type)`: `.live`, `.semantic_kinds`, `.autonomy_assess`, `.auto_submit` are all evaluable per slice via `slice_autonomy_state`. Start with one well-understood panel × stage, widen on evidence.
- **Graduated autonomy is per-slice AND per-layer**: a slice can be `full_auto` on the documents layer while still `supervised` on the action layer; **auto-submit is a separate, stricter gate** than auto-assess and is the last thing to open.
- **Asymmetric cost everywhere**: thresholds weight false-auto-file ≫ false-hold; any drift auto-reverts the affected slice to `supervised`.
- **Cost guardrails**: deterministic kinds run first and free; semantic/vision kinds gated behind `.semantic_kinds`, each `recordCall`-tracked under `CLAIM_HARD_LIMIT_INR=15`; replay mode keeps all harness runs free.
- **Data safety**: all migration up/down tested against a scratch DB; **no destructive or speculative writes against `finclarity_prod`**; rule promotion is a `status` flip, fully reversible.

---

## Key file hook-point index (verified)

- Resolver call site: `Backend/src/Services/adjudicationEngine.service.ts:561` (after getDossier), `:566-568` (stage), `:571` (cache hash), `:607-613` (rules.evaluate).
- Orchestrator populate hook: `Backend/src/Services/intelligenceOrchestrator.service.ts:352-387`, entrypoint `:79`.
- Selection: `Backend/src/Services/rulesEngineV2.service.ts:357-400`; context `:149-156`, `:266-347`; dispatch switch `:423-553` (default `:541-546`); persistence `:593-633` (UPSERT `:605`); summary `:635-693`; empty `:695-722`.
- Wave-3A pure logic to port: `Backend/src/Services/rulesEngine.service.ts:407-443`.
- Authoring attach point: `Backend/src/Controllers/rulesV2.controller.ts:158-229` (+ `rulesV2.routes.ts`); CRUD pattern to copy `Backend/src/Controllers/stageRequirements.controller.ts:28-364`, `stageRequirements.routes.ts:38-58`.
- Schema: `document_sections` `Backend/src/schema/migrations/032_document_sections.sql:56-114,121-123`; rule sets/rules `044_insurer_rule_sets.sql:39-55,69-96,166-188,194-211`; ipd_stage vocab `024_add_ipd_stage.sql:27-46`; route CHECK `017_add_claim_filing_route_to_ipds.sql:19-20`; empanelment `020_add_is_empanelled.sql`.
- Harness: `Backend/src/Services/pipelineV2/harness/run.ts`, `regression.ts`, `regression.baseline.json`.
- Next free migration: **067** (highest existing `066_derived_page.sql`).