I have what I need. The CRIT in-flight branch (`feature/pipeline-v2-vision-native`) has 65 dirty files touching the pipeline core, adjudication queue, orchestrator, and harness — this is the live work the plan must not collide with. Writing the plan now.

# ClaimOS Adjudication Engine — Parallel Build Plan

Repo root: `/Users/maverick/Documents/Finclarity-Tech/claimsos`. All paths absolute under that root unless noted. Planning only; no source is to be edited by any agent in this workflow.

## 0. State of the world (verified, supersedes recon where it differs)

- **Routes ARE mounted** (recon said unmounted): `Backend/src/index.ts:383` mounts `stageRequirementsRouter`, `:399` mounts `rulesV2Router`. So authoring CRUD added to `rulesV2.routes.ts` goes live immediately on merge — gate it behind admin auth and a feature flag.
- **In-flight CRIT branch is dirty and large.** Current branch `feature/pipeline-v2-vision-native`, 65 modified/untracked paths, including the exact files this build must touch: `Services/intelligenceOrchestrator.service.ts`, `Workers/adjudicationEngine.queue.ts`, `Services/pipelineV2/**`, `Services/llm/**`, the harness. **This is the load-bearing guardrail of the whole plan** — see §4.
- Next free migration number = **067**. Highest on disk = `066_derived_page.sql`.
- Single git checkout, no existing worktrees.

## 1. Milestones (architecture-plan alignment, M0..M6)

- **M0 — Contracts frozen.** Shared TypeScript types + DB column contracts + migration register agreed; nothing else starts.
- **M1 — Auto-Context resolver (Stage 0).** Deterministic `{scheme,route,insurer,stage,case_type}` with provenance; replaces `inferTargetStage` default.
- **M2 — Stage-aware document understanding.** `document_sections.stage` tagging + per-doc-type field provenance preserved.
- **M3 — Unified stage-scoped rules engine.** One engine keyed by the resolved context, two rule families (sufficiency + content), pluggable evaluator kinds, evidence-cited.
- **M4 — 4-layer hypothesis output + persistence.** Per (claim,stage) layered result, stage-scoped persistence.
- **M5 — Authoring (versioned rule-set CRUD + admin UI) + HITL feedback flywheel.** Per-layer feedback, deterministic rule-authoring path, rule-miner stub.
- **M6 — Graduated autonomy + eval/replay gating.** Per-slice × per-layer autonomy ladder, joint-correctness gate, auto-submit gated separately, drift revert.

## 2. Interface-freeze points (MUST be agreed FIRST, single source — Wave 0)

These are the only things all downstream agents share. Freeze them as type/SQL stubs in a single owned location before any parallel work begins. **W0 owns them; everyone else consumes, no one else edits.**

**F1 — ResolvedContext type** (new, e.g. `Backend/src/Services/context/types.ts`):
```
ResolvedContext = {
  scheme: string; route: 'cashless_everywhere'|'network'|null;
  insurer_id: string|null; panel_id: string|null;
  stage: string;            // master_options(category='ipd_stage') code
  case_type: string|null;   // from episode_type/procedures
  provenance: Record<keyof ResolvedContext, { source: 'record'|'docmix'|'dates'|'events'|'llm_crosscheck'; confidence: number }>;
}
```
Rule: LLM/derived signals are cross-checks only (provenance.source='llm_crosscheck' may never be the sole basis for scheme/route/insurer).

**F2 — Rule shape extension.** The `validation_logic.logic_type` dispatch contract in `rulesEngineV2.service.ts:423-553` is the extension seam. Freeze the **set of new evaluator kinds** and their `validation_logic` JSON shapes: `DOCUMENT_PRESENCE`, `REQUIRED_FIELDS` (deterministic, fold-in from Wave 3A), `TEMPORAL_WINDOW`, `FUZZY_NAME` (deterministic), `LLM_COHERENCE`, `EVIDENCE_CHECK` (semantic, constrained single-purpose evaluators, structured output + confidence, cached). Each returns `{ status: 'PASS'|'FAIL'|'SKIP'|'ERROR', evidence, message, confidence? }` — the existing `RuleEvaluation` shape (`:50-63`). No DB CHECK on `logic_type`, so kinds need no migration; **new `category` values DO** (CHECK `chk_ir_category`, `044:90-93`).

