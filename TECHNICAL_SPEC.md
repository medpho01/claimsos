# ClaimsOS — Technical Specification

**Owner:** Finclarity-Tech / 24Eleven Healthcare
**Last updated:** 2026-06-02
**Service name in code:** `24eleven-backend`

This document is the single source of truth for how ClaimsOS is built. Pair with `PRODUCT_SPEC.md` (what we're building, for whom), `TECH_DEBT.md` (what's broken / needs work), and [`docs/PROJECT_HANDOFF.md`](./docs/PROJECT_HANDOFF.md) (role-based onboarding & knowledge base).

> **2026-06 revision:** added the **Intelligence Layer** (§3 — the AI document pipeline, Waves 1-12, harmoniser, rules-v2, the v2 vision pipeline & benchmark harness) and corrected stale facts: **Node 22** (was 20), **Google Drive removed** (May 2026), **structured `pino` logging** (was "console only"), a real **migration runner**, and the **API/worker two-container split**. Prior architecture sections renumbered (Webapp §4, Mobile §5, Deployment §6, Operations §7, Cookbook §8, Risks §9).

---

## 1. System Overview

```
                          ┌────────────────────────────┐
                          │      Flutter Mobile App     │
                          │   (Field agents, Android)   │
                          └─────────────┬───────────────┘
                                        │  HTTPS (Dio)
                          ┌─────────────┴───────────────┐
                          │        React Webapp          │
                          │  (3 portals + public dir)    │
                          └─────────────┬───────────────┘
                                        │  HTTPS (axios)
                                        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │      API container — Express 5 (Node 22, ESM, run via tsx)         │
   │            RUN_WORKERS=false · serves HTTP, ENQUEUES jobs          │
   │   Routes ─► Controllers ─► Services ─► DB (pg.Pool)                │
   │                                   ├─► AWS S3 + CloudFront (files)   │
   │                                   ├─► UltraMsg (WhatsApp)           │
   │                                   ├─► Gmail (in/out) · Sheets hook  │
   │                                   ├─► Prometheus /metrics (gated)   │
   │                                   └─► Bull.enqueue ─► Redis ──┐     │
   └──────────────────────────────────────────────────────────────│────┘
                                                                   │ Bull / Redis
   ┌───────────────────────────────────────────────────────────────▼────┐
   │   Worker container(s) — SAME image, RUN_WORKERS=true                 │
   │   horizontally scalable: `docker compose up -d --scale worker=N`     │
   │   Bull processors + crons run the intelligence pipeline:             │
   │     segment / bundle-classify ─► classify ─► extract ─► dedup ─►     │
   │     harmonise (medical_episode.v2) ─► signals ─► rules-v2            │
   │                                   │                                  │
   │      ┌────────────────────────────┼───────────────────────────┐     │
   │      ▼                            ▼                            ▼     │
   │  Anthropic Claude           Voyage embeddings            AWS S3 /    │
   │  (Haiku + Sonnet pools,     (episodic memory)            CloudFront  │
   │   vision-capable)                                                    │
   └───────────────────────────────┬──────────────────────────────────────┘
                                    │
                          ┌─────────┴──────────┐
                          │     PostgreSQL     │
                          │  (schema=hospital) │
                          └────────────────────┘
```

**The defining architectural fact:** the backend ships as **one image run in two roles**, switched by the `RUN_WORKERS` env var. The **API container** (`RUN_WORKERS=false`) serves HTTP and only *enqueues* Bull jobs. One or more **worker containers** (`RUN_WORKERS=true`) consume those queues and do the heavy LLM/pipeline work; they scale horizontally (Bull queues are Redis-backed and worker-safe). Everything below §3 (the intelligence layer) runs on the worker. See §3.1.

---

## 2. Backend (`Backend/`)

### 2.1 Stack
- **Runtime:** Node.js **22** (`node:22-alpine`), TypeScript, **ESM** (`.js` import suffixes required for relative imports). **Executed via `tsx`** (esbuild, transpile-only) in both dev (`tsx watch`) and prod (`npm start` → `tsx src/index.ts`). **There is no `tsc` build step** — see §9 and the Dockerfile comment for why (the intelligence-layer code carries latent TS-5 type errors that `tsx` tolerates).
- **Framework:** Express 5.
- **DB:** PostgreSQL via `pg.Pool` (single pool in `src/DB/db.ts`). Default schema `hospital` plus `public`.
- **Queues / async:** **Bull on Redis** — the backbone of the whole intelligence pipeline (segmenter, bundle-classifier, classifier, extractor, harmoniser, adjudication, action engine, email intelligence, notifications, …) plus crons (KB miner, episodic backfill, eval harness, claim-run reconciler). Legacy custom in-memory FIFO (`uploadQueue.service.ts`) still backs the V1 upload path.
- **LLMs:** **Anthropic Claude** via `@anthropic-ai/sdk` — a **Haiku pool** (cheap/bulk: classify, extract) and a **Sonnet pool** (vision + harmonisation), each governed by a concurrency semaphore (`Utils/llmConcurrency.ts`). **Voyage** embeddings power episodic memory. See §3.5.
- **Auth:** JWT (access + refresh), refresh tokens bcrypt-hashed in `user_refresh_tokens`.
- **Object Storage:** AWS S3 with CloudFront-signed URLs (1 hr) for delivery. (Google Drive backup **removed**, May 2026.)
- **PDF / OCR / images:** Ghostscript (PDF compress), `pdf-lib` / `pdf-parse` / `pdf-to-png-converter` / `pdfkit`, `tesseract.js` (OCR), `sharp` (images).
- **Logging:** **structured `pino` / `pino-http`** with a PII-redacting logger (`Utils/logger.ts`) and a per-request `X-Request-Id`.
- **Metrics:** `prom-client` at `/metrics` (**token-gated** via `METRICS_TOKEN`, deny-by-default).
- **Migrations:** runner at `src/schema/run-migrations.cjs` (`npm run migrate:up|down|create`).
- **Health:** `/health/live`, `/health/ready`, `/health/worker`, `/api/v1/health`, `/api/v1/version`.

