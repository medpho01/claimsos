All facts verified. Writing the plan now.

---

# QA / VALIDATION PLAN — Adjudication Engine (Build-Stage + Runtime-to-Autonomy)

**Owner:** QA Lead · **Status:** Planning baseline (architecture NOT frozen) · **Date:** 2026-06-02
**Repo root (all paths absolute):** `/Users/maverick/Documents/Finclarity-Tech/claimsos`

---

## 0. Scope, boundary, and what this plan must freeze first

This plan validates the adjudication engine described in the recommended architecture across **two axes**:
- **Build-time** — does each milestone (M0…M7) do what it claims before it merges?
- **Runtime** — as a slice graduates supervised → shadow → auto+audit → full-auto, is it still correct, and does it degrade safely?

**The validation boundary mirrors the system boundary:** the pipeline **interprets** (produces facts + rule inputs); the rules/decision layer **adjudicates**. We therefore validate *interpretation accuracy* (extraction/context facts vs. ground truth) and *adjudication correctness* (rule outcomes + readiness/action vs. expert label) **separately**, then validate their **joint** correctness for autonomy gating. No whole-claim veto is asserted inside the pipeline, and no QA gate may reward one by collapsing the two layers.

### 0.1 Decisions to FREEZE before M1 work starts (this plan flags, does not decide)

These are unfrozen in the architecture and **block** writing acceptance criteria with hard numbers. QA cannot sign off milestones until each is frozen:

| # | Open decision | Why QA is blocked | Proposed freeze owner |
|---|---|---|---|
| F1 | **Stage-scoped persistence key.** Recon A confirms `claim_rule_evaluations` UPSERT key is `(claim_id, rule_set_id, rule_id)` (`044_insurer_rule_sets.sql:166-188`); evaluating one claim at multiple stages **collapses rows**. | Cannot assert "per-stage evaluations coexist" without the migration-067 unique-key change. | Eng + QA |
| F2 | **The 5 deterministic evaluator kinds** (`doc_present`, `field_exists`, `compare`, `fuzzy_name`, `temporal_window`) — exact semantics, operators, and tie-break rules. Today the v2 switch (`rulesEngineV2.service.ts:423-553`) has different kind names (`SIMPLE_COMPARISON`, `EXISTENCE_CHECK`, etc.). | Pure-function golden tables (the only thing host CAN run) need frozen I/O contracts per kind. | Eng |
| F3 | **Auto-Context resolver output contract** `{scheme, route, insurer, stage, case_type}` + confidence per field + the precedence rule "record-of-truth wins, LLM is cross-check only." | The resolver's golden fixtures and the "LLM never source-of-truth" assertion need a frozen contract. | Eng + QA |
| F4 | **Readiness score → recommended action mapping** thresholds (per slice). | Action-level acceptance + false-auto-file gate need a defined action enum and cutoffs. | Product + QA |
| F5 | **Slice definition** = `(panel × stage × case_type)` granularity, and the **layer** enumeration (L1 docs+stage, L2 content/fields, L3 rules+evidence, L4 readiness+action). | Per-slice/per-layer dashboards and graduation are keyed on these. | Product + QA |
| F6 | **Asymmetric error costs** — the numeric cost ratio of a false-auto-file vs. a false-hold, per scheme (PMJAY vs private vs cashless-everywhere). | The auto-file precision gate is a function of this ratio. | Product + Compliance |

> **Gate G-FREEZE:** No milestone beyond M0 merges until F1–F6 are recorded in `docs/proposals/` and referenced by the milestone's acceptance criteria.

---

## 1. Test execution strategy under the host constraints

### 1.1 The hard reality (verified)

- **No `tsc` build gate.** `tsx` is transpile-only. Type-checking is a *separate* gate: pinned isolated **TypeScript 5.4.5 under Node 22** against `Backend/tsconfig.json`. Bar = **ZERO NEW errors on edited lines**, proven against `git diff -U0` — **not** zero total (~50 pre-existing missing-module errors are accepted baseline).
- **Host `node_modules` is INCOMPLETE** — `@anthropic-ai/sdk`, `pdf-*`, `tesseract.js` are missing. Therefore **most integration tests and anything that imports the LLM SDK or PDF/OCR libs cannot run on host.**

### 1.2 What CAN run on host (the two pillars)

