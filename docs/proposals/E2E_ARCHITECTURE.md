# ClaimOS — End-to-End Architecture

**Date:** 2026-09-13
**Method:** Four parallel agents read the backend subsystems end-to-end (AI pipeline, Gmail/email intelligence, document management, deployment/migrations/env), cross-checked against a live production instance (18 hospitals, 917 claims). File:line references throughout point at `Backend/src/…`.

**Companion docs:** [`DEPLOYMENT_HARDENING.md`](./DEPLOYMENT_HARDENING.md) (migrations + env) · [`EXTRACTION_LANDSCAPE_FIX.md`](./EXTRACTION_LANDSCAPE_FIX.md) (document extraction, landscape proof + code plan)

---

## 0. What ClaimOS is

A hospital-side cashless-insurance claims platform. Documents (bills, discharge summaries, pre-auth letters, ID proofs) are uploaded or arrive by email from insurers/TPAs; an AI pipeline OCRs → classifies → extracts → harmonises them into a canonical claim episode; a stage-aware rules engine adjudicates readiness; and a Gmail integration ingests insurer correspondence and drafts next-steps. The **next phase** — the reason for this analysis — is turning the harmonised episode + rules engine into **accurate, AI-applied adjudication**: telling the hospital exactly what to do next on each claim.

## 1. Deployment topology

Four containers (`docker-compose.yml`) plus **external RDS Postgres** (schema `hospital`):

| Container | Role | Key env | Notes |
|---|---|---|---|
| `backend` | API only | `RUN_WORKERS=false` | Express, enqueues Bull jobs but processes none. Port `6001→8000`. |
| `worker` | All queue consumers + crons | `RUN_WORKERS=true` | Same image; **no `container_name`** so it scales (`--scale worker=N`). |
| `webapp` | nginx serving CRA build | — | Proxies `/api/`→`backend:8000`; SPA fallback. No API URL baked at build (relative `/api/`). |
| `redis` | Bull queue broker | — | `--appendonly yes`; **6379 published to host** (exposure risk). |

- **Backend** runs TypeScript directly via `tsx` (no `tsc` build — latent type errors in the intelligence layer). **webapp** builds with CRACO, type/lint errors deliberately non-fatal.
- **Gotcha:** `docker compose restart` does **not** reload `env_file`; an `.env` edit needs `docker compose up -d --force-recreate`.
- **No healthchecks** in prod compose — `depends_on` waits for container *start*, not readiness. See [`DEPLOYMENT_HARDENING.md`](./DEPLOYMENT_HARDENING.md).

## 2. The LLM bridge (`Services/llm/`)

All model access is centralized behind `LlmClient` → `providers/claudeClient.ts`. This is the right seam to evolve for the next phase.

- **Models:** `HAIKU='claude-haiku-4-5'`, `SONNET='claude-sonnet-4-5'` (`claudeClient.ts:47-48`); embeddings `voyage-3` (1024-dim). *(Upgrade lever: the Claude 5 family — `claude-sonnet-5` / `claude-opus-5` — for the extraction & adjudication reasoning tiers.)*
- **Tiers:** cheap→Haiku, premium→Sonnet, **standard→Haiku auto-escalating to Sonnet** when parsed `confidence < 0.7` (`claudeClient.ts:79-89, 285-310`).
- **Attachments** (`attachmentsToContent`, `claudeClient.ts:135-157`): `text`→text block; `image`→base64 image block; `pdf`→base64 document block. **No image resizing/normalization here** — bytes are sent as-is (relevant to the landscape issue).
- **Prompt caching:** system prompt sent as a single `cache_control:{type:'ephemeral'}` block (`buildSystemBlocks:222-230`) — one cache-eligible template kept warm across categories.
- **Output parsing:** fenced-```json``` → balanced-brace scan → Zod validation (`extractJson:167-214`).
- **Cost:** bridge computes INR (USD→INR fixed **83**) and returns token counts but does **not** write `llm_cost_log`; callers invoke `costAccounting.recordCall` (migration `029`). Concurrency-gated via `acquireLlmSlot(model)` (separate Haiku/Sonnet pools). SDK `maxRetries:4, timeout:90s`.

## 3. AI adjudication pipeline

