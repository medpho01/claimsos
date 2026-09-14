# Document Extraction — Landscape/Wide-Table Failure: Root Cause, Proof, and Code Plan

**Date:** 2026-09-13
**Context:** Extraction accuracy is the gating quality problem for the next phase (AI-applied adjudication). Adjudication can only be as correct as the extracted itemised data. Landscape/wide documents (final bills, itemised pharmacy bills, multi-column lab reports) extract poorly today. This doc root-causes it, proves the fix empirically, and specifies the code changes.

**Companion:** [`E2E_ARCHITECTURE.md`](./E2E_ARCHITECTURE.md) (§3 AI pipeline).

---

## 1. TL;DR

- The pipeline is **OCR-first and schema-bounded**, and where it does use vision it sends **one downscaled image per page with no tiling**. Anthropic downsizes any image whose long edge >1568px to ~1.15MP, so a wide multi-column bill collapses to ≤1568px wide and per-cell text becomes sub-pixel.
- On a realistically-degraded wide scan, single-image Claude Vision scored **80–97% (unstable)**, and — critically — **its errors concentrate in the money and date columns** (payable amounts row-shifted onto the wrong line item; `2026`→`2028`). That is unusable for adjudication: wrong figures, silently.
- **Tiling the same source into high-res overlapping horizontal slices scored a flat 99.5% across every trial.** Clean/full-res single images score 97–99%.
- **Fix:** for wide/landscape pages, render at higher DPI and send **overlapping tiles** (plus a downscaled full-page overview for global fields), route bill/table categories to **vision-first**, and extend the extractor to capture the **full itemised line-item table**, not just schema fields.

## 2. How extraction works today (and why it fails on landscape)

Path for a claim document (`Backend/src/Services/…`):

1. `ocr.service.ts` — PDF pages rendered at fixed `viewportScale:2.0` (`:1226`), Tesseract OCR; rotation salvage for 90° multiples via OSD + brute-force sweep.
2. `docBundleClassifier.service.ts` — **text-only**, classifies sections from OCR text.
3. `docExtractor.service.ts` — builds a Zod schema from `document_field_schemas` and extracts **fixed fields**; `extraction_mode` ∈ ocr/vision/auto per category; vision attaches page PNGs (`viewportScale:2.0`, ≤8 pages, downscale to ≤2048px if >4MB) — **single image per page, no tiling** (`:1226-1315`).
4. `harmonisation.service.ts` — text-only merge into the canonical episode.

**Six compounding causes** (all cited in code):

1. **Fixed `viewportScale:2.0`, orientation-blind**, at every rasterization point (`ocr.service.ts:1229`, `docExtractor.service.ts:1256`, `pipelineV2/readBridge.ts:110,136`). No landscape detection bumps DPI for wide pages.
2. **Upscale gated on WIDTH only** (`ocr.service.ts:1108`: `origWidth<1500`). A landscape page's long edge is already >1500, so it is **never upscaled**, though its *rows* are what's under-resolved.
3. **Rotation only corrects 90° multiples** (OSD returns {0,90,180,270}; sweep is [90,180,270]). No small-angle **deskew** — so a photographed bill with a 1–2° tilt keeps its skew, which drifts the far-right columns off their rows (see the proof image).
4. **Vision sends the whole wide page as ONE downsized image — no tiling/column-splitting** anywhere (`docExtractor.service.ts:1242,1265`, `ocr.service.ts:905`, `pipelineV2/pageReader.service.ts:121`). Anthropic further downsizes >1568px long edge to ~1.15MP. **This is the single biggest lever.**
5. **The PDF OCR path has NO real vision fallback** — `ocr.service.ts:559-567` only stamps a `vision_fallback_eligible` warning. A wide table inside a multi-page PDF (the common bundle case) gets Tesseract-only garbled text unless its category is separately flagged vision.
6. **Extraction is schema-bounded** — `document_field_schemas` captures fixed fields, not an arbitrary-length line-item array. The **full itemised data** an adjudicator needs (every bill line, every deduction) is not a first-class output. OCR text is also truncated at 24,000 chars (`docExtractor.service.ts:116`), clipping long wide-table dumps.

Net: rotated *portrait* scans are well-handled; *landscape/wide* documents fall through every mechanism.

## 3. Empirical proof

**Method:** generated a dense landscape itemised final bill (18 line items × 11 columns, 3400×1400) with **known ground truth**, degraded it into a realistic phone-scan (1° skew + blur + JPEG q50, kept high-res), then extracted with `claude-sonnet-4-5` (the model the app uses) three ways and scored **196 fields** (11 header + 18×10 cells + 5 totals) exactly against ground truth. Harness: `scratchpad/extract-proof/` (`gen-bill.mjs`, `prod-vision-proof.cjs`).

| Strategy | Trial 1 | Trial 2 | Trial 3 | Notes |
|---|---|---|---|---|
| Clean full-res, single image | 100% | — | — | Pristine text — even Tesseract→text hits 100% here. Not the failure mode. |
| Realistic scan, **single downscaled image** *(today)* | 89.3% | 96.9% | 80.1% | **Errors in `payable` & `date` columns**: amounts row-shifted onto wrong line items; `2026`→`2028`. |
| Realistic scan, **high-res overlapping tiles** *(fix)* | 99.5% | 99.5% | 99.5% | Flat, reproducible. Only a single global field (`bill_no`) occasionally missed. |

