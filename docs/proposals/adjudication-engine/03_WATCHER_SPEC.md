Confirmed: `costAccounting.recordCall` and the `CLAIM_HARD_LIMIT_INR=15` cap are real and wired through the LLM call sites. I have everything needed to write the spec.

---

# WATCHER — Oversight Mechanism for the Multi-Agent Build

**Status:** Planning spec. No source code is written or modified by this document or by the Watcher itself. The Watcher is a *read-only verifier* plus a *gate*; it can fail a workstream and emit signals, but it never edits repo source.

**Scope of authority:** The Watcher governs the build of the unified stage-scoped rules engine + Auto-Context resolver + stage-tagging + authoring CRUD described in the recommended architecture. It enforces the HARD CONSTRAINTS verbatim.

---

## 0. Things this plan FLAGS TO FREEZE before the build starts

The recommended architecture is a *baseline, not frozen*. The Watcher cannot check "plan adherence" against a moving target, so the following must be frozen into a `FROZEN_CONTRACTS.md` artifact (an input the Watcher reads) at milestone M0. Until frozen, the Watcher runs in **shadow** (emits signals, blocks nothing).

**FREEZE-1 — Context contract.** The exact shape and field names of `ResolvedContext = {scheme, route, insurer, stage, case_type}`, plus the *source-of-truth precedence* per field (admission/panel record + empanelment for scheme/route/insurer; doc-mix + timeline + dates for stage; procedures/episode_type for case_type) and the explicit rule that LLM/derived signals are cross-checks only. This is the contract behind constraint (e), boundary integrity.

**FREEZE-2 — Rule-set selection key.** Whether the selection key is extended on `hospital.insurer_rule_sets` with `applicable_stages TEXT[]`, `applicable_panel_ids UUID[]`, `case_type VARCHAR` (per Recon A §1) and the scoring/gate semantics. The Watcher's plan-adherence check keys off this.

**FREEZE-3 — Evaluator-kind registry.** The closed list of evaluator `kind`s for v1 of the unified engine and which are deterministic (in-process: `doc_present`, `field_exists`, `compare`, `fuzzy_name`, `temporal_window`) vs. semantic (constrained LLM: `llm_coherence`, `evidence_check`). New `case` arms in the `evaluateRule` switch (`rulesEngineV2.service.ts:432`) must map 1:1 to this frozen list. Anything outside it is scope creep.

**FREEZE-4 — Persistence key change.** The decision to add `stage` to the `claim_rule_evaluations` unique key (`uq_cre_claim_set_rule`) so per-stage evaluations coexist (Recon A §3). This is a migration-shape contract; the migration-safety check depends on it.

**FREEZE-5 — The 4-layer output contract.** The JSON shape of the per-(claim,stage) hypothesis: (1) documents+stage, (2) content/fields, (3) rules+pass/fail+evidence, (4) readiness+action. Feedback pinning and graduated-autonomy gating both key off layer identity, so layer boundaries must be frozen.

**FREEZE-6 — Milestone→file-scope map.** For each milestone (M1…Mn), the *allowed file set* and *forbidden file set*. This is the single most important Watcher input — plan-adherence is mechanically checked against it.

The Watcher's first action at M0 is to assert all six artifacts exist and are non-empty. Missing freeze artifact = **NO-GO**, build does not start.

---

## 1. Watcher role, cadence, and how it is actually run

### 1.1 Role
The Watcher is a **non-author oversight agent** with three modes:
- **Verify-phase Watcher** (synchronous gate): runs at the end of every milestone, before the next wave's builder agents are dispatched. This is the load-bearing mechanism. It produces a GO/NO-GO verdict (§4).
- **Periodic drift Watcher** (asynchronous, via `/loop`): runs on an interval during long milestones to catch divergence early rather than only at the gate.
- **On-demand Watcher**: any builder agent or the orchestrator can invoke it mid-milestone to pre-check before declaring "done."