**Pillar A — Standalone pure-function assertion harnesses.** Every **deterministic evaluator** and the **context resolver** must be authored as pure functions with NO import of the missing libs, runnable via `npx tsx <file>` with inline `assert`. These are the only thing fully runnable on host and are the **primary build-time gate** for deterministic logic. Targets:
- Auto-Context resolver (F3): given a fixture `{admission/panel record, doc-mix, timeline, dates, procedures}` → assert `{scheme, route, insurer, stage, case_type}` + that **LLM-derived fields are ignored when a record-of-truth field is present** (the cross-check-only invariant).
- `doc_present` / `field_exists` — presence/required-field logic (the Wave-3A presence checks being folded in per Recon A §6).
- `compare` — operators, type coercion, null handling (extend `applyOperator`, `rulesEngineV2.service.ts:162-202`).
- `fuzzy_name` — name-match scoring with a frozen threshold and a **labeled corpus of name pairs** (match / no-match / hard-negatives like initials, honorifics, transposition).
- `temporal_window` — admission/discharge/preauth date windows, inclusive/exclusive boundaries, timezone, missing-date behavior.

Each evaluator ships a **golden table** (input row → expected `{status, evidence, message}`). Golden tables are the regression net for F2.

**Pillar B — pipelineV2 replay benchmark = the AI-quality gate.** Anything touching **extraction / LLM / vision / context inference that consumes model output** is validated with the free replay harness (verified present: `Backend/src/Services/pipelineV2/harness/{run.ts,regression.ts,scorer.ts,errorBudget.ts,regression.baseline.json}`):

```
docker exec hospital_worker_dev \
  env LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=/tmp/probe/.llm-cache \
  npx tsx src/Services/pipelineV2/harness/run.ts
```
Regression gate (hard-fails on field-accuracy HIT→MISS only; signal/quarantine are drift-only — confirmed in `scorer.ts`/`errorBudget.ts`):
```
docker exec hospital_worker_dev \
  env LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=/tmp/probe-bench12/.llm-cache \
      HARNESS_CORPUS_DIR=/tmp/probe-bench12 \
  npx tsx src/Services/pipelineV2/harness/regression.ts
```
Re-bless intended changes with `HARNESS_UPDATE_BASELINE=1`. Real-spend record pass (`LLM_REPLAY_MODE=record HARNESS_ALLOW_RECORD=1`, optional `HARNESS_MAX_INR`) only when the corpus changes — gated behind a human, never in CI.

### 1.3 What CANNOT run on host → where it runs

| Cannot run on host | Runs in |
|---|---|
| Anything importing `@anthropic-ai/sdk`, `pdf-*`, `tesseract.js` | `docker exec hospital_worker_dev …` (worker container) |
| Live DB-backed engine path (`AdjudicationEngine.run()`, persistence UPSERT) | Worker container against a **disposable** DB, never `finclarity_prod` |
| Semantic evaluator kinds (`llm_coherence`, `evidence_check` vision) | Replay harness (Pillar B) with cached structured outputs |

> **Design constraint for testability (QA pushes back at design review):** every new deterministic evaluator and the context resolver MUST be a pure function in a file with **no top-level import** of the missing libs, so Pillar A stays runnable. If a kind needs the LLM, it is a *semantic* kind and belongs to Pillar B. This split is itself an acceptance criterion (see M2/M3).

### 1.4 Three CI gates per PR (build-time)

1. **Type-check gate** — TS 5.4.5 isolated, zero new errors on `git diff -U0` edited lines.
2. **Pure-function gate** — all Pillar-A harnesses + golden tables pass (`npx tsx`, host).
3. **Replay gate** — `regression.ts` exits 0 (no field-accuracy HIT→MISS) for any PR touching extraction/context/LLM (worker container).

---

## 2. Test-data strategy

### 2.1 Sources

- **Real corpus (frozen):** the **15-patient** corpus already wired into the harness (`corpus.ts`: `MANIFEST.txt` + `<slug>/docs/<category>__<uuid>.<ext>`; default `/tmp/probe`, regression `/tmp/probe-bench12`; ground truth `<corpus>/ground_truth.json`). This is the AI-quality anchor. **No new real PHI added without a record pass + legal sign-off.**
- **Synthetic per-stage bundles (NEW, QA-owned):** hand-built document bundles that exercise the slice grid the real corpus under-covers. Built as the same on-disk shape as the corpus (`<slug>/docs/<category>__<uuid>.<ext>` + `ground_truth.json`) so they load through the existing loader unchanged.

### 2.2 The synthetic slice grid (fixture matrix)

Cover the cartesian product the architecture must serve, minimally:

| Dimension | Values |
|---|---|
| **stage** | pre-auth · enhancement · discharge (mapped to `master_options(ipd_stage)`, the 19 codes seeded in `024_add_ipd_stage.sql:27-46`) |
| **case_type** | conservative (medical) · surgical |
| **scheme/route** | PMJAY (forced-empanelled → `network`) · private cashless (`network`) · cashless-everywhere (non-empanelled) |

Each cell gets **≥2 fixtures**: one **clean/should-pass** and one **adversarial/should-fail** (missing mandatory doc for that stage, name mismatch, out-of-window date, content-rule violation). Ground truth per fixture records, per layer: expected stage, expected resolved context, expected field values, expected rule pass/fail set with the **evidence each cites**, and expected readiness/action.

### 2.3 Hard data rules

- **NO destructive or speculative writes to `finclarity_prod` (localhost:5432).** All engine/persistence tests run against a **disposable** Postgres seeded from migrations + synthetic fixtures. `finclarity_prod` is **read-only** for distribution analysis (e.g. to confirm slice coverage matches real volume).
- Synthetic PHI is **fabricated**, never derived from prod rows.
- Migration tests apply `up` then `down` (reversibility is a hard constraint) against the disposable DB.

### 2.4 Fixturing per `(panel, stage, case_type)`

Provide a fixture-builder spec (a manifest schema, authored as data, not code in repo): a row per slice naming its docs, the panel/scheme it represents, its `claim_filing_route` (derived per `020_add_is_empanelled.sql`), and its expected 4-layer output. The same fixtures feed both Pillar A (resolver/evaluator unit golden) and Pillar B (full replay).

---

## 3. Per-milestone acceptance criteria (build-time)

Milestones are derived from the architecture. Each lists **what proves it correct before merge**, the **gate**, and the **slice/layer it touches**. All cite the verified hook points.

### M0 — Harness & fixture readiness (no engine change)
- **Build:** stand up the synthetic slice grid (§2.2) into `/tmp/probe-slices/`; confirm it loads through `corpus.ts` and `run.ts` reads its `ground_truth.json`.
- **Accept:** `run.ts` produces a report over the synthetic corpus; baseline blessed; type-check + pure-function CI gates green on an empty diff. F1–F6 freeze docs landed (G-FREEZE).
- **Proves:** the test apparatus itself is trustworthy before any logic changes.

### M1 — Auto-Context resolver (Stage 0)
- **Hook:** `adjudicationEngine.service.ts:559-613` `run()` — resolver runs **after** `getDossier` (`:561`), **before** `target_stage` resolution (`:566-568`) and rule eval (`:606-613`); output must feed `hashDossierState` cache key (`:571,192-208`) and the rules call (`:607-613`).
- **Pillar A golden (host):** resolver fixtures for every slice → exact `{scheme, route, insurer, stage, case_type}`.
- **Invariants asserted:**
  - **Zero ground-ops tagging** — resolver consumes only deterministic signals (`doc_sections_by_category` per `projector:315-334`; `ipds.claim_filing_route`; `ipds.panel_id`; dates/events). Test: with all manual tags stripped, output is unchanged.
  - **LLM cross-check-only (F3)** — when a record-of-truth field and an LLM-derived field disagree, resolver returns the record value and emits a **discrepancy flag**, never the LLM value. Dedicated adversarial fixtures.
  - **Replaces naive default** — resolver must NOT silently fall through to `inferTargetStage(null,…) → 'preauth_submitted'` (`:149,167`); a claim with discharge-summary sections resolves to a discharge-family stage. Regression of the known `bootstrapShell` gap (`claimDossier.service.ts:131-164` does not copy `ipds.stage`).
- **Replay (Pillar B):** field accuracy on the 15-patient corpus **does not regress** (resolver feeds the cache key, so a wrong resolve perturbs replay).
- **Accept:** all resolver golden pass; `insurer` field is now populated (today **always null**, `claimDossier.service.ts:154-155`) for empanelled fixtures; replay HIT→MISS = 0.

### M2 — Stage-aware document understanding (per-doc provenance + stage tag)
- **Hook:** add `document_sections.stage` (migration **067**, additive, mirrors `ipds.stage`/migration 024, partial index paralleling `032:121-123`). Preserve per-document-type field provenance (do not fuse-only into one episode).
- **Pillar A golden:** stage-tagging of `document_section` rows from doc category + claim dates is deterministic and matches fixtures.
- **Provenance test:** for a multi-stage claim, each field traces to its source document-type/section; the fused episode does NOT erase the per-document origin.
- **Migration test:** `067` applies and reverses on disposable DB; no data loss to existing `document_sections`.
- **Accept:** golden pass; provenance survives fusion; replay field accuracy unchanged (tagging is additive metadata).