### 2.2 Folder Layout
```
src/
  app.ts                     Express + CORS + JSON
  index.ts                   bootstrap, env validation, pino, route mount, worker boot ("Waves" map)
  DB/db.ts                   pg Pool + connectDB
  Controllers/               ~47 files + v2/uploads.controller.ts
  Services/                  ~67 files (business logic + the AI pipeline)
    llm/                       LLM clients, versioned prompts, zod output schemas (§3.5)
    pipelineV2/                vision-native pipeline + benchmark harness (§3.9)
  Routes/                    ~37 files + v2/uploads.routes.ts
  Middlewares/               auth, multer   (⚠️ a case-variant `middlewares/` also exists)
  Workers/                   ~23 Bull queues + crons (self-gate on RUN_WORKERS)
  Utils/                     tokens, errorHandler, asyncHandler, apiResponse, indianTime,
                             logger (pino, PII-redacting), env.util, crypto, llmConcurrency, queueRedis
  schema/                    schema.sql + migrations/ (77 files) + run-migrations.cjs + seeds/
  Public/                    multer disk dest
```

### 2.3 Module Conventions
- Controllers are thin: parse + delegate + format response (`apiResponse.util.ts` produces `{ statusCode, data, message, success }`).
- Services hold SQL and business logic.
- Async handlers wrapped with `asyncHandler.util.ts` for unhandled-rejection safety.
- Structured logging via `pino` (`Utils/logger.ts`); access logs via `pino-http` with request ids. (Earlier revisions logged via `console.*` only — that has been replaced.)
- Boot order, route mounts, and the worker bootstrap (the "Waves" map) all live in `src/index.ts`.

### 2.4 Authentication
- `POST /api/v1/auth/login` returns `{ accessToken, refreshToken, user }`. Frontend stores in localStorage / SecureStorage.
- `POST /api/v1/auth/refreshAccessToken` accepts refresh token in body **and** old access token in Authorization header. Backend `jwt.decode`s (⚠️ not verify) the access token to fetch `userId`, then bcrypt-compares the refresh token against `user_refresh_tokens.token_hash`. On success, rotates both tokens.
- Roles: `superadmin`, `admin`, `hospital`. Doctor user-role planned but **not implemented in auth flow** — doctors registered via `/doctors/register` create `doctors` rows but no logged-in session today.
- Middleware guards: `checkAuth`, `checkSuperAdmin`, `checkAdmin`, `checkSuperAdminOrAdmin`, `checkHospital`, plus access-checks `checkAdminPermission(perm)`, `checkPatientViewAccess`, `checkPatientEditAccess`, `checkHospitalUserPermission`.

### 2.5 API Surface (by router)

**Core platform**

| Router | Mount | Purpose |
|---|---|---|
| `auth.routes` | `/api/v1/auth` | login, signup (superadmin-gated), refreshAccessToken |
| `patient.routes` | `/api/v1/patient` | IPD CRUD, discharge, toggle-active |
| `user.routes` | `/api/v1/user` | me, list, roles, toggle-status |
| `uploads.routes` (V1) | `/api/v1/uploads` | legacy upload pipeline (multer→queue→S3+WhatsApp) |
| `uploads.routes` (V2) | `/api/v2/uploads` | **current** S3-direct upload |
| `admin.routes` | `/api/v1/admin` | admin↔hospital assignments, permissions |
| `audit.routes` | `/api/v1/audit-logs` | audit list (⚠️ table missing) |
| `hospital.routes` | `/api/v1/hospitals` | hospital CRUD, panels, users |
| `claim.routes` | `/api/v1/claims` | claim create/update |
| `hospitalDocs.routes` | `/api/v1/hospital-docs` | hospital doc upload/list/delete |
| `hospitalProfile.routes` | `/api/v1` | hospital profile + attributes + documents + verification + share tokens + public access |
| `panelAttribute.routes` / `attributeDefinition.routes` / `panelAttributeDefinition.routes` | `/api/v1` | panel & hospital attributes + definitions |
| `masterOptions.routes` | `/api/v1/master-options` | dropdown master values (⚠️ no auth) |
| `doctor.routes` | `/api/v1` | doctor registry + attributes + hospital-doctor + share + public |
| `doctors.routes` | (none) | **dead code — imported but never mounted** |

**Email / cashless**

| Router | Mount | Purpose |
|---|---|---|
| `gmailAuth.routes` / `gmailInbound.routes` / `emailInbox.routes` | `/api/v1` | Gmail OAuth, inbound polling, inbox surface (Cashless Everywhere) |
| `insuranceSubmission.routes` | `/api/v1` | pre-auth / insurer submission |

**Intelligence layer (Waves 1-10 — see §3)**

| Router | Mount | Wave |
|---|---|---|
| `claimDossier.routes` | `/api/v1` | 1 — per-claim case file |
| `aiDrafts.routes` | `/api/v1` | 2 — email-intelligence review |
| `stageRequirements.routes` / `adjudication.routes` / `claimActions.routes` | `/api/v1` | 3A/3B/3C |
| `kbPatterns.routes` / `episodicMemory.routes` | `/api/v1` | 4A/4B |
| `eval.routes` | `/api/v1/eval` | 5 — prediction accuracy |
| `intelligence.routes` | `/api/v1` | orchestrator ("analyze this claim") |
| `harmonisation.routes` | `/api/v1` | 7 — harmonised episodes |
| `rulesV2.routes` | `/api/v1` | 8 — rules engine v2 (adjudication) |
| `aiAuditTrail.routes` / `documentSectionCorrection.routes` | `/api/v1` | 9 — FE gap-fills |
| `aiCorrections.routes` | `/api/v1` | 10 — correction→KB |
| `intelligenceStatus.routes` | `/api/v1` | pipeline status (Claim AI Summary poll) |
| `reviewQueue.routes` | `/api/v1/review-queue` | Stage 7 — flagged-claim review (superadmin) |
| `extractionCorrections.routes` | `/api/v1` | reviewer-correction capture |

A historical endpoint inventory is archived under `docs/archive/audits/`; `src/index.ts` is the authoritative mount list.