**F3 — Rule-set selection key.** Freeze the augmented key `{insurer × treatment × specialty × stage × case_type}` and the additive columns on `hospital.insurer_rule_sets`: `applicable_stages TEXT[]`, `applicable_panel_ids UUID[]`, `case_type VARCHAR`. Freeze the `ClaimContext` extension (`rulesEngineV2.service.ts:149-156`) carrying `current_panel_id`, `current_insurer_id`, resolved `stage`, `case_type`, and the dossier snapshot (`doc_sections_by_category`).

**F4 — 4-layer hypothesis output type** (new, e.g. `Backend/src/Services/adjudication/hypothesis.types.ts`):
```
ClaimStageHypothesis = {
  claim_id; stage;
  layer1_documents: {...}; layer2_content: {...};
  layer3_rules: RuleEvaluation[];   // each cites evidence
  layer4: { readiness_score: number|null; recommended_action; autonomy_tier };
}
```

**F5 — Persistence keys.** Freeze that `claim_rule_evaluations` UNIQUE key becomes `(claim_id, rule_set_id, rule_id, stage)` (today `(claim_id,rule_set_id,rule_id)`, `044:166-188`) so per-stage evaluations don't overwrite. Freeze the per-layer feedback table shape and the autonomy-state table shape.

**F6 — Migration register.** A single ordered ledger file (planning doc, not code) assigning `067, 068, 069...` to workstreams so no two agents claim the same number. See §4.

**F7 — Feedback + autonomy contracts.** Per-layer feedback record `{claim_id, stage, layer, root_cause: 'missing_rule'|'wrong_rule'|'wrong_context'|'extraction', payload}` and autonomy-state `{slice: panel×stage×case_type, layer, tier: 'supervised'|'shadow'|'auto_audit'|'full_auto', auto_submit_enabled: bool}`.

## 3. Workstreams (W1..W9)

Sizing: S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks for one agent.

---

### W0 — Contract & migration-register freeze (M0)
- **Scope:** Author F1–F7 as compiling type stubs + SQL column stubs + the migration ledger. No logic. This is the merge-base every other branch forks from.
- **Owned files:** `Backend/src/Services/context/types.ts`, `Backend/src/Services/adjudication/hypothesis.types.ts`, `Backend/src/Services/feedback/types.ts`, `Backend/src/Services/autonomy/types.ts`, plus a planning ledger `docs/proposals/ADJUDICATION_BUILD_REGISTER.md`.
- **Interface:** exposes F1–F7; consumes nothing.
- **Depends-on:** none. **Parallel-with:** none (everyone waits on it).
- **Worktree:** main feature branch base; merged first.
- **DoD:** types compile under the pinned tsc (zero new errors on edited lines); ledger assigns migration numbers; all downstream agents fork from this commit.
- **Size:** S.

---

### W1 — Auto-Context resolver / Stage 0 (M1)
- **Scope:** Pure deterministic resolver producing `ResolvedContext` (F1) from admission/panel record + empanelment (scheme/route/insurer), doc-mix + timeline + admission/discharge dates (stage), procedures/episode_type (case_type). Fix the two known gaps: `bootstrapShell` not copying `ipds.stage` (`claimDossier.service.ts:131-164`) and `current_insurer_id` always null (`:154-155`). Replace the naive `inferTargetStage(null,…)→'preauth_submitted'` default (`adjudicationEngine.service.ts:149-167`).
- **Owned files:** `Backend/src/Services/context/resolver.ts` (+ helpers under `Services/context/`). **Read-only consumes** dossier/episode/empanelment data.
- **Interface:** exposes `resolveContext(dossier, episode, empanelment): ResolvedContext` (F1). Consumes F1.
- **Depends-on:** W0. **Parallel-with:** W2, W3, W5, W8.
- **Worktree:** YES (isolated; touches `claimDossier.service.ts` / `adjudicationEngine.service.ts` call sites that overlap with CRIT branch — see §4).
- **DoD:** standalone pure-function assertion harness covers scheme/route/insurer/stage/case_type derivation incl. provenance; LLM cross-check never sole source for scheme/route/insurer; zero new type errors on edited lines.
- **Size:** M.

