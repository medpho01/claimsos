# Wave 12 — Bundle Classifier (design proposal)

**Status:** Proposed
**Author:** Wave 9 follow-up
**Targets:** classifier accuracy on multi-document PDFs (the dominant input shape in Indian hospital claims)

---

## Problem statement

Indian hospitals routinely scan multiple distinct documents into a single PDF — e.g., one upload may contain:

```
p.1  OPD prescription
p.2-3 Surgery consent form
p.4   Continuation of consent form
p.5   Discharge summary
```

The current Wave 2 pipeline handles this in two stages:

1. **docSegmenter** (`Services/docSegmenter.service.ts`) — LLM-driven layout splitter. Reads the full OCR'd text and outputs `{page_start, page_end}` boundaries.
2. **docClassifier** (`Services/docClassifier.service.ts`) — runs ONCE per section produced above. Receives only the slice's OCR'd text and an isolated category list; picks one code.

This works for single-document PDFs but degrades on bundles in three ways:

| Symptom | Root cause |
|---|---|
| Categories drift on confusable pairs (consent ↔ OT notes, OPD ↔ admission notes) | Classifier sees the slice in isolation, can't use neighbouring documents to disambiguate. |
| Disagreement between segmenter and classifier (segmenter splits "X then Y" → classifier calls both "X") | Two independent decisions over the same evidence. |
| Per-call latency × N sections | Each section pays a full segmenter→OCR→classify chain. For a 10-doc bundle that's ~10 classifier calls. |

Wave 9 added two mitigations that materially help but don't close the gap:

- **Fix A** — preview iframe jumps to the section's page range so reviewers can actually verify what was classified.
- **Fix B** — sibling-aware classifier prompt: each `classify` call now sees the categories of OTHER sections of the same parent doc, plus a system-prompt directive about bundle reasoning. `CLASSIFIER_VERSION` bumped to `v2`.

These help. They don't fix the fundamental architecture: the segmenter and classifier are still independent calls, and each classifier call is still seeing its slice in isolation against a system prompt cached across millions of unrelated sections.

Wave 12 proposes a single end-to-end **bundle classifier** that replaces the segmenter + per-section classifier chain with one Sonnet call that processes the entire PDF and emits the full taxonomy at once.

---

## Architecture

```
                  ┌──────────────────────────────────────────┐
                  │       Wave 2 pipeline (current)          │
                  ├──────────────────────────────────────────┤
PDF → OCR → docSegmenter (Sonnet) → [N section rows] →
            └───────────────────┘
                                   for each section:
                                     OCR slice → docClassifier (Haiku→Sonnet escalation)

                  ┌──────────────────────────────────────────┐
                  │       Wave 12 pipeline (proposed)        │
                  ├──────────────────────────────────────────┤
PDF → OCR (whole) → docBundleClassifier (single Sonnet call) → [N section rows ALREADY classified]
                    └──────────────────────────┘
```

### New service: `Services/docBundleClassifier.service.ts`

Input:
- `claim_id`, `hospital_id`, `document_id`
- full OCR text of the PDF, with page-number markers inline (e.g. `\n--- PAGE 5 ---\n`)
- candidate category list (same source as today: `master_options(category='doc_category')`)
- KB hints (same source: `kbHints.service.ts`)
- (optional) prior corrections on THIS document, for re-runs

Output (one LLM call, JSON):

```json
{
  "sections": [
    {
      "page_start": 1,
      "page_end": 1,
      "category": "opd_prescription",
      "confidence": 0.95,
      "reasoning": "Letterhead reads 'OPD Slip', includes outpatient diagnosis with no admission notes."
    },
    {
      "page_start": 2,
      "page_end": 3,
      "category": "surgery_consent_form",
      "confidence": 0.92,
      "reasoning": "..."
    },
    ...
  ]
}
```

### Prompt structure