**The failure is visual and systematic** (see `degraded.jpg`): a 1° skew over a wide page drifts the rightmost `Payable` column *down by more than one row*, so the model associates each amount with the wrong line item. At downscaled resolution it cannot realign. Tiling narrows the horizontal span (less drift) and roughly doubles per-cell resolution, so rows realign — a flat 99.5%.

**Why this matters for adjudication:** an 80–97% that is wrong *specifically on payable amounts and dates* is worse than a visible failure — it produces confident, wrong figures. Adjudication built on that is unsafe. Tiling converts it to a reliable ~99.5%.

## 4. The fix — concrete code plan

Target the single seam (`Services/llm/` + `ocr.service.ts` + `docExtractor.service.ts`), keep it behind flags, validate on the harness + real prod docs before defaulting on.

### 4.1 Landscape-aware, high-resolution tiling (the core change)
- **New util `Services/extractor/imageTiler.ts`:**
  - Detect wide pages (`width/height > LANDSCAPE_ASPECT` e.g. 1.3, or width > `TILE_TRIGGER_PX` e.g. 1600).
  - Render/keep the source at **high DPI** (raise `viewportScale` to 3.0–4.0 for wide pages instead of the fixed 2.0; or size to a target long-edge of ~4000px).
  - Emit **N overlapping horizontal tiles** (start N=2 at ~58% width each, ~16% overlap; go to 3 for very wide/dense pages) each ≤1568px long edge so the API does **not** downscale them.
  - Also emit one **downscaled full-page overview** tile for global/header fields (fixes the occasional `bill_no` miss and gives the model document context).
- **Wire into vision attachment builders:** replace the single-image attach in `docExtractor.buildVisionAttachments` (`:1226-1265`) and `pipelineV2/pageReader.readPage` with `imageTiler.tile(page)` when the page is wide; keep single-image for portrait.
- **Prompt update:** in the vision extractor/page-reader prompts, state that multiple images are **overlapping horizontal slices of one wide page** — merge by row key (Sr / first column), de-duplicate the overlap, and never invent or drop rows. (Proven effective in the harness prompt.)

### 4.2 Small-angle deskew (addresses cause #3)
- Before OCR/vision on wide pages, add a deskew pass in `preprocessImageForOcr` (`ocr.service.ts:1080`): estimate skew (Hough/`sharp`+projection-profile, or a cheap Tesseract OSD-adjacent angle) and `sharp().rotate(-angle)`. This directly removes the column-drift that causes the money-column row-shift. Deskew also improves the single-image path as a defense-in-depth.

### 4.3 Route bill/table categories to vision-first (addresses causes #1,#2,#5)
- In `master_options` set `extraction_mode='vision'` for wide-table categories (`final_bill`, `pharmacy_bill`, itemised lab reports) so they skip the Tesseract-first path that returns false-high confidence on wide tables (Tesseract reported **94% confidence** on a wide bill in testing). Combined with tiling.
- Implement the real PDF vision fallback where `ocr.service.ts:559-567` currently only warns.

### 4.4 Capture the FULL itemised table (addresses cause #6)
- Add a **line-items extraction contract** to the extractor for table categories: a first-class `line_items: [{particulars, code, date, qty, rate, gross, discount, net, tax_pct, payable}]` array (arbitrary length), separate from the flat schema fields, persisted on `document_sections.extracted_fields` (or a dedicated `document_line_items` table for query/adjudication).
- Raise/remove the 24,000-char truncation for table categories on the vision path (not needed when sending images, not text).
- This is what the next-phase adjudicator consumes to check per-line deductions against insurer rules.

### 4.5 Model & cost
- Keep `claude-sonnet-4-5` (proven ~99.5% tiled). Optionally A/B `claude-sonnet-5` for the hardest scans. Tiling adds ~1 extra image block per wide page (2–3 vs 1) — a few paise per doc; cost is per **output** token, so more input tiles barely move cost. Keep it behind `EXTRACT_TILING_ENABLED` + per-category `extraction_mode`.

### 4.6 Validation gate before default-on
1. Run the harness (`prod-vision-proof.cjs`) in CI as a regression gate — assert tiled ≥ 99% on the synthetic ground-truth doc.
2. Validate on a sample of **real prod landscape docs** (query `ipd_doc` for wide images/PDFs; extract with tiling; human-verify against the document). Real-doc validation has no ground truth, so verify visually on a labelled sample.
3. Roll out per-category (`final_bill` first), watch `extraction_confidence` and correction rates, then widen.

## 5. Sequencing with the next phase
Extraction accuracy is upstream of adjudication. Recommended order: (1) ship tiling + deskew + vision-first for `final_bill`/`pharmacy_bill` and prove ~99.5% on real docs; (2) add the full line-items contract; (3) then enable the rules engine (`insurer_rule_sets` etc.) so per-line adjudication runs against trustworthy figures. Adjudicating on today's 80–97% money-column accuracy would produce confident wrong recommendations.