### 2.6 Services
~67 services, mostly stateless module-level functions wrapping SQL + (for the pipeline) LLM calls.
- **Core data:** `attribute`, `attributeDefinition`, `panelAttribute*`, `doctor*`, `hospitalDoctor*`, `hospitalProfile`, `masterOptions`, `panelDefaults`.
- **Verification:** `attributeVerification`, `verification`, `verificationNotes`, `verificationVisit`, `validator`. (⚠️ overlap — see TECH_DEBT.md.)
- **Files / storage:** `s3`, `pdfConverter`, `attachment`, `documentExtraction`, `documentFormatLibrary`, `hospitalFormatProfile`.
- **Upload / notifications:** `uploadQueue` (V1 in-mem queue), `notificationBuffer`, `notificationDispatch`, `ultraMsg`.
- **Pipeline orchestration:** `intelligenceOrchestrator`, `claimAiRun`, `docPhaseLedger`, `startup`.
- **Document pipeline:** `docSegmenter`, `docBundleClassifier`, `docClassifier`, `docExtractor`, `extractedFieldValidators`, `sectionDedup`, `ocr`.
- **Harmonisation & adjudication:** `harmonisation`, `identityGate`, `rulesEngine`, `rulesEngineV2`, `adjudicationEngine`, `actionEngine`, `actionTemplating`, `reviewQueue`.
- **Learning / memory:** `aiCorrections`, `extractionCorrections`, `kbHints`, `kbPatternMatcher`, `kbPatternMiner`, `episodicMemory`, `evalHarness`, `reasoningAgent`.
- **Email intelligence:** `emailInbox`, `emailIntelligence`, `emailMatching`, `inboundClassifier`, `gmailAuth`, `gmailInbound`, `gmailSend`, `insuranceSubmission`, `submissionEvents`, `preauthPdfFill`.
- **Cost:** `costAccounting` (§3.6).
- **Case file:** `claimDossier`, `claimDossierProjector`.

### 2.7 Database

**Schema strategy:** all domain tables in PG schema `hospital` (search_path set to `hospital, public`). `users`, `user_refresh_tokens`, and a duplicate `doctors` table live in `public`.

**Core tables:**
- *Identity:* `users`, `user_refresh_tokens`.
- *Hospital core:* `hospitals`, `hospital_assignments`, `hospital_users`, `hospital_interfaces` (email/integration config).
- *Panels:* `panels`, `hospital_panels`, `panel_empanelments`.
- *IPD / Claims:* `ipds`, `claims`, `ipd_doc`, `doctor_doc`, `hospital_doc`.
- *Profile system:* `hospital_profile`, `hospital_key_contacts`, `hospital_certifications`, `hospital_documents`, `hospital_attributes`, `hospital_attribute_documents`.
- *Definitions / panels / doctors / verification / sharing:* see the earlier audits — `attribute_definitions`, `panel_attribute_definitions`, `doctor_attribute_definitions`, `master_options`, `doctor_profiles`, `hospital_doctors`, `verification_visits`, `attribute_verifications`, `public_share_tokens`, `doctor_share_tokens`, etc.

**Intelligence-layer tables** (defined by the later migrations — read `src/schema/migrations/` for the authoritative shape):

| Table | Purpose |
|---|---|
| `claim_harmonised_episodes` | The canonical `medical_episode.v2` JSONB per claim (Wave 7 output). |
| `document_sections` | Per-document classified sections + extracted fields. |
| `document_field_schemas` | Per-category extraction schemas the extractor fills. |
| `claim_ai_runs` | Tracks each analyze-claim run (progress/status) — migration 060. |
| `doc_phase_ledger` | Per-document phase settlement; gates the harmoniser — migration 061. |
| `extraction_corrections` / `corrections` | Reviewer field corrections (feed Wave 10; `ON DELETE SET NULL`) — migration 064. |
| `hospital_format_profiles` | Per-hospital document-format learning — migration 065. |
| `derived_page` | v2 page-derivation artifacts — migration 066. |
| dedup tables (`section_phash_arrays`, …) | Perceptual-hash + content/file dedup — migrations 055-058. |
| `llm_cost_log` | Per-call LLM spend ledger (§3.6). |
| KB-pattern / episodic-memory / eval tables | Wave 4/5 mined patterns, case embeddings, prediction accuracy. |

**Migrations:** raw SQL files under `src/schema/migrations/` (**77 files**, up to `066_*`), applied via the **`run-migrations.cjs` runner** (`npm run migrate:up|down|create`). Historical "_fixed" siblings and hospital-specific data SQL were a known mess; consolidation is tracked in `TECH_DEBT.md` (and `schema/SCHEMA_DRIFT_AUDIT.md`). Keep hospital-specific data in `seeds/`, never in `migrations/`.

### 2.8 File Upload Pipelines

**V1 (`/api/v1/uploads`) — legacy, still active for some paths:**
1. multer disk storage → `src/public/<file>`.
2. Job enqueued in `uploadQueue.service.ts` (in-memory `UploadJob[]`, persisted to `queue_state.json`).
3. Serial worker (concurrency=1) Ghostscript-compresses PDFs and uploads to S3.
4. On batch completion, `notificationBuffer.service` triggers a WhatsApp message to the panel group.
5. **Risk:** process exit drops in-flight job.

**V2 (`/api/v2/uploads`) — current:**
1. multer memory storage → controller streams directly to S3.
2. Backup status columns on `ipd_doc` are legacy from the Drive era; **Google Drive backup was removed (May 2026)** and the Drive uploader / startup recovery are no-ops.
3. Bull configured with `enableOfflineQueue: false` → gracefully no-ops if Redis is down.

Uploaded documents become the input to the **intelligence pipeline** (§3.3) once a claim is analyzed.

### 2.9 Notifications
- **UltraMsg** (`ultraMsg.service.ts`) — HTTP client to UltraMsg WhatsApp API.
- **`notificationBuffer.service`** — debounces per-group messages so a batch of N photos sends one summary message after a quiet window.
- **`notification.queue` / `inboundNotification.queue` (Bull)** — wrap notification sending for retries.

### 2.10 Public Share Token System
- `public_share_tokens` (hospital) + `hospital.doctor_share_tokens` — random URL-safe token, optional `expires_at`, `max_views`, `view_count`, `is_active`.
- Public routes mounted **without auth**: `/hospitals/share/:token`, `/hospitals/share/:token/documents/:documentId/download`, `/doctors/public/doctor/:token`, plus public directories.
- Document delivery uses S3 presigned URLs gated by token validity.

