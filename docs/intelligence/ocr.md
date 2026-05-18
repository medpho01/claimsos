# OCR Pipeline (Sprint 5)

## Why OCR before LLM

LLM vision tokens are 10–30x more expensive than text tokens. Indicative pricing we plan around:

- Text input: ~₹0.07 per 1k tokens
- Vision input: ~₹2 per 1k tokens

A discharge summary or pre-auth form is typically 2–6 pages. If we send each page as an image to a vision model, a single document can cost ₹40–₹120 to ingest. The same document, OCR'd to plain text first, costs cents. Vision should be reserved for documents where OCR genuinely fails (handwriting, very low-resolution scans, complex multi-column forms) — not as the default ingestion path.

The OCR service (`Backend/src/Services/ocr.service.ts`) is the cheap foundation every downstream document worker calls first.

## Decision tree

For each PDF page:

1. **pdf-parse** pulls the typed text layer.
2. If the page yields > 50 characters with alphanumeric content → **`typed_pdf`** source, confidence fixed at 0.95. No OCR engine invoked.
3. Otherwise, render that page to PNG via **pdf-to-png-converter**, run **tesseract.js** → **`tesseract`** source, confidence = Tesseract's reported page confidence / 100.
4. If Tesseract confidence < `opts.minConfidence` (default 0.6) → still return the text but tag the page with a `low_confidence_ocr` warning. The **caller** decides whether to escalate to vision LLM. This service does NOT call the LLM bridge; if `allowVisionFallback` is set we add a `vision_fallback_eligible` warning so callers can detect intent without coupling layers.

Results are SHA-256 keyed and stored in an in-memory LRU cache (max 100 entries) so retries and re-fetches across worker stages don't re-OCR the same buffer.

Single images (PNG/JPEG) use `extractTextFromImage` which is just Tesseract on the raw bytes and returns one page with `pageNumber = 1`.

## Known limitations

- **Handwritten text** — Tesseract is poor at it; expect low confidence. Vision fallback is the right escalation here.
- **Indic scripts** — current build is English-only (`'eng'` traineddata). Hindi, Telugu, Tamil discharge notes will return garbage. Adding the relevant language packs is straightforward but inflates the WASM bundle on cold start.
- **Multi-column layouts** — Tesseract's default reading order can interleave columns. Column-detection (e.g. a layoutparser pass) is a likely Sprint 6+ follow-up.
- **Tables** — recognised as flat text. Structured table extraction needs either tabula-style heuristics or a vision LLM.
- **Rotated / skewed pages** — Tesseract auto-rotates only at higher PSM levels; we use defaults.

## Operational notes

- **No native binaries.** Tesseract.js bundles its own WASM, so the existing Docker image needs no extra apt packages. `pdf-to-png-converter` uses pdf.js + a JS canvas implementation; on some Node versions you may see a soft warning about a missing native `canvas` peer dep, which is safe to ignore for our use (the package falls back to a pure-JS rasteriser). If we ever hit perf trouble on render, installing `canvas` as an optional dep is the fix.
- **Concurrency.** Tesseract worker init is heavy (~1–2s, downloads traineddata on first run). For high throughput we should pool workers via `tesseract.js`'s `createWorker` API — out of scope for v1.
- **Memory.** A rendered PNG of a single A4 page at 2x scale is ~2–4 MB. Bound concurrent page processing if memory becomes an issue.

## Follow-up TODOs

- Wire the **LLM vision fallback** hook to the intelligence-layer LLM bridge (currently a no-op marked by `vision_fallback_eligible` warning + a TODO in the service).
- Ship **Indic language packs** behind a runtime flag.
- Move to a **batch/async** processing model (Bull queue worker) once we have real document throughput numbers.
- Evaluate **Google Cloud Vision** as the higher-accuracy upgrade path for Indic OCR. GCV is the most likely paid-OCR option but it adds recurring per-page cost (~$1.50/1k pages) and an outbound network dependency, so we'd want to gate it behind the same confidence threshold rather than use it by default.