---

### W2 — Stage-tagging migration + document-understanding (M2)
- **Scope:** Migration **067** adding `hospital.document_sections.stage VARCHAR(40)` + partial index `(claim_id, stage)` (mirrors `032:121-123`). Stage-tag each section using W1's resolver signals; preserve per-document-type field provenance (do not fuse all into one episode).
- **Owned files:** `Backend/src/schema/migrations/067_document_sections_stage.sql` (reversible), section-tagging helper under `Services/context/` or `Services/pipelineV2/` (coordinate file path with CRIT owner — see §4).
- **Interface:** writes `document_sections.stage`; exposes `tagSectionStages(claimId, ResolvedContext)`. Consumes F1, F3.
- **Depends-on:** W0, W1 (uses resolver output). **Parallel-with:** W3 (selection), W5, W8.
- **Worktree:** YES (migration serialization + pipelineV2 overlap with CRIT).
- **DoD:** migration up/down clean against a throwaway DB (NOT `finclarity_prod`); replay benchmark unchanged (`run.ts` replay mode) or drift explained; index present.
- **Size:** M.

---

### W3 — Unified rules engine: selection + evaluator kinds (M3)
- **Scope:** Extend `resolveRuleSet` (`rulesEngineV2.service.ts:357-400`) with the F3 key (stage, panel, case_type) as added gate+score terms. Extend `ClaimContext` + `loadClaimContext` (`:149-156`, `:266-347`) to carry panel/insurer/stage/case_type + dossier snapshot. Add the F2 deterministic evaluator kinds (`DOCUMENT_PRESENCE`, `REQUIRED_FIELDS`, `TEMPORAL_WINDOW`, `FUZZY_NAME`) as new `case`s in the `evaluateRule` switch (`:423-553`). Fold Wave 3A presence logic (`rulesEngine.service.ts:407-443`) into `DOCUMENT_PRESENCE`.
- **Owned files:** `Backend/src/Services/rulesEngineV2.service.ts`, evaluator modules under `Backend/src/Services/rules/` (new files; do not edit the frozen `customFunctions/index.ts` registry except additive entries).
- **Interface:** exposes the extended `RulesEngineV2.evaluate(claim_id, ResolvedContext)`. Consumes F1, F2, F3, F5.
- **Depends-on:** W0; integration-depends on W1 (context) and W4 (migration 068 for selection columns + UPSERT key). **Parallel-with:** W4, W6, W8 (build kinds against stubs).
- **Worktree:** YES.
- **DoD:** pure-function harness for each new kind; selection scoring unit-tested incl. stage/case_type ties; existing Wave 8 evals unchanged; zero new errors on edited lines.
- **Size:** L.

---

### W4 — Rules schema + persistence migration (M3/M4)
- **Scope:** Migration **068**: additive columns on `hospital.insurer_rule_sets` (`applicable_stages`, `applicable_panel_ids`, `case_type`); relax `chk_ir_category` if new categories needed (F2); change `claim_rule_evaluations` UNIQUE to `(claim_id, rule_set_id, rule_id, stage)` (F5; add `stage` column). Data-migrate Wave 3A `stage_requirements` rows into `insurance_rules` under stage-scoped rule sets (`required_doc_category`/`required_fields` → `validation_logic`; `blocking|warning|info` → v2 severity/impact).
- **Owned files:** `Backend/src/schema/migrations/068_unified_rules.sql` + a reversible data-backfill migration.
- **Interface:** provides the schema W3 selects against and W6 persists to. Consumes F3, F5.
- **Depends-on:** W0. **Parallel-with:** W3 (schema-first contract lets W3 code against columns). **Serialized after W2's 067.**
- **Worktree:** YES (migration serialization).
- **DoD:** up/down clean on throwaway DB; Wave 3A backfill idempotent + reversible; NO writes to `finclarity_prod`.
- **Size:** M.