### 2.11 Observability
- **Structured logging:** `pino` + `pino-http` via `Utils/logger.ts` (PII-redacting), per-request `X-Request-Id`, health endpoints logged at `debug` to cut noise.
- **Metrics:** `prom-client` default metrics + custom histogram `app_24eleven_http_requests_total`. `/metrics` is **token-gated** (`METRICS_TOKEN`; deny-by-default if unset).
- **Health probes:** `/`, `/health/live`, `/health/ready`, **`/health/worker`** (queue depths + DB-derived liveness on the worker; `{workers_enabled:false}` on the API), `/api/v1/health`.
- **Version probe:** `/api/v1/version` (mobile force-update check).
- No external log aggregation (Loki/Datadog/Sentry) wired in repo.

---

## 3. Intelligence Layer (AI Document Pipeline)

> **What it does:** turn a claim's pile of uploaded documents (40-120+ pages, scanned, sometimes handwritten, sometimes containing the *wrong* patient's pages) into one **accurate structured medical episode** plus **quality signals** a reviewer can act on. It runs entirely on the **worker container**.

### 3.1 Two-container execution model
- The backend is one image; `RUN_WORKERS` decides its role. On the **API** (`RUN_WORKERS=false`) every worker module no-ops at import — it only enqueues. On the **worker** (`RUN_WORKERS=true`) the Bull processors + crons register and do the work.
- **Horizontal scale:** `docker compose up -d --scale worker=N`. Bull queues are Redis-backed and worker-safe; replicas consume the same queues and parallelise across patients.
- **Concurrency control:** each worker enforces per-queue caps (`BUNDLE_CLASSIFIER_CONCURRENCY`, `DOC_EXTRACTOR_CONCURRENCY`, …) and a per-pool LLM semaphore (`LLM_MAX_CONCURRENT_HAIKU` / `_SONNET`, in `Utils/llmConcurrency.ts`). **When scaling beyond 1 replica, divide those caps by the replica count** so effective Anthropic-account concurrency stays under your RPM/TPM ceiling. (A Redis-backed global limiter is a planned Tier-2 improvement.)

### 3.2 The "Waves" model
The intelligence layer is built as **additive layers ("Waves")** that mostly run concurrently. The worker bootstrap in `src/index.ts` is the canonical map:

| Wave | Name | Key modules |
|---|---|---|
| **1** | ClaimDossier projector (per-claim event-sourced case file) | `claimDossierProjector.queue.ts`, `claimDossier.service.ts` |
| **2** | Document intelligence pipeline + Email intelligence | `docSegmenter`/`docClassifier`/`docExtractor` queues; `emailIntelligence.queue.ts` |
| **3A/3B/3C** | Stage requirements / Adjudication readiness / Actions dispatch | `adjudicationEngine.queue.ts`, `actionEngine.queue.ts` |
| **4A/4B** | KB pattern mining + Episodic memory | `kbPatternMiner.cron.ts`, `caseEmbedder.queue.ts` |
| **5** | Eval harness (prediction accuracy) | `evalHarness.cron.ts` |
| **7** | **Claim Harmoniser** — canonical `medical_episode.v2` per claim | `claimHarmoniser.queue.ts`, `harmonisation.service.ts` |
| **8** | **Rules Engine v2** — insurer rule sets vs episode (**the adjudication layer**) | `rulesEngineV2.service.ts` |
| **9** | FE gap-fills (AI audit trail, doc-section correction) | `aiAuditTrail`, `documentSectionCorrection` |
| **10** | Correction-to-KB pipeline | `aiCorrections.service.ts` |
| **12** | **Bundle classifier** (vision-native; current default ingestion) | `docBundleClassifier.queue.ts` |
| **iter7 / Stage 7** | Review queue (flagged-claim surface) | `reviewQueue.service.ts`, `pipelineV2/runState.service.ts` |

Wave 12's bundle classifier is the current default ingestion path; the Wave 2 segmenter→classifier chain is kept as a fallback for very long PDFs and force re-runs.

### 3.3 The document pipeline (stage by stage)

```
upload (S3) ─► analyzeClaim() ─► [worker] ─► bundle-classify / segment ─► classify
                                                                            │
   rules-v2 ◄── signals ◄── harmonise (episode.v2) ◄── dedup ◄── extract ◄─┘
```

| Stage | Service | What it does |
|---|---|---|
| Ingest / segment | `docBundleClassifier` (default) / `docSegmenter` (legacy) | Turn uploaded PDFs into classified **sections**. Bundle classifier does it in one Sonnet-vision pass. |
| Classify | `docClassifier` | Per-section category (`final_bill`, `discharge_slip`, `implant_invoice`, `pmjay_letter`, …). |
| Extract | `docExtractor` | Fill the section's fields per its `document_field_schema`. Vision routing for handwritten categories. |
| Dedup | `sectionDedup`, `pipelineV2/dedup` | Perceptual-hash + content/file dedup. |
| **Harmonise** | `harmonisation.service.ts` (+ `harmoniser.v1` prompt) | Fuse kept sections → one `medical_episode.v2`; run Fix-N enrichment (§3.4). |
| Signals | `pipelineV2/runState.service.ts` | Non-blocking `RunSignal[]` (foreign pages removed, multiple identities, possible contamination, coverage gap, low-confidence field). |
| Adjudicate | `rulesEngineV2.service.ts` | Insurer rule sets → readiness report (**separate layer**, §3.8). |

### 3.4 The harmonised episode & the "Fix-N" enrichment pattern
The harmoniser sends all kept sections to Claude (Sonnet) via the versioned `harmoniser.v1` prompt and zod-parses the result into `medical_episode.v2` (`llm/schemas/harmonisedEpisode.ts`). After parse, a series of **deterministic, non-fatal `try/catch` "Fix-N" blocks** in `harmonisation.service.ts` cross-check and enrich `episode` + `validation_metadata`, then persist **without re-parsing** (safe because `FinancialSummary` / `ValidationMetadata` are zod `.passthrough()`):

