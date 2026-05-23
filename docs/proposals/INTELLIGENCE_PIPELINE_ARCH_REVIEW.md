# ClaimOS Intelligence Pipeline — Architecture Review

**Date:** 2026-05-19
**Scope:** End-to-end document understanding pipeline — segmentation, classification, extraction, harmonisation.
**Method:** Multi-agent forensic analysis (pipeline architect + schema gap analyst + SRE/reliability auditor), synthesised by senior architect viewpoint.

---

## TL;DR

What works:
- **The pipeline shape is correct.** Event-sourced, queue-backed, idempotent at every stage, with version-bumped invalidation. Last session's additions (vision routing, KB hints, force re-run, slot promotion, per-field corrections) closed real gaps and are layered onto the right foundation.
- **Document understanding is good.** With vision routing + rotation auto-correct + category hints + Verhoeff validators, we can read what's on paper.
- **Closed-loop learning exists.** Field corrections feed `ai_corrections` → `kb_patterns` → classifier prompt hints. The feedback wiring is real.

What doesn't:
- **The harmonised episode is insurer-thin.** Of ~280 leaves in the canonical schema, a typical run populates ~50-80 (20-30% density). The reference samples ship 250/280 (~90%). **Four claim-critical sections — `validation_metadata`, `claim_processing_metadata`, `audit_trail`, and the deep granularity inside `clinical_timeline` / `financial_summary.breakdown` — are essentially never populated.** The Zod schema is so lenient (`z.record(z.unknown())` on most nested nodes) that almost anything validates. An insurer comparing our output to the Khatoon/Rajesh reference would reject it on completeness alone.
- **Reliability has 4 specific named gaps** that will bite under real production load: (1) harmoniser `status='pending'` orphans on worker crash, (2) cost-cap race allowing per-claim overspend, (3) concurrent force re-runs with a TOCTOU window on `_corrected_fields`, (4) no reconciler for failed Bull jobs.
- **Performance is acceptable but cost is uncomfortably close to the cap.** A typical 15-section PMJAY claim runs in ~50-60s wall-clock and ₹9-12 — meaning **a second re-run breaches the ₹15/claim cap**.

What to do about it:
- **Three near-term focus areas, ranked by leverage:** (1) **Insurer-grade harmoniser** — deterministic validation_metadata + claim_processing_metadata + audit_trail post-processors, strict Zod with cross-doc consistency, replace the truncated prompt exemplar with full Khatoon+Rajesh. (2) **Reliability hygiene** — reaper for pending rows, advisory lock on re-run, real reconciler for failed jobs. (3) **Itemised financials** — 7-group breakdown matching the reference, with deterministic reconciliation.
- **3-week effort to ship the harmoniser uplift; 1 week for reliability hygiene.** Both can run in parallel.

---

## 1. Current State — Pipeline Flow

### 1.1 The end-to-end picture

