# ClaimOS Deployment Runbook

The one page an operator follows. Companion to `DEPLOYMENT_HARDENING.md` (which
explains *why* each of these exists) and `Backend/src/schema/README.md` (which
explains the schema layer in detail).

**Two rules that cover most of the incidents this runbook exists to prevent:**

1. `docker compose restart` does **not** re-read `env_file`. After any edit to
   `Backend/.env`, use `docker compose up -d --force-recreate`.
2. Never rename a migration and never renumber a seed. Production matches
   migrations by **name** in `hospital.pgmigrations`; a rename silently re-runs
   the file. The CI guard (`npm run lint:migrations`, rule R12) rejects it.

**Spending too much on Claude Vision? Go straight to [§ 8](#8-cost--rollback--claude-vision-spend).**

---

## 1. New environment (empty database)

```bash
cp Backend/.env.example Backend/.env      # then fill it in
docker compose up -d
```

That is the whole procedure. The `migrate` service is a one-shot gate that runs
before anything else starts:

```
migrate:  npm run check-env   →  npm run db:bootstrap
                                 ( = migrate:up  &&  seed )
```

* `check-env` fails in ~2 seconds with a **named variable** if the config is
  wrong — instead of surfacing later as a migration timeout or a 500 at first
  request.
* `migrate:up` applies `000_genesis` → `075` against the empty database.
* `seed` applies every file in `Backend/src/schema/seeds/` and records each
  file's sha256 in `hospital.seed_applications`.

`backend` and `worker` are gated on `migrate: condition:
service_completed_successfully`, so they start **only** if that exits 0. Both
are additionally gated on `redis: condition: service_healthy`, which waits for
Redis to actually accept connections rather than merely for its container to
exist.

Verify:

```bash
docker compose ps                 # migrate = Exited (0); everything else healthy
docker compose logs migrate
```

---

## 2. Existing production — first deploy on this change

Order matters here. Do not skip straight to (d).

**a. Audit the ledger (read-only).**

```bash
npm run db:reconcile-ledger:dry
```

Read the plan. Expect:

| name | expectation |
| --- | --- |
| `000_genesis` | **STAMP** (its objects exist by construction — 001 ALTERs `ipd_doc` and calls `update_modified_column()`) |
| `066_derived_page` … `073_inbound_auth_results` | **STAMP** or already present (the bootstrap script stamped only 001→065) |
| everything else | already present |
| any row | **zero UNKNOWN**, **zero ORDER VIOLATION** |

An `UNKNOWN` means a migration has no evidence probe in
`ledger-manifest.json` — fix the manifest, do not guess. An `ORDER VIOLATION`
means `migrate:up` would abort mid-deploy with *"Not run migration X is
preceding already run migration Y"*; stop and resolve it before deploying.

**b. Apply the reconciliation.**

```bash
npm run db:reconcile-ledger
```

This also de-duplicates `hospital.pgmigrations` and adds the missing unique
index on `name`. That index is the fix for a live bug: `prod-bootstrap-final.sql`
stamps 65 rows with `ON CONFLICT DO NOTHING`, but the table it created has only
`id SERIAL PRIMARY KEY` — no unique index on `name` — so the conflict target can
never fire and every re-run duplicated all 65 rows.

**c. Validate the live env BEFORE deploying.**

```bash
npm run check-env:api
npm run check-env:worker
```

Expect `REDIS_URL` and `ANTHROPIC_API_KEY` to be the ones that surface: neither
has ever been validated, and `REDIS_URL` has a `redis://localhost:6379` default
in 20 worker files that silently resolves to the container's own loopback.

**d. Deploy.**

```bash
docker compose up -d --force-recreate
```

`migrate:up` now applies only `074` and `075`. `run-migrations.cjs`'s pre-flight
stamps `000_genesis` anyway as a belt-and-braces backstop, so step (a)/(b) being
skipped by a hurried operator still does not break the deploy.

**e. Seed.**

```bash
npm run seed
```

The first run applies every seed file and records its checksum. Subsequent runs
report `0 applied, N unchanged`.

---

## 3. Routine deploy

```bash
docker compose up -d --force-recreate
```

**`docker compose restart` does NOT reload `env_file`.** A restart after an
`.env` edit leaves the container running on the old values, which has bitten
this team before — the symptom is a config change that "didn't take".

---

## 4. Changing seed data

Edit the file under `Backend/src/schema/seeds/`. Its sha256 changes, so the next
`npm run seed` re-applies **just that one** file and updates its ledger row.
That is the intended release mechanism.

```bash
npm run seed:dry      # print the plan: apply / unchanged / new. Touches nothing.
npm run seed          # apply
```

Rules the CI guard enforces on seeds:

* every statement is `INSERT … ON CONFLICT …` or `UPDATE … WHERE` — no bare
  `INSERT`, no `DELETE`;
* no DDL (that belongs in `migrations/`) and no `BEGIN`/`COMMIT` (the runner
  owns the transaction);
* never renumber a seed, never rename a migration.

---

## 5. Failure playbook

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Not run migration 000_genesis is preceding already run migration 001_add_s3_support` | prod's ledger is stamped 001+ but has no `000_genesis` row; node-pg-migrate's order check aborts before applying anything | `npm run db:reconcile-ledger:dry` then `npm run db:reconcile-ledger`. (`run-migrations.cjs` also stamps it pre-flight; `--no-preflight` disables that.) |
| `ERROR: relation "idx_…" already exists` | a migration lost its `IF NOT EXISTS` guard | `npm run lint:migrations` names the file and line; `--fix` rewrites the mechanical rules |
| `ERROR: column "hospital_id" does not exist` during migrate | a curated `_fixed` duplicate created the table with a narrower shape and a later file indexes a column it lacks | the later file needs `ADD COLUMN IF NOT EXISTS` shims, not just `IF NOT EXISTS` on the index |
| Worker healthcheck red, `/health/worker` returns `{"status":"API_ONLY"}` | `RUN_WORKERS` is wrong on that service — it must be unset or `true` on `worker`, and `false` on `backend` | fix the service's `environment:` block and `up -d --force-recreate` |
| Boot exits 1 with *"REDIS_URL points at localhost in production"* | Compose needs the service name, not loopback | `REDIS_URL=redis://redis:6379` |
| Boot exits 1 with *"… has leading/trailing whitespace"* | a pasted secret carried a trailing space; `docker run --env-file` rejects these outright while Compose silently tolerates them | strip the space in `Backend/.env` |
| Queues never drain, no errors in the log | the silent `redis://localhost:6379` default — the classic failure this validation exists to kill | `npm run check-env:worker` |
| `/metrics` returns 503 | `METRICS_TOKEN` unset (deny-by-default) | set it and have Prometheus scrape with `bearer_token` |
| `spawn … node-pg-migrate ENOENT` in the migrate container | the image was built with a production-only install while `node-pg-migrate` was still a devDependency | it is now a `dependency`; rebuild the image |
| Gmail poll throws on first decrypt | `ENC_KEY` unset or not 32 bytes | `openssl rand -base64 32`; boot validation now catches this in production |
| Anthropic spend climbing, extraction slow | the document engine is vision-first — one provider call per page, ₹4.985 per tiled page read | [§ 8](#8-cost--rollback--claude-vision-spend). The env flag alone is **not** the whole revert |
| Claims dead-lettering with `LlmBudgetExceededError`, `reason` naming the claim **hard limit** | the claim's **reasoning** cap (`CLAIM_HARD_LIMIT_INR`, default ₹40) is exhausted — usually several tiled `doc_extract.<category>` sections at ₹5-8.65 each | [§ 8](#8-cost--rollback--claude-vision-spend) *"What each cap protects"*. Raise the env var + `--force-recreate`; no deploy |

---

## 6. Scaling workers

```bash
docker compose up -d --scale worker=N
```

Each replica enforces its **own** per-queue concurrency caps and its own
per-pool LLM semaphore, so effective concurrency against the Anthropic account
multiplies by N. Before scaling, divide these by the replica count in
`Backend/.env`:

* `BUNDLE_CLASSIFIER_CONCURRENCY`, `DOC_CLASSIFIER_CONCURRENCY`,
  `DOC_EXTRACTOR_CONCURRENCY`, `DOC_SEGMENTER_CONCURRENCY`,
  `HARMONISER_CONCURRENCY`
* `LLM_MAX_CONCURRENT_HAIKU`, `LLM_MAX_CONCURRENT_SONNET`

Set `WORKER_REPLICAS=N` too — it is injected into the worker container so the
division is auditable from inside it. Making the caps genuinely global needs a
Redis-backed limiter; that is filed as a follow-up and is not in this change.

---

## 7. What CI guarantees

`.github/workflows/db-and-env.yml` runs on every PR and push:

1. **`lint-migrations`** — static idempotency guard over `migrations/` and
   `seeds/`. Rules R1–R12, zero false positives on comment-embedded SQL, empty
   allowlist by design.
2. **`check-env`** — proves the validator accepts a complete config
   (`Backend/.env.ci`) *and* exits 1 on an incomplete one and on
   `redis://localhost` in production. Asserting the failure path is the point.
3. **`from-scratch-migrate`** — `postgres:16`, then `migrate:up` → `seed` →
   `migrate:up` → `seed` → `db:reconcile-ledger:dry`, and finally
   `git status --porcelain` must be empty. This is what makes "a new
   environment comes up with one command" a tested claim.

---

## 8. Cost & rollback — Claude Vision spend

The document engine is **vision-first** as of Sep 2026: a page with no usable
typed text is read by Claude Vision (high-DPI overlapping tiles + deskew) rather
than by Tesseract. It is the largest per-claim cost item in the system, and it
is the one that can run away.

### The unit economics — measured, not estimated

Everything in this section, and both caps below, derive from these numbers.
They were measured on the certification corpus on **2026-09-14** (Sonnet 4.5,
`USD_TO_INR_RATE = 83` in `claudeClient.ts`) and they are **per LLM call**, not
per sheet of paper:

| what | cost | measured on |
| --- | --- | --- |
| `doc_extract.<category>`, tiled, **dense A4 portrait**, itemised | **₹8.646** | n=3, 416/416 cells = 100.00% |
| `doc_extract.<category>`, tiled, **landscape** bill, itemised | **₹5.003** | n=2, 196/196 cells = 100.00% |
| `ocr_vision_page`, one page read | **₹4.985/page** | dense A4 portrait bundle |
| the same two extractions **before tiling** | ₹7.42 portrait / ₹3.74 landscape | same pages, untiled |
| single-image (untiled) vision page | ~₹0.50-1.20 | sparse pages |
| vision tokens / text tokens | ~₹2 per 1k / ~₹0.07 per 1k | |
| worst case, one document read | `OCR_VISION_MAX_PAGES_DOCUMENT` = 40 pages ≈ **₹200** | |

Read the fourth row before you argue about the caps. **Tiling made the
extractor 17% more expensive per dense-portrait section (₹7.42 → ₹8.646) and
34% more expensive per landscape section (₹3.74 → ₹5.003).** That is what
bought the two 100.00% accuracy numbers, and it is a real recurring cost, not a
rounding error — it lands on `doc_extract.*`, which is the **reasoning**
dimension, not the OCR one.

### What each cap protects — sign these, don't inherit them

There are two per-claim caps and they are not interchangeable. Both live in
`costAccounting.service.ts`, both are read per call, and both are now
env-readable:

| cap | env var | default | covers | what happens at the cap |
| --- | --- | --- | --- | --- |
| per-claim **reasoning** | `CLAIM_HARD_LIMIT_INR` | **₹40** | segment, bundle-classify, classify, **`doc_extract.<category>`**, harmonise, reasoning agent | `checkBudget` → `'block'` → `LlmBudgetExceededError` → 3 Bull retries → **dead letter** |
| per-claim **page transcription** | `CLAIM_OCR_HARD_LIMIT_INR` | ₹300 | `ocr_vision_page`, `ocr_vision_image`, `ocr_vision_read`, `ocr_vision_fallback` | remaining pages **degrade to Tesseract**; the claim completes with worse text |

Soft warns (`CLAIM_SOFT_LIMIT_INR`, `CLAIM_OCR_SOFT_LIMIT_INR`) default to 70%
of their hard cap and only annotate the verdict's `reason` — they never change
an action.

**The reasoning cap is a stop button, the OCR cap is a quality dial.** If you
have to cut spend in an incident, cut the OCR one first: it degrades text,
whereas cutting the reasoning one stops claims from being processed at all.

**Why the reasoning cap is ₹40 and was ₹15 until 2026-09-14.** ₹15 was set when
a section extraction was a paragraph of Tesseract text. It is now a tiled
vision call. The arithmetic that forced the change is two lines:

```
2 × ₹8.646 = ₹17.29  >  ₹15
```

Two itemised-bill sections on one claim — a final bill and a pharmacy bill,
which is the *ordinary* shape of an Indian cashless claim — exceeded the cap,
so the second one blocked and the claim dead-lettered with half its money
un-extracted. That is a stopped pipeline, not an overspend. ₹40 is sized
against the measured numbers above:

```
fixed per claim   doc_segmenter ~₹0.9 + doc_bundle_classify ~₹2.1   ₹3.00
4 × dense-portrait itemised extraction       4 × ₹8.646            ₹34.58
                                                            total  ₹37.58   (₹2.4 spare)
```

So ₹40 buys **four** worst-case tiled dense-portrait itemised sections (or
seven landscape ones) plus the fixed segment/classify overhead. A fifth dense
itemised section does not fit, and that is deliberate: a claim wanting five
dense itemised bills is a claim a human should look at. **Do not lower this
below ~₹20 without also turning tiling down — ₹15 reproduces the dead-letter.**

**The tail ₹40 does not cover, so you recognise it when it pages you.** ₹8.646
is a *single-page* section. One `doc_extract` call attaches up to 8 rendered
pages (`MAX_VISION_PAGES` in `docExtractor.service.ts` — a hardcoded 8 that
`OCR_VISION_MAX_PAGES` does **not** reach), each as overview + ~3 tiles ≈ 6,272
image tokens ≈ **₹1.56/page of image input**. A maxed 8-page itemised section is
therefore ~₹12.5 of images before a single output token, and two of them
exhaust ₹40. A claim of long multi-page bills is the case to raise
`CLAIM_HARD_LIMIT_INR` for — and as of 2026-09-14 that is an env change and a
`--force-recreate`, not a deploy.

The OCR cap's ₹300 is the same kind of number: at ₹4.985/page it buys one full
40-page scanned bundle (~₹200) plus a second smaller document on the same
claim, and the failure mode past it is degraded text rather than a stopped
claim, so it is the safer of the two to tighten.

Every lever below is read **per call**, not at import time. Edit `Backend/.env`,
then `docker compose up -d --force-recreate` (a `restart` does not re-read
`env_file`); the next extraction picks it up. No rebuild, no code deploy. That
now includes both rupee caps — until 2026-09-14 `CLAIM_HARD_LIMIT_INR` was a
hard-coded `const` and raising it took a deploy. Per-variable annotation lives
in `Backend/.env.example` under *"Document extraction engine — the vision spend
levers"*; the caps are the *"THE PER-CLAIM SPEND CAPS"* block inside it.

### The one-line revert

```bash
# Backend/.env
DOC_EXTRACT_DEFAULT_MODE=ocr
```

```bash
docker compose up -d --force-recreate
```

That single flag reverts **both** layers: `docExtractor`'s default extraction
mode *and* (while `OCR_ENGINE` is unset) `ocr.service`'s engine, so no per-page
Anthropic call survives it. Reverting behaviour without reverting spend was a
real bug in this switch; it is fixed, and the flag is the first thing to reach
for.

> **`DOC_EXTRACT_DEFAULT_MODE=ocr` IS NOT A COMPLETE ROLLBACK.** On a seeded
> database it leaves the *majority* of the catalog reading from images. It is
> step 1 of 3, not the whole procedure. Do not set it, watch a graph for ten
> minutes, and declare the incident handled — run the SQL in the next section
> too, and read the residual note after it. The three steps, in order:
>
> 1. `DOC_EXTRACT_DEFAULT_MODE=ocr` + `--force-recreate` — covers the 140
>    categories whose `extraction_mode` is NULL, and the `ocr.service` engine.
> 2. **The `UPDATE … SET extraction_mode = 'ocr'` below** — the only thing that
>    covers the 106 pinned categories. No env var reaches them.
> 3. A deploy, for the 3 hardcoded `HINDI_LIKELY_CATEGORIES`. No flag and no
>    SQL reaches those.

### What the one-line revert does NOT cover — read this before declaring victory

`DOC_EXTRACT_DEFAULT_MODE` sets the **default** for a category, and only for a
category that *has* no explicit one. An explicit
`hospital.master_options.extraction_mode` value wins over it in both directions,
and a freshly seeded database ships **106 doc_category rows already pinned** —
**98 pinned `'vision'`** (handwritten clinical notes, consent forms, OT notes,
ECGs, patient photos) and **8 pinned `'auto'`** — exactly `admission_notes`,
`discharge_slip`, `discharge_summary`, `echo`, `follow_up_advice`,
`follow_up_prescription`, `specialist_consultation_reports`,
`ultrasound_reports`. That is 98 + 8 + 140 NULL = the 246-row catalog in
`Backend/src/schema/seeds/010_master_options_doc_category.sql`; count them on
the live database with query 2a below. Every pinned row keeps reading from
images with the flag set.

The 8 `'auto'` rows deserve their own warning, because the revert makes them
*worse*, not better. `'auto'` starts on the text path and escalates to the
extractor's own vision path when the OCR text comes back sparse — average
confidence below 0.35 **and** under 50 alphanumeric characters, or any
Devanagari at all. Engaging `DOC_EXTRACT_DEFAULT_MODE=ocr` forces that first read
to Tesseract, and Tesseract on a handwritten nursing-home discharge summary is
exactly what produces sparse low-confidence text. So the flag makes the
escalation *more* likely to fire, and the escalation does not consult the flag.
Un-pin them (step 2) or they will keep spending.

**Why no env var reaches them — the mechanism, so you can stop looking for one.**
`docExtractor.service.ts` resolves the section's mode first, and a pinned
`'vision'` goes straight down the image path — the
`if (extractionMode === 'vision') { … buildVisionAttachments(…) }` branch in
`extractSection` (`docExtractor.service.ts:702-712` at the time of writing; grep
the condition, that file moves).
`buildVisionAttachments` calls `prepareVisionInput` — render → deskew → tile →
attach — and hands the images to the LLM client itself. **It never calls
`ocr.service` at all.** So `OCR_ENGINE` and `OCR_VISION_FALLBACK_DISABLED`,
which are `ocr.service`'s own flags, are not "overridden" on that path; they are
simply never consulted. `OCR_VISION_FALLBACK_DISABLED=true` is described as a
hard kill-switch that outranks caller intent, and it is — *for every vision call
`ocr.service` makes*. The extractor's own pinned-`'vision'` section reads are not
among them. A pinned `'auto'` category escalates through the very same
`buildVisionAttachments` call, so it is not among them either.

| Lever | stops `ocr.service` per-page vision reads | stops a category pinned `'vision'` / `'auto'` |
| --- | --- | --- |
| `DOC_EXTRACT_DEFAULT_MODE=ocr` | yes | **no** — only categories whose mode is NULL |
| `OCR_ENGINE=tesseract` | yes | **no** — that path never reaches `ocr.service` |
| `OCR_VISION_FALLBACK_DISABLED=true` | yes (hard kill, outranks caller intent) | **no** — same reason |
| `OCR_VISION_MAX_PAGES` and friends | caps pages | **no** — caps, does not stop |
| the SQL below | n/a | **yes — this is the only real revert** |

To stop vision spend on the pinned categories, un-pin them. This takes effect on
the next extraction — no restart, no deploy, because the mode is read per
section. Copy-paste exactly this:

```sql
-- ── STEP 2 of the rollback. THE ONLY THING THAT STOPS THE 106 PINNED ROWS. ──
-- Run as the migration/app role against the ClaimOS database.

-- 2a. Look before you leap: what is pinned right now? Save this — the
--     "Putting it back" step below needs it.
SELECT extraction_mode, COUNT(*) AS categories
  FROM hospital.master_options
 WHERE category = 'doc_category'
 GROUP BY extraction_mode
 ORDER BY extraction_mode NULLS LAST;
-- Freshly seeded: vision 98, auto 8, NULL 140.
```

Still in `psql`, snapshot the current pins to a file before you change them:

```text
\copy (SELECT code, extraction_mode FROM hospital.master_options WHERE category = 'doc_category' AND extraction_mode IS NOT NULL ORDER BY code) TO 'extraction_mode_before_rollback.csv' WITH CSV HEADER
```

```sql
-- 2b. FREEZE. Every pinned category falls back to the text path.
--     Expect "UPDATE 106" on a freshly seeded database.
--     Deliberately scoped to the pinned rows only: it must NOT touch the 140
--     NULL rows, because NULL is what makes them follow
--     DOC_EXTRACT_DEFAULT_MODE, and overwriting that would turn step 1 into a
--     no-op and make the rollback much harder to undo.
UPDATE hospital.master_options
   SET extraction_mode = 'ocr'
 WHERE category = 'doc_category'
   AND extraction_mode IN ('vision', 'auto');

-- 2c. NARROWER ALTERNATIVE to 2b — the high-volume categories only, if you
--     would rather keep vision on the low-volume ID/consent documents.
--     Run this INSTEAD of 2b, not after it.
UPDATE hospital.master_options
   SET extraction_mode = 'ocr'
 WHERE category = 'doc_category'
   AND code IN (
     'treatment', 'icps', 'nursing_charts', 'progress_notes',
     'daily_progress_notes', 'daily_clinical_notes', 'clinician_notes',
     'icu_charts', 'icu_flow_sheets', 'nursing_notes', 'case_sheet',
     'bed_head_ticket', 'vitals_monitoring_sheet',
     'medication_administration_record', 'medication_charts',
     'discharge_summary'
   );
```

Confirm it took, in the same session:

```sql
SELECT COUNT(*) AS still_on_vision
  FROM hospital.master_options
 WHERE category = 'doc_category'
   AND extraction_mode IN ('vision', 'auto');
-- Expect 0 after 2b.
```

**Putting it back** when the incident is over — replay the CSV you saved in 2a,
or hand the whole catalog back to the committed defaults. Both lines are
required, in this order:

```sql
UPDATE hospital.master_options SET extraction_mode = NULL
 WHERE category = 'doc_category';
```
```bash
node src/schema/run-seeds.cjs --force --only 010_master_options_doc_category
```

The re-seed is what re-pins the 98 `'vision'` + 8 `'auto'` rows — it can only do
that because the mode is NULL again (the seed resolves this column as
`COALESCE(existing, EXCLUDED)`, so a row that still says `'ocr'` keeps saying
`'ocr'` forever). Running the `UPDATE` *without* the re-seed leaves all 246
categories following `DOC_EXTRACT_DEFAULT_MODE`, which is `vision` unless you
also left that flag set. Do both.

To hand back a single category instead of all of them:

```sql
UPDATE hospital.master_options SET extraction_mode = NULL
 WHERE category = 'doc_category' AND code = 'treatment';
```
```bash
node src/schema/run-seeds.cjs --force --only 010_master_options_doc_category
```

**This edit is durable by design.** A value you put in `extraction_mode` is
treated as operator intent: neither `npm run seed` nor a migration replay
overwrites it. Seed `010` resolves the column as
`COALESCE(existing, EXCLUDED)` — the database wins — and every `UPDATE` that
writes the column in migrations `050`, `051` and `052` is guarded
`AND extraction_mode IS NULL`. Before those guards, the next `npm run seed` *or*
a `db:bootstrap` against a populated database silently reverted exactly the
statement above: a cost dial an operator could not hold. `npm run lint:migrations`
enforces it (rule R13) and reports zero `extraction_mode` debt. See
`Backend/src/schema/seeds/README.md` § *"extraction_mode is operator-owned"*.

### STEP 3 — the residual, and it requires a deploy

Three categories are forced to vision **in code**, not in the database:
`HINDI_LIKELY_CATEGORIES` in `docExtractor.service.ts:178` — `aadhaar_back`,
`ration_card`, `pmjay_letter`. `extractSection` overrides the resolved mode to
`'vision'` for these regardless of what the row says, because Tesseract's
Devanagari output is gibberish (14/30 patients in the May 2026 smoke test).

**No env var and no SQL turns those off.** Setting their rows to `'ocr'` does
nothing — the code override runs after the row is read. They are three
low-volume ID categories, so in almost every incident the right answer is to
leave them; if they genuinely matter, the only lever is editing that set and
deploying.

### Turning the tap down instead of off

```bash
OCR_VISION_MAX_PAGES=4            # per-section budget (default 8)
OCR_VISION_MAX_PAGES_UNATTENDED=1 # inbound email attachments (default 3)
OCR_VISION_MAX_PAGES_DOCUMENT=10  # one document-scope read (default 40)
CLAIM_OCR_HARD_LIMIT_INR=150      # per-claim page-read cap (default 300) — degrades to Tesseract
OCR_VISION_MAX_COST_INR_PER_READ=120 # ceiling on ONE read (default 250)
```

Those four are all page-read levers: past them a page falls back to Tesseract
and the claim still completes. The reasoning cap is the one to leave alone —

```bash
CLAIM_HARD_LIMIT_INR=40           # per-claim REASONING cap. LOWERING THIS STOPS CLAIMS.
```

— because a claim that hits it does not degrade, it dead-letters. Raise it if
claims are failing on budget; lower it only when you have decided that stopping
claims is the outcome you want.

Pages past a budget fall back to Tesseract with a warning on the result — the
document stays readable, it does not fail. `OCR_VISION_CONCURRENCY` (default 3,
max 8) buys latency, not cost, and is per worker replica: divide it by `N`
before `--scale worker=N`, along with the caps in § 6.

`EXTRACT_TILING_ENABLED=0` is a last-resort lever, not a tuning one: it sends
one fitted image per page instead of overview + tiles. It is cheaper and
measurably less accurate — a landscape bill scores 100.00% tiled vs 96.43% as a
single image, because Anthropic re-scales any image over ~1.15 MP. Prefer the
page budgets.

**Known gap — tiling has no middle setting.** `EXTRACT_TILING_ENABLED` is the
*only* runtime lever over tiling, and it is all-or-nothing. The threshold that
actually decides whether a page gets tiled — `minTileResolutionGain`, the
resolution gain a tiled plan must beat to be worth 3-4× the images — is the
hardcoded constant `DEFAULT_MIN_TILE_RESOLUTION_GAIN = 1.1` in
`Backend/src/Services/extractor/imageTiler.ts`. `planTiles()` accepts a per-call
override, but no caller passes one and no environment variable is read for it.

The consequence, if you are looking at a tiling bill you did not expect: a plain
150-dpi A4 portrait scan (1240x1754) clears the 1.1 floor at a 1.36× gain, so it
emits **3 images instead of 1** — roughly 3× the per-page vision cost — on a page
a single fitted image usually reads fine. Raising that floor to ~1.4 would leave
the wide landscape bills tiled (where tiling is worth 100.00% vs 96.43%) while
sending routine portrait scans as one image. There is no way to do that today
without a deploy. Your only runtime option is `EXTRACT_TILING_ENABLED=0`, which
turns tiling off for the landscape bills too — so reach for the page budgets
first, and accept the portrait tiling until the knob is wired.

### Verifying it worked

Spend is recorded per call in `hospital.llm_cost_log`. `ocr.service`'s page
reads are tasks `ocr_vision_page`, `ocr_vision_image` and
`ocr_vision_fallback`; the extractor's own section reads — the ones the pinned
categories drive — are `doc_extract.<category>`, which is how you tell *which*
category is spending:

```sql
SELECT task, COUNT(*) AS calls, ROUND(SUM(cost_inr)::numeric, 2) AS inr
  FROM hospital.llm_cost_log
 WHERE created_at > NOW() - INTERVAL '1 hour'
 GROUP BY task
 ORDER BY inr DESC;
```

Run it before and after. If the vision rows do not fall, the pinned categories
are still doing the spending — go back to the SQL above.

To see a single claim the way `checkBudget` sees it — which dimension its money
landed in, and therefore which cap will stop it — split the same log by task:

```sql
SELECT
  SUM(cost_inr) FILTER (WHERE task LIKE 'ocr_vision%')       AS ocr_inr,
  SUM(cost_inr) FILTER (WHERE task NOT LIKE 'ocr_vision%')   AS reasoning_inr,
  SUM(cost_inr)                                              AS total_inr
FROM hospital.llm_cost_log
WHERE claim_id = '<ipd-id>';
```

`reasoning_inr` is the column compared against `CLAIM_HARD_LIMIT_INR` (₹40) —
**`doc_extract.<category>` counts here, not in `ocr_inr`** — and `ocr_inr` is
the one compared against `CLAIM_OCR_HARD_LIMIT_INR` (₹300). A claim that
dead-lettered on budget will show `reasoning_inr` at or above the cap, almost
always as three or more tiled `doc_extract.*` rows at ₹5-8.65 apiece.