Two coexisting pipelines: **v1/legacy** (OCR-first, Bull queue hand-offs — this is what runs in prod today) and **pipelineV2** (vision-native `PageReaderService`, offline/harness only, gated behind migration `066` which is **not applied on prod**).

Flow: **OCR → Bundle Classify → Extract → Harmonise → Adjudicate**, orchestrated per-claim by `intelligenceOrchestrator.analyzeClaim` with a per-doc/-phase audit trail in `doc_phase_ledger` and a run cursor in `claim_ai_runs`.

### Stage 1 — OCR (`ocr.service.ts`, 1421 lines)
- **Input:** PDF/image buffer. **Output:** `OcrResult{pages[], source:'typed_pdf'|'tesseract'|'vision_fallback'}`. In-memory LRU cache, no DB.
- **PDF path:** `pdf-parse` per page; accepted as `typed_pdf` (conf 0.95) only if >50 chars AND ≥5 word-like tokens (rejects glyph-garbage from image-only PDFs) → else Tesseract.
- **Tesseract path:** renders page via `pdf-to-png-converter` at `viewportScale:2.0` (`:1226-1229`), OCRs `eng`. Below `ROTATION_GOOD_ENOUGH=0.55` → rotation salvage.
- **Orientation handling (mature for *rotated portrait*):** EXIF auto-orient; upscale to width 1800 **only if origWidth<1500**; Tesseract **OSD** (`worker.detect()`, trusted at conf≥2.0) for 0/90/180/270; brute-force 90/180/270 sweep scored by `confidence × wordlike`.
- **Vision fallback:** single Sonnet call, transcription-only prompt, when conf<0.55 + caller opt-in + `OCR_VISION_FALLBACK_DISABLED!='true'`. Returns fixed conf 0.85. **Note: the PDF path has NO real vision fallback — only a `vision_fallback_eligible` warning stub (`:559-567`).**
- **The landscape gap lives here** — see [`EXTRACTION_LANDSCAPE_FIX.md`](./EXTRACTION_LANDSCAPE_FIX.md).

### Stage 2 — Bundle Classifier (`docBundleClassifier.service.ts`, 1919 lines)
- **Text-only.** OCRs the whole document, then **one Sonnet call** segments the bundle into disjoint page-range sections AND classifies each into a `doc_category` (validated against `master_options WHERE category='doc_category'`, 25 codes in prod). Writes `document_sections` (`classifier_version='v2-bundle'`). Coverage-checked (no gaps/overlaps); retries ×3 then falls back to legacy per-section segmenter→classifier. No images sent to the model.

### Stage 3 — Extractor (`docExtractor.service.ts`, 1566 lines) + `document_field_schemas`
- **Input:** a classified section. **Output:** `extracted_fields` + per-field confidence → `document_sections`. Builds a dynamic Zod schema from `document_field_schemas` (latest `schema_version` per category; prod has **42 categories / 334 fields**). Only ~5 categories currently have schemas → others `extraction_skipped`.
- **Modality** (`extraction_mode` from `master_options`, per category): `ocr` (Tesseract text→LLM, default), `vision` (image→LLM, skips Tesseract), `auto` (OCR, escalate to vision if conf<0.35 AND alnum<50). `HINDI_LIKELY_CATEGORIES` forced to vision.
- **Vision attachments:** image→direct; PDF→`fetchAndSlicePdf`→`pdfToPng(viewportScale:2.0)`, capped `MAX_VISION_PAGES=8`, downscaled to ≤2048px if >4MB. **Single image per page, no tiling.**
- **Extraction is schema-bounded** (fixed fields) — it does **not** capture arbitrary-length line-item tables as full data. This matters for the next phase (adjudication needs the itemised bill).

### Stage 4 — Harmoniser (`harmonisation.service.ts`, 3657 lines)
- **Last LLM stage, text-only, Sonnet premium**, `max_tokens=16384`, `task='claim_harmonisation'`. Merges dossier + all section extractions into a canonical `medical_episode.v2` JSON → `claim_harmonised_episodes` (PK claim_id). Cache short-circuits on `dossier_state_hash`. Hard budget cap ₹15 (over-budget → `status='failed'`, no model call). Identity gate drops foreign-patient sections. Human corrections via JSONPath patch (no LLM) → `harmonisation_corrections`.