```
HTTP POST /api/v1/claims/:claimId/intelligence/analyze {force?, target_stage?}
  │
  ▼
intelligenceOrchestratorService.analyzeClaim (sync, returns 202)
  │
  ├─[1] SELECT ipd_doc rows for the claim
  │
  ├─[2] For each doc:
  │       !force AND sections exist → skip
  │       else → enqueueDocSegmentation(...)              ──► Bull 'doc-segmenter' (concurrency 2)
  │
  ├─[2b] If force=true:
  │       For every existing section:
  │         enqueueDocClassification(force=true)          ──► Bull 'doc-classifier' (concurrency 4)
  │         enqueueDocExtraction(force=true)              ──► Bull 'doc-extractor' (concurrency 4)
  │
  ├─[3] claimDossierService.rebuildFromEvents(claim)
  │
  ├─[4] AdjudicationEngine.run()
  │
  └─[5] enqueueClaimHarmonisation(claim, {force})         ──► Bull 'claim-harmoniser' (concurrency 2)


══════════════════════════════════ ASYNC ══════════════════════════════════

  doc-segmenter (attempts=3, exp@30s)
    │ 1. Idempotency on segmenter_version='v1'; skip if rows exist
    │ 2. OCR via pdf-parse OR Tesseract image fast-path
    │ 3. costAccounting.checkBudget → LlmBudgetExceededError if exceeded
    │ 4. LLM (Haiku 'cheap') with cacheKey=doc_segmenter:<docId>:v1
    │ 5. INSERT document_sections rows
    │ 6. Emit 'doc_segmented' event
    │ 7. For each section: enqueueClassifier(...)
    ▼

  doc-classifier (attempts=3, exp@5s)
    │ 1. status='corrected' → short-circuit (still cascade extractor)
    │ 2. !force AND classifier_version='v2' AND category → short-circuit
    │ 3. costAccounting.checkBudget
    │ 4. OCR slice (no vision branch)
    │ 5. Load candidates + KB hints + bundle context (sibling sections)
    │ 6. LLM.classify (Haiku→Sonnet escalation on conf<0.7)
    │ 7. UPDATE document_sections (category, classifier_version='v2')
    │ 8. Emit 'section_classified'
    │ 9. enqueueExtractor(...)
    ▼

  doc-extractor (attempts=3, exp@5s)
    │ 1. !force AND extractor_version='v1' AND extracted_fields → short-circuit
    │ 2. costAccounting.checkBudget
    │ 3. Load field_schema + category hint + extraction_mode
    │ 4. If no schema → stamp 'no_schema', exit
    │ 5. Branch on extraction_mode:
    │    'vision' → render pages to PNG → Sonnet vision
    │    'auto'   → OCR; if conf<0.35 AND alnum<50 → escalate to vision
    │    'ocr'    → Tesseract → Haiku→Sonnet
    │ 6. LLM.extract (dynamic Zod schema from field_schemas)
    │ 7. Drop zero-confidence sentinel fields
    │ 8. Run validators (Verhoeff, PIN, etc.) → down-weight conf
    │ 9. Merge LLM output ← human-corrected fields (preserve _corrected_fields)
    │ 10. UPDATE document_sections (extracted_fields, extractor_model)
    │ 11. Emit 'section_extracted'
    ▼

  claim-harmoniser (attempts=3, exp@60s)
    │ a. Load dossier + all sections
    │ b. Compute dossier_state_hash (sha256 over stable JSON of dossier + section_ids)
    │ c. !force AND hash matches AND status IN (fresh, corrected) → cache hit
    │ d. UPSERT row with status='pending'
    │ e. Budget check
    │ f. Load IPD seed facts
    │ g. LLM.extract (Sonnet premium, big prompt, big schema)
    │    on parse failure → retry with HarmonisedEpisodePartial
    │ h. buildProvenanceMap (coarse, category → top-level JSONPath)
    │ i. stitchSupportingDocuments(episode, sections):
    │    - supporting_documents.{category}[] = verbatim extracted_fields
    │    - Slot-promote into canonical paths if currently empty
    │      (aadhaar_number, pmjay_beneficiary_id, date_of_birth, pincode, ...)
    │ j. UPSERT row with status='fresh' | 'partial' | 'failed'
    │ k. Record cost
    │ l. Emit 'claim_harmonised'
    ▼
DONE
```

### 1.2 Per-stage contract summary

| Stage | Version | Input | Output | Idempotency | Force behaviour | LLM tier |
|---|---|---|---|---|---|---|
| Segmenter | `v1` | `ipd_doc.s3_key` | N×`document_sections` rows | Existing rows AT `segmenter_version='v1'` short-circuit | Force only re-enqueues; existing rows still short-circuit. **To genuinely re-segment, you must DELETE the section rows first** | Haiku (cheap) |
| Classifier | `v2` | Section row | `category`, `classification_confidence` | `classifier_version='v2' AND category NOT NULL` | Force bypasses version check. NEVER overrides `status='corrected'` | Haiku → Sonnet on conf<0.7 |
| Extractor | `v1` | Section + field_schema | `extracted_fields`, `extraction_confidence` | `extractor_version='v1' AND extracted_fields NOT NULL` | Force bypasses version check. Per-field human corrections (`_corrected_fields`) preserved across re-runs | Vision/`premium` for `extraction_mode='vision'`; else `standard` |
| Harmoniser | `v1` (`harmoniser.v1` / `medical_episode.v2`) | Dossier + all sections | One `claim_harmonised_episodes` row with the canonical episode | `dossier_state_hash + prompt_version + status IN (fresh, corrected)` | Force bypasses hash check | Sonnet (premium) |