- **Fix-5** — laterality consensus.
- **Fix-7** — cross-document identity.
- **Fix-18** — **financial reconciliation** (CRIT-3): a pure `reconcileFinancials()` harvests stated totals + summed line items, picks a hospital anchor (final → interim → discharge-slip fallback), tallies pharmacy/implant/sub-bills **separately**, flags stated-vs-itemised mismatch / conflicting finals / all-empty, and writes `financial_summary.reconciliation` + a reviewer-queryable `validation_metadata.financial_reconciliation` (status incl. `no_financial_data`) **without ever clobbering an LLM-provided amount**.

> **To add a deterministic post-LLM check:** follow the Fix-N pattern — own `try/catch`, mutate `episode`/`vm` only, never throw, write any signal into `validation_metadata`.

### 3.5 The LLM layer (`Services/llm/`)
```
llm/
  LlmClient.ts            interface: classify / extract / harmonise result shapes
  RecordReplayClient.ts   records responses to disk / replays them (FREE harness runs)
  factory.ts              picks provider (real Claude vs record/replay) from env
  providers/              claudeClient.ts (Anthropic, vision) · voyageEmbedder.ts
  prompts/                versioned builders: docBundleClassifier.v1, docClassifier.v1,
                          docExtractor.generic.v1, docSegmenter.v1, harmoniser.v1,
                          pageReader.v1, reasoningAgent.v1, emailClassifier/extractor.*.v1
  schemas/                zod: harmonisedEpisode (medical_episode.v2), bundleClassifierOutput,
                          pageRead, reasoningAgent, emailIntelligence
```
Conventions: **prompts are versioned** (`.v1`) — bump the version when changing the contract (the benchmark baseline is keyed to behavior); **every model output is zod-validated**; models are **Claude Haiku** (bulk classify/extract) + **Claude Sonnet** (vision + harmonise), with **Voyage** for embeddings.

### 3.6 Cost accounting & the budget gate
`costAccounting.service.ts` exposes `checkBudget` (pre-flight), `recordCall` (post-call → `llm_cost_log`), `getClaimSpendInr`. Hard cap **`CLAIM_HARD_LIMIT_INR = 15`** per claim (soft warn at 10). **Every** LLM-calling service (segment/bundle-classify/classify/extract/harmonise) must `recordCall` its spend so the gate is real (this was the CRIT-2 fix — classify/extract/bundle previously checked but never recorded). A follow-up atomic per-claim **reservation ledger** (to close the concurrent-section TOCTOU) is deferred — it needs a schema migration.

### 3.7 Run orchestration & "re-run from scratch"
- `intelligenceOrchestrator.service.ts` owns `analyzeClaim()`. `claim_ai_runs` tracks the run; `doc_phase_ledger` tracks per-document phase settlement and **gates the harmoniser** (the harmoniser only fires once every doc has settled).
- **Force re-run = from scratch.** The FE "Re-run AI Analysis" button calls `analyzeClaim({ force: true })`, which runs `resetClaimDerivedState` first — **wiping `document_sections`, `claim_harmonised_episodes`, and `doc_phase_ledger`** and rebuilding from source. This is intentional: it pays full LLM cost every time, by design. Do **not** re-introduce an incremental / "refresh in place" mode (it wedged the ledger and confused the run counter). **Accepted side-effect:** human field-corrections orphan on a from-scratch re-run (output reverts to pure-AI).

### 3.8 Architectural boundary — interpret, NOT adjudicate
**The single most important rule of the pipeline.** The document pipeline's only job is `documents → (accurate episode JSON + quality signals)`. It **must not** decide hold/file/block — that **adjudication** lives in the **Rules Engine v2 (Wave 8)**.
- When the episode is wrong because a *different patient's* or *different episode's* page leaked in, the fix is to **exclude that page from fusion and emit a signal** — never to veto the whole claim.
- A whole-claim veto (`canHarmonise`, `QUARANTINE`/`INCOMPLETE`/`NEEDS_REVIEW`, `survivorIdentityCount` discriminators) was tried and **deliberately removed**. Do not resurrect any block-deciding discriminator in the pipeline.

### 3.9 v2 vision-native pipeline & benchmark harness (`Services/pipelineV2/`)
A page-first, vision-native re-architecture plus the **eval system that gates AI quality**.
```
pipelineV2/
  pageManifest · pageReader (per-page vision read) · extraction · dedup
  identityGate (is this page THIS claim's patient/episode?) · fusion (build episode)
  validators · runState (non-blocking signals) · types
  harness/  corpus + groundTruth (15-patient ground truth) · scorer (field accuracy) ·
            regression(.baseline.json) (HIT→MISS hard-fail gate) · readBridge (record/replay) ·
            budget + errorBudget (dominant failure bucket) · runner · run · dumpDetail
```
- **Replay mode is FREE** (`LLM_REPLAY_MODE=replay`, `LLM_REPLAY_DIR=…`); **record mode makes REAL paid calls** (needs explicit permission).
- **Regression gate** hard-fails only on a field going **HIT→MISS**; re-bless the baseline (`HARNESS_UPDATE_BASELINE=1`) only after an intended improvement.
- Pursue **systemic** gains (move the dominant `errorBudget` bucket), not per-patient point-fixes. The harness is **not** wired into the production request path — it is the QA gate (§9 / `docs/PROJECT_HANDOFF.md` Part 5).

### 3.10 The learning loop (Waves 4 & 10)
Reviewer corrections (`extraction_corrections`, `corrections`) → `kbPatternMiner` mines patterns → `kbPatterns` / `kbHints` feed back into prompts. `episodicMemory` + `caseEmbedder` (Voyage embeddings) surface similar past cases. Human review compounds into model-input quality over time.

### 3.11 Recent critical fixes
Implemented on `feature/pipeline-v2-vision-native` (type-verified): **CRIT-1** un-stalls the harmoniser (terminal-fire + `claimRunReconciler.cron.ts` self-heal heartbeat); **CRIT-2** records per-call LLM cost so the ₹15 cap is enforceable; **CRIT-3** adds deterministic financial reconciliation (§3.4). Detail: `docs/PROJECT_HANDOFF.md` change log.

---

## 4. Webapp (`webapp/`)