System prompt (cached, stable across all calls):
- Persona/task framing (re-uses the v2 system prompt's bundle reasoning section)
- Closed list of categories (rendered at runtime from master_options)
- Output schema spec

User prompt (per-call):
- OCR'd full text with page markers
- KB hints block (same shape as the per-section classifier)
- Hint about parent page count
- (Optional) override block: "These sections were previously corrected by humans — preserve their categories"

### Persistence

Replaces both `docSegmenter` and `docClassifier` writes:

1. Create N rows in `hospital.document_sections` in one transaction, each carrying:
   - `category`, `classification_confidence`, `classifier_provider='claude'`, `classifier_model='bundle:v1'`, `classifier_version='v2-bundle'`
   - `status='auto'`
   - `extracted_fields=null` (extractor pipeline downstream is unchanged)
2. Emit `section_classified` events identical to today's so the dossier projector, correction stream, and downstream queues require zero changes.

### Idempotency

- Key: `(document_id, classifier_version)`. If a document has been processed by `v2-bundle` already, the worker short-circuits — same idempotency pattern as today.
- Re-running with a bumped version causes the worker to enqueue a re-process. Existing sections are NOT deleted; instead the new run produces fresh section rows and the old rows are soft-deleted (`status='superseded'`) so audit trail survives.

---

## Cost / latency analysis

**Today** (per bundle, 5 docs, ~12 pages):
- 1× segmenter (Sonnet, ~3k input, ~500 output) ≈ ₹0.18
- 5× classifier (Haiku for ~70%, Sonnet escalation for 30%) ≈ 5 × ~₹0.06 = ₹0.30
- 5× OCR slice (already cached) — negligible
- **Total ≈ ₹0.48 per bundle, p95 latency ~22s**

**Proposed** (per bundle):
- 1× bundle classifier (Sonnet, ~5k input, ~1k output) ≈ ₹0.40
- **Total ≈ ₹0.40 per bundle, p95 latency ~8s (single call, no escalation chain)**

Wins:
- 65% latency reduction (no per-section round-trip)
- 17% cost reduction at typical N=5
- Accuracy lift expected on confusable pairs (no quantitative baseline yet — we'll measure with the eval harness, see below)

Risks:
- Context window for very long PDFs (>30 pages of dense scan-OCR) — Sonnet 4.5 handles 200k tokens, well within budget, but multi-language OCR can balloon to 2-3× English. Fall back to per-section path when the prompt would exceed 50k tokens.
- Single call = single point of failure. Today's per-section path can succeed on 4 of 5 sections; bundle approach either fully succeeds or fully fails. Mitigated by: (a) the bundle prompt asks for ALL sections, missing pages are flagged as a quality issue not retried, (b) on parse error / partial output, fall back to per-section v2 path.

---

## Evaluation plan

Before flipping the worker to call `docBundleClassifier`:

1. **Build an eval set.** 50 multi-document PDFs from past closed claims, each with the human-corrected categories as ground truth. Sample bias toward bundles (≥3 sections).
2. **Dual-classify.** Run BOTH pipelines on the eval set in shadow mode (the bundle classifier writes to a `bundle_eval_runs` table; the production per-section path stays authoritative).
3. **Metrics:**
   - Section-level accuracy (correct category / total sections)
   - Bundle-level accuracy (ALL sections correct in the bundle / total bundles)
   - Per-confusion-pair lift: e.g. consent vs OT-notes accuracy with bundle context vs without
   - Cost per bundle, p50/p95 latency
4. **Promotion gate:** ship `docBundleClassifier` as primary only when:
   - Section accuracy ≥ Wave 2 + 5pp absolute
   - Bundle accuracy ≥ Wave 2 + 10pp absolute
   - p95 latency within 2× of Wave 2 (we'd be SHRINKING latency in expectation, so this is a safety net)
   - No degradation on single-document PDFs (must be at least as good as v2 per-section)

---

## Migration plan

Phase 1 (Wave 12.0) — **service + shadow mode** (~2 days)
- New `docBundleClassifier.service.ts`
- New worker job kind `bundle_classify` that runs OFF-PATH on every uploaded PDF, writing to `bundle_eval_runs(document_id, sections_json, cost_inr, generated_at)`
- No effect on production classification

Phase 2 (Wave 12.1) — **eval + gate** (~1 day)
- Eval harness reads `bundle_eval_runs` + `document_section_corrections` to compute the metrics above
- Surface results on the existing `/superadmin/eval` page

Phase 3 (Wave 12.2) — **flip-the-switch** (~½ day, gated on Phase 2 metrics)
- Replace the segmenter queue with the bundle classifier queue
- Keep the per-section path as a fallback for context-window overflow
- Update `intelligenceStatus` to reflect the new pipeline stages

Phase 4 (Wave 12.3) — **cleanup** (~½ day, after a month of stability)
- Retire `docSegmenter.service.ts` and the per-section `docClassifier` LLM call (the persistVerdict path is preserved — it's still used by corrections + future re-runs)

---

## Open questions

1. **Vision input?** Today the classifier is text-only. For very short / image-heavy bundles (e.g. all photos with stamps), passing rendered page thumbnails to Sonnet vision could lift accuracy further. Out of scope for Wave 12.0 but worth a Wave 13 exploration.

2. **Correction propagation.** When a reviewer fixes one section's category in a bundle, should we automatically re-run the bundle classifier on the OTHER sections with that fix as a constraint? Argument for: bundle layout is correlated (a consent form between two consents is consents). Argument against: re-running costs money. Recommend punting to Wave 13 once we have baseline accuracy numbers.

3. **Streaming output.** Sonnet supports incremental JSON streaming. For a 10-section bundle the reviewer could see classifications appear page-by-page rather than waiting for the whole call. Nice-to-have, not Wave 12.0 blocking.

---

## File-by-file impact

| File | Change |
|---|---|
| `Backend/src/Services/docBundleClassifier.service.ts` | NEW — the bundle classifier itself |
| `Backend/src/Services/llm/prompts/docBundleClassifier.v1.ts` | NEW — prompt module (same conventions as `docClassifier.v1.ts`) |
| `Backend/src/Services/llm/schemas/bundleClassifierOutput.ts` | NEW — Zod schema for the multi-section output |
| `Backend/src/Workers/docBundleClassifier.queue.ts` | NEW — Bull queue + worker |
| `Backend/src/schema/migrations/048_bundle_eval_runs.sql` | NEW — shadow-mode eval table |
| `Backend/src/Controllers/intelligenceStatus.controller.ts` | UPDATE — new pipeline stage |
| `Backend/src/Services/docSegmenter.service.ts` | UNCHANGED in Phase 1; retired in Phase 4 |
| `Backend/src/Services/docClassifier.service.ts` | UNCHANGED in Phase 1; demoted to fallback in Phase 3 |
| `webapp/src/pages/superadmin/EvalDashboard/...` | UPDATE — surface bundle eval metrics |

No frontend-visible changes in Phase 1.
No DB migrations on `document_sections` — the existing schema already carries everything the bundle classifier needs.

---

## Decision needed before starting

- [ ] Approve shadow-mode rollout (Phase 1) — no production risk, ~2 days of work, gives us real measurements before we touch the prod path.
- [ ] Confirm cost ceiling: bundle classifier expected at ~₹0.40/PDF. Hard cap stays at ₹15/claim (claim-level meter), so even a 30-doc claim with re-runs sits comfortably under budget.
- [ ] Confirm eval set sourcing: 50 closed claims is enough for the initial gate; we'd want ~300 for a stable accuracy estimate, but that's a Wave 13 concern.