### 1.3 Configuration surfaces (what an operator can change without a code release)

- `master_options(doc_category).code` — the category vocabulary
- `master_options(doc_category).description` — per-category extraction hint
- `master_options(doc_category).extraction_mode` — `'ocr' | 'vision' | 'auto'`
- `document_field_schemas` — what fields to pull per category
- `kb_patterns` (status='live', pattern_type='category_confusion') — classifier prompt hints
- `concept_aliases` — surface-form → canonical mapping (seeded, **not yet consumed at runtime**)

Version bumps are code releases: `SEGMENTER_VERSION`, `CLASSIFIER_VERSION`, `EXTRACTOR_VERSION`, `HARMONISER_VERSION`, all `*_PROMPT_VERSION`.

---

## 2. Reliability Posture

### 2.1 Failure modes — the ones that will bite

Curated from the SRE audit's full table of 21. These are the failure modes ranked by **likelihood × blast radius**:

| # | Failure mode | Where | Today's behaviour | Recovery | Mitigation |
|---|---|---|---|---|---|
| **1** | **Harmoniser `status='pending'` orphans on worker crash** | `harmonisation.service.ts:652` writes pending before LLM call at `:716` | Row sticks at `pending` forever. Future harmonise calls bypass cache because status not in `(fresh, corrected)` — but Bull dedup may still drop the retry | Manual SQL or force re-run | Reaper cron: `UPDATE claim_harmonised_episodes SET status='failed', error_message='timed_out' WHERE status='pending' AND generated_at < NOW() - INTERVAL '15 min'`. Better: wrap pending→success in a transaction |
| **2** | **Cost-cap race allowing per-claim overspend** | `costAccountingService.checkBudget` is non-locking SUM | 4 concurrent classifier jobs all read spend=14.5, all pass "allow", all spend ₹0.50 → claim ends ₹16.5 (₹1.50 over) | None | `llm_cost_reservations` table (debit on reserve, settle on log). Or PG advisory lock on `claim_id` for one-in-flight-LLM-per-claim |
| **3** | **Concurrent force re-run TOCTOU on `_corrected_fields`** | `docExtractor.service.ts:1001-1015` reads list, line ~1080 writes new state | Two clicks within 1s → two jobs both run. Human correction made between read and write of job #2 silently overwritten | None | `SELECT … FOR UPDATE` on section row, or move `_corrected_fields` merge into a JSONB SQL update. Plus: debounce FE button |
| **4** | **No reconciler for failed Bull jobs / Redis-down enqueues** | Every queue's `.add()` failure handler self-references "catch-up scheduler will retry" — **scheduler doesn't exist** | Lost jobs after Redis blip. Bull `failed/` set grows unbounded | Manual via `bull-board` / admin scripts | Build it. Periodic query: `sections WHERE (classifier_version != v2 OR extractor_version != v1) AND updated_at < NOW() - 10 min` → re-enqueue with `force=true` |
| **5** | **Cost-cap pre-flight burns 3 Bull retries deterministically** | `LlmBudgetExceededError` thrown on every retry; same input | All 3 attempts fail identically → noisy failed/ set | Manual cap raise | Custom error class with `noRetry: true` flag, or per-job `attempts: 1` override on the budget path |
| **6** | **Anthropic 429 not honoured** | `claudeClient.ts:331-343` rethrows bare | 30s base backoff is too tight for sustained rate limiting; cascading retries make the rate-limit worse | Bull retry × 3, often all fail | Detect 429 → parse `Retry-After` → schedule next attempt accordingly. Add provider-wide concurrency cap (~8 concurrent calls org-wide) |
| **7** | **Tesseract / Sharp OOM on pathological scans** | `ocr.service.ts` per-rotation try/catch swallows; baseline OOM kills worker | Worker process death; Bull moves to `stalled`; container supervisor restarts; possible cascade on poison-pill input | Auto via container restart, but risk of crashloop | Pre-check: `buffer.length > 50MB` → degrade; `setTimeout` wrap around Tesseract calls; isolate OCR in separate worker pod |
| **8** | **LLM hallucinated values with high `per_field_confidence`** | All extract calls; only Aadhaar/PIN have validators | Persisted silently. Caught only by human correction (`status='corrected'`) | None automatic | Expand `extractedFieldValidators.ts` with cross-field invariants per category. Add LLM-as-judge spot-check (sample 1%) into eval harness |
| **9** | **Classifier never uses LRU** | `docClassifier.service.ts:320-322` self-admits | Every classify is a fresh provider call. Idempotent retries pay full cost | None automatic | Add `cacheKey = sha256(sectionText + classifier_version)` to classify; route LRU through `claudeClient.ts:classify()` (currently extract-only) |
| **10** | **No per-claim/per-hospital trace ID** | Nowhere | Slow incident response when a claim "is stuck" | Manual log grep | Add `correlation_id` string on every queue payload; thread through orchestrator → enqueue → worker → DB → events |