### 4.1 Stack
- **React 19.2.3** (very recent), **TypeScript 4.9.5** (old), CRA 5 + **CRACO 7**.
- **Tailwind 3.4** + **shadcn/ui** (Radix primitives) + `lucide-react` icons.
- **Routing:** `react-router-dom` 7.11 (BrowserRouter).
- **State:** local `useState` + three Contexts (`AuthContext`, `UploadContext`, `HospitalDataContext`). No Redux/Zustand/React Query.
- **Forms:** `react-hook-form` 7.72 + `zod` 3.25 (only in attribute-definition managers).
- **Toasts:** `sonner` mounted globally in `App.tsx`.
- **Files:** `pdfjs-dist`, `react-pdf`, `mammoth` (docx), `jspdf`, `exceljs`, `xlsx`, `browser-image-compression`.
- **HTTP:** `axios` via singleton `services/api.ts` (1065 lines).

### 4.2 Build Config
- `tsconfig.json`: **`strict: false`**, `noImplicitAny: false`, `strictNullChecks: false`. Target `es5`.
- Build script: `DISABLE_ESLINT_PLUGIN=true SKIP_PREFLIGHT_CHECK=true CI=false craco build` — **lint is disabled in CI**.
- `craco.config.js`: only adds `@/*` → `src/*` alias and sets `postcss.mode = file`.

### 4.3 Folder Layout
```
src/
  App.tsx                    routing + role redirect + global toaster + upload panel
  index.tsx
  components/
    ui/                      shadcn primitives (alert, dialog, table, ...)
    common/Skeleton.tsx      ⚠️ duplicate of ui/skeleton.tsx
    forms/                   SelectField, MultiSelectField
    modals/                  AddHospitalModal, AddPanelModal, AddUserModal, PatientModal, PatientPhotosModal/
    Navbar/                  GlobalNavbar
    DoctorDetailsTabs/       Doctor details modal (⚠️ legacy + new folder side-by-side)
    DocumentUploadManager.tsx
    FilePreviewModal.tsx
  context/                   AuthContext, UploadContext
  features/
    attributeDefinitions/    HospitalAttrDefMgr, PanelAttrDefMgr, DoctorAttrDefMgr (⚠️ ~900 LOC each, near-duplicate)
    dashboard/
    panels/
  hooks/                     useAttributeFormRenderer, useAttributeManager, useDocumentUpload, useMasterOptions
  pages/
    auth/                    LoginPage (raw CSS), RegisterDoctor
    superadmin/              SuperAdminPage, HospitalDetailsPage/, MasterOptionsManager/
    admin/                   AdminDashboardPage
    hospital/                Layout (portal sidebar), Dashboard, Panels, PanelDetails, Users, Profile (5 tabs),
                             ClaimAISummary/ (harmonised-episode review surface)
    doctor/                  DoctorProfilePage/, PublicDoctorProfile
    doctors/                 DoctorDirectory
    panels/                  patient-list per panel (legacy)
    HospitalDirectory.tsx
    PublicHospitalProfile.tsx (1027 lines)
  services/api.ts            single God-class for HTTP
  styles/                    Login.css and other CSS files coexisting with Tailwind
  types/                     attributeTypes.ts + ad-hoc
  utils/                     apiTransformers (snake_case ↔ camelCase), attributeValidation
```

### 4.4 Routing & Auth Guards
- `App.tsx` defines `<PrivateRoute roles=[...]>` wrapping protected routes.
- Public routes: `/login`, `/register/doctor`, `/hospitals`, `/doctors`, `/public-profile/:token`, `/hospitals/share/:token`, `/public-doctor/:token`.
- Role-based landing: `/` → superadmin to `/superadmin`, hospital to `/portal/:hospitalId`, otherwise `/dashboard`.
- **Two hospital views coexist:** legacy `/hospital/:hospitalId` (superadmin path) and new `/portal/:hospitalId` (hospital portal). Both reuse `useHospitalData` from the superadmin folder.

### 4.5 API Service Layer
- `services/api.ts` exports a singleton `ApiService` wrapping two axios instances:
  - `this.api` → `/api/v1`
  - `this.apiV2` → `/api/v2`
- Request interceptor: injects `Bearer` from localStorage; strips `Content-Type` for FormData.
- Response interceptor: proper **mutex-based 401 refresh** with subscriber queue — concurrent failures coalesce into one refresh call. Solid implementation.
- On refresh failure: `localStorage.clear()` + `window.location.href = '/login'` (full reload bypasses React Router).
- **Token storage:** localStorage (XSS risk; no HttpOnly cookies).
- **Response shape:** all callers must unwrap `response.data.data` (backend wraps with `apiResponse`).

### 4.6 State Management
- `AuthContext` — user + accessToken; hydrated from localStorage. **`refreshToken` is in localStorage but never in context.**
- `UploadContext` — global upload queue UI panel mounted in `App.tsx` (background uploads survive navigation).
- `HospitalDataContext` — route-scoped, used by `HospitalPortalLayout` and superadmin hospital details.
- Caching: `SuperAdminPage` rolls its own `sessionStorage` cache (`sa_admins`, `sa_hospitals`); other pages refetch on every mount.

### 4.7 Major Page Areas (page → role → notes)
| Page | Role | Notes |
|---|---|---|
| `LoginPage` | All | Uses raw HTML + `Login.css` (not shadcn) — inconsistent. |
| `RegisterDoctor` | Public | TODO: auto-login broken after registration. |
| `SuperAdminPage` | superadmin | Tabbed dashboard, 9 parallel API calls on mount. |
| `HospitalDetailsPage` | superadmin / admin | Legacy hospital view with full doc/doctor/user mgmt. |
| `MasterOptionsManager` | superadmin | Dropdown master-data CRUD. |
| `HospitalPortalLayout` + nested | hospital | Sidebar-driven portal (Dashboard, Panels, Users, Profile). |
| `ClaimAISummary` | hospital / reviewer | Harmonised-episode + AI-pipeline status review surface (polls `intelligenceStatus`). |
| `Profile/AttributesManager` | hospital | **1470 LOC** — attribute fill + verification UI. |
| `Profile/PanelsManager` | hospital | **1594 LOC** — panel attribute mgmt. |
| `Profile/PublicSharingManager` | hospital | Share token CRUD. |
| `DoctorProfilePage` | doctor | Tabbed self-service: profile, credentials, affiliations, sharing. |
| `PublicHospitalProfile` | public | **1027 LOC** single file, two URL aliases. |
| `PublicDoctorProfile` | public | Token-gated doctor view. |
| `HospitalDirectory` / `DoctorDirectory` | public | Searchable lists of public-enabled records. |