---

### W5 — 4-layer hypothesis assembler + stage-scoped persistence (M4)
- **Scope:** Assemble `ClaimStageHypothesis` (F4) from W1 (layer1/2), W3 (layer3), and a readiness scorer (layer4). Persist per (claim,stage) via the F5 key. Wire into the adjudication call path (`adjudicationEngine.service.ts:559-613` run(); orchestrator `intelligenceOrchestrator.service.ts:352-387` Step3→Step4).
- **Owned files:** `Backend/src/Services/adjudication/hypothesisAssembler.ts`, readiness scorer module. Call-site edits in `adjudicationEngine.service.ts` (coordinate with CRIT — §4).
- **Interface:** exposes `buildHypothesis(claim_id, ResolvedContext): ClaimStageHypothesis`. Consumes F1, F2, F4, F5.
- **Depends-on:** W0, W1, W3, W4. **Parallel-with:** W7 (UI), W8.
- **Worktree:** YES.
- **DoD:** assembler harness over a fixed fixture; readiness_score nullable when no rules match (mirror `emptyResult` `:695-722`); evidence present on every layer3 entry.
- **Size:** M.

---

### W6 — Authoring: versioned rule-set CRUD + admin UI (M5)
- **Scope:** Add `POST/PUT/DELETE /insurer-rule-sets` and `…/:id/rules` to `rulesV2.controller.ts`/`rulesV2.routes.ts` (next to read-only `listRuleSets`/`getRuleSet` `:158-229`), gated `Auth.checkSuperAdminOrAdmin` (copy Wave 3A pattern, `stageRequirements.routes.ts:38-58`). Use draft→live→deprecated lifecycle already on `insurer_rule_sets` (`044:43-51`). Admin UI in webapp. **Routes are live on mount** — gate behind feature flag.
- **Owned files:** `Backend/src/Controllers/rulesV2.controller.ts`, `Backend/src/Routes/rulesV2.routes.ts`, new webapp authoring pages under `webapp/src/pages/...` (new dir, avoid CRIT-dirty webapp files).
- **Interface:** consumes F2, F3 (rule/rule-set shapes). Exposes authoring REST contract.
- **Depends-on:** W0, W4 (schema). **Parallel-with:** W3, W5, W7, W8.
- **Worktree:** YES.
- **DoD:** CRUD respects version lifecycle + admin gate; create sets `created_by` from `req.user.id`; behind flag; no new type errors on edited lines.
- **Size:** L.

---

### W7 — HITL per-layer feedback + rule-miner stub (M5)
- **Scope:** Per-layer feedback capture with root-cause attribution (F7). Deterministic fixes (missing/wrong rule, wrong context) write directly to the rule library (via W6 authoring) — instant + permanent. Model fixes (extraction) batched to the replay harness. Rule-miner stub that flags stable human-override patterns (reads `rule_overrides`, `044:194-211`) for promotion.
- **Owned files:** `Backend/src/Services/feedback/*`, migration **069** for the per-layer feedback table (F7). Feedback UI panels in webapp (new dir).
- **Interface:** consumes F4, F7; writes feedback rows; calls W6 authoring for deterministic promotion.
- **Depends-on:** W0, W4 (overrides table exists), integration with W5/W6. **Parallel-with:** W6, W8. **Migration 069 serialized after 068.**
- **Worktree:** YES.
- **DoD:** feedback rows pin to (claim,stage,layer) with root_cause; deterministic path produces a draft rule set; up/down migration clean.
- **Size:** M.

---