The Watcher is itself bound by the hard constraint: **no agent in this workflow may edit or write repo source code.** The Watcher only reads the repo, runs read-only/replay commands, and writes its verdict to a non-source location (`/tmp/watcher/<milestone>.json` and its final text return).

### 1.2 Mechanism in THIS harness

**Verify-phase (primary).** The orchestration script that spawns builder subagents calls the Watcher as a subagent immediately after each milestone's builders return, with a prompt containing: `milestone_id`, the frozen `FROZEN_CONTRACTS.md`, the milestone's allowed/forbidden file set (FREEZE-6), and the git ref range for the milestone's changes (`BASE_REF..HEAD`). The Watcher returns a single JSON verdict string (the workflow parses it). The orchestrator does not dispatch the next wave unless `verdict == "GO"`.

The Watcher's checks are run as **read-only Bash** against:
- `git diff -U0 <BASE_REF>..HEAD` — for plan-adherence + type-check-on-edited-lines + boundary scans.
- the pinned isolated TypeScript 5.4.5 / Node 22 type-checker against `Backend/tsconfig.json`.
- the pipelineV2 replay regression gate (`LLM_REPLAY_MODE=replay`, free) inside `hospital_worker_dev`.
- `psql`/migration-runner dry checks against the migration files (NOT prod data).

**Periodic (`/loop`).** During a milestone expected to run long, the orchestrator starts a background `/loop` Watcher: `/loop 10m /watcher --mode=drift --milestone=Mk`. Each tick runs the cheap subset (plan-adherence + boundary + cost-discipline static scans + type-check on edited lines) against the working tree and emits drift signals. It does NOT run the (slower) replay benchmark every tick — that is gate-only or triggered by a `pipelineV2/**` touch.

**Concretely wired commands the Watcher runs** (read-only):
```
# A) edited-line type-check gate (zero NEW errors)
git -C $REPO diff -U0 $BASE..HEAD --name-only -- '*.ts' > /tmp/watcher/edited.txt
git -C $REPO diff -U0 $BASE..HEAD > /tmp/watcher/diff.patch
<pinned-tsc-5.4.5 under node22> -p Backend/tsconfig.json --noEmit > /tmp/watcher/tsc.full.txt
# then intersect tsc errors against edited line ranges from diff.patch

# B) AI-quality gate (FREE replay regression)
docker exec hospital_worker_dev \
  env LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=/tmp/probe-bench12/.llm-cache \
      HARNESS_CORPUS_DIR=/tmp/probe-bench12 \
  npx tsx src/Services/pipelineV2/harness/regression.ts

# C) migration safety (offline)
node Backend/src/schema/run-migrations.cjs up --dry-run   # against a throwaway DB, never finclarity_prod
node Backend/src/schema/run-migrations.cjs down --dry-run  # reversibility proof
```

---

## 2. Per-checkpoint checks mapped to build milestones

Each check returns one of `PASS | WARN | FAIL`. Mapping to constraint letters is preserved from the task.

### (a) Plan adherence — interface contracts, file-scope, no scope creep
**How:** `git diff -U0 $BASE..HEAD --name-only` is intersected with FREEZE-6's allowed/forbidden file set for the milestone.
- Any touched file **outside** the milestone's allowed set → **FAIL** (`SCOPE_CREEP`).
- Any touched file in the **forbidden** set (e.g. Wave-3A `rulesEngine.service.ts` during a v2-only milestone; `claimDossierProjector.service.ts` event-fold internals when only the resolver was scoped) → **FAIL** (`FORBIDDEN_FILE`).
- Interface-contract honoring: the Watcher greps the diff for the frozen symbol signatures — e.g. `ResolvedContext` field names (FREEZE-1), the new evaluator-kind `case` labels (FREEZE-3) being a subset of the frozen registry, the 4-layer output keys (FREEZE-5). A new `case` arm whose label is not in FREEZE-3, or a `ResolvedContext` with a renamed/extra field, → **FAIL** (`CONTRACT_DRIFT`).
- New columns/tables not named in FREEZE-2/FREEZE-4 appearing in the migration → **WARN→FAIL** (`UNDECLARED_SCHEMA`).