### 4.8 Design System
- **shadcn/ui** + Tailwind is the target design system. Slate base, blue brand gradient.
- **Inconsistencies tracked:** Login uses raw CSS; two dialog systems (`dialog.tsx` and `flexible-dialog.tsx`); two skeleton components; `window.alert()` mixed with sonner toasts; `react-multi-select-component` alongside shadcn `Select`.

---

## 5. Mobile App (`Frontend/` — Flutter)

### 5.1 Stack
- **Flutter SDK** `^3.10.4`, Dart with `flutter_lints` 6.0.
- **HTTP:** `dio ^5.9.0` primary; `http ^1.6.0` (inconsistently used by `version_check.service.dart` and Google Static Maps fetch).
- **Token storage:** `flutter_secure_storage ^9.2.2` (Keychain / Keystore).
- **Camera & media:** `camera ^0.11.3`, `gal ^2.3.2`, `photo_manager ^3.8.3`, `image ^4.7.2` (overlay compositing), `flutter_image_compress`, `exif`.
- **Location:** `geolocator ^14.0.2`, `geocoding ^4.0.0`, Google Static Maps API for thumbnail.
- **Permissions:** `permission_handler ^11.3.0`.
- **PDF:** **two libs coexist** — `flutter_pdfview ^1.3.2` and `pdfx ^2.9.2`.
- **Env:** `envied ^0.5.3` — compile-time obfuscated constants from `.env` (`BASE_ADDRESS`, `GOOGLE_MAP_API_KEY`).
- **State:** none (no Provider/Riverpod/Bloc). Each screen instantiates its own `ApiService()`.

### 5.2 Folder Layout (`lib/`)
```
main.dart                  AuthCheck, ConnectivityWrapper, version check
env/                       envied generated config
models/patients.model.dart only model class — everything else is Map<String,dynamic>
screens/                   14 screens, all StatefulWidgets
services/                  api_service, auth_service, upload_service,
                           location_service, image_processor,
                           version_check.service
widgets/                   empty_state, loading_skeleton, pdf_viewer,
                           upload_progress_dialog
utils/toast_utils.dart
```

### 5.3 Key Flows
- `main.dart` → `AuthCheck` → either `LoginScreen` or `PatientListScreen` based on `accessToken` in secure storage.
- `CameraScreen` (630 LOC) streams `Position`, builds a watermark overlay, stamps it onto each JPEG via `package:image` (CPU-bound, **not** in an isolate).
- `UploadService` is a separate Dio instance with 120 s timeouts; **no 401 refresh logic** here (would silently fail mid-upload on token expiry).