### 2.2 Performance / cost profile (typical PMJAY claim, 7 docs, ~15 sections)

| Stage | Per-call cost (₹) | Wall-clock | Total per claim |
|---|---|---|---|
| OCR (pdf-parse + Tesseract) | ~₹0 (CPU only) | typed PDF <1s/doc; scanned ~2-4s/page | ~35s (half scanned) |
| Segmenter (Haiku, ~1.5k in / 500 out) | ~₹0.10-0.50/doc (cached vs not) | 1-3s/doc, parallel-2 | **5-7s, ₹0.50-1.50** |
| Classifier (Haiku, 30% Sonnet escalation) | ~₹0.05 Haiku, ~₹0.50 Sonnet | 1-2s Haiku, 3-5s Sonnet, parallel-4 | **₹2.80, 6-10s** |
| Extractor (10 OCR Haiku + 4 OCR Sonnet + 1 vision) | OCR ₹0.10-0.60, vision ~₹1.50 | 2-4s OCR, 8-15s vision | **₹5-7, 15-25s** |
| Harmoniser (Sonnet premium) | ~₹1.00-1.50 first run; ~₹0 cache-hit | 6-10s | **₹1.00-1.50, 8s** |

**End-to-end wall clock:** ~50-60s on a clean run (classify+extract pipeline per-section).
**Total cost:** **₹9-12** — uncomfortably close to the ₹15/claim hard cap. **One force re-run breaches the cap**, and the second re-run would be blocked mid-flight at a non-deterministic stage.