### (b) Type-check gate — pinned TS 5.4.5 + Node 22, bar = ZERO NEW errors on edited lines
**How:** There is no `tsc` build gate in the repo (tsx transpile-only) and host `node_modules` is incomplete, so the Watcher uses the **pinned isolated TypeScript 5.4.5 under Node 22** against `Backend/tsconfig.json`, `--noEmit`. It then **filters** the full error list down to errors whose file+line fall inside the added/changed line ranges of `git diff -U0 $BASE..HEAD`.
- The bar is **zero NEW errors on edited lines**, proven against `git diff -U0` — NOT zero total. The ~50 pre-existing missing-module errors are baselined and ignored.
- Mechanism: parse `tsc` output `file(line,col): error TSxxxx`; keep only `(file,line)` pairs present in the diff's hunk-added ranges.
- Any surviving error → **FAIL** (`NEW_TYPE_ERROR`), with the offending `file:line` and TS code cited.
- Net-new pre-existing-error count increasing (regressing the ~50 baseline by editing a previously-clean module into erroring on unedited lines) → **WARN** (`BASELINE_DRIFT`), reported but not auto-blocking.

### (c) AI-quality gate — pipelineV2 replay benchmark HIT→MISS regression
**How:** runs `regression.ts` in replay mode (FREE) inside `hospital_worker_dev` against `/tmp/probe-bench12` with the committed `regression.baseline.json`.
- The gate **hard-fails only on field-accuracy regressions (HIT→MISS)** — this matches the harness's own contract (`regression.ts` only hard-fails on field-accuracy regressions; signal/quarantine changes are drift-only).
- Any HIT→MISS → **FAIL** (`AI_QUALITY_REGRESSION`), citing the regressed field(s) and slug(s).
- Signal/quarantine drift (non-field) → **WARN** (`AI_DRIFT`), reported.
- This check is **mandatory at any milestone whose allowed file-set includes `Services/pipelineV2/**` or anything feeding the harness's deterministic Stage 0→7 composition** (the resolver, stage-tagging that feeds extraction). For pure rules-engine/authoring milestones that do not touch pipeline composition, the gate is run but expected to be a no-op; an unexpected regression there is itself a **FAIL** (it means a "rules-only" change leaked into the pipeline → also trips boundary check (e)).
- Re-blessing the baseline (`HARNESS_UPDATE_BASELINE=1`) is **never** done by the Watcher. A builder requesting a baseline re-bless requires human sign-off (§3).

### (d) Migration safety — reversible, correctly numbered, no prod-data writes
**How:** static + offline-dry checks on any `Backend/src/schema/migrations/*.sql` in the diff.
- **Numbering:** new migration must be `067` (highest existing is `066_derived_page.sql`); subsequent waves increment monotonically with no gaps/collisions. Wrong/duplicate number → **FAIL** (`MIGRATION_NUMBER`).
- **Reversibility:** migration must have a working `down`. Watcher runs `up` then `down` then `up` against a **throwaway/disposable DB** (never `finclarity_prod`). A `down` that errors or is a no-op/`IRREVERSIBLE` stub → **FAIL** (`IRREVERSIBLE_MIGRATION`).
- **No prod writes:** the Watcher greps every command, connection string, and migration body for `finclarity_prod` / `localhost:5432` write paths and for `INSERT/UPDATE/DELETE/TRUNCATE/DROP` aimed at prod. Any migration or build step that targets prod data → **FAIL** (`PROD_DATA_WRITE`), highest severity.
- **Additive shape:** column additions follow the additive pattern (new migration, not editing `032`/`044`); editing an already-applied numbered migration in place → **FAIL** (`MUTATED_APPLIED_MIGRATION`).
- The persistence-key change (FREEZE-4, adding `stage` to `uq_cre_claim_set_rule`) must appear as a declared unique-key migration; if per-stage evaluation is being built but the key was NOT changed, evaluations will collapse → **FAIL** (`STAGE_KEY_COLLAPSE`).