### M3 — Unified stage-scoped rules engine (selection + deterministic kinds)
- **Hooks:** extend selection key with `{stage, panel, case_type}` (`resolveRuleSet` `:357-400`; `ClaimContext` `:149-156`; `loadClaimContext` `:266-347`; `RuleSetRow` `:123-130`; schema columns on `insurer_rule_sets`). Add the 5 deterministic kinds as new `case`s in the dispatch switch (`evaluateRule` `:423-553`, keyed at `:429`). Fold Wave-3A presence checks in as a `DOCUMENT_PRESENCE`/`REQUIRED_FIELDS` kind (Recon A §6).
- **Pillar A golden (host) per kind (F2):** `doc_present`, `field_exists`, `compare`, `fuzzy_name`, `temporal_window` each pass their golden table including hard-negatives and null/boundary cases.
- **Selection correctness:** given a fixture's `{scheme,route,insurer,stage,case_type}`, the **most-specific live rule set wins**; scoring ties resolve deterministically; a slice with no matching set returns `applicable=false` / `no_match=true` / `readiness_score=null` (verified fields, `rulesEngineV2.service.ts:80-95`) — NOT a spurious pass.
- **Persistence (F1):** with migration 067 adding `stage` to the UPSERT unique key, a claim evaluated at two stages produces **two rows**, not an overwrite (today's key collapses them, `044:166-188`).
- **Evidence:** every outcome cites evidence (test: no PASS/FAIL row has empty evidence).
- **Accept:** all kind goldens pass; selection golden pass; multi-stage persistence verified on disposable DB; Wave-3A parity test — every previously-passing stage-requirement check produces the **same** verdict through the unified engine (no silent rule loss in the fold).

### M4 — Semantic evaluator kinds (`llm_coherence`, `evidence_check` vision)
- **Pillar B only** (these import the LLM/vision path → not host-runnable). Validated via replay: constrained single-purpose evaluators return **structured output + confidence**, cached.
- **Accept:** on the synthetic adversarial fixtures (incoherent narrative, document that fails an evidence check), the semantic kind returns FAIL with cited evidence + confidence; replay deterministic (same cache ⇒ same verdict); **cost** — every LLM call hits `recordCall`, claim total ≤ `CLAIM_HARD_LIMIT_INR=15`. A claim that would exceed the cap aborts rather than partially adjudicating.

### M5 — 4-layer hypothesis output
- **Accept:** for every fixture, the engine emits all four layers — (L1) documents+stage, (L2) content/fields, (L3) rules applied + pass/fail + cited evidence, (L4) readiness score + recommended action (per F4 mapping). Each layer is independently scorable against ground truth. **L4 action never contradicts L3** (e.g. action=auto-file while a blocking rule failed) — assertion test.

### M6 — Human-in-the-loop flywheel (per-layer feedback + rule-miner)
- **Authoring CRUD** attaches to `rulesV2.controller.ts`/`rulesV2.routes.ts` next to read-only `listRuleSets`/`getRuleSet` (`:158-229`), admin-gated like Wave-3A (`Auth.checkSuperAdminOrAdmin`), using the draft→live→deprecated lifecycle (`044:43-51`). **Both rules surfaces are currently unmounted** — mounting in `index.ts` is part of this milestone and a test asserts the routes resolve.
- **Accept:**
  - Feedback pins to the **correct layer** with root-cause attribution; a deterministic fix (missing/wrong rule, wrong context) is **instant + permanent** — test: after a context-correction, re-running the same claim yields the corrected context with no model call.
  - Model fixes (extraction) are **batched into the replay harness**, never applied live — test: an extraction correction lands as a new ground-truth/fixture entry, not a hot patch.
  - **Rule-miner** promotes a stable human-override pattern to a deterministic rule — test: feed N identical overrides, miner proposes a rule whose golden reproduces the override; the proposed rule is authored as **data** (a row), is versioned, and does NOT auto-promote to `live` without admin action.
  - CRUD is versioned + reversible; soft-delete via lifecycle status, not row delete.

### M7 — Graduated-autonomy gating wiring (assessment vs. submit separated)
- **Accept:** the **auto-SUBMIT** action is gated **separately** from the assessment (architecture requirement); a slice can be auto+audit on assessment while auto-submit stays off. Per-slice × per-layer state is persisted and revertible. This milestone wires the controls; §4 validates them at runtime.

> Each milestone's **gate** = the three CI gates (§1.4) green + the milestone-specific accepts above. No milestone merges on a slice it touches without its synthetic adversarial fixtures present.

---

## 4. Runtime validation for graduated autonomy

Autonomy is granted **per slice (`panel × stage × case_type`) AND per layer (L1–L4)** (F5), gated on **JOINT** correctness with **asymmetric** error cost (F6). The auto-submit action is gated separately from assessment.

### 4.1 Dashboards (the measurement substrate)

- **Per-slice × per-layer accuracy matrix.** Rows = slices, columns = layers. Each cell: agreement-with-expert rate over a rolling window, sample count, and CI width. A slice with too few samples shows **insufficient-data** and cannot graduate.
- **JOINT-correctness panel.** A claim is **jointly correct** only if L1∧L2∧L3∧L4 are all correct for that claim. Per-layer rates can look high while joint correctness is low (errors stack across layers) — **JOINT correctness is the graduation metric**, never per-layer rates in isolation.
- **Asymmetric-error panel.** Separate **false-auto-file rate** (system would auto-submit something an expert would hold/reject) from **false-hold rate**. Weight by F6 cost ratio. The auto-submit gate is a function of **false-auto-file precision**, not overall accuracy.

### 4.2 The four states and promotion/demotion criteria

| State | What runs | What ships | Promotion gate (→ next) | Demotion trigger (→ prev) |
|---|---|---|---|---|
| **Supervised** | Engine assesses; human decides everything | Nothing auto | Per-layer agreement ≥ target AND joint correctness ≥ target over N≥min-sample claims in that slice, sustained over window W | — |
| **Shadow** | Engine produces full hypothesis silently alongside human | Nothing auto | Shadow joint-correctness ≥ target AND **false-auto-file precision** ≥ F6-derived bar on the *would-have* decisions | Shadow joint-correctness drops below supervised entry bar |
| **Auto + audit** | Engine assessment is acted on; **every** decision sampled/audited | Auto-assessment (submit still gated separately) | Audit pass rate sustains AND drift flat AND reviewer-consistency healthy AND zero confirmed false-auto-file in window | Any confirmed false-auto-file; audit pass dips; drift alarm |
| **Full-auto** | Engine acts; **sampled** audit | Auto-assessment; auto-submit only if **separately** graduated | (terminal) | Drift alarm, audit-sample failure, or false-auto-file → **auto-demote on drift**, alert, revert to auto+audit or shadow |

Graduation is **per slice AND per layer**: L1 (docs+stage) may be full-auto on a slice while L3 (rules) is still shadow. **Auto-submit is its own gate** — never implied by assessment graduation.

### 4.3 Audit sampling & reviewer quality

- **Audit sampling:** 100% in auto+audit; risk-stratified sample in full-auto (oversample high-cost slices: PMJAY/surgical/high-value, near-threshold readiness, low-confidence semantic-kind verdicts).
- **Reviewer consistency / inter-rater:** route a periodic **blind double-review** subset; track Cohen's/Fleiss κ. Low κ means the ground truth is noisy → **freeze graduation for that slice** until the rubric is sharpened (you cannot graduate against a label you can't agree on).
- **Automation-bias guard:** in auto+audit, periodically present reviewers a **hidden-recommendation** subset (engine verdict withheld) and compare to their normal (recommendation-shown) agreement. A large gap = rubber-stamping → tighten sampling / demote.