### Stage 5 — Adjudication / rules (M0–M7)
- **Pure rules engine (M3)** `rules/engine.ts` — no IO; evaluators `DOCUMENT_PRESENCE | REQUIRED_FIELDS | FUZZY_NAME | TEMPORAL_WINDOW`; **abstention gate** forces `SKIP` (never auto PASS/FAIL) below `rule.minConfidence`; FAIL penalties → readiness score.
- **Stage-aware adjudicator (M4/M5)** `adjudication/stageAwareAdjudicator.service.ts` — resolves `{scheme,route,insurer,stage,case_type}`, selects a rule set, runs the engine, persists per-stage evaluations + a 4-layer hypothesis (documents / content / rules / readiness).
- **Adjudication Engine v0** `adjudicationEngine.service.ts` → `AdjudicationReport` (readiness bucket, recommended action), optionally enriched by KB-pattern matcher + episodic memory + reasoning agent.
- **Status:** M0/M1 committed **shadow-only**, paused pre-M2 (per project memory). **On prod: `insurer_rule_sets`, `insurance_rules`, `stage_requirements` are all empty → the engine abstains.** Enabling this is the next phase.

### Orchestration & memory
- `intelligenceOrchestrator.analyzeClaim` — opens a run (`force` wipes AI-derived state), enqueues bundle-classify per doc, cascades classify→extract→harmonise via Bull hooks, runs claim-level section-dedup + harmonisation.
- `claim_ai_runs` (run cursor, phases quality→orient→dedup→classify→extract→harmonise, stall detector 300s) + `claimRunReconciler.cron` (re-enqueues stranded runs, periodic `recomputeFromState`).
- **Episodic memory:** `case_embeddings` (`vector(1024)`, ivfflat cosine, migration `039`, needs `pgvector`), voyage-3 embeddings, top-k retrieval. **KB patterns:** `kb_patterns` + `kb_pattern_matches`, mined by cron.

## 4. Gmail + email-intelligence subsystem

Tokens live in `hospital.hospital_interfaces` (`kind='email'`, AES-256-GCM `secrets_encrypted`, `status` machine `active|pending|token_expired|disconnected|error`), **not** on `hospitals`.

- **OAuth** (`gmailAuth.service.ts`): consent→callback (hard-fails without a `refresh_token`), `getAuthenticatedClient` is the shared entry point (refreshes if <5min to expiry; on failure sets `token_expired` + throws 401). Endpoints under `/api/v1/hospitals/:id/gmail-oauth/*` (+ unauthenticated `/oauth/gmail/callback`).
- **Inbound poll** (`gmailPoll.queue` every 120s → `gmailInbound.service`): Gmail History API incremental sync (`history_id` cursor advanced only after successful ingest; re-baselines on expiry), self-loop guard on SENT, SPF/DKIM/DMARC parse, attachments→S3, `INSERT emails_inbound ON CONFLICT(gmail_message_id) DO NOTHING`, then synchronously calls the matcher.
- **Matching** (`emailMatching.service`): priority ladder — In-Reply-To (0.99) → Gmail thread (0.95) → VERP correlation token (0.97) → claim-number regex (0.85) → IPD-UUID in subject (0.92) → sender→panel (0.65) → sender disambiguation → unmatched (`needs_ops_review`). Confidence <0.9 or failed SPF/DKIM/DMARC forces ops review. High-confidence matches auto-save insurer attachments to `ipd_doc` and trigger `enqueueEmailIntelligence`.
- **Email intelligence** (`emailIntelligence.service`): OCR attachments → classify (`emailClassifier.v1`) → extract (approval / query / rejection extractors) → persist `email_intelligence_drafts` (`pending_review`). Human apply (`applyDraft`) writes claim effects: approved amounts (`claim_financials`), `request_doc`/`notify_ops` actions (`claim_actions`), corrections (`email_intelligence_corrections`).
- **Outbound** (`gmailSend.service` + `emailOutbox.queue`): hand-rolled RFC822 MIME, S3 attachments, VERP `Reply-To` for reply-matching, atomic status-claim, 5 retries + 60s stranded-row rescue.
- **Reconciler** (`emailIntelligenceReconciler.cron`, 120s): PASS1 re-drives matched-but-undrafted emails; PASS2 emits 5 Prometheus gauges + log alerts (ERROR on `outboundFailed>0 || interfacesUnhealthy>0`; WARN on `unmatched>5`).
- **Security:** AES-GCM at-rest tokens; SPF/DKIM/DMARC spoof gate; high-confidence-only auto-save; hospital-scoping on every cross-tenant lookup; PHI kept out of logs.