### W8 — Eval / replay-gate harness extension (M6, cross-cutting)
- **Scope:** Extend the replay harness (`Services/pipelineV2/harness/`) and `regression.ts` to score the new layers: context-resolution accuracy, stage-tag accuracy, rule pass/fail joint-correctness with **asymmetric error cost** (penalize false-auto-file heavily). This is the AI-quality gate every other workstream runs before merge.
- **Owned files:** new scorer modules under `Backend/src/Services/pipelineV2/harness/` (NEW files only — `regression.ts`, `runner.ts`, `scorer.ts` are CRIT-dirty; add `adjudicationScorer.ts` etc. and a separate baseline rather than editing in place).
- **Interface:** consumes F1, F4; produces a gate report. Exposes `npx tsx .../harness/run.ts` extensions in replay mode (FREE).
- **Depends-on:** W0; consumes W1/W5 outputs to score. **Parallel-with:** all (harness is additive). **Heavy coordination with CRIT branch owner** (§4).
- **DoD:** replay gate runs FREE (`LLM_REPLAY_MODE=replay`); hard-fails on field-accuracy + new joint-correctness regression; baseline blessed only on intended change (`HARNESS_UPDATE_BASELINE=1`).
- **Size:** M.

---

### W9 — Graduated autonomy state machine + auto-submit gating (M6)
- **Scope:** Per-slice (panel×stage×case_type) × per-layer autonomy ladder supervised→shadow→auto+audit→full-auto (F7). Tier transitions gated on W8 joint-correctness with asymmetric cost. **Auto-SUBMIT action gated SEPARATELY** from assessment. Drift detection reverts a slice's tier.
- **Owned files:** `Backend/src/Services/autonomy/*`, migration **070** for autonomy-state table (F7).
- **Interface:** consumes F4, F7, W8 gate metrics; gates the recommended_action / auto-submit in layer4.
- **Depends-on:** W0, W5, W8. **Parallel-with:** W6, W7. **Migration 070 serialized after 069.**
- **Worktree:** YES.
- **DoD:** tier transitions require joint-correctness threshold; auto-submit flag independent of tier; drift triggers revert; CLAIM_HARD_LIMIT_INR + recordCall preserved on any LLM call in the path.
- **Size:** M.

## 4. Guardrails for parallel agents on a live, fragile repo

1. **Do NOT touch the in-flight CRIT branch work.** `feature/pipeline-v2-vision-native` has 65 dirty paths including the exact integration points (`intelligenceOrchestrator.service.ts`, `adjudicationEngine.queue.ts`, `Services/pipelineV2/**`, `Services/llm/**`, all harness `.ts` files, `index.ts`, migration `066`). **Rule:** No adjudication-build agent may edit a CRIT-dirty file. Where W1/W2/W5 must touch call sites in `adjudicationEngine.service.ts`/`claimDossier.service.ts`, they add NEW modules and expose a single thin call to be wired in by a final integration agent AFTER the CRIT branch lands and is committed. W8/W2 add NEW harness/pipeline files, never edit `regression.ts`/`runner.ts`/`scorer.ts` in place.
2. **Worktree isolation.** Every workstream that writes code (W1–W9) runs in its own `git worktree` off the W0 freeze commit. No two agents share a working tree. Use the `EnterWorktree`/`ExitWorktree` tools.
3. **Type-check bar = zero NEW errors on edited lines.** No `tsc` build gate; verify via the pinned isolated TypeScript 5.4.5 (Node 22) against `Backend/tsconfig.json`, proven against `git diff -U0`. ~50 pre-existing missing-module errors are tolerated; edited lines must add none.
4. **Tests run as standalone pure-function assertion harnesses + the pipelineV2 replay benchmark** (host `node_modules` is incomplete — `@anthropic-ai/sdk`, `pdf-*`, `tesseract.js` missing). AI-quality gate = `LLM_REPLAY_MODE=replay` (FREE) via W8. Real-spend record passes need `HARNESS_ALLOW_RECORD=1` and are out of scope for these agents.
5. **No prod-data writes.** `finclarity_prod` (localhost:5432) is read-only for these agents. All migration up/down testing runs against a throwaway/scratch DB. No speculative or destructive writes.
6. **Migrations serialized to avoid number collisions.** W0's register (F6) is the single allocator: **067=W2, 068=W4, 069=W7, 070=W9.** No agent picks a number ad hoc. Every migration reversible (`node-pg-migrate`; runner `Backend/src/schema/run-migrations.cjs`). Migrations merge in numeric order regardless of branch readiness.
7. **Every LLM call records cost.** Semantic evaluator kinds (`LLM_COHERENCE`, `EVIDENCE_CHECK`) and any autonomy-path LLM call must `recordCall` and respect `CLAIM_HARD_LIMIT_INR=15/claim`; results cached. Deterministic kinds run in-process, no LLM.
8. **Pipeline interprets, never adjudicates.** No whole-claim veto inside the pipeline/W1/W2 — they produce facts + rule inputs only. Adjudication lives in W3/W5/W9. (Consistent with the standing memory: pipeline = files→accurate JSON + flags; hold/file lives in the rules layer.)
9. **Feature-flag live routes.** Because `rulesV2Router` is already mounted (`index.ts:399`), W6's authoring endpoints go live on merge — they must ship behind an admin gate + feature flag.

