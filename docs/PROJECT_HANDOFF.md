# ClaimOS — Project Handoff & Knowledge Base

> **Purpose:** a single onboarding document that lets a new contributor — product, architecture, AI, backend, or QA — understand what ClaimOS is, how it is built, and how to contribute safely.
>
> **Status:** Living document. Last substantive update: 2026-06-02 (after the v2 vision-native pipeline benchmark + CRIT-1/2/3 fixes).
>
> **How to read this:** jump to your lens. Each part is self-contained.
> - [Part 1 — Product](#part-1--product-pm-lens)
> - [Part 2 — Architecture](#part-2--architecture-architect-lens)
> - [Part 3 — AI Engineering](#part-3--ai-engineering)
> - [Part 4 — Development](#part-4--development)
> - [Part 5 — QA & Verification](#part-5--qa--verification)
> - [Appendix — Glossary, env vars, file map, change log](#appendix)
>
> **Canonical companions (do not duplicate — read alongside):**
> - [`README.md`](../README.md) — repo entry point + quick start.
> - [`PRODUCT_SPEC.md`](../PRODUCT_SPEC.md) — product scope & roadmap.
> - [`TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) — canonical architecture & folder conventions.
> - [`TECH_DEBT.md`](../TECH_DEBT.md) — prioritized bugs, security holes, cleanup.
> - [`docs/intelligence/`](./intelligence/), [`docs/proposals/`](./proposals/), [`docs/v2/`](./v2/) — design docs for the intelligence layer & v2 pipeline.
> - [`Backend/src/schema/migrations/`](../Backend/src/schema/migrations/) — the authoritative data model (77 migrations as of writing).

---

## Part 1 — Product (PM lens)

### What ClaimOS is

ClaimOS (service name in code: `24eleven-backend`, brand: Finclarity-Tech / 24Eleven Healthcare) is a **hospital-network operations platform for India's cashless health-insurance ecosystem**. Hospitals submit insurance claims (notably under **PMJAY**, India's government scheme, and private insurers) backed by a large pile of evidence documents — admission notes, discharge summaries, bills, implant invoices, pharmacy bills, ID proofs, pre-auth letters, lab reports.

The platform's job is to **capture, verify, structure, and route** that evidence so a claim can move through the cashless lifecycle with far less manual effort, and so insurers/regulators/patients can trust the result.

### The problem we solve

A single IPD (in-patient) claim can carry **40–120+ pages** across many uploaded files, often scanned, sometimes handwritten, frequently containing pages from the *wrong* patient or a *different* hospital episode. Humans process this slowly and inconsistently. ClaimOS uses an AI document pipeline to turn that pile into one **accurate, structured "medical episode"** plus quality signals a reviewer can act on.

### Users / personas

Three roles exist in code (`superadmin`, `admin`, `hospital`):

| Persona | What they do in ClaimOS |
|---|---|
| **Hospital ops / TPA desk** (`hospital`) | Upload claim documents, track claim status, respond to insurer queries, see the AI summary of each claim. |
| **Internal reviewer / admin** (`admin`, `superadmin`) | Review AI output, correct mistakes (corrections feed the learning loop), work the Review Queue of flagged claims, manage hospital/doctor profiles & attributes. |
| **Insurers / regulators / patients** (external) | Consume verifiable public hospital & doctor profiles. |

### The cashless claim lifecycle (where AI fits)

```
Upload docs ──► AI Document Pipeline ──► Harmonised Episode (medical_episode.v2)
   (S3)         (segment→classify→         + quality signals
                 extract→dedup→harmonise)        │
                                                  ▼
                                         Rules Engine v2 (Wave 8)
                                         insurer rule sets → adjudication readiness
                                                  │
                                                  ▼
                                   Actions (Wave 3C): WhatsApp / in-app / email
                                   queries, approvals, rejections
```

### The hard product boundary — **the pipeline interprets, it does not adjudicate**

This is the single most important product rule and it is enforced architecturally:

- **The document pipeline's only job** is: *read the uploaded files → produce an accurate JSON of the patient's treatment journey → flag suspicious documents as signals on that output.*
- It **must not** decide whether to hold, file, or block a claim. That **adjudication** belongs to the **separate rules layer (Wave 8 — Rules Engine v2)**.
- **Why:** separation of concerns. If hold/file logic lives in the pipeline, every business-rule change forces a pipeline change and "should we pay this claim" logic accretes in the wrong place. The pipeline is a pure `documents → (JSON + quality-signals)` function; the rules engine owns decisions.
- **Consequence for accuracy bugs:** when the episode JSON is wrong because a *different patient's* page or a *different episode's* page leaked in, the fix is to **exclude that page from fusion and emit a signal** — never to block the whole claim. (Real example: a hernia-readmission discharge slip was leaking 14/03 dates into a 16/02 fracture claim; excluding the flagged page recovered the correct discharge date and raised corpus field accuracy.)

> A whole-claim veto (`canHarmonise`, `QUARANTINE`/`INCOMPLETE`/`NEEDS_REVIEW` status, `survivorIdentityCount` discriminators) was tried and **deliberately removed**. Do not resurrect any block-deciding discriminator in the pipeline.

### "Re-run AI Analysis" semantics — from scratch, always

The FE "Re-run AI Analysis" button calls `analyzeClaim({ force: true })`. **Force re-run means start from scratch:** wipe all AI-derived state for the claim (`document_sections`, `claim_harmonised_episodes`, `doc_phase_ledger`) and rebuild from the source documents.

- The accepted tradeoff: a force re-run **pays full segment+classify+extract LLM cost every time, by design.** Do **not** re-propose an incremental / "refresh in place" mode to save money — it was explicitly rejected (it wedged the phase ledger and started the run counter mid-count).
- Implemented as `resetClaimDerivedState` in `intelligenceOrchestrator.service.ts`, called when `force===true` before the run cursor opens.
- **Known accepted side-effect:** human field-corrections orphan on a from-scratch re-run (output reverts to pure-AI). Preserving + re-applying corrections across a rebuild would be a separate feature, not the default.

### Current maturity

- Backend, webapp (React 19 + Tailwind + shadcn/ui), and a Flutter mobile app are all live; backend at `https://claims.24elevenhealthcare.com`.
- The AI **document intelligence pipeline** is the actively-evolving core. A **v2 vision-native re-architecture** plus a **benchmark harness** exist under `Backend/src/Services/pipelineV2/`.
- A 15-patient PMJAY corpus was run end-to-end as a benchmark; it surfaced three CRITICAL issues (pipeline stall, missing cost recording, no financial reconciliation) that have since been fixed in code (see [change log](#recent-change-log-crit-123)). The benchmark also confirmed the corpus's `financial_summary` was hollow — see [B7](#part-3--ai-engineering).

---

## Part 2 — Architecture (Architect lens)

### Three applications

```
claimsos/
├── Backend/   Node.js + TypeScript + Express 5  (service name: 24eleven-backend)
├── webapp/    React 19 + Tailwind + shadcn/ui   (CRA + CRACO)
├── Frontend/  Flutter mobile (Android primary, iOS in progress)
└── docs/      Design docs + archive
```

### Backend topology — **two roles from one image**

The same backend image runs in two modes, switched by the **`RUN_WORKERS`** env var:

| Container | `RUN_WORKERS` | Responsibility |
|---|---|---|
| **API** | `false` | Serves HTTP, **enqueues** jobs. Every worker module no-ops at import. |
| **Worker** | `true` (default) | Registers all Bull queue processors + cron schedules; does the heavy LLM/pipeline work. |

Health endpoints (`Backend/src/index.ts`):
- `GET /health/live` — liveness.
- `GET /health/ready` — DB connectivity.
- `GET /health/worker` — on the worker: queue depths + DB-derived liveness (last poll, last send, stuck rows); on the API: `{workers_enabled:false}`.
- `GET /api/v1/health` — full system snapshot.
- `GET /metrics` — Prometheus, **token-gated** via `METRICS_TOKEN` (deny-by-default if unset).

### Infrastructure

| Concern | Choice |
|---|---|
| Language / runtime | TypeScript on Node 22, executed via **`tsx`** (esbuild, transpile-only) — see [toolchain reality](#toolchain-reality-read-this-first). |
| Web framework | Express 5. |
| Async / jobs | **Bull** queues on **Redis** (per-stage queues + crons). |
| Database | **PostgreSQL** (schema `hospital`), `pg` driver, `node-pg-migrate`-style migrations. |
| File storage | **AWS S3** (primary) + **CloudFront** signed URLs (1 hr expiry). Google Drive path is **removed** (May 2026). |
| LLMs | **Anthropic Claude** (Sonnet-class, vision-capable) via `@anthropic-ai/sdk`; **Voyage** embeddings for episodic memory. |
| Messaging | **UltraMsg** (WhatsApp), Gmail (inbound polling + outbound), Google Sheets webhook. |
| PDFs | `pdf-lib`, `pdf-parse`, `pdf-to-png-converter`, `pdfkit`, `sharp`, Ghostscript compression, `tesseract.js` OCR. |
| Observability | `pino`/`pino-http` structured logs (PII-redacting logger), `prom-client` metrics, per-request `X-Request-Id`. |

### The "Waves" model

The intelligence layer is organized as **Waves**, visible in the worker bootstrap in `Backend/src/index.ts`. This is the mental model the whole team uses:

| Wave | Name | Key modules |
|---|---|---|
| **1** | ClaimDossier projector (per-claim event-sourced case file) | `claimDossierProjector.queue.ts`, `claimDossier.service.ts` |
| **2** | Document intelligence pipeline + Email intelligence | `docSegmenter`/`docClassifier`/`docExtractor` queues; `emailIntelligence.queue.ts` |
| **3A/3B/3C** | Stage requirements / Adjudication readiness / Actions dispatch | `adjudicationEngine.queue.ts`, `actionEngine.queue.ts` |
| **4A/4B** | KB pattern mining + Episodic memory | `kbPatternMiner.cron.ts`, `caseEmbedder.queue.ts` |
| **5** | Eval harness (prediction accuracy) | `evalHarness.cron.ts` |
| **7** | **Claim Harmoniser** — canonical `medical_episode.v2` per claim | `claimHarmoniser.queue.ts`, `harmonisation.service.ts` |
| **8** | **Rules Engine v2** — insurer rule sets vs harmonised episode (**the adjudication layer**) | `rulesEngineV2.service.ts` |
| **9** | FE gap-fills (AI audit trail, doc-section correction) | `aiAuditTrail`, `documentSectionCorrection` |
| **10** | Correction-to-KB pipeline (reviewer corrections → learning) | `aiCorrections.service.ts` |
| **12** | **Bundle classifier** (vision-native; replaces segmenter→classifier for new docs) | `docBundleClassifier.queue.ts` |
| **iter7 / Stage 7** | Review queue (superadmin surface for flagged claims) | `reviewQueue.service.ts`, `pipelineV2/runState.service.ts` |

> Waves are **additive layers, not a rewrite history** — most run concurrently. Wave 12 (bundle classifier) is the current default ingestion path; the Wave 2 segmenter→classifier chain is kept as a fallback for very long PDFs and for force re-runs over existing sections.

### Data model overview

Schema namespace is `hospital`. The data model is **defined by the migrations** in `Backend/src/schema/migrations/` (authoritative — read those, not this table). Key AI-pipeline tables:

| Table | Migration | Purpose |
|---|---|---|
| `claim_harmonised_episodes` | (Wave 7) | The canonical `medical_episode.v2` JSONB per claim. |
| `document_sections` | (Wave 2/12) | Per-document classified sections + extracted fields. |
| `claim_ai_runs` | 060 | Tracks each analyze-claim run (progress, status). |
| `doc_phase_ledger` | 061 | Per-document phase settlement; gates the harmoniser. |
| `document_field_schemas` | (various) | Per-category extraction schemas the extractor fills. |
| `extraction_corrections` / `corrections` | 064 | Reviewer field corrections (feed Wave 10 learning; `ON DELETE SET NULL` so they orphan on re-run). |
| `hospital_format_profiles` | 065 | Per-hospital document-format learning. |
| `derived_page` | 066 | v2 page-derivation artifacts. |
| `llm_cost_log` | (cost) | Per-call LLM spend ledger (see CRIT-2). |
| dedup tables (`section_phash_arrays`, …) | 055–058 | Perceptual-hash + content/file dedup. |

Core domain tables (patients, hospitals, doctors, users, attributes, panels, documents/`ipd_doc`, emails) predate the intelligence layer — see `Backend/src/schema/schema.sql` and the early migrations.

### Request & event flow (happy path, IPD claim)

1. Hospital uploads files → **V2 upload API** stores to **S3** (`/api/v2/uploads`), creates document rows.
2. Operator (or automation) triggers **"analyze claim"** → `intelligenceOrchestrator.analyzeClaim()` (API enqueues; worker runs).
3. `claim_ai_runs` opens; `doc_phase_ledger` tracks each doc. If `force`, `resetClaimDerivedState` wipes prior AI state first.
4. **Ingest/classify:** Wave 12 `docBundleClassifier` (one Claude-vision pass over the bundle) → sections; (legacy: `docSegmenter` → `docClassifier`).
5. **Extract:** `docExtractor` fills each section's fields against its `document_field_schema` (vision routing for handwritten categories).
6. **Dedup:** perceptual-hash + content dedup drops duplicate pages/sections.
7. **Harmonise (Wave 7):** `claimHarmoniser` fuses all kept sections into one `medical_episode.v2` JSONB (Claude → `harmoniser.v1` prompt → `harmonisedEpisode` zod schema), then runs post-parse **"Fix-N" enrichment** (laterality consensus, cross-doc identity, **financial reconciliation**).
8. **Signals (Stage 7):** non-blocking `RunSignal[]` (foreign pages removed, multiple identities, possible contamination, coverage gap, low-confidence field) + cost + counts. Flagged claims appear in the **Review Queue**. **No veto.**
9. **Adjudicate (Wave 8):** `rulesEngineV2` evaluates insurer rule sets against the episode → readiness report.
10. **Act (Wave 3C):** dispatch WhatsApp/in-app/email queries, approvals, rejections.

### Deploy & environments

- Local dev: `npm run dev` (backend, `tsx watch`), `npm start` (webapp on :3000 proxying the API). Requires Postgres + Redis. Docker dev via `docker-compose.dev.yml` / `Backend/Dockerfile.dev`.
- Backend port comes from `PORT` (default `8000` in code; dev commonly `6001`).
- Prod: backend at `claims.24elevenhealthcare.com`; webapp via nginx; API and worker as **separate containers** distinguished by `RUN_WORKERS`.

---

## Part 3 — AI Engineering

### The LLM layer (`Backend/src/Services/llm/`)

```
llm/
├── LlmClient.ts          # interface: classify / extract / harmonise result shapes
├── RecordReplayClient.ts # wraps a provider; records responses to disk / replays them (FREE harness runs)
├── factory.ts            # picks the provider (real Claude vs record/replay) from env
├── providers/
│   ├── claudeClient.ts   # Anthropic Claude (vision) — classify/extract/harmonise calls
│   └── voyageEmbedder.ts # Voyage embeddings (episodic memory)
├── prompts/              # versioned prompt builders (…​.v1.ts)
│   ├── docBundleClassifier.v1.ts   docClassifier.v1.ts   docExtractor.generic.v1.ts
│   ├── docSegmenter.v1.ts          harmoniser.v1.ts        pageReader.v1.ts
│   ├── reasoningAgent.v1.ts        emailClassifier.v1.ts   emailExtractor.{approval,query,rejection}.v1.ts
└── schemas/              # zod output schemas
    ├── harmonisedEpisode.ts (medical_episode.v2)  bundleClassifierOutput.ts
    ├── pageRead.ts  reasoningAgent.ts  emailIntelligence.ts
```

**Conventions that matter:**
- Prompts are **versioned** (`.v1`). When you change a prompt's contract, bump the version rather than mutating silently — the benchmark baseline is keyed to behavior.
- Every model output is validated by a **zod schema**. `FinancialSummary` and `ValidationMetadata` inside `harmonisedEpisode.ts` are `.passthrough()` — extra keys persist (this is what lets post-parse enrichment add fields).
- Models: classify/extract/harmonise use **Claude (Sonnet-class, vision-capable)**; embeddings use **Voyage**. The bundle classifier is a **vision** call over rendered pages.

### The document intelligence pipeline (stage by stage)

| Stage | Service | What it does |
|---|---|---|
| Ingest/segment | `docSegmenter.service.ts` (legacy) / `docBundleClassifier.service.ts` (Wave 12 default) | Turn uploaded PDFs into classified **sections**. Bundle classifier does it in one vision pass. |
| Classify | `docClassifier.service.ts` | Per-section category (final_bill, discharge_slip, implant_invoice, pmjay_letter, …). |
| Extract | `docExtractor.service.ts` | Fill the section's fields per its `document_field_schema`. Vision routing for handwritten categories. |
| Dedup | `sectionDedup.service.ts`, `pipelineV2/dedup.service.ts` | Perceptual-hash + content/file dedup. |
| **Harmonise** | `harmonisation.service.ts` (+ `harmoniser.v1` prompt) | Fuse kept sections → one `medical_episode.v2`; run Fix-N enrichment. |
| Signals | `pipelineV2/runState.service.ts` | Non-blocking `RunSignal[]`. |
| Adjudicate | `rulesEngineV2.service.ts` | Insurer rules → readiness (separate layer). |

### Harmonisation & the post-parse "Fix-N" enrichment pattern

`harmonisation.service.ts` (~3,500 lines) is the heart of the AI output. After the LLM returns and zod-parses into `episode`, a series of **non-fatal `try/catch` "Fix-N" blocks** mutate `episode` and `validation_metadata` (`vm`) with **deterministic** cross-checks, then the result is persisted *without re-parsing* (safe because the schemas are `.passthrough()`). Established examples:

- **Fix-5** — laterality consensus (`checkLateralityConsensus`).
- **Fix-7** — cross-document identity (`collectIdValuesAcrossSections`).
- **Fix-18** — **financial reconciliation** (CRIT-3, below).

> **If you add a deterministic post-LLM check, follow this pattern:** wrap it in its own non-fatal `try/catch`, mutate `episode`/`vm` only, never throw out of it, and write any new signal into `validation_metadata` for reviewer SELECTs.

### Financial reconciliation (Fix-18 / CRIT-3) — the most recent AI change

**Finding (B7), confirmed by read-only DB inspection of the 15-patient corpus:** `financial_summary` was **100% LLM-produced and never cross-checked**. Every episode's `financial_summary` was a hollow `{currency:"INR", package_details:{…}}` with **no monetary amount**; 22/22 discharge slips never populated `total_amount`; the only real number in the whole corpus was one `implant_invoice.total_amount`. Nothing flagged the gap.

What was added:
1. `harmoniser.v1.ts` — billing categories get a **4000-char** field budget (vs the 600-char default) so line-item arrays survive into the prompt instead of being truncated.
2. `harmonisation.service.ts buildProvenanceMap` — multi-bill provenance no longer last-write-wins; an **authority priority** (final/consolidated/breakup = 4 > interim = 2 > pharmacy = 1) keeps the most authoritative bill as the recorded source.
3. A **pure** helper `reconcileFinancials(episode, sections)` (+ `parseInrAmount` / `lineItemAmount` / `amountsAgree`): harvests stated totals + summed line items defensively, picks a hospital anchor (final-wins → interim → discharge-slip fallback), tallies pharmacy/implant/sub-bills **separately** (never silently folded), and flags stated-vs-itemised mismatch / conflicting finals / all-empty.
4. **Fix-18** writes `financial_summary.reconciliation` + a reviewer-queryable `validation_metadata.financial_reconciliation` (status incl. **`no_financial_data`**, totals, discrepancies, source_count) — **never clobbering an existing LLM amount.**

The reconciler is **interpret-only**: when there's no money in the docs it reports `status:'no_financial_data'` (an explicit reviewer signal) instead of inventing a number or blocking the claim.

### The v2 vision-native pipeline & benchmark harness (`pipelineV2/`)

A re-architecture toward a page-first, vision-native flow plus the **eval/benchmark system** that gates AI quality.

```
pipelineV2/
├── pageManifest.service.ts  pageReader.service.ts   # per-page vision read
├── extraction.service.ts    dedup.service.ts
├── identityGate.service.ts                          # is this page THIS claim's patient/episode?
├── fusion.service.ts                                # build the episode from kept pages
├── validators.service.ts    runState.service.ts     # non-blocking signals
├── types.ts
└── harness/
    ├── corpus.ts  groundTruth.ts                    # the 15-patient ground truth
    ├── scorer.ts                                    # field-level accuracy
    ├── regression.ts + regression.baseline.json     # HIT→MISS hard-fail gate
    ├── readBridge.ts                                # record/replay bridge (RecordReplayClient)
    ├── budget.ts  errorBudget.ts                    # names the dominant failure bucket
    └── runner.ts  run.ts  dumpDetail.ts
```

- **Replay mode is FREE:** `LLM_REPLAY_MODE=replay` + `LLM_REPLAY_DIR=…` replays recorded responses; no paid calls. **Record mode makes REAL paid LLM calls** and needs explicit permission first.
- The **regression gate** hard-fails only on a field going **HIT→MISS**. Re-bless the baseline (`HARNESS_UPDATE_BASELINE=1`) only after an *intended* improvement.
- Pursue **systemic** accuracy gains (fix the dominant `errorBudget` bucket), not per-patient point-fixes on the small corpus.
- The harness is the only caller of Stage-7 signals — **it is not wired into the production request path.**

### Cost accounting & the budget gate (CRIT-2)

`costAccounting.service.ts` exposes `checkBudget` (pre-flight), `recordCall` (post-call), and `getClaimSpendInr`. Hard cap **`CLAIM_HARD_LIMIT_INR = 15`** per claim (soft warn at 10).

**The CRIT-2 fix:** classify / extract / bundle-classify services previously called `checkBudget` but **never recorded** their spend, so `getClaimSpendInr` under-read and the cap was unenforceable for the dominant cost drivers. Each now calls `recordCall` after its LLM call (writing `llm_cost_log`), matching segmenter/harmonisation. A follow-up (#31) for an **atomic per-claim reservation ledger** (to close the concurrent-section TOCTOU) is deferred — it needs a schema migration.

### The learning loop (Waves 4 & 10)

Reviewer corrections (`extraction_corrections`, `corrections`) → `kbPatternMiner` mines patterns → `kbPatterns` / `kbHints` feed back into prompts. `episodicMemory` + `caseEmbedder` (Voyage embeddings) surface similar past cases. This is how human review compounds into model-input quality over time.

---

## Part 4 — Development

### Toolchain reality (READ THIS FIRST)

This repo's build/test story is unusual. Internalize it before you trust any green/red signal:

- **Prod runs via `tsx`** (esbuild, **transpile-only**). **Type errors do NOT block runtime.** There is **no `tsc` build step** — `npm run build` literally echoes a skip; `npm test` echoes an error and exits 1.
- **The repo's installed TypeScript is stale (4.9.5)** even though `package.json` pins `^5.4.5`. The stale 4.9.5 cannot parse pino 10's TS5-only syntax, so the local `tsc` is effectively unusable. The README's "PR must pass `tsc --noEmit`" convention therefore needs a **pinned 5.4.5 compiler** to be meaningful.
- **To type-check reliably** (what the recent CRIT work used): run an **isolated TypeScript 5.4.5** under **Node 22** against the project tsconfig, leaving the repo `node_modules`/lockfile untouched:
  ```bash
  ~/.nvm/versions/node/v22.14.0/bin/node /tmp/ts5/node_modules/typescript/bin/tsc \
    -p Backend/tsconfig.json --noEmit
  ```
  (Node 22 because tsc.js uses `??`/optional-chaining; an old default shell node will choke.)
- **The host `node_modules` is INCOMPLETE.** `@anthropic-ai/sdk`, `pdf-lib`, `pdf-to-png-converter`, `tesseract.js`, `jsonpath-plus`, `expr-eval`, `pdf-parse` are declared in `package.json` but **not installed on the host**. This produces a persistent bucket of `TS2307 "cannot find module"` errors **and** `ERR_MODULE_NOT_FOUND` at runtime for any file that imports them. **Prod works because the Docker worker image ships a complete `node_modules`.**
- **Net effect:** a clean type-check is **~50 pre-existing errors** that are all in the "missing module" bucket or known latent typings — they are not regressions. When you verify a change, the bar is *"my edited lines introduce zero new errors,"* proven by cross-referencing error line numbers against your `git diff -U0` hunks — not *"zero errors total."*

### How to run locally

```bash
# Backend (needs Postgres + Redis)
cd Backend && cp .env.example .env   # fill ACCESS_TOKEN_SECRET, DB creds, AWS, ANTHROPIC_API_KEY, …
npm install && npm run dev           # tsx watch; PORT from env (default 8000, dev often 6001)

# Webapp
cd webapp && npm install && npm start # :3000, proxies API

# Migrations
cd Backend && npm run migrate:up      # node src/schema/run-migrations.cjs up
```

Docker dev: `docker-compose.dev.yml`. Remember the **API vs worker split** (`RUN_WORKERS`).

### Repo layout (Backend)

```
Backend/src/
├── index.ts            # boot: env validation, routers, worker bootstrap (the Waves map)
├── app.ts              # express app + global middleware
├── Controllers/        # ~47 HTTP controllers
├── Routes/             # ~37 routers (mounted under /api/v1, V2 uploads under /api/v2)
├── Services/           # ~67 services — business logic + the AI pipeline
│   ├── llm/            # LLM clients, prompts, zod schemas (see Part 3)
│   └── pipelineV2/     # vision-native pipeline + benchmark harness
├── Workers/            # ~23 Bull queues + crons (self-gate on RUN_WORKERS)
├── Middlewares/        # auth.middleware.ts, multer.middleware.ts
├── Utils/              # logger (PII-redacting), env.util, crypto, transaction, redis helpers
├── DB/db.ts            # pg pool + connectDB
├── schema/             # schema.sql + migrations/ (authoritative data model) + run-migrations.cjs
└── scripts/
```

> Note: both `Middlewares/` and `middlewares/` exist (case-variant dirs) — a known cleanup item; check which one a given import actually targets.

### Conventions (from README + observed practice)

- **Commits:** present-tense imperative, scoped — e.g. `fix(api): correct deletePatient ownership`.
- **Branches:** `feature/<name>`, `fix/<name>`, `chore/<name>`. (Active line of work: `feature/pipeline-v2-vision-native`.)
- **PRs:** reference a `TECH_DEBT` id or a `PRODUCT_SPEC` roadmap item; type-check must pass (use the pinned 5.4.5 compiler above).
- **New docs:** canonical design → fold into `TECHNICAL_SPEC.md`; transient (sprint/debug) → `docs/working/`, **not the repo root**. (This handoff lives in `docs/`.)
- **Prompts** are versioned; **model outputs** are zod-validated; **deterministic post-LLM checks** go in Fix-N blocks.

### Footguns / gotchas

- `find` is shadowed in some shells here (it can trip a nested-session guard). Use `ls`/Glob or `rg` instead.
- DB host: from the host machine use `localhost:5432`, **not** `host.docker.internal` (doesn't resolve from host). The local DB is named **`finclarity_prod` and holds REAL data** — treat writes as significant.
- Don't `pkill -f tsx` — you may kill unrelated running processes.
- A zod interface without an index signature is **not** assignable to `Record<string, unknown>` — type mock inputs as `any` in tests (this caused a real TS2741 cascade; see CRIT-2 test fix).
- Pre-existing bug class to be aware of: a `classifier_confidence` vs `classification_confidence` typo exists in the harmonisation path; `HarmoniserSectionInput`'s field is **`classifier_confidence`**.

---

## Part 5 — QA & Verification

### Test layout

| Location | Count | Notes |
|---|---|---|
| `Backend/src/Services/__tests__/` | ~22 | Unit tests for services (harmonisation, docClassifier, docExtractor, rulesEngine, adjudication, kbPatternMiner, …). |
| `Backend/src/Services/pipelineV2/__tests__/` | 9 | dedup, extraction, fusion, identityGate, pageManifest, pageReader, runState, validators, harness. |
| `Backend/src/Services/llm/__tests__/` | 2 | claudeClient, recordReplayClient. |

Tests use the built-in **`node:test`** runner (run via `node --test` / `tsx --test`), not Jest. (`npm test` is a no-op stub — don't rely on it.)

### What can and cannot run on the host

- **Cannot run on the host:** any test whose import graph reaches a missing dep (`@anthropic-ai/sdk`, `pdf-*`, `tesseract.js`, …) fails at import with `ERR_MODULE_NOT_FOUND` **before any test body runs**. Installing the deps is **forbidden** (it would mutate `node_modules`/lockfile); exec-ing into the live prod container is off-limits (real data).
- **Can run on the host:** **pure** logic with no heavy imports. The standard workaround for verifying a pure function is a **standalone harness** that pastes the exact function bodies and asserts against known cases. (CRIT-3's `reconcileFinancials` was verified this way — **23 assertions, all passing** — because the full module can't import on the host.)
- **The benchmark harness runs FREE in replay mode** (`LLM_REPLAY_MODE=replay`) and is the primary AI-quality gate.

### The AI-quality gate (most important QA artifact)

The `pipelineV2/harness/` is how AI accuracy regressions are caught:

1. **Ground truth:** `corpus.ts` / `groundTruth.ts` hold the 15-patient hand-labeled corpus.
2. **Scorer:** `scorer.ts` computes field-level accuracy of the produced episode vs ground truth.
3. **Regression gate:** `regression.ts` + `regression.baseline.json` **hard-fail on any field HIT→MISS**. New misses block; improvements require an explicit baseline re-bless (`HARNESS_UPDATE_BASELINE=1`).
4. **Error budget:** `errorBudget.ts` / `budget.ts` name the **dominant failure bucket** so effort targets systemic gains.
5. **Record/replay:** `readBridge.ts` + `RecordReplayClient` make runs deterministic and free in replay.

> QA principle for AI work: **don't chase per-patient point-fixes** on the small corpus; move the dominant error bucket. A local win that doesn't generalize is not a win.

### The 15-patient benchmark (recent) & what it found

The corpus was run end-to-end in two waves — **Wave A** (10 small/medium claims, ≤29 docs) and **Wave B** (7 large claims, 38–117 docs). Independent Claude reads of the source documents produced a reference for scoring. Top CRITICAL findings (all since fixed in code, not yet committed):

| ID | Finding | Fix |
|---|---|---|
| **CRIT-1** | Pipeline **stalled**: a lost terminal queue-fire + zero self-recovery left runs wedged. | Un-swallowable terminal jobId; Fix-17 auto-heal re-enqueue; `claimRunReconciler.cron.ts` self-heal heartbeat (PASS2 always-on; heavy PASS1 dormant behind `CLAIM_RUN_RECONCILER_ENABLED`). |
| **CRIT-2** | LLM **cost not recorded** for classify/extract/bundle → the ₹15/claim cap was unenforceable. | Each service now `recordCall`s its spend; `llm_cost_log` populated. |
| **CRIT-3 / B7** | `financial_summary` was hollow & never cross-checked. | `reconcileFinancials` + Fix-18 enrichment; `no_financial_data` signal. |

### Verification approach when you can't run the tests

The recent CRIT verification establishes the house pattern:
1. **Type-check** with the pinned isolated TS 5.4.5 + Node 22 (above). Bar = *zero new errors on your edited lines*, proven against `git diff -U0` hunks. (Recent run: 55 → 50 total; the drop was exactly 5 pre-existing test errors that got fixed.)
2. **Pure logic** → standalone assertion harness.
3. **Pipeline behavior** → benchmark harness in replay mode + regression gate.
4. Record the result in a short verification note (the recent ones live under `/tmp/claimsos_bench/`; promote anything durable into `docs/`).

### Known open items

- **#31** — atomic per-claim spend reservation ledger (needs a schema migration; deferred).
- Bill-amount **extraction** quality (e.g. `discharge_slip.total_amount` rarely captured) is an extractor/prompt issue, not harmonisation — reconciliation now makes the gap *visible* (`no_financial_data`) rather than silent, but the underlying capture is still weak.
- The stale-`tsc` / incomplete-host-`node_modules` situation is itself tech debt — see `TECH_DEBT.md` and consider a dev-container that mirrors the worker image.
- See `TECH_DEBT.md` for the prioritized bug/security backlog (e.g. historical `jwt.decode` vs `verify`, `deletePatient` ownership check, schema-drift items in `schema/SCHEMA_DRIFT_AUDIT.md`).

---

## Appendix

### Glossary

| Term | Meaning |
|---|---|
| **PMJAY** | Ayushman Bharat — India's government cashless health-insurance scheme; the dominant corpus here. |
| **Cashless** | Insurer pays the hospital directly; the claim must be pre-authorized & documented. |
| **Episode / `medical_episode.v2`** | The canonical structured JSON of one patient's treatment journey for a claim (output of harmonisation). |
| **Section** | A classified, extracted chunk of an uploaded document (e.g. one discharge slip). |
| **Harmonisation** | Fusing all kept sections of a claim into one episode. |
| **Adjudication** | Deciding hold/file/pay — lives in the **Rules Engine v2 (Wave 8)**, *not* the pipeline. |
| **Signal / `RunSignal`** | A non-blocking quality flag on the episode (foreign page, multiple identities, coverage gap, …). |
| **Wave** | An additive feature layer of the intelligence system (see Part 2). |
| **Fix-N** | A deterministic, non-fatal post-LLM enrichment block in `harmonisation.service.ts`. |
| **Replay / Record** | Harness modes — replay reuses recorded LLM responses (free); record makes real paid calls. |

### Environment variables of note

> Names only — **never print or commit secret values.** Secrets here include `POSTGRES_PASSWORD`, AWS creds, `ANTHROPIC_API_KEY`, `ACCESS_TOKEN_SECRET`, `ENC_KEY`, UltraMsg / Google OAuth creds.

| Var | Effect |
|---|---|
| `RUN_WORKERS` | `false` = API-only container; otherwise worker container (registers queues/crons). |
| `PORT` | HTTP port (default 8000; dev often 6001). |
| `METRICS_TOKEN` | Bearer token gating `/metrics` (deny-by-default if unset). |
| `CLAIM_RUN_RECONCILER_ENABLED` | Gates the **heavy** reconciler PASS1 (Sonnet-vision re-drive). Keep **dormant** unless intentionally re-driving. |
| `CLAIM_RUN_HEARTBEAT_ENABLED` | Kill switch for the safe self-heal heartbeat (PASS2, always-on by default). |
| `LLM_REPLAY_MODE` / `LLM_REPLAY_DIR` | `replay` = free deterministic harness runs from recorded responses. |
| `HARNESS_UPDATE_BASELINE` | `1` to re-bless the regression baseline (only after an intended improvement). |
| `NODE_ENV`, `APP_VERSION` | Standard env/version reporting. |
| Postgres / Redis / AWS / Anthropic / Gmail / UltraMsg creds | Connection + integration secrets (see `.env.example`). |

### Quick file map (where things live)

| I want to… | Go to |
|---|---|
| Understand boot order & the Waves | `Backend/src/index.ts` |
| Change the harmonised episode logic | `Backend/src/Services/harmonisation.service.ts` + `llm/prompts/harmoniser.v1.ts` + `llm/schemas/harmonisedEpisode.ts` |
| Touch classification/extraction | `Services/docBundleClassifier|docClassifier|docExtractor.service.ts` + matching `llm/prompts/*.v1.ts` |
| Work the v2 pipeline / benchmark | `Backend/src/Services/pipelineV2/` (+ `harness/`) |
| LLM cost / budget | `Services/costAccounting.service.ts` |
| Run orchestration / force re-run | `Services/intelligenceOrchestrator.service.ts`, `Services/claimAiRun.service.ts`, `Services/docPhaseLedger.service.ts` |
| Adjudication (decisions) | `Services/rulesEngineV2.service.ts` (Wave 8) |
| Queues / crons | `Backend/src/Workers/` |
| Data model | `Backend/src/schema/migrations/` + `schema.sql` |
| Known bugs / debt | `TECH_DEBT.md`, `schema/SCHEMA_DRIFT_AUDIT.md` |

### Recent change log (CRIT-1/2/3)

Implemented on `feature/pipeline-v2-vision-native`, **type-verified, not yet committed** (awaiting explicit sign-off):

- **CRIT-1 (stall):** `claimHarmoniser.queue.ts`, `claimAiRun.service.ts`, new `Workers/claimRunReconciler.cron.ts`, `index.ts`.
- **CRIT-2 (cost):** `costAccounting.service.ts`, `docExtractor/docClassifier/docBundleClassifier.service.ts`, `llm/LlmClient.ts`, `llm/providers/claudeClient.ts`, `__tests__/docClassifier.test.ts`, `__tests__/docExtractor.test.ts`.
- **CRIT-3 (financial reconciliation / B7):** `harmonisation.service.ts` (`reconcileFinancials`, `buildProvenanceMap` priority, Fix-18), `llm/prompts/harmoniser.v1.ts` (financial char budget).

> **Maintainer note:** when these land, move the verification notes out of `/tmp/claimsos_bench/` into `docs/` and add a row to the README documentation table pointing here.