### 5.4 Build / Release
- **Android:**
  - `applicationId = com.claimsos.app` (May 2026 change).
  - `namespace = com.twentyfoureleven.claims` (stale, doesn't match applicationId).
  - Release signing config hardcoded in `android/app/build.gradle.kts` with **keystore password in plain text**: `ClaimsKey@2024`. Keystore path is developer-machine-specific.
  - `isMinifyEnabled = false`, `isShrinkResources = false`.
- **iOS:**
  - `PRODUCT_BUNDLE_IDENTIFIER = com.example.hospitalApp` — **still on Flutter template default**.
  - `Info.plist` **missing all permission usage descriptions** — app will crash on iOS permission requests; App Store will reject.
  - No `DEVELOPMENT_TEAM` set, signing unconfigured.
- **CI/CD:** none. No `.github/workflows`, no Fastlane.

### 5.5 Mobile ↔ Backend Contract
- Login: `POST /api/v1/auth/login` with `userName` / `passWord` (note non-idiomatic field names).
- Patients: `GET /api/v1/patient/getActivePatients`.
- Photo upload: `POST /api/v2/uploads/photos` (multipart with `patientId`, `category`, N file parts).
- Version check: `GET /api/v1/version`.

---

## 6. Deployment & Environments

### 6.1 Docker
- `Backend/Dockerfile` (`node:22-alpine`, installs Ghostscript, **runs via `tsx`** — `CMD ["npm","start"]`, no precompile) + `Backend/Dockerfile.dev`.
- `webapp/Dockerfile` + `Dockerfile.dev` + `nginx.conf` — built artifact served by nginx in prod.
- **`docker-compose.yml` (prod) defines four services:**
  - `backend` — `RUN_WORKERS=false`, port `${BACKEND_PORT:-6001}:8000` (API only enqueues).
  - `worker` — **same image, `RUN_WORKERS=true`, no `container_name`** so it can scale: `docker compose up -d --scale worker=N` (remember to divide LLM concurrency caps by N — §3.1).
  - `webapp` — nginx on `${WEBAPP_PORT:-5001}:80`.
  - `redis` — `redis:7-alpine`, append-only persistence.
- Dev: `docker-compose.dev.yml` (hot reload); see `DOCKER_DEV.md`.

### 6.2 Environments
- **Local dev** — backend via `npm run dev` (`tsx watch`, `PORT` from env; container maps `:6001`→`:8000`), webapp on `:3000` (or `:5001` in Docker). Requires Postgres + Redis.
- **Production** — hosted at `claims.24elevenhealthcare.com` (mobile uses `https://claims.24elevenhealthcare.com/api/v1` as `BASE_ADDRESS`); API and worker as separate containers.
- No staging environment evident.

### 6.3 Secrets & key env vars
- Backend reads from `Backend/.env` (⚠️ historically committed — see TECH_DEBT). Validated at boot by `Utils/env.util.ts` (`validateEnv()`), which fails loudly on missing critical vars.
- **Never print or commit secret values:** `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `ENC_KEY`, `POSTGRES_*`, AWS keys, `ANTHROPIC_API_KEY`, Voyage key, UltraMsg instance/token, Google OAuth / Sheets webhook.
- **Operational toggles of note:** `RUN_WORKERS`, `PORT`, `METRICS_TOKEN`, `CLAIM_RUN_RECONCILER_ENABLED` (heavy reconciler PASS1 — keep **dormant**), `CLAIM_RUN_HEARTBEAT_ENABLED` (safe self-heal heartbeat — on by default), `BUNDLE_CLASSIFIER_CONCURRENCY` / `DOC_EXTRACTOR_CONCURRENCY`, `LLM_MAX_CONCURRENT_HAIKU` / `_SONNET`, `LLM_REPLAY_MODE` / `LLM_REPLAY_DIR`, `HARNESS_UPDATE_BASELINE`.
- Mobile bakes obfuscated constants via `envied`; webapp reads `REACT_APP_*` at build time.

---

## 7. Operational Concerns

### 7.1 Backups
- PostgreSQL: assumed manual snapshots (no automation in repo).
- S3: versioning / lifecycle posture unknown.
- Google Drive: **removed (May 2026)** — the Drive uploader, startup recovery, and backup queue are no-ops; `ipd_doc.drive_backup_*` columns are vestigial.

### 7.2 Monitoring & self-healing
- Prometheus metrics from `/metrics` (consumer external; token-gated).
- Worker health via `/health/worker` (queue depths + DB-derived liveness).
- **`claimRunReconciler.cron.ts`** self-heals stranded `claim_ai_runs`: PASS2 (safe, bounded heartbeat that drives stall/orphan detectors + the Fix-17 harmoniser auto-heal) runs always-on; PASS1 (heavy Sonnet-vision re-drive) stays dormant behind `CLAIM_RUN_RECONCILER_ENABLED`.
- Structured `pino` logs (no external aggregation wired in repo).

### 7.3 Rate Limiting
- None. No `express-rate-limit` or equivalent on the HTTP layer. (LLM-side concurrency is bounded per §3.1.)

### 7.4 CORS
- Hardcoded localhost ports plus comma-separated `CORS_ORIGIN` env. `credentials: true`.

---

## 8. Extending the System (Cookbook)

### 8.1 Add a new hospital attribute type
1. Superadmin → Hospital Attribute Configurator → "Add Attribute".
2. Pick category (existing or new), data type, required/has_expiry/requires_document flags.
3. (Optional) link a `master_options` category for `select` data type.
4. Save. New attribute appears in `AttributesManager` for every hospital automatically.

### 8.2 Add a new API endpoint
1. Add route in `src/Routes/<resource>.routes.ts` with appropriate middleware.
2. Add controller in `src/Controllers/<resource>.controller.ts` using `asyncHandler` wrapper + `apiResponse`.
3. Add service method in `src/Services/<resource>.service.ts` with parameterized SQL.
4. Mount router in `src/index.ts` if new file. **Beware route ordering** — `/api/v1/hospitals/:hospitalId` is a catch-all; specific paths must come before it.

### 8.3 Add a new webapp page
1. Add route in `App.tsx` inside `<PrivateRoute roles=[...]>`.
2. Place page under `pages/<role>/<feature>/index.tsx`.
3. Use shadcn primitives + Tailwind. Pull data via `apiService.<method>` from `services/api.ts`.
4. For forms: prefer `react-hook-form` + `zod`. For toasts: `sonner`. Do **not** use `window.alert()`.

### 8.4 Database migration
1. `npm run migrate:create <short_name>` (or add `src/schema/migrations/<NNN>_<short_name>.sql`).
2. Use `IF NOT EXISTS` defensively; apply with `npm run migrate:up` (rollback `migrate:down`).
3. **Never** put hospital-specific data SQL in `migrations/` — use `seeds/`.
4. Update `src/schema/schema.sql` to reflect canonical state.

### 8.5 Add / change a pipeline stage or prompt
1. Prompts live in `Services/llm/prompts/*.v1.ts` and are **versioned** — bump the version when changing the contract (the harness baseline is keyed to behavior).
2. Validate every model output with a zod schema in `Services/llm/schemas/`.
3. **Record per-call cost** via `costAccounting.recordCall` (§3.6) — the budget gate depends on it.
4. For a deterministic post-LLM cross-check, add a **Fix-N block** in `harmonisation.service.ts` (own `try/catch`, mutate `episode`/`vm` only — §3.4).
5. Re-run the **benchmark harness** in replay mode and check the regression gate before merging (§3.9).

### 8.6 Run the benchmark harness
- Free: `LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=<dir>` against `Services/pipelineV2/harness/`.
- The gate hard-fails on any field HIT→MISS; re-bless only after an intended improvement (`HARNESS_UPDATE_BASELINE=1`). Record mode makes real paid calls — get explicit permission first.

---

## 9. Known Risks (high-level)

See `TECH_DEBT.md` for the full prioritized list and `docs/PROJECT_HANDOFF.md` for contributor-facing detail. Top-of-mind for any new work:

- **No `tsc` gate.** Prod runs via `tsx` (transpile-only); the repo's installed TypeScript is a stale 4.9.5 and there is no build step, so **type errors don't block runtime**. The intelligence layer carries latent TS-5 errors (documented in the Dockerfile). Type-check with a **pinned TS 5.4.5 under Node 22** against `Backend/tsconfig.json`; the bar is *zero new errors on your edited lines*, not zero total.
- **Incomplete host `node_modules`.** Several deps (`@anthropic-ai/sdk`, `pdf-*`, `tesseract.js`, `jsonpath-plus`, `expr-eval`) are declared but not installed on a bare host, so some tests/imports fail locally; the Docker worker image has the full set. Consider a dev-container mirroring the worker image.
- **LLM cost TOCTOU:** the ₹15/claim cap is enforced via `recordCall`, but concurrent sections can still slightly overshoot until the deferred reservation ledger lands (§3.6).
- **Financial extraction quality:** discharge-slip totals are often not captured; reconciliation now makes the gap *visible* (`no_financial_data`) but the underlying capture is still weak.
- **Schema drift:** `hospital_assignments.is_active` referenced in code but not in schema (see `schema/SCHEMA_DRIFT_AUDIT.md`).
- **Auth bug:** `jwt.decode` instead of `verify` in refresh path.
- **iOS unshippable** until Info.plist + bundle id fixed; **lint disabled in webapp CI**; **three near-duplicate attribute configurators** (~900 LOC each) waiting to be unified.

---

*Source audits are archived at `docs/archive/`. For product context see `PRODUCT_SPEC.md`; for role-based onboarding see `docs/PROJECT_HANDOFF.md`; for prioritized cleanup see `TECH_DEBT.md`. Intelligence-layer design docs live under `docs/intelligence/` and `docs/v2/`.*