### (e) Boundary integrity — pipeline INTERPRETS, never re-acquires whole-claim veto
**How:** static scan of the diff plus a structural assertion against the 4-layer contract.
- The pipeline (Stage 0→7 / `pipelineV2`, `adjudicationEngine` interpretation steps, the resolver) must produce **facts + rule inputs only**. Any new code path inside the pipeline that emits a hold/reject/file/approve *decision*, a whole-claim `veto`, or a `readiness`/`action` that short-circuits the rules layer → **FAIL** (`PIPELINE_VETO`). This is the constraint that the pipeline interprets, the rules/decision layer adjudicates (see also memory: "pipeline interprets, not adjudicates").
- The resolver (Stage 0) must set context from the frozen sources of truth and treat LLM/derived signals as cross-checks only. A diff where an LLM-derived signal is written as the *authoritative* `stage`/`insurer`/`scheme` (rather than as a cross-check that can only flag a discrepancy) → **FAIL** (`SOT_INVERSION`).
- Decision verbs (`recommended_action`, hold/file) are allowed **only** in layer-4 of the output, produced by the rules/decision layer — not by Stage 0–7 extraction. Watcher checks the producing module of each layer.
- Auto-SUBMIT must be gated **separately** from the assessment; a diff that couples them → **FAIL** (`SUBMIT_COUPLING`).