## 5. Document management

- **Two upload paths:** v1 (async `UploadQueue`, disk-persisted, serial) and **v2** (`Controllers/v2/uploads.controller.ts`, synchronous, 5-wide concurrent, adds an **identity gate** stashed in `doc_metadata`). Both `INSERT ipd_doc` with SHA-256 `content_hash` dedup. Multer caps 10 MB (disk) / 25 MB (memory).
- **S3** (`s3.service.ts`): key `{uploads/ if image}{hospitalId}/{panelId}/{patientId}/{documentType}/{ts}_{rand}_{name}`, `AES256` SSE. CloudFront removed → per-request SigV4 presigned URLs (`getViewUrl`, no raw-URL fallback for PHI). `proxyPhoto` streams bytes through the API.
- **Image processing:** PDF→PNG at `viewportScale:2.0` (`pdf-to-png-converter`); Ghostscript PDF compression to ≤900 KB; `sharp` for rotate/resize/grayscale. **`.webp` key suffix is stored but no webp encode actually runs** — a magic-byte sniffer copes with mislabeled bytes (iPhone/Android screenshots).
- **5-layer dedup:** file-bytes SHA-256 (`content_hash`, unique per `(ipd_id, hash)`), section page-range overlap, section text-hash (`sectionDedup.service`), per-page perceptual/difference hash (`058`, GIN-indexed), file-level `dedup_of` pointer.
- **Sectioning:** `document_sections` (one row per page-range) is the spine — segmenter (boundaries) → classifier (category) → extractor (fields), with an append-only `document_section_corrections` human-edit log.
- **Pipeline v2** (`derived_page`, Layer A uploads vs Layer B renders; `pageReader.service` consolidated vision read) is authored but **migration `066` not applied** — current prod sectioning writes `document_sections` directly.

## 6. Cross-cutting

- **Queues (Bull/Redis, `REDIS_URL`):** gmail-poll, email-intelligence (conc 3), email-outbox (5 retries + poll), inbound-notification, plus the AI-pipeline queues (bundle-classify, extract, classify, segment, harmonise). All have Redis-absent stubs; all gated by `RUN_WORKERS`.
- **Idempotency everywhere:** `emails_inbound.gmail_message_id` unique; drafts `(inbound_email_id, prompt_version)` unique; outbox atomic status-claim; Bull `jobId` dedup; `claim_actions.idempotency_key`; migration `ON CONFLICT`/`IF NOT EXISTS` patterns (imperfect — see hardening doc).
- **Cost governance:** `llm_cost_log` + `costAccounting` per-claim budget (harmoniser hard cap ₹15) with fail-open on check errors.
- **Observability:** `/metrics` (token-gated by `METRICS_TOKEN`), `/health/worker`, pino structured logs, `doc_phase_ledger` per-phase audit, reconciler gauges.

## 7. The most important architectural facts for the next phase

1. **The pipeline produces an accurate interpretation, not a verdict** — harmonised episode + suspicious-doc flags. Adjudication (hold/file/what-to-do) is a **separate rules layer**, currently inert on prod (empty rule tables). Enabling it = the next phase.
2. **Extraction is schema-bounded and OCR-first**, so the *full itemised data* an adjudicator needs (every bill line, every deduction) is not reliably captured today — worst on landscape/wide documents. This is the gating quality problem; see the extraction doc.
3. **The LLM bridge is the clean seam** to add rules-aware, vision-first extraction and AI-applied adjudication without touching every service.
4. **Prod's DB diverges from the migration ledger** (dump-created) — any next-phase schema (rule sets, per-line extractions) must ship through the hardened migration path in [`DEPLOYMENT_HARDENING.md`](./DEPLOYMENT_HARDENING.md).