## 5. Wave schedule + merge order

- **Wave 0 (serial, blocking): W0.** Freeze F1–F7 + migration register. Merge to the shared base first. Rationale: every parallel branch forks from this; it is the only thing that prevents type/contract merge conflicts.
- **Wave 1 (parallel): W1, W2, W4, W8.** Resolver (W1), stage-tag migration+tagging (W2, mig 067), rules schema+backfill (W4, mig 068), harness extension (W8). Rationale: W1 is the upstream fact source; W2/W4 are schema-first so code can compile against columns; W8 is additive and needed as the gate for everyone. W3 can also begin coding here against W4's frozen columns.
- **Wave 2 (parallel): W3, W5, W6, W7.** Engine (W3) integrates W1+W4; assembler (W5) integrates W1+W3+W4; authoring (W6) on W4 schema; feedback (W7, mig 069) on W4+W6. Rationale: all depend on Wave-1 schema/resolver being merged.
- **Wave 3 (parallel then serial): W9** (mig 070, depends W5+W8), then **final integration agent** wires the resolver/assembler call sites into `adjudicationEngine.service.ts` + `intelligenceOrchestrator.service.ts` — **only after the CRIT branch has landed**. Rationale: autonomy needs the gate + hypothesis; integration must happen last to avoid colliding with in-flight pipeline-v2 work.

**Merge order:** W0 → (W2 mig067, W4 mig068 in number order) → W1, W8 → W3 → W5 → W6 → W7 (mig069) → W9 (mig070) → final integration. Migrations always merge in numeric sequence even if their feature branch is otherwise ready early.

## 6. What must be FROZEN before build (explicit, since architecture is "not yet frozen")

Decide and lock in W0: (a) the F1 `ResolvedContext` field set + the "LLM is cross-check only" rule for scheme/route/insurer; (b) the F2 evaluator-kind enum + each kind's `validation_logic` JSON shape and which are deterministic vs semantic; (c) the F3 selection-key dimensions and whether case_type is scalar or array; (d) the F5 `(claim_id,rule_set_id,rule_id,stage)` persistence key (irreversible-ish — drives migration 068); (e) F7 autonomy slice granularity (panel×stage×case_type) and that auto-submit is a separate flag from tier. Everything else can evolve behind these contracts.

Key file references the build hangs on: `Backend/src/Services/rulesEngineV2.service.ts` (selection `:357-400`, dispatch `:423-553`, context `:149-156`, persistence `:593-633`); `Backend/src/Services/adjudicationEngine.service.ts:559-613` (run/integration seam); `Backend/src/Services/intelligenceOrchestrator.service.ts:352-387` (orchestration seam); `Backend/src/Services/claimDossier.service.ts:131-164` (bootstrap gaps); `Backend/src/schema/migrations/044_insurer_rule_sets.sql` + `032_document_sections.sql` + `024_add_ipd_stage.sql` (schema base); `Backend/src/Services/pipelineV2/harness/` (gate); `Backend/src/index.ts:383,399` (live route mounts); `Backend/src/Controllers/rulesV2.controller.ts:158-229` (authoring attach point).