### (f) Cost discipline — recordCall present, cap respected
**How:** static scan of every new/changed LLM call site in the diff.
- Every new LLM invocation (Anthropic SDK call, vision/OCR call, the new semantic evaluator kinds `llm_coherence`/`evidence_check`) must be followed by a `costAccounting.recordCall({...})` on all paths. A new LLM call with no `recordCall` → **FAIL** (`UNRECORDED_LLM_CALL`). (Pattern verified live in `docSegmenter.service.ts:348`, `episodicMemory.service.ts:374`, `emailIntelligence.service.ts:729`.)
- The per-claim hard cap `CLAIM_HARD_LIMIT_INR=15` must be respected: any new spend path must check the running claim spend before issuing the call, mirroring `docSegmenter.service.ts:304` (`claimSpendInr >= 15`). A new evaluator that can loop LLM calls per-rule without a cap check → **FAIL** (`COST_CAP_BYPASS`).
- Semantic evaluator results must be **cached** (per the architecture's "constrained single-purpose evaluators … cached"); a diff adding `llm_coherence`/`evidence_check` with no cache key/lookup → **WARN** (`UNCACHED_EVALUATOR`) escalating to FAIL if it can be re-invoked within a single evaluation pass.

---

## 3. Signal taxonomy, severity, escalation

The Watcher emits **signals**. Each signal has `{code, severity, milestone, check, evidence (file:line / slug / command output), workstream}`.

| Severity | Meaning | Effect |
|---|---|---|
| **CRITICAL** | Hard-constraint violation or data-safety breach | **Auto-pause** the workstream immediately; NO-GO; needs human sign-off to resume |
| **BLOCK** | Gate failure | NO-GO for that milestone; builder must remediate and re-verify; no human needed if fix passes re-check |
| **WARN** | Drift / quality concern, not a gate breach | Recorded; aggregated; 3 WARNs of the same code in a milestone escalate to BLOCK |
| **INFO** | Observability | Recorded only |

**Signal → severity mapping:**

| Code | Check | Severity |
|---|---|---|
| `PROD_DATA_WRITE` | (d) | CRITICAL — auto-pause all workstreams, not just one |
| `MUTATED_APPLIED_MIGRATION` | (d) | CRITICAL |
| `PIPELINE_VETO` | (e) | CRITICAL |
| `SOT_INVERSION` | (e) | CRITICAL |
| `SUBMIT_COUPLING` | (e) | CRITICAL |
| `AI_QUALITY_REGRESSION` (HIT→MISS) | (c) | BLOCK |
| `NEW_TYPE_ERROR` | (b) | BLOCK |
| `SCOPE_CREEP` / `FORBIDDEN_FILE` / `CONTRACT_DRIFT` | (a) | BLOCK |
| `IRREVERSIBLE_MIGRATION` / `MIGRATION_NUMBER` / `STAGE_KEY_COLLAPSE` | (d) | BLOCK |
| `UNRECORDED_LLM_CALL` / `COST_CAP_BYPASS` | (f) | BLOCK |
| `UNDECLARED_SCHEMA` | (a) | WARN→BLOCK on repeat |
| `AI_DRIFT` (signal/quarantine) | (c) | WARN |
| `BASELINE_DRIFT` (pre-existing TS count up) | (b) | WARN |
| `UNCACHED_EVALUATOR` | (f) | WARN→BLOCK if re-invokable |

**What auto-pauses a workstream:** any **CRITICAL** signal. The Watcher returns a verdict with `auto_pause: true` and the orchestrator must not re-dispatch that workstream's builders (and for `PROD_DATA_WRITE`, must halt *all* workstreams) until a human clears it.

**What needs human sign-off (cannot be cleared by a passing re-check alone):**
- Any CRITICAL clear.
- Re-blessing the replay baseline (`HARNESS_UPDATE_BASELINE=1`) — the Watcher never does this autonomously.
- Promoting any slice to a higher autonomy tier (supervised→shadow→auto+audit→full-auto), and especially enabling the auto-SUBMIT action — gated on JOINT correctness with asymmetric error cost (low false-auto-file rate), reviewed by a human.
- Modifying `FROZEN_CONTRACTS.md` mid-build (a freeze change is a re-plan, not a fix).

**What a passing re-check clears (no human):** all BLOCK-severity signals — the builder remediates within scope and the Watcher re-runs the relevant check; if it passes, the signal clears.

---

## 4. Per-milestone GO / NO-GO gate

Before the orchestrator dispatches milestone **M(k+1)**'s builders, the Watcher runs the verify-phase against **Mk** and returns:

```json
{
  "milestone": "Mk",
  "verdict": "GO | NO_GO",
  "auto_pause": false,
  "checks": {
    "plan_adherence": "PASS|WARN|FAIL",
    "type_check_edited_lines": "PASS|FAIL",
    "ai_quality_replay": "PASS|WARN|FAIL",
    "migration_safety": "PASS|WARN|FAIL|N/A",
    "boundary_integrity": "PASS|FAIL",
    "cost_discipline": "PASS|WARN|FAIL"
  },
  "signals": [ { "code": "...", "severity": "...", "evidence": "..." } ],
  "human_signoff_required": false,
  "base_ref": "<sha>", "head_ref": "<sha>"
}
```

**GO requires ALL of:**
1. Zero CRITICAL signals (no auto-pause).
2. Zero BLOCK signals open: `plan_adherence`, `type_check_edited_lines`, `boundary_integrity`, `cost_discipline` all `PASS`; `migration_safety` `PASS` or `N/A`.
3. `ai_quality_replay` is `PASS` (no HIT→MISS). `WARN` (signal/quarantine drift) is acceptable for GO but is recorded and surfaced.
4. No outstanding `human_signoff_required` item (e.g. an autonomy-tier promotion or baseline re-bless requested in this milestone).
5. The milestone's frozen deliverable for the wave is present (e.g. M(resolver) must have produced a `ResolvedContext` populated at the call site in `adjudicationEngine.service.ts:run()` after `getDossier` and before target_stage/rule eval — Recon B §3 — checked structurally, not by running prod).

**NO-GO** if any of the above fails. NO-GO with `auto_pause:true` (CRITICAL) additionally freezes the workstream until human sign-off. NO-GO without auto-pause means: builder remediates within the milestone's file-scope, Watcher re-verifies, gate re-evaluated.

### Milestone sequencing the gate enforces (build order)
The gate also enforces dependency order so a wave cannot start before its substrate is GO:
1. **M0 — Freeze.** All six FREEZE artifacts exist (§0). Gate: all present + non-empty. (No code; the only NO-GO is a missing contract.)
2. **M1 — Migration 067** (schema: `document_sections.stage`, rule-set selection columns, `claim_rule_evaluations` stage in unique key). Gate: (d) + (a).
3. **M2 — Auto-Context resolver (Stage 0)** at the `run()` call site. Gate: (a)(b)(e)(c-no-op-expected) — boundary check is the load-bearing one here (SOT must not invert).
4. **M3 — Stage-aware document understanding / stage-tagging** feeding the harness. Gate: (a)(b)(c) — the replay gate is mandatory and must be PASS (HIT→MISS), since this touches pipeline composition.
5. **M4 — Unified stage-scoped rules engine** (Wave-3A presence collapsed into v2 as `DOCUMENT_PRESENCE`/`REQUIRED_FIELDS` kinds + new evaluator kinds). Gate: (a — kinds ⊆ FREEZE-3)(b)(d — stage key)(e)(f — new semantic kinds recordCall + cap + cache).
6. **M5 — 4-layer hypothesis output + feedback pinning.** Gate: (a — layer keys match FREEZE-5)(b)(e — decision verbs only in layer 4).
7. **M6 — Authoring CRUD + versioned rule-set lifecycle** on `rulesV2.controller.ts`/`rulesV2.routes.ts`, admin-gated. Gate: (a)(b)(d if migration)(f).
8. **M7 — Graduated autonomy gating** (per slice × stage × case_type × layer; auto-SUBMIT gated separately). Gate: all checks + **mandatory human sign-off** to enable any tier above shadow.

Each milestone is GO/NO-GO independently; M(k+1) builders are not dispatched until Mk is GO.

---

## Operational summary
- The Watcher is a read-only subagent invoked by the orchestration script at each milestone boundary (verify-phase) and optionally on a `/loop` interval (drift), returning a single JSON verdict the script parses.
- Six checks map to the six constraints; each emits coded signals with severity.
- CRITICAL signals (prod-data write, pipeline veto, SOT inversion, submit coupling, mutated applied migration) auto-pause and require human sign-off; BLOCK signals are clearable by a passing re-check; WARNs aggregate.
- GO requires zero CRITICAL, zero open BLOCK, replay PASS (no HIT→MISS), no pending human sign-off, and the milestone deliverable present — enforced before the next wave's builders are dispatched.
- The Watcher writes no repo source, never re-blesses the baseline, never touches `finclarity_prod`, and never promotes autonomy tiers on its own.

**Key file references (absolute):**
- Resolver call site: `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/Services/adjudicationEngine.service.ts` (`run()` after `getDossier`, before target_stage + rule eval)
- Rules dispatch switch: `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/Services/rulesEngineV2.service.ts:432`
- Persistence + unique key: `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/schema/migrations/044_insurer_rule_sets.sql` (`uq_cre_claim_set_rule`)
- Stage-tag target: `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/schema/migrations/032_document_sections.sql`
- Replay gate: `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/Services/pipelineV2/harness/regression.ts` (+ `run.ts`, `regression.baseline.json`)
- Cost-discipline pattern: `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/Services/docSegmenter.service.ts:304,348`
- Authoring CRUD attach point: `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/Controllers/rulesV2.controller.ts:158` + `/Users/maverick/Documents/Finclarity-Tech/claimsos/Backend/src/Routes/rulesV2.routes.ts`
- Next migration: `067` (highest existing `066_derived_page.sql`)