**Anthropic prompt cache:** working on system blocks (1st-call miss, subsequent hits within 5min window). Classifier never uses the LLM-bridge LRU at all (see failure #9). User-prompt content is never cached — extractor field schemas would benefit from a cached second block.

### 2.3 What's NOT measured

| What | Why it matters |
|---|---|
| Per-stage success rate over time | Quality regressions invisible |
| Per-category extraction yield | "Did we improve X category's accuracy after the v3 prompt?" — unanswerable |
| Vision-vs-OCR accuracy A/B | We're paying 10× for vision; is it worth it per category? |
| Time-to-first-result (upload → harmonised) | The number that matters most to ops; not tracked |
| Anthropic prompt cache hit ratio | Cost optimisation target invisible |
| Bull queue depth, stalled job count | Operational health invisible |
| `status='pending'` harmoniser rows older than N min | Orphan accumulation invisible (and we know they accumulate) |

---

## 3. Insurer-Grade Output — The Brutal Truth

This is the section the user flagged as not OK. The schema-gap analyst's full deliverable is comprehensive; the headline points:

### 3.1 Population density: ~25% vs reference's ~90%

The canonical schema has ~280 leaves. Our prompt instructs the model to consider 11 top-level nodes; its abbreviated Khatoon exemplar shows ~50 populated leaves AND tells the model to "OMIT what you don't have". Net: a typical output populates **50-80 leaves (20-30%)**. The Khatoon reference populates ~250/280 (**~90%**).

### 3.2 The schema is effectively unenforced

Self-admitted in `harmonisedEpisode.ts:8-41`: every top-level section is `.partial()` and nested sub-structures fall through `z.record(z.unknown())`. Concretely:

- **No ISO date pattern enforcement** — comment at L52: "the LLM emits `'2025-12-31 14:30'` and `'31-Dec-2025'` so we accept any string"
- **No enum enforcement** — `episode_type`, `phase_code`, `location`, `gender`, `discharge_type`, `admission_type`, `disposition` are all `z.string()`. Canonical spec lists 8-12 valid values per enum
- **No Aadhaar regex** (`^[0-9]{12}$`), no **PAN regex** — both required by canonical
- **No required-field enforcement on nested objects**
- **Zero cross-document consistency checks** — nothing validates `discharge_datetime >= admission_datetime`, nothing checks Aadhaar name matches across docs, nothing reconciles `actual_total_cost` against `sum(breakdown.*)`

### 3.3 Four critical-severity blocks never populated

The gap matrix flags these as **CRITICAL**:

| Block | What's missing | Why critical |
|---|---|---|
| **`validation_metadata.underwriting_flags`** | All 12 booleans (`implant_cost_exceeds_limit`, `prolonged_hospitalization`, `pre_existing_condition_suspected`, etc.) | This block IS what makes the artifact actionable to an insurer. Without flags the claim must be re-scored manually |
| **`validation_metadata.document_checklist`** | Per-document `{available, quality_score, missing_reason}` array | An insurer cannot know what's missing without this. We *have* the data in `document_sections` — we just don't project it |
| **`validation_metadata.clinical_validation`** + **`policy_validation`** | 11 booleans across both (`diagnosis_procedure_match`, `los_justified`, `room_rent_eligible`, `sublimit_breached`, etc.) | These are *computed* fields. They don't need an LLM call — they're deterministic from the rest of the JSON. We just don't compute them |
| **`claim_processing_metadata`** | `claim_readiness_status: RED/YELLOW/GREEN`, `risk_score: 0..1`, `queries_raised[]`, `deduction_analysis[]` | The traffic-light + risk score are the headline primitives every downstream consumer expects. Today they live (partially) elsewhere in the system instead of inside the artifact |

### 3.4 Critical structural gaps within nodes that ARE populated

- **`clinical_timeline` phases** — Every sub-object (`presentation`, `admission_details`, `clinical_assessment`, `outcome`, `daily_progress`, `diagnostics_performed[].results.structured_results[]`) is `z.record(z.unknown())`. Khatoon's `presentation.chief_complaints[]` has severity enums; Rajesh's `daily_progress[]` has vitals per day; both ship per-parameter lab values with reference ranges. Ours typically ships unstructured summary text
- **`financial_summary.breakdown`** — Reference carves into ~40 distinct numeric leaves across 7 sub-groups (room/professional/investigation/pharmacy/procedure/implant/consumables/other). Ours is `z.record(z.unknown())` — the LLM can emit `{total: 125000}` and pass. **This is the #1 deduction-driver** for insurers and the single most-detailed reference section
- **`procedures_performed.implants_used / .anaesthesia / .operative_findings`** — Khatoon ships 3 implants with manufacturer/size/quantity/sticker_available + full anaesthesia block + operative_findings text. Ours: all `.optional()`, sub-array as `z.record(z.unknown())`
- **`diagnosis.pre_existing_diseases[].declaration_status`** — `DECLARED/NOT_DECLARED/SUSPECTED_UNDECLARED`. This is precisely the underwriting hook insurers want. We never produce it
- **`stay_summary.los_benchmark`** — `{expected_los, actual_los, variance, justification_required, justification}`. We don't feed any benchmark table to the prompt. LOS variance is the #2 deduction-driver
- **`hospital_context.accreditation`** — Schema accepts `z.record(z.unknown())`. PSU insurers and PMJAY won't pay non-NABH hospitals at NABH rates — they need a verifiable cert number + validity date. Today we wouldn't even know if `nabh: true` came from a real cert or LLM inference

### 3.5 Provenance is too coarse to defend

`buildProvenanceMap` maps **category → top-level JSONPath**. So every leaf inside `$.discharge_summary` shares one section_id. An insurer asking "where did `discharge_summary.discharge_medications[2].dose` come from?" gets the same answer as for `discharge_summary.discharge_date` — useless for field-level dispute. Documented as "intentionally coarse for v1".

### 3.6 Concrete insurer-rejection list (today)

If our current output were submitted to a PSU insurer or PMJAY today, these are the queries the auto-system would raise:

1. *Provide per-day progress notes for ICU stay* — `clinical_timeline[phase=ICU].daily_progress[]` empty
2. *Provide implant stickers and serial numbers* — `procedures_performed[].implants_used[].serial_number/batch_number/sticker_available` missing
3. *Provide operative findings text* — `procedures_performed[].operative_findings` missing
4. *Confirm NABH/NABL accreditation status and certificate* — `accreditation.nabh_certificate_number/nabh_valid_till` missing
5. *Provide anaesthetist name and registration* — `anesthesia.anesthetist` missing/placeholder
6. *Justify length of stay vs benchmark* — `los_benchmark` missing
7. *Itemize implant invoice* — `financial_summary.breakdown.implant_charges.item_details[]` missing
8. *Justify room category for sum-insured tier* — `room_eligibility.eligible_room_type` empty, can't compare against `clinical_timeline[phase].room_category`
9. *Provide PED declaration status* — `diagnosis.pre_existing_diseases[].declaration_status` empty
10. *Provide structured lab values with reference ranges* — `diagnostics_performed[].results.structured_results[]` typically empty
11. *Confirm surgeon's MCI/SMC registration* — `treating_team.surgeons[].registration_number/registration_council` missing for many sections
12. *Reconcile final bill total with itemised charges* — no cross-check between `actual_total_cost` and `sum(breakdown.*)`
13. *Provide pre-auth approval letter reference* — `insurance_context.pre_authorization.pa_number/pa_approval_date` missing

Each maps 1:1 to a sub-block the reference samples populate.

---

## 4. Recommended Roadmap

Ranked by leverage. All effort estimates assume one senior engineer.

### Phase A — Insurer-grade harmoniser (3 weeks, biggest leverage)

**A1. Deterministic post-processors for `validation_metadata` + `claim_processing_metadata` (5 days)**
After the LLM call, before persistence (insert beside `stitchSupportingDocuments` at `harmonisation.service.ts:766`), compute:
- 12 `underwriting_flags` from `financial_summary` + `stay_summary` + `clinical_timeline` (e.g. `prolonged_hospitalization = total_los.value > episode_specific_benchmark`)
- `document_checklist` from `hospital.document_sections` (already in DB)
- `clinical_validation` booleans (`diagnosis_procedure_match` via ICD↔CPT lookup, `los_justified` from benchmark, etc.)
- `policy_validation` booleans (`room_rent_eligible` from policy + actual room, `sublimit_breached` from breakdown vs sublimits)
- `claim_readiness_status: RED/YELLOW/GREEN` from flag count + critical-flag check
- `risk_score: 0..1` from flag-weighted formula

New file: `Services/harmonisation.validations.ts`. No LLM call needed — pure code over the existing JSON. **This single change moves us from "clinical summary" to "insurer artifact".**

**A2. Strict-mode Zod schema with cross-doc consistency, behind a feature flag (2 days)**
Add `HarmonisedEpisodeStrict` alongside the lenient one:
- Enforce ISO date regex, all enums, Aadhaar/PAN regex
- `.refine()`: `discharge_datetime >= admission_datetime`, `total_los === days_between(discharge, admission)`, `episode_type='SURGICAL' ⇒ ≥1 phase with phase_code='INTRA_OPERATIVE'`, patient name matches across `patient_context` and `supporting_documents.aadhaar_front`

Run strict in parallel — log failures to new `harmonisation_schema_failures` table — keep using lenient for persistence until strict pass-rate > 80%. **Gives us data on the gap; once strict passes consistently, flip it.**

**A3. Re-architect prompt with full reference exemplars (1 day + cost re-validation)**
Current exemplar is the *abbreviated* Khatoon. Replace with the *full* Khatoon AND full Rajesh — give the model two anchor examples spanning SURGICAL and MEDICAL_MANAGEMENT. System prompt grows from ~3k → ~10k tokens; cached after first call. Explicit instructions to populate `daily_progress[]` per day, `structured_results[]` per lab parameter, all 12 `underwriting_flags`.

Expected lift: canonical density from ~25% to ~60-70% on first pass.

**A4. Itemised financial breakdown + reconciliation (4 days)**
Define strict Zod sub-schema for `financial_summary.breakdown` matching the 7-group / ~40-leaf carve-out. After the LLM emits, deterministically compute `actual_total_cost = sum(all_leaves)` and flag variance > 1% into `underwriting_flags`. Removes the #1 deduction query.

**A5. Per-leaf provenance (3 days)**
Ask the LLM in a second small call (or sibling JSON in the same call) to emit a sparse provenance map keyed by JSONPath: `{ "$.diagnosis.primary_diagnosis.icd_code": {section_id, page, evidence_text}, ... }`. Persist in the existing `provenance` JSONB column.

**Phase A total: ~15 working days. Result: insurer-grade artifact.**

### Phase B — Reliability hygiene (1 week, in parallel with A)

**B1. Pending-row reaper cron (½ day)**
```sql
UPDATE claim_harmonised_episodes
   SET status='failed', error_message='timed_out'
 WHERE status='pending'
   AND generated_at < NOW() - INTERVAL '15 minutes'
```
Runs every 5 min.

**B2. Per-claim advisory lock on LLM operations (1 day)**
Wrap `extractSection` and `harmonise` in `pg_advisory_xact_lock(hashtext(claim_id))`. One LLM call per claim in flight at a time. Fixes the cost-cap race AND the concurrent re-run TOCTOU.

**B3. Real reconciler (2 days)**
Periodic cron:
```sql
-- Sections that should have been classified but weren't
SELECT id FROM document_sections
 WHERE (classifier_version IS DISTINCT FROM 'v2' OR category IS NULL)
   AND updated_at < NOW() - INTERVAL '10 minutes';
-- Same for extractor_version
```
Re-enqueue with `force=false` (let normal idempotency handle dups).

**B4. Cost-cap error class with no-retry semantics (½ day)**
`LlmBudgetExceededError extends Error { noRetry: true }`. Worker job processor checks the flag and calls `job.discard()` instead of letting Bull retry.

**B5. 429 + Retry-After honouring (1 day)**
Detect Anthropic 429, parse Retry-After, reschedule the Bull job with that delay. Add `p-limit`-style semaphore: org-wide cap at 8 concurrent Anthropic calls.

**B6. Correlation IDs (1 day)**
Add `correlation_id` to every Bull job payload. Thread through orchestrator → enqueue → worker → DB writes → event payloads. Pino logger picks it up via context propagation.

**Phase B total: ~7 working days. Result: production-grade reliability.**

### Phase C — Observability (3-4 days)

**C1. Per-stage success-rate metrics** — counter per (stage, outcome, hospital). Export to Prometheus or write to a new `pipeline_metrics` table polled by a dashboard.

**C2. Time-to-first-result histogram** — `pipeline_started_at` (= `upload_completed_at`) → `claim_harmonised` event timestamp.

**C3. Per-category extraction yield** — `% of <category> sections where ≥1 required field is non-null`.

**C4. Vision-vs-OCR A/B harness** — for `extraction_mode='auto'` sections, occasionally run BOTH paths and compare. Store winner. Feeds Phase D's cost-quality tradeoff.

**C5. Bull queue depth + stalled-job alerts** — `bull-board` integration or direct Redis polling.

### Phase D — Cost optimisation (1-2 weeks, after A+B+C)

**D1. Classifier LRU integration** — wire `cacheKey = sha256(sectionText + classifier_version)` through `claudeClient.classify`. Idempotent retries pay ₹0 instead of full cost.

**D2. Extractor user-prompt caching** — split the per-call user prompt into a `documents[]` cached block (field schemas + category hint, ~stable per category) and a fresh block (the section text). Anthropic caches up to 4 blocks.

**D3. Per-section OCR cache reuse** — today classifier and extractor each re-slice + re-OCR the same section bytes. Add a `section_ocr_cache` table keyed by `(section_id, ocr_engine_version)` so the extractor reads the classifier's OCR result.

**D4. Parallel page OCR** — Tesseract per-page is currently serial inside `runPdfParse`. Promise.all-ifying with a small concurrency cap (4) would cut OCR wall-clock by ~3-5× on long discharge summaries.

**Expected outcome of Phase D**: total cost per claim drops from ₹9-12 → ₹4-6, raising headroom under the ₹15 cap. Wall-clock 50-60s → 25-35s.

### Phase E — Bundle classifier (Wave 12, already designed)

Reference: `docs/proposals/WAVE_12_BUNDLE_CLASSIFIER.md`. Replaces the segmenter + per-section classifier chain with a single Sonnet call that processes the whole PDF and emits the full taxonomy. Should follow A+B+C.

---

## 5. Honest Limitations

What this review couldn't fully verify:

1. **Postgres pool sizing** — depends on `DB/db.js`, not audited here. With ~12 worker concurrency + API handlers, pool must be ≥ 20. Worth checking.
2. **`evalHarness` scoring of production vs ground-truth** — service exists but wasn't audited in this pass. Could be doing more than we credit.
3. **The reconciler genuinely doesn't exist anywhere** — every queue file's `.add()` failure handler self-references one, but we couldn't find any reconciler code. This is the single biggest reliability gap.
4. **Real measured Anthropic prompt cache hit rate** — `tokens_input_cached` is logged per call but never aggregated. Need a dashboard to see.
5. **Schema-gap-analysis population density estimate** is reconstructed from the schema + prompt; couldn't fetch a live harmonised JSON via DB in the agent run. The structural gaps stand regardless of the precise percentage.

---

## 6. Closing — Recommended Sequencing

**Weeks 1-2:** Ship Phase A1 (validation_metadata + claim_processing_metadata post-processors) and Phase B (reliability hygiene) in parallel. Two engineers, no conflicts. End state: insurer artifact ships with the four critical missing blocks; pipeline stops losing work to crashes.

**Week 3:** Ship Phase A3 (full reference exemplars in prompt) + A4 (financial breakdown). Re-run on all existing claims with `force=true` to backfill the new shape. Population density should jump from ~25% to ~60%.

**Weeks 4-5:** Phase A2 (strict schema feature flag) + A5 (per-leaf provenance) + C (observability). End state: we now have data on remaining gaps and can iterate the prompt + validators against measured failures.

**Weeks 6-7:** Phase D (cost + perf). Cost per claim cut roughly in half.

**Week 8+:** Phase E (bundle classifier) once Phase A has stabilised.

The user said "biggest of insurance companies should rely on us for this data." That bar is achievable from where we are, but requires Phase A done end-to-end. Phase A1 alone moves the artifact from "clinical narrative" to "actionable insurance document".