### 4.4 Drift detection

- **Input drift:** distribution shift in resolved-context mix, doc-category mix, doc quality per slice vs. the window the slice graduated on.
- **Output drift:** moving readiness-score distribution, rule fire-rate, semantic-kind confidence, override rate.
- **Outcome drift:** rising human-override / audit-fail rate.
- Any drift alarm on a graduated slice → **auto-demote** + alert. Drift is also why graduation must be **revertible** per slice/layer.

### 4.5 Cost as a runtime gate
- Per-claim LLM spend tracked via `recordCall`; alarm approaching `CLAIM_HARD_LIMIT_INR=15`. A slice whose semantic-kind usage pushes cost toward the cap is flagged for rule-mining (promote stable patterns to deterministic kinds to cut spend).

---

## 5. Regression discipline

### 5.1 The HIT→MISS baseline gate (extraction/context)
- `regression.ts` against committed `regression.baseline.json` hard-fails on **field-accuracy HIT→MISS** only; signal/quarantine changes are **drift-only** (confirmed in `scorer.ts`/`errorBudget.ts`). Any PR touching extraction/context runs this gate (CI gate #3, §1.4).
- **Re-blessing** the baseline (`HARNESS_UPDATE_BASELINE=1`) requires: (a) the change is intended, (b) a human reviewer signs off the diff of HIT↔MISS deltas, (c) the bless commit references the milestone. Never auto-bless in CI.
- Drift-only signals (quarantine/signal) are **reviewed, not gated** — a regression there opens a ticket, doesn't block, but a sustained trend feeds §4.4 drift.

### 5.2 Validating rule changes without breaking prior slices
- **Golden replay per rule change:** any new/edited rule (data row) must (a) pass its own golden, and (b) **re-run the full synthetic slice grid** and assert no *previously-passing slice flips verdict* unless that flip is the intended change and is recorded in ground truth. This is the rules-engine analog of HIT→MISS.
- **Selection regression:** changing the selection key (M3) re-runs the selection golden across all slices — a more-specific new rule set must not silently capture slices it shouldn't (over-broad `applicable_*` arrays). Assert each slice still resolves to its expected set.
- **Persistence regression:** after the M3/067 unique-key change, a stored multi-stage claim is re-evaluated and asserted to still hold one row per `(claim, set, rule, stage)` — guards the F1 collapse.
- **Rule-miner promotions** (M6) enter as draft rule sets; they must pass the full slice-grid regression **before** an admin can move them to `live`. A promotion that flips a prior slice is rejected or requires an explicit ground-truth update.
- **Runtime regression loop:** every audit-confirmed miss in production becomes a new fixture in the synthetic grid (or a new ground-truth entry on the real corpus via a record pass), closing the flywheel so the same defect cannot silently recur.

---

## 6. Traceability summary (validation → milestone/gate)

| Validation | Pillar | Where it runs | Ties to |
|---|---|---|---|
| Context resolver golden + LLM-cross-check-only | A | host | M1 |
| Stage-tag + provenance golden | A | host | M2 |
| 5 deterministic kind goldens | A | host | M3 / F2 |
| Selection most-specific-wins + no_match | A | host | M3 / F5 |
| Multi-stage persistence (067 key) | — | disposable DB (worker) | M3 / F1 |
| Wave-3A fold parity | A + DB | host + worker | M3 |
| Semantic kinds + cost cap | B | replay (worker) | M4 |
| 4-layer output + L4↛L3 contradiction | A/B | host + replay | M5 / F4 |
| Flywheel: instant det-fix, batched model-fix, rule-miner | A + DB | host + worker | M6 |
| Assessment vs. submit separation | DB/wiring | worker | M7 |
| Per-slice×layer + JOINT + false-auto-file gates | runtime | dashboards | §4 / F5,F6 |
| Audit, inter-rater κ, automation-bias, drift | runtime | dashboards | §4 |
| HIT→MISS extraction gate | B | replay (worker) | §5.1 |
| Rule-change slice-grid no-flip | A + replay | host + worker | §5.2 |

**Three standing CI gates on every PR:** (1) TS 5.4.5 zero-new-errors-on-edited-lines; (2) Pillar-A pure-function goldens; (3) replay regression (extraction/context PRs). **G-FREEZE blocks all post-M0 merges until F1–F6 are frozen.**

---

Key file references (all absolute): engine entry `…/Backend/src/Services/adjudicationEngine.service.ts:559-613`; v2 rules `…/Backend/src/Services/rulesEngineV2.service.ts` (dispatch `:423-553`, selection `:357-400`, result shape `:80-95`, persistence `:593-633`); Wave-3A `…/Backend/src/Services/rulesEngine.service.ts:407-443`; projector `…/Backend/src/Services/claimDossierProjector.service.ts`; dossier bootstrap gap `…/Backend/src/Services/claimDossier.service.ts:131-164`; doc sections schema `…/Backend/src/schema/migrations/032_document_sections.sql`; rule schema `…/Backend/src/schema/migrations/044_insurer_rule_sets.sql`; harness `…/Backend/src/Services/pipelineV2/harness/{run.ts,regression.ts,scorer.ts,errorBudget.ts,corpus.ts,regression.baseline.json}`. Next free migration number: **067**.