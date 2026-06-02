# FROZEN CONTRACTS — Stage-Aware Adjudication Engine

**Status:** Frozen at M0 · **Date:** 2026-06-02 · **Owner:** Eng Lead
**How to change:** any edit here is a re-plan event — it requires sign-off and a Watcher `CONTRACT_DRIFT` review, because downstream milestones (M1–M9) are built against these shapes.

> These values were adopted from the planning package's **recommended defaults** (OD1–OD6) on a "let's implement" go-ahead. They are reversible decisions — the founder/eng-lead may override any of them before the dependent milestone starts. OD7 (autonomy metric) is intentionally **not** frozen here; it blocks M8, not M0.

---

## OD1 — Context dimension model (`scheme · route · insurer · case_type`)

All four are **data**, modelled on the existing catalog/record fields (no new code-level enums):

| Dimension | Source of truth | Representation |
|---|---|---|
| `route` | `ipds.claim_filing_route` (CHECK enum, mig 017) | `'cashless_everywhere' \| 'network'` |
| `insurer` | `ipds.panel_id` (panels double as insurers — no insurers table) | UUID (`panels.id`) |
| `scheme` | derived from panel code / `scheme_name` + route | `'PMJAY' \| 'CASHLESS_EVERYWHERE' \| 'NETWORK_PRIVATE' \| <panel_code>` (freeze as `master_options(category='scheme')` when authoring lands) |
| `case_type` | **derived for now** from `episode.meta.episode_type` + procedure count; **intended future SoT = an explicit admission field** (not yet built) | `'SURGICAL' \| 'MEDICAL_MANAGEMENT' \| 'UNKNOWN'` (freeze as `master_options(category='case_type')`) |

## OD2 — Stage is the universal join key

The **19 `master_options(category='ipd_stage')` codes** (mig 024) are the single stage vocabulary used by `ipds.stage`, `document_sections.stage`, `claim_context.stage`, rule-set selection, and per-stage evaluation history. All stage columns are `VARCHAR(40)`, **app-validated** (no DB FK/CHECK — mirrors `ipds.stage`).

```
draft, preauth_submitted, preauth_queried, preauth_query_responded, preauth_approved,
admitted, enhancements_submitted, enhancements_queried, enhancements_query_responded,
discharge_draft, discharge_submitted, discharge_queried, discharge_query_responded,
discharge_approved, discharged, claim_filed, claim_queried, claim_query_responded, claim_approved
```

Canonical **stage classes** (for cross-checks/selection): `preauth · enhancement · discharge · claim · other`.

## OD3 — Per-stage evaluation key

`claim_rule_evaluations` unique key becomes `(claim_id, stage, rule_set_id, rule_id)` (migration **069**, at M3). Until then, evaluations are not stage-partitioned. *(Forward-only; documented at M3.)*

## OD4 — Evaluator-kind registry (canonical names, UPPER_SNAKE)

Deterministic (in-process, free): `DOCUMENT_PRESENCE`, `REQUIRED_FIELDS`, `FUZZY_NAME`, `TEMPORAL_WINDOW`, plus existing v2 `SIMPLE_COMPARISON` / `CALCULATION` / `COMPLEX_CONDITION` / `LOOKUP_TABLE`.
Semantic (LLM/vision, capped + cached): `LLM_COHERENCE`, `EVIDENCE_CHECK`.
Confidence contract: a single `confidence ∈ [0,1]` per evaluation + a per-rule `min_confidence`; **below floor ⇒ `SKIP` (never auto-`PASS`/`FAIL`)**. No DB CHECK on `kind` (new kinds stay migration-free). *(Consumed at M3/M6.)*

## OD5 — The boundary invariant (Watcher CRITICAL: `SOT_INVERSION` / `PIPELINE_VETO`)

- The pipeline **interprets**; the rules/decision layer **adjudicates**. No whole-claim veto inside the pipeline.
- **An LLM is never the final determiner.** For context, **source-of-truth precedence is `record → empanelment → dates → derived`**; LLM/derived signals are *cross-checks only* and may raise a flag but never override a record value. Semantic rule kinds below `min_confidence` abstain. Auto-submit always requires a deterministic-rule basis.

## OD6 — Provenance: renovate, don't rebuild

Field provenance is stored **inline** in `document_sections.extracted_fields` (already JSONB) as `{ value, source_section_id, source_document_id, confidence }`. **No separate provenance table** in M1/M2.

---

## Migration-number ledger (single allocator)

| # | Owner | Adds |
|---|---|---|
| **067** | M0 (this milestone) | `hospital.claim_context` + `document_sections.stage` |
| 068 | M3 | rule `kind` + `min_confidence` + stage/scheme/case_type on rule-set selection |
| 069 | M3 | per-stage eval key + `claim_hypothesis` |
| 070 | M7 | feedback + root-cause attribution |
| 071 | M8 | autonomy / graduation state |
| 072 | M7 | audit |

Migrations merge in numeric order regardless of branch readiness. **No ad-hoc numbers.**

## Reconciliation vs the plan (recorded deviation)

The plan assumed **reversible up/down** migrations. The repo's actual convention (verified: node-pg-migrate `-j sql`, no `-- Down Migration` markers ⇒ `down:false`) is **forward-only + idempotent**. We follow the repo: every migration is additive, guarded with `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, and carries a documented **manual** rollback in its header. The M0 objects are additive + inert (written in shadow, read by nothing), so manual rollback is a `DROP TABLE` / `DROP COLUMN`.

## Contract artifact

The TypeScript source-of-truth for the resolved context shape is **`Backend/src/Services/context/types.ts`** (`ResolvedContext`, `ResolveContextInput`, `ContextField<T>`, `IPD_STAGE_CODES`). Changing those types = a `CONTRACT_DRIFT` event.
