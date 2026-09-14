import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

/**
 * Cost Accounting Service — Sprint 4
 *
 * Records every LLM call to hospital.llm_cost_log and enforces per-claim
 * and per-hospital spend caps.
 *
 * Recording boundary (IMPORTANT — corrected May 2026): the LLM bridge
 * (Services/llm/*) COMPUTES per-call tokens + costInr but deliberately does
 * NOT write the cost log itself. Each CALLING SERVICE records its own call
 * via `recordCall` right after the bridge returns — docSegmenter,
 * docClassifier, docExtractor, docBundleClassifier, harmonisation,
 * reasoningAgent, emailIntelligence, ocr, episodicMemory. This keeps a
 * single recording point per logical call (no double-counting) while still
 * attributing spend to the right (claimId, hospitalId, task). An earlier
 * version of this header claimed the bridge was the only recorder — that was
 * never true and left classify+extract spend unlogged, which made the
 * per-claim reasoning cap unenforceable (benchmark finding B1). Everything
 * else just READS this log (getClaimSpendInr / checkBudget).
 *
 * Budget model:
 *   - Per claim, REASONING: hard ₹150, soft warn ₹60 (both env-readable — see
 *     `claimHardLimitInr`). Hitting the hard cap blocks any further reasoning
 *     LLM work for that claim until an operator raises it.
 *   - Per claim, OCR PAGE TRANSCRIPTION: its own dimension, hard ₹300 by
 *     default (see below for why it is separate and why it is that big).
 *   - Per hospital, per day:   default ₹3,000, overrideable in hospital_cost_caps.
 *     Soft = 80% of cap (throttle: queue-only, non-realtime calls allowed).
 *     Hard = 100% of cap (block: no LLM calls at all).
 *   - Per hospital, per month: default ₹50,000. Same soft/hard scheme.
 *
 * `checkBudget` returns the strictest verdict across all dimensions
 * supplied (claim, hospital-daily, hospital-monthly, and — when a runId is
 * passed — the run's user-approved budget). The LLM bridge is expected to call
 * this BEFORE the provider call and throw LlmBudgetExceededError on 'block'.
 *
 * ─── THE FOURTH DIMENSION: THE RUN'S APPROVED BUDGET (2026-09-14) ──────────
 *
 * The three caps above are OPERATOR policy: they exist so no single claim or
 * hospital can run away, and a user never sees them. The run budget is a
 * different kind of limit — it is a NUMBER A HUMAN AGREED TO before pressing
 * Run Analysis, and the contract we owe them is that we ask again before
 * spending past it rather than either silently exceeding it or silently
 * stopping short.
 *
 * So it does not block and it does not throttle. It returns the new verdict
 * action 'pause_for_consent', and the caller parks the run (status='paused',
 * pause_reason='cost_consent_required') with spend-so-far and a remaining
 * estimate, to be resumed with more budget or ended cleanly with partial
 * results. Precedence, strictest first:
 *
 *     block  >  pause_for_consent  >  throttle  >  allow
 *
 * A static-cap 'block' still blocks. The user's approval buys headroom INSIDE
 * the operator caps, never through them — consent is not an override.
 *
 * COMPATIBILITY, stated plainly because it is a widening union: any consumer
 * that only checks `action === 'block'` will fall through on
 * 'pause_for_consent'. Every consumer must treat anything other than 'allow'
 * and 'throttle' as "do not make the call".
 *
 * ─── WHY OCR PAGE TRANSCRIPTION IS ITS OWN DIMENSION (2026-09-14, NEW-2) ───
 *
 * The vision-first OCR flip made page transcription an LLM call: ocr.service
 * sends every pixel page to Claude as overview + tiles. Measured on a dense
 * A4 portrait bundle, that is ~6,272 image tokens and ~₹5.4 PER PAGE, so a
 * 40-page scanned bundle costs ~₹217 to READ — before a single classify or
 * extract call has run.
 *
 * When that spend landed in the same bucket as the reasoning cap (₹15 at the
 * time), the result was not overspend, it was a STOPPED PIPELINE:
 *
 *   docBundleClassifier.checkBudget passes at spend ₹0
 *     → the document-scope vision read burns ₹217 against the claim
 *     → getClaimSpendInr sums it
 *     → docClassifier / docExtractor get action:'block'
 *     → LlmBudgetExceededError → 3 retries → dead-letter.
 *
 * Classification and extraction never ran for that claim. The cap designed
 * to stop runaway *reasoning* was being consumed by an *input-size* cost, and
 * a pre-flight check cannot bound the call it authorises.
 *
 * So the two costs are now measured separately, because they scale on
 * different axes and deserve different limits:
 *
 *   - REASONING spend scales with how much thinking a claim needs, and with
 *     how many document SECTIONS that claim has (see the per-section unit
 *     economics on `claimHardLimitInr`).
 *   - OCR spend scales with how many pixel pages the hospital uploaded. It is
 *     bounded by the document, not by us, and the reasoning cap cannot buy
 *     three pages of it. Capping it there does not make OCR cheaper — it
 *     makes the claim fail.
 *
 * The OCR dimension is NOT a licence to spend: `getOcrReadAllowanceInr`
 * returns the rupees a single read may spend RIGHT NOW (claim OCR headroom ∩
 * hospital headroom ∩ per-read cap ∩ the run's approved-budget headroom), and
 * ocr.service enforces that ceiling INSIDE the read — projecting before it
 * starts and re-checking between pages. Pages it cannot pay for are now marked
 * UNREADABLE with reason 'cost_budget' rather than silently degrading to
 * Tesseract; the user is told which pages were not read and what to do about
 * it. That is a bound the old pre-flight never had.
 */

type Queryable = Pool | PoolClient;

// Defaults when no row exists in hospital_cost_caps.
const DEFAULT_DAILY_CAP_INR = 3000;
const DEFAULT_MONTHLY_CAP_INR = 50000;

// Throttle threshold as a fraction of the cap.
const HOSPITAL_THROTTLE_FRACTION = 0.8;

// ── OCR page-transcription dimension ───────────────────────────────────────
//
// Every llm_cost_log task that is a raw page READ rather than reasoning about
// a page. These are excluded from the per-claim reasoning cap and counted
// against CLAIM_OCR_HARD_LIMIT_INR instead. Keep this list in sync with the
// task names ocr.service.ts / visionRead.ts pass to recordCall — a task name
// that is missing here silently reverts to charging the reasoning cap, which
// is the exact failure NEW-2 describes.
export const OCR_TASK_NAMES = [
  'ocr_vision_page', // ocr.service readPdfPagesViaVision (per PDF page)
  'ocr_vision_image', // ocr.service readImageViaVision (single image)
  'ocr_vision_read', // visionRead default task name
  'ocr_vision_fallback', // legacy single-image Sonnet fallback
] as const;

const OCR_TASK_SET: ReadonlySet<string> = new Set(OCR_TASK_NAMES);

/** True when this task is page transcription, not reasoning. */
export function isOcrTask(task: string): boolean {
  return OCR_TASK_SET.has(task);
}

function envPositiveNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Money, as the ledger stores it: NUMERIC(10,4) rounded to paise for display. */
function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

// ── Per-claim REASONING dimension ──────────────────────────────────────────

/** Default per-claim reasoning cap, in rupees. See `claimHardLimitInr`. */
export const DEFAULT_CLAIM_HARD_LIMIT_INR = 80;

/**
 * Default soft-warn threshold, in rupees. PINNED, not derived — see
 * `claimSoftLimitInr` for why 70% of the hard cap is the wrong shape here.
 */
export const DEFAULT_CLAIM_SOFT_LIMIT_INR = 50;

/**
 * Per-claim ceiling on REASONING spend (everything that is not an
 * OCR_TASK_NAMES page read), in rupees.
 *
 * ─── WHY THIS IS ₹80, UP FROM THE ₹15 ON COMMITTED HEAD ───────────────────
 * ─── (2026-09-14, THE CAP RE-TUNE. THIS IS A DELIBERATE LOOSENING.) ───────
 *
 * SIZED FROM THE OBSERVED DISTRIBUTION, NOT FROM UNIT COSTS. An earlier draft
 * of this constant read ₹150, argued from per-section arithmetic. Measured
 * against the real ledger (finclarity_prod, 48 claims carrying reasoning
 * spend, sonnet rows rescaled x3.75 to undo the pricing bug below):
 *
 *     median ₹13.57 · p90 ₹40.32 · p99 ₹54.91 · max ₹57.72
 *
 * Tiling raises per-extraction cost ~17% (portrait) to ~34% (landscape), so
 * the forward-looking p99 is ≈ ₹69. ₹150 therefore sits so far above the
 * distribution that it would never bind on a real claim — it is a runaway
 * guard wearing a budget's clothing. ₹80 sits just above the post-tiling p99
 * with room for the documented one-call overshoot (a pre-flight cannot bound
 * the call it authorises; worst case ≈ ₹80 + ₹12.5). The soft warn is pinned
 * at ₹50, just under the post-tiling p90, so the log goes loud on the top
 * decile of claims long before anything blocks.
 *
 * THE REAL BUDGET CONTROL IS NOW CONSENT, NOT THIS CONSTANT. Since 076 the
 * operator approves a per-run budget up front and is re-asked when actual
 * spend would exceed it. That is the mechanism that should stop a claim. This
 * cap is the backstop for when something is genuinely wrong — a retry storm,
 * a pathological document — and should be sized to catch that, not to
 * second-guess an approval the user already gave.
 *
 * STATE THE BASELINE HONESTLY FIRST, because an earlier draft of this comment
 * did not. The last COMMITTED value of this constant is ₹15. There has never
 * been a committed ₹40 — `git log --all -S"CLAIM_HARD_LIMIT_INR = 40"`
 * returns nothing; ₹40 was an uncommitted intermediate from this same work
 * stream and has no standing as a baseline. So the change this constant
 * records is
 *
 *     ₹15  →  ₹150     (nominal, as the constant reads)
 *     ~₹56 →  ₹150     (in TRUE rupees, after the pricing fix below)
 *
 * i.e. roughly a 2.7x LOOSENING of the real ceiling. It is not a neutral
 * restatement of an existing limit and must not be described as one. The
 * number is defensible on the measured economics set out below; it is not
 * defensible as "no change".
 *
 * READ THE PRICING FIX NEXT. `claudeClient.computeCostInr` looked COST_TABLE
 * up on the exact model id, COST_TABLE was keyed on the ALIAS
 * ('claude-sonnet-4-5'), and the Anthropic API answers with the DATED id
 * ('claude-sonnet-4-5-20250929'). The lookup missed on every real call and
 * silently charged HAIKU rates. Sonnet is 3.75x Haiku on input, output and
 * cached input alike, so every Sonnet call — which is essentially all
 * reasoning spend — landed in llm_cost_log at 1/3.75 of its true cost.
 * Measured on one tiled dense-A4 itemised extraction: ₹2.21 recorded, ₹8.30
 * true. That is the number the OLD cap was being enforced against.
 *
 * So the ₹15 on HEAD was not a ₹15 ceiling in real money. With every Sonnet
 * rupee recorded at 1/3.75, a ledger reading ₹15 corresponds to
 *
 *     ₹15 × 3.75 = ₹56.25 actually spent.
 *
 * ₹56 true is the honest statement of the ceiling production has been running
 * under. Everything below is an argument for moving that to ₹150 — a real
 * increase of ~₹94 of permitted true spend per claim — NOT an argument that
 * ₹150 is what we were already doing.
 *
 * WHY LOOSEN AT ALL. Sized against TRUE measured costs (certified 2026-09-14,
 * Sonnet 4.5, USD_TO_INR_RATE=83):
 *
 *   dense A4 portrait, itemised   ₹8.646  (n=3, 416/416 cells, 100.00%)
 *   landscape bill, itemised      ₹5.003  (n=2, 196/196 cells, 100.00%)
 *   fixed per claim               doc_segmenter ₹0.9 + bundle classify ₹2.1
 *
 * A ₹56 true ceiling buys 6 dense itemised sections plus overhead and not a
 * seventh. Real bundles exceed that: an ordinary claim with a dozen itemised
 * sections is ~₹107 true. Under the corrected pricing those claims hit
 * 'block', and block is not a graceful degradation — docExtractor throws
 * LlmBudgetExceededError, Bull retries three times, and the section dead
 * letters with the claim half-extracted. Correcting the pricing while holding
 * ₹15 would therefore convert a silent 3.75x overspend into a loud
 * dead-letter on a large share of live claims on the day it ships.
 *
 * ₹150 is chosen to clear the observed bundle sizes with margin, and it is
 * chosen ONCE, to be revisited against a correct ledger — see the tightening
 * note below. What it buys, priced correctly:
 *
 *   fixed per claim                                              ₹3.0
 *   17 × dense-portrait itemised extraction  17 × ₹8.646       ₹147.0
 *   (or 29 landscape ones at ₹5.003)                           ₹148.1
 *
 * THIS IS NOT THE REAL CEILING, AND THE GAP IS STRUCTURAL. `checkBudget` is a
 * PRE-FLIGHT: it reads accumulated spend and answers "may I make a call?"
 * before a call whose cost is not known until it returns. A pre-flight cannot
 * bound the call it authorises. The true worst case is therefore
 *
 *   effective ceiling = CLAIM_HARD_LIMIT_INR + ONE MAXIMAL doc_extract CALL
 *
 * and a maximal doc_extract call is not small: up to 8 rendered pages
 * (MAX_VISION_PAGES in docExtractor.service.ts) at overview + ~3 tiles ≈ 6,272
 * image tokens/page ≈ ₹1.56/page = ~₹12.5 of image input, plus up to 16,384
 * output tokens at $15/M ≈ ₹20.4 — about ₹33. So the honest statement of this
 * limit is "₹150, and a claim may finish at ~₹183". Anyone reasoning about
 * worst-case spend must use the second number. Narrowing that gap needs a
 * mid-call bound (the OCR pump has one; reasoning does not) or a smaller
 * maximal call — not a smaller cap.
 *
 * TIGHTENING FROM ₹150 IS A SEPARATE, DATA-DRIVEN DECISION, AND IT IS OWED.
 * Because this IS a loosening (₹56 true → ₹150), the obligation runs one way:
 * ₹150 is an upper bound picked without a trustworthy distribution to pick
 * against, and it should come DOWN once there is one. It cannot be picked now
 * — until this change ships, no recorded reasoning figure in the database is
 * true, so there is nothing to tighten against. The soft limit (₹60) is what
 * makes that cycle observable — see `claimSoftLimitInr`.
 *
 * Note also that the operator cap is no longer the only thing standing
 * between a bundle and a large bill: since 076 the user approves a per-run
 * budget and `checkBudget` returns 'pause_for_consent' when a run crosses it.
 * That is the limit a user actually experiences, and it is typically far
 * below ₹150. The static cap is the backstop for runaway behaviour, not the
 * per-claim spending policy — which is part of why loosening it to ₹150 is
 * tolerable in a way it would not have been before consent existed.
 *
 * CLAIM_OCR_HARD_LIMIT_INR is deliberately NOT re-tuned. `visionRead.ts`
 * computes its cost from its own hardcoded Sonnet rates and never calls
 * `computeCostInr`, so the OCR dimension's ledger was never wrong and ₹300
 * still means ₹300.
 *
 * NOT per-hospital configurable (no hospital_cost_caps column for it), but it
 * IS env-readable, and read PER CALL rather than snapshotted at import — so an
 * operator can tighten it during a spend incident, or widen it for one
 * pathological bundle, with an env change plus a worker restart. Same contract
 * as `claimOcrHardLimitInr`; tests rely on it too.
 */
export function claimHardLimitInr(): number {
  return envPositiveNumber('CLAIM_HARD_LIMIT_INR', DEFAULT_CLAIM_HARD_LIMIT_INR);
}

/**
 * Soft warn threshold for the reasoning dimension. Crossing it changes nothing
 * about the verdict's ACTION — it only sets `reason`, so the log line names the
 * claim long before anything blocks it.
 *
 * ─── WHY ₹60 IS PINNED AND NO LONGER 70% OF THE HARD CAP ──────────────────
 *
 * 70% of ₹150 is ₹105, and a warn that first fires at ₹105 tells us nothing
 * we want to know. The whole point of this release is that the ledger is
 * correct for the first time, and what we need out of the next cycle is the
 * REAL distribution of per-claim reasoning spend — specifically, how many
 * claims sit in the ₹56-150 band this release newly permits.
 *
 * ₹60 sits just above the ₹56.25 of TRUE spend that the committed ₹15 cap
 * effectively allowed (₹15 × 3.75). So the warn fires on exactly the claims
 * this loosening is about: the first claim to spend more than the old ceiling
 * really permitted becomes a log line immediately, while ₹90 of headroom
 * still separates it from anything blocking. That gives one release of loud,
 * correct data about the band we just opened, before anyone argues about
 * tightening.
 *
 * It is read directly from CLAIM_SOFT_LIMIT_INR and NOT derived from
 * claimHardLimitInr(): an operator who widens the hard cap during an incident
 * must not simultaneously and silently blind the warn that would tell them
 * how bad it got.
 */
export function claimSoftLimitInr(): number {
  return envPositiveNumber('CLAIM_SOFT_LIMIT_INR', DEFAULT_CLAIM_SOFT_LIMIT_INR);
}

/**
 * Per-claim ceiling on OCR page transcription, in rupees.
 *
 * 300 is not a guess: at the measured ~₹5.4 per dense A4 page it buys one
 * full 40-page scanned bundle (~₹217) plus headroom for a second smaller
 * document on the same claim. A claim that needs more than this has either
 * been uploaded wrong (duplicate bundles) or genuinely needs an operator
 * decision — and either way it degrades to Tesseract rather than failing.
 *
 * Read per call (not captured at import) so an operator can tighten it during
 * a spend incident with an env change + worker restart, exactly like every
 * other knob on this path.
 */
export function claimOcrHardLimitInr(): number {
  return envPositiveNumber('CLAIM_OCR_HARD_LIMIT_INR', 300);
}

/** Soft warn threshold for the OCR dimension. Defaults to 70% of the hard cap. */
export function claimOcrSoftLimitInr(): number {
  return envPositiveNumber(
    'CLAIM_OCR_SOFT_LIMIT_INR',
    Math.round(claimOcrHardLimitInr() * 0.7),
  );
}

/**
 * What a SINGLE OCR read (one extractTextFromPdf call) is allowed to spend,
 * before the claim/hospital headroom is intersected in. Stops one pathological
 * 500-page upload from consuming a whole claim's OCR budget in one call.
 */
export function ocrPerReadCapInr(): number {
  return envPositiveNumber('OCR_VISION_MAX_COST_INR_PER_READ', 250);
}

// ── Pre-flight run estimate: the knobs ─────────────────────────────────────
//
// EVERY ONE OF THESE IS READ PER CALL, never captured at import. The same
// contract as every other limit on this path, and here it matters more than
// usual: an operator who re-tunes a multiplier mid-incident must see the new
// number in the NEXT quote, not after a worker restart — otherwise the price
// a user is shown and the price the pipeline enforces drift apart, and consent
// becomes a number about nothing.

/**
 * Rupees per vision page read. Shared with ocr.service, which reads the same
 * env var for its own projection — the estimate and the reader MUST price a
 * page identically or the quote promises a different amount of work than the
 * one that runs.
 */
export function visionEstPageCostInr(): number {
  return envPositiveNumber('OCR_VISION_EST_PAGE_COST_INR', 5.5);
}

/** Fixed reasoning cost per document: doc_segmenter + doc_bundle_classify. */
export function estBundleClassifyInrPerDoc(): number {
  return envPositiveNumber('EST_BUNDLE_CLASSIFY_INR_PER_DOC', 2.1);
}

/**
 * One HEAVY section extraction — a tiled dense-portrait itemised bill, the
 * measured ₹8.646 rounded to the quoting figure ₹8.65. Every document is
 * assumed to contain exactly one of these, because almost every document that
 * matters does (the final bill, the pharmacy bill, the implant invoice).
 */
export function estSectionExtractInr(): number {
  return envPositiveNumber('EST_SECTION_EXTRACT_INR', 8.65);
}

/**
 * Every OTHER section in a document — discharge summaries, ID proofs, consent
 * forms: a handful of scalars and no line-item table.
 */
export function estSectionExtractLightInr(): number {
  return envPositiveNumber('EST_SECTION_EXTRACT_LIGHT_INR', 1.5);
}

/** Pages per section, for turning a page count into a section count. */
export function estPagesPerSection(): number {
  return envPositiveInt('EST_PAGES_PER_SECTION', 3);
}

/**
 * The gap between "what we think this costs" and "what we ask you to approve".
 * 1.25 is deliberately generous: a run that pauses for consent mid-way costs a
 * human interruption and an OCR re-read of the blocked document (§D.3), which
 * is far more expensive than quoting 25% high and coming in under.
 */
export function estBudgetSafetyFactor(): number {
  return envPositiveNumber('EST_BUDGET_SAFETY_FACTOR', 1.25);
}

/** Floor on what a user may approve for one run, in rupees. */
export function aiRunMinApprovedBudgetInr(): number {
  return envPositiveNumber('AI_RUN_MIN_APPROVED_BUDGET_INR', 5);
}

/**
 * Ceiling on what a user may approve for one run, in rupees. A request above
 * it is a 400, never a silent clamp — a clamp is how consent becomes theatre:
 * the user approves ₹5,000, we quietly approve ₹1,000, and the run pauses for
 * a reason they were never told about.
 */
export function aiRunMaxApprovedBudgetInr(): number {
  return envPositiveNumber('AI_RUN_MAX_APPROVED_BUDGET_INR', 1000);
}

/**
 * Whether a run requires an explicit approved budget before it may start.
 *
 * Defaults to TRUE. 'false' makes the server auto-approve at the estimate's
 * recommended budget with budget_approved_by = NULL — which CI and any
 * unattended path rely on, and which must never be set in production: it turns
 * "the user agreed to spend this" into "a config file agreed to spend this".
 */
export function analyzeBudgetConsentRequired(): boolean {
  return String(process.env.ANALYZE_BUDGET_CONSENT_REQUIRED ?? 'true').trim().toLowerCase() !== 'false';
}

// ── Pre-flight run estimate: the shapes ────────────────────────────────────

/** One document, as counted by the CPU-only page census in ocr.service. */
export interface RunCostEstimateDocInput {
  doc_id: string;
  file_name: string | null;
  total_pages: number;
  /** Pages with no usable typed text layer — these need a vision call. */
  pixel_pages: number;
  /** The census failed; pixel_pages is a conservative guess, not a count. */
  degraded: boolean;
}

export interface RunCostEstimateDoc extends RunCostEstimateDocInput {
  est_ocr_inr: number;
  est_sections: number;
  est_extraction_inr: number;
  /** est_ocr_inr + est_extraction_inr. Excludes the per-doc fixed cost. */
  est_total_inr: number;
}

export interface RunCostEstimate {
  /**
   * Stable hash of the inputs. Echoed back on approve; a mismatch means the
   * document set changed between the quote and the consent, and the FE must
   * re-quote rather than start a run against a price nobody agreed to.
   */
  estimate_token: string;
  computed_at: string;
  docs_total: number;
  pages_total: number;
  pixel_pages_total: number;
  /** Pages that already carry a usable typed layer and cost nothing to read. */
  typed_pages_total: number;
  est_page_cost_inr: number;
  ocr_inr: number;
  extraction_inr: number;
  fixed_inr: number;
  total_inr: number;
  /** ceil((total_inr * EST_BUDGET_SAFETY_FACTOR) / 10) * 10 */
  recommended_budget_inr: number;
  /** Headroom the existing static caps still impose. Display only. */
  claim_ocr_headroom_inr: number;
  claim_reasoning_headroom_inr: number;
  /** Rupees already spent on this claim by PREVIOUS runs. Display only. */
  prior_claim_spend_inr: number;
  docs: RunCostEstimateDoc[];
  /** Free-form display notes. Never a failure. */
  notes: string[];
}

/**
 * Project what one analysis run will cost, in rupees.
 *
 * PURE. No I/O, no database, no clock beyond `computed_at`, no provider call.
 * The page census that feeds it (ocr.service.censusPdfPages) is CPU-only and
 * spends nothing, which is the whole reason a user can be shown a price before
 * agreeing to it: a quote that costs money to produce is a quote you cannot
 * offer before consent.
 *
 * The model is deliberately coarse and deliberately HIGH. It is not trying to
 * predict the bill; it is trying to produce a number a human can agree to that
 * the run will then fit inside. Being 20% over costs nothing. Being 5% under
 * costs a mid-run pause, a human interruption, and an OCR re-read of whatever
 * document was cut short (§D.3 discards a paused read rather than inheriting a
 * truncated transcription) — so the asymmetry is priced in via
 * EST_BUDGET_SAFETY_FACTOR and the round-up to ₹10.
 *
 * What it counts, per document:
 *   sections    = max(1, ceil(total_pages / EST_PAGES_PER_SECTION))
 *   ocr         = pixel_pages × OCR_VISION_EST_PAGE_COST_INR
 *                 (typed pages are free; that is what the census is FOR)
 *   extraction  = one heavy section + (sections − 1) light ones
 * plus, once per document, EST_BUNDLE_CLASSIFY_INR_PER_DOC of segment/classify.
 */
export function estimateRunCostInr(input: {
  claim_id: string;
  docs: RunCostEstimateDocInput[];
  prior_claim_spend_inr: number;
  claim_ocr_headroom_inr: number;
  claim_reasoning_headroom_inr: number;
}): RunCostEstimate {
  const pageCost = visionEstPageCostInr();
  const heavy = estSectionExtractInr();
  const light = estSectionExtractLightInr();
  const pagesPerSection = estPagesPerSection();
  const perDocFixed = estBundleClassifyInrPerDoc();
  const safety = estBudgetSafetyFactor();

  const notes: string[] = [];
  const docs: RunCostEstimateDoc[] = [];

  let pagesTotal = 0;
  let pixelTotal = 0;
  let ocrInr = 0;
  let extractionInr = 0;

  for (const d of input.docs) {
    const totalPages = Math.max(0, Math.floor(Number(d.total_pages) || 0));
    const pixelPages = Math.max(
      0,
      Math.min(totalPages || Number.MAX_SAFE_INTEGER, Math.floor(Number(d.pixel_pages) || 0)),
    );
    const sections = Math.max(1, Math.ceil((totalPages || 1) / pagesPerSection));
    const docOcr = pixelPages * pageCost;
    const docExtract = heavy + (sections - 1) * light;

    pagesTotal += totalPages;
    pixelTotal += pixelPages;
    ocrInr += docOcr;
    extractionInr += docExtract;

    if (d.degraded) {
      notes.push(
        `${d.file_name ?? d.doc_id}: could not be parsed for a page count; ` +
          `quoted conservatively at ${pixelPages} page(s)`,
      );
    }

    docs.push({
      doc_id: d.doc_id,
      file_name: d.file_name ?? null,
      total_pages: totalPages,
      pixel_pages: pixelPages,
      degraded: !!d.degraded,
      est_ocr_inr: round2(docOcr),
      est_sections: sections,
      est_extraction_inr: round2(docExtract),
      est_total_inr: round2(docOcr + docExtract),
    });
  }

  const docsTotal = input.docs.length;
  const fixedInr = docsTotal * perDocFixed;
  const totalInr = ocrInr + extractionInr + fixedInr;

  const reasoningHeadroom = round2(
    Math.max(0, Number(input.claim_reasoning_headroom_inr) || 0),
  );

  // ─── THE RECOMMENDATION IS CLIPPED TO THE REASONING HEADROOM ─────────────
  //
  // A recommendation above the static reasoning cap is a number the user can
  // approve and can never actually reach, because `checkBudget` ranks
  // 'block' ABOVE 'pause_for_consent'. Concretely: with
  // CLAIM_HARD_LIMIT_INR=150 and an approved budget of ₹220, reasoning spend
  // hits the ₹150 cap first, checkBudget returns 'block' and RETURNS before
  // the run dimension is even read — so the run never pauses to re-ask. It
  // throws LlmBudgetExceededError, Bull dead-letters it, and the user who
  // approved ₹220 gets a hard failure at ₹150 instead of the pause-and-ask
  // that consent exists to provide. A measured claim recommended ₹220.
  //
  // Clipping to the REASONING headroom (not the combined reasoning+OCR
  // headroom) is what makes that interaction impossible rather than merely
  // unlikely. The approved budget is a COMBINED reasoning+OCR number, so the
  // adversarial case is a run whose spend is entirely reasoning: only
  // `budget ≤ reasoning headroom` guarantees that total spend reaches the
  // budget — and therefore pauses — at or before reasoning reaches the cap.
  // Clipping to the larger combined headroom would leave the bad interaction
  // reachable for any reasoning-dominated bundle, which is most of them.
  //
  // We clip only when the headroom is strictly positive. Zero is AMBIGUOUS:
  // intelligenceOrchestrator.estimateRun reports zero headroom both when the
  // claim is genuinely at its cap AND when the headroom read threw (it logs
  // 'showing zero headroom' and carries on). Clipping to 0 would turn a
  // transient database blip into a recommendation the controller's
  // [min,max] range check refuses outright. A claim genuinely at ₹0 headroom
  // blocks cleanly on its first pre-flight having spent nothing, which is a
  // different and much better failure than the one above.
  const rawRecommended = Math.ceil((totalInr * safety) / 10) * 10;
  let recommended = rawRecommended;
  if (reasoningHeadroom > 0 && rawRecommended > reasoningHeadroom) {
    // Prefer a round ₹10 step below the headroom; fall back to the exact
    // headroom when it is itself under ₹10, so the clip never rounds UP
    // through the cap it exists to respect.
    const stepped = Math.floor(reasoningHeadroom / 10) * 10;
    recommended = stepped > 0 ? stepped : round2(reasoningHeadroom);
    notes.push(
      `Recommended budget reduced from ₹${rawRecommended} to ₹${recommended}: ` +
        `only ₹${reasoningHeadroom} of this claim's reasoning cap remains, and a ` +
        `budget above that can never pause for consent — it would hit the ` +
        `operator cap and fail the run instead.`,
    );
  }

  // The token binds the quote to the exact document set it was computed over.
  // Sorting makes it order-independent (the doc query has no stable ORDER BY
  // guarantee across calls); including the two dominant rates makes an
  // operator re-tune invalidate an in-flight quote, which is correct — the
  // user would otherwise approve one price and be charged against another.
  const estimateToken = createHash('sha256')
    .update(
      `${input.claim_id}|` +
        input.docs
          .map((d) => `${d.doc_id}:${Math.max(0, Math.floor(Number(d.total_pages) || 0))}:${Math.max(0, Math.floor(Number(d.pixel_pages) || 0))}`)
          .sort()
          .join(',') +
        `|${String(pageCost)}|${String(heavy)}`,
    )
    .digest('hex')
    .slice(0, 32);

  return {
    estimate_token: estimateToken,
    computed_at: new Date().toISOString(),
    docs_total: docsTotal,
    pages_total: pagesTotal,
    pixel_pages_total: pixelTotal,
    typed_pages_total: Math.max(0, pagesTotal - pixelTotal),
    est_page_cost_inr: pageCost,
    ocr_inr: round2(ocrInr),
    extraction_inr: round2(extractionInr),
    fixed_inr: round2(fixedInr),
    total_inr: round2(totalInr),
    recommended_budget_inr: recommended,
    claim_ocr_headroom_inr: round2(Math.max(0, Number(input.claim_ocr_headroom_inr) || 0)),
    claim_reasoning_headroom_inr: reasoningHeadroom,
    prior_claim_spend_inr: round2(Math.max(0, Number(input.prior_claim_spend_inr) || 0)),
    docs,
    notes,
  };
}

// ── The run's approved budget ──────────────────────────────────────────────

/** What one run has spent, against what the user approved for it. */
export interface RunSpend {
  runId: string;
  /**
   * Reasoning + OCR, COMBINED. This is the dimension the user approved a
   * single number for: they agreed to spend ₹390 analysing a claim, not
   * ₹250 of reading and ₹140 of thinking. The operator caps stay split
   * because they are about different runaway modes; consent is about the
   * bill.
   */
  totalInr: number;
  reasoningInr: number;
  ocrInr: number;
  approvedBudgetInr: number | null;
  /** max(0, approved − total). Infinity when nothing was approved. */
  remainingInr: number;
  overBudget: boolean;
}

export interface RecordCallInput {
  claimId?: string | null; // typically the IPD id
  hospitalId?: string | null;
  /**
   * The analysis run this call belongs to, when the caller knows it.
   *
   * This is what makes `getRunSpendInr` mean "this run's spend" rather than
   * "all claim spend since this run was triggered". Migration 076 added the
   * column and the index; leaving it NULL is CORRECT for genuinely
   * run-less work (an inbound-email draft, a manual re-extract) and is what
   * getRunSpendInr's time-window fallback exists for — but a caller that DOES
   * know its run and omits it silently pollutes another run's budget. Pass it
   * wherever a run id is in scope.
   */
  runId?: string | null;
  task: string;
  provider: string;
  model: string;
  promptVersion: string;
  tokensInputUncached: number;
  tokensInputCached: number;
  tokensOutput: number;
  latencyMs: number;
  costInr: number;
  succeeded?: boolean;
  errorMessage?: string | null;
}

export interface BudgetVerdict {
  claimUnderLimit: boolean;
  hospitalUnderLimit: boolean;
  /**
   * WIDENING UNION — 'pause_for_consent' is new. It means "the operator caps
   * are fine, but this call would spend past the budget the USER approved for
   * this run". The caller must not make the call; it must pause the run and
   * ask (claimAiRunService.pauseForConsent), NOT throw
   * LlmBudgetExceededError — a throw burns Bull's three retries against a run
   * that is deliberately parked.
   *
   * Precedence, strictest first:
   *     block  >  pause_for_consent  >  throttle  >  allow
   *
   * Any consumer written as `if (action === 'block') throw` falls THROUGH on
   * this member. Treat anything that is not 'allow' or 'throttle' as
   * "do not make the call".
   */
  action: 'allow' | 'throttle' | 'block' | 'pause_for_consent';
  reason?: string;
  // Helpful telemetry the caller can log / surface in dashboards.
  claimSpendInr?: number;
  /**
   * Page-transcription spend on this claim. Reported for observability but
   * deliberately NOT part of `claimSpendInr` and NOT a reason to block — see
   * the OCR-dimension note in the module header.
   */
  claimOcrSpendInr?: number;
  hospitalDailySpendInr?: number;
  hospitalMonthlySpendInr?: number;
  hospitalDailyCapInr?: number;
  hospitalMonthlyCapInr?: number;
  // ── the run dimension, populated only when a runId was supplied ──
  /** Reasoning + OCR spend attributed to this run. */
  runSpendInr?: number;
  /** What the user approved. NULL on a legacy run created before consent. */
  runApprovedBudgetInr?: number | null;
  runId?: string | null;
}

/** Rupee headroom for one OCR read, plus why it is what it is. */
export interface OcrReadAllowance {
  /** Rupees this read may spend. Always finite and ≥ 0. */
  allowanceInr: number;
  /**
   * Which dimension produced the number.
   *
   * 'run_budget' is the one the consumer must treat specially: it means the
   * read stopped because the USER'S approved budget ran out, not because an
   * operator cap did. Pages left unread under it become unreadable with
   * reason 'cost_budget' and the run pauses for consent — approving more
   * money genuinely fixes them. Every other value is an operator bound and
   * approving more money would not.
   */
  limitedBy:
    | 'per_read_cap'
    | 'claim_ocr_cap'
    | 'hospital_daily'
    | 'hospital_monthly'
    | 'run_budget'
    | 'budget_query_failed';
  claimOcrSpendInr?: number;
  claimOcrCapInr?: number;
  hospitalDailySpendInr?: number;
  hospitalMonthlySpendInr?: number;
  runSpendInr?: number;
  runApprovedBudgetInr?: number | null;
  /** Human-readable explanation, safe to log. */
  reason: string;
}

/** Per-claim spend split by dimension. Reporting/observability helper. */
export interface ClaimSpendBreakdown {
  /** Everything that is NOT page transcription — the claimHardLimitInr dimension. */
  reasoningInr: number;
  /** Page transcription only — the CLAIM_OCR_HARD_LIMIT_INR dimension. */
  ocrInr: number;
  /** reasoningInr + ocrInr. What the claim actually cost. */
  totalInr: number;
}

class CostAccountingService {
  /**
   * Insert a row into llm_cost_log. Best-effort: if the insert fails the
   * parent operation must NOT be aborted — the LLM result is already
   * computed. We log loudly so the gap shows up in observability.
   */
  async recordCall(input: RecordCallInput, db: Queryable = pool): Promise<void> {
    const baseCols =
      `claim_id, hospital_id, task, provider, model, prompt_version,
       tokens_input_uncached, tokens_input_cached, tokens_output,
       latency_ms, cost_inr, succeeded, error_message`;
    const baseParams = [
      input.claimId ?? null,
      input.hospitalId ?? null,
      input.task,
      input.provider,
      input.model,
      input.promptVersion,
      input.tokensInputUncached,
      input.tokensInputCached,
      input.tokensOutput,
      input.latencyMs,
      input.costInr,
      input.succeeded ?? true,
      input.errorMessage ?? null,
    ];

    const SQL_WITHOUT_RUN_ID =
      `INSERT INTO hospital.llm_cost_log
         (${baseCols})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;
    const SQL_WITH_RUN_ID =
      `INSERT INTO hospital.llm_cost_log
         (${baseCols}, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`;

    const runId = input.runId ?? null;

    try {
      if (runId === null) {
        await db.query(SQL_WITHOUT_RUN_ID, baseParams);
      } else {
        await db.query(SQL_WITH_RUN_ID, [...baseParams, runId]);
      }
    } catch (err) {
      // 42703 = undefined_column. A database on which migration 076 has not
      // landed has no run_id column. Retry WITHOUT it rather than lose the
      // row: the attribution degrades to getRunSpendInr's time-window
      // fallback, which is exactly the pre-076 behaviour, whereas a dropped
      // row would under-report spend — the one direction that lets a run
      // quietly outspend its approval.
      if (runId !== null && (err as any)?.code === '42703') {
        try {
          await db.query(SQL_WITHOUT_RUN_ID, baseParams);
          return;
        } catch (inner) {
          logger.warn(
            { err: inner, task: input.task, claimId: input.claimId, hospitalId: input.hospitalId },
            'costAccounting.recordCall: insert failed on pre-076 retry (audit-only, parent op unaffected)'
          );
          return;
        }
      }
      logger.warn(
        { err, task: input.task, claimId: input.claimId, hospitalId: input.hospitalId, runId },
        'costAccounting.recordCall: insert failed (audit-only, parent op unaffected)'
      );
    }
  }

  /**
   * REASONING spend on a single claim, in INR, succeeded or not. Failed calls
   * still cost tokens (Anthropic bills on partial responses), so they count
   * against the cap.
   *
   * Excludes the OCR page-transcription tasks (OCR_TASK_NAMES) — see the
   * OCR-dimension note in the module header. This is the number the per-claim
   * hard limit (`claimHardLimitInr`) is about, and the split is what stops a ₹217 bundle
   * read from blocking the classify/extract calls that follow it.
   * `getClaimOcrSpendInr` is the other half; `getClaimSpendBreakdownInr`
   * returns both plus the true total for reporting.
   */
  async getClaimSpendInr(claimId: string, db: Queryable = pool): Promise<number> {
    try {
      const res = await db.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(cost_inr), 0)::TEXT AS total
           FROM hospital.llm_cost_log
          WHERE claim_id = $1
            AND NOT (COALESCE(task, '') = ANY($2::TEXT[]))`,
        [claimId, OCR_TASK_NAMES as unknown as string[]]
      );
      return Number(res.rows[0]?.total ?? 0);
    } catch (err) {
      logger.error({ err, claimId }, 'costAccounting.getClaimSpendInr failed');
      // Fail closed: report "high spend" to be safe rather than allowing
      // an unbounded run when the budget query is broken.
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * OCR page-transcription spend on a single claim, in INR.
   *
   * Fails CLOSED the same way `getClaimSpendInr` does: an unreadable budget
   * table reports infinite spend, which drives `getOcrReadAllowanceInr` to an
   * allowance of ₹0 — every page then reads on Tesseract. Degraded text, a
   * working pipeline, no unbounded spend.
   */
  async getClaimOcrSpendInr(claimId: string, db: Queryable = pool): Promise<number> {
    try {
      const res = await db.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(cost_inr), 0)::TEXT AS total
           FROM hospital.llm_cost_log
          WHERE claim_id = $1
            AND COALESCE(task, '') = ANY($2::TEXT[])`,
        [claimId, OCR_TASK_NAMES as unknown as string[]]
      );
      return Number(res.rows[0]?.total ?? 0);
    } catch (err) {
      logger.error({ err, claimId }, 'costAccounting.getClaimOcrSpendInr failed');
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Both dimensions plus the true total, in one round trip. Nothing gates on
   * this — it exists so a dashboard, a run summary, or a log line can state
   * what a claim actually cost without re-deriving the task split.
   */
  async getClaimSpendBreakdownInr(
    claimId: string,
    db: Queryable = pool
  ): Promise<ClaimSpendBreakdown> {
    try {
      const res = await db.query<{ ocr: string | null; reasoning: string | null }>(
        `SELECT
           COALESCE(SUM(cost_inr) FILTER (
             WHERE COALESCE(task, '') = ANY($2::TEXT[])), 0)::TEXT AS ocr,
           COALESCE(SUM(cost_inr) FILTER (
             WHERE NOT (COALESCE(task, '') = ANY($2::TEXT[]))), 0)::TEXT AS reasoning
           FROM hospital.llm_cost_log
          WHERE claim_id = $1`,
        [claimId, OCR_TASK_NAMES as unknown as string[]]
      );
      const ocrInr = Number(res.rows[0]?.ocr ?? 0);
      const reasoningInr = Number(res.rows[0]?.reasoning ?? 0);
      return { reasoningInr, ocrInr, totalInr: reasoningInr + ocrInr };
    } catch (err) {
      logger.error(
        { err, claimId },
        'costAccounting.getClaimSpendBreakdownInr failed'
      );
      return {
        reasoningInr: Number.POSITIVE_INFINITY,
        ocrInr: Number.POSITIVE_INFINITY,
        totalInr: Number.POSITIVE_INFINITY,
      };
    }
  }

  /**
   * The run row's consent columns, or null when the run does not exist.
   *
   * Tolerant of a database on which migration 076 has not been applied: the
   * consent columns simply do not exist there, the query fails with
   * undefined_column (42703), and we retry without them. On such a database
   * there is no consent flow at all, so "no approved budget" is not a
   * degradation — it is the accurate answer.
   */
  private async loadRunBudgetRow(
    runId: string,
    db: Queryable = pool,
  ): Promise<{ claimId: string | null; triggeredAt: string | null; approvedBudgetInr: number | null } | null> {
    const shape = (row: any) => ({
      claimId: row?.claim_id ?? null,
      triggeredAt: row?.triggered_at ? new Date(row.triggered_at).toISOString() : null,
      approvedBudgetInr:
        row?.approved_budget_inr === null || row?.approved_budget_inr === undefined
          ? null
          : Number(row.approved_budget_inr),
    });
    try {
      const res = await db.query<any>(
        `SELECT claim_id, triggered_at, approved_budget_inr
           FROM hospital.claim_ai_runs
          WHERE id = $1`,
        [runId],
      );
      if ((res.rowCount ?? 0) === 0) return null;
      return shape(res.rows[0]);
    } catch (err) {
      if ((err as any)?.code === '42703') {
        try {
          const res = await db.query<any>(
            `SELECT claim_id, triggered_at FROM hospital.claim_ai_runs WHERE id = $1`,
            [runId],
          );
          if ((res.rowCount ?? 0) === 0) return null;
          return shape(res.rows[0]);
        } catch (inner) {
          logger.error({ err: inner, runId }, 'costAccounting.loadRunBudgetRow failed (pre-076 retry)');
          return null;
        }
      }
      logger.error({ err, runId }, 'costAccounting.loadRunBudgetRow failed');
      return null;
    }
  }

  /**
   * What this RUN has spent so far, reasoning and OCR combined, against what
   * the user approved for it.
   *
   * ─── THE ATTRIBUTION GAP, DOCUMENTED RATHER THAN HIDDEN ───────────────────
   *
   * Run spend is defined by a predicate that is correct BOTH ways:
   *
   *     run_id = $2  OR  (run_id IS NULL AND created_at >= run.triggered_at)
   *
   * Rows that carry the id are matched exactly; rows that do not fall back to
   * the run's time window.
   *
   * WHICH ROWS CARRY THE ID (as of the consent-wiring pass). `RecordCallInput`
   * takes an optional `runId` and `recordCall` writes it. The reasoning call
   * sites that know their run now stamp it: docSegmenter, docClassifier,
   * docExtractor and harmonisation all resolve the claim's active run for
   * their budget pre-flight and pass the same id through to the cost log.
   * Rows still landing NULL are the genuinely run-less ones — inbound-email
   * intelligence (deliberately exempt from run budgets), and any manual or
   * out-of-band call with no run in scope — plus OCR page reads recorded
   * inside visionRead, which are not this owner's files.
   *
   * THE RESIDUAL IMPRECISION, stated plainly: for the rows that are still
   * NULL, the time-window arm can attribute to the current run work that
   * belongs to someone else — the tail calls of a SUPERSEDED run, work already
   * in flight when a new Run Analysis click replaced it. That OVER-counts.
   * Over-counting fails SAFE: it asks the user for consent slightly earlier
   * than strictly necessary. It can never UNDER-count, so it can never let a
   * run quietly outspend its approval, which is the only direction that would
   * break the promise being made here.
   */
  async getRunSpendInr(
    runId: string,
    claimId: string,
    runTriggeredAt: string | Date,
    db: Queryable = pool,
  ): Promise<RunSpend> {
    const since =
      runTriggeredAt instanceof Date
        ? runTriggeredAt.toISOString()
        : new Date(runTriggeredAt).toISOString();

    const runRow = await this.loadRunBudgetRow(runId, db).catch(() => null);
    const approvedBudgetInr = runRow?.approvedBudgetInr ?? null;

    const settle = (total: number, reasoning: number, ocr: number): RunSpend => {
      const remaining =
        approvedBudgetInr === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, approvedBudgetInr - total);
      return {
        runId,
        totalInr: total,
        reasoningInr: reasoning,
        ocrInr: ocr,
        approvedBudgetInr,
        remainingInr: remaining,
        overBudget: approvedBudgetInr !== null && total >= approvedBudgetInr,
      };
    };

    const SQL_WITH_RUN_ID = `SELECT
             COALESCE(SUM(cost_inr), 0)::TEXT AS total,
             COALESCE(SUM(cost_inr) FILTER (
               WHERE NOT (COALESCE(task,'') = ANY($4::TEXT[]))), 0)::TEXT AS reasoning,
             COALESCE(SUM(cost_inr) FILTER (
               WHERE COALESCE(task,'') = ANY($4::TEXT[])), 0)::TEXT AS ocr
           FROM hospital.llm_cost_log
          WHERE claim_id = $1
            AND (run_id = $2 OR (run_id IS NULL AND created_at >= $3))`;

    // Identical, minus the run_id predicate — for a database on which 076 has
    // not landed. The time window alone is exactly what the dual predicate
    // degrades to when no row carries an id, so the number is the same one.
    const SQL_TIME_WINDOW_ONLY = `SELECT
             COALESCE(SUM(cost_inr), 0)::TEXT AS total,
             COALESCE(SUM(cost_inr) FILTER (
               WHERE NOT (COALESCE(task,'') = ANY($4::TEXT[]))), 0)::TEXT AS reasoning,
             COALESCE(SUM(cost_inr) FILTER (
               WHERE COALESCE(task,'') = ANY($4::TEXT[])), 0)::TEXT AS ocr
           FROM hospital.llm_cost_log
          WHERE claim_id = $1
            AND $2 IS NOT NULL
            AND created_at >= $3`;

    const params = [claimId, runId, since, OCR_TASK_NAMES as unknown as string[]];

    const run = async (sql: string) => {
      const res = await db.query<{ total: string; reasoning: string; ocr: string }>(sql, params);
      const row = res.rows[0];
      return settle(
        Number(row?.total ?? 0),
        Number(row?.reasoning ?? 0),
        Number(row?.ocr ?? 0),
      );
    };

    try {
      return await run(SQL_WITH_RUN_ID);
    } catch (err) {
      if ((err as any)?.code === '42703') {
        try {
          return await run(SQL_TIME_WINDOW_ONLY);
        } catch (inner) {
          logger.error({ err: inner, runId, claimId }, 'costAccounting.getRunSpendInr failed (pre-076 retry)');
        }
      } else {
        logger.error({ err, runId, claimId }, 'costAccounting.getRunSpendInr failed');
      }
      // Fail CLOSED on spend, like every other read here: an unreadable ledger
      // reports infinite spend, which drives the run to pause for consent
      // rather than to keep spending against a number nobody can see.
      return settle(
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      );
    }
  }

  /**
   * Hospital spend for either 'today' (since 00:00 IST) or 'month'
   * (since first-of-month IST). India runs on a single timezone so we
   * just use AT TIME ZONE 'Asia/Kolkata' in the date-trunc.
   */
  async getHospitalSpendInr(
    hospitalId: string,
    period: 'today' | 'month',
    db: Queryable = pool
  ): Promise<number> {
    try {
      // date_trunc in IST then compare against IST-clock now.
      const truncUnit = period === 'today' ? 'day' : 'month';
      const res = await db.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(cost_inr), 0)::TEXT AS total
           FROM hospital.llm_cost_log
          WHERE hospital_id = $1
            AND created_at >= date_trunc($2,
                  (NOW() AT TIME ZONE 'Asia/Kolkata'))
                  AT TIME ZONE 'Asia/Kolkata'`,
        [hospitalId, truncUnit]
      );
      return Number(res.rows[0]?.total ?? 0);
    } catch (err) {
      logger.error(
        { err, hospitalId, period },
        'costAccounting.getHospitalSpendInr failed'
      );
      return Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Resolve the currently-effective cost caps for a hospital. Picks the
   * most recent row in hospital_cost_caps whose effective window contains
   * now(); falls back to defaults if none.
   */
  // Was `private` — TS4094 fires on `private readonly cost = costAccounting`
  // in EmailIntelligenceService because the singleton's inferred type leaks
  // the private member. Singleton has no callers outside the module anyway,
  // so widening to public is a no-op for encapsulation in practice.
  async getHospitalCaps(
    hospitalId: string,
    db: Queryable = pool
  ): Promise<{ daily: number; monthly: number }> {
    try {
      const res = await db.query<{ daily_cap_inr: string; monthly_cap_inr: string }>(
        `SELECT daily_cap_inr, monthly_cap_inr
           FROM hospital.hospital_cost_caps
          WHERE hospital_id = $1
            AND effective_from <= NOW()
            AND (effective_to IS NULL OR effective_to > NOW())
          ORDER BY effective_from DESC
          LIMIT 1`,
        [hospitalId]
      );
      if ((res.rowCount ?? 0) === 0) {
        return { daily: DEFAULT_DAILY_CAP_INR, monthly: DEFAULT_MONTHLY_CAP_INR };
      }
      const row = res.rows[0]!;
      return {
        daily: Number(row.daily_cap_inr) || DEFAULT_DAILY_CAP_INR,
        monthly: Number(row.monthly_cap_inr) || DEFAULT_MONTHLY_CAP_INR,
      };
    } catch (err) {
      logger.warn({ err, hospitalId }, 'costAccounting.getHospitalCaps: using defaults');
      return { daily: DEFAULT_DAILY_CAP_INR, monthly: DEFAULT_MONTHLY_CAP_INR };
    }
  }

  /**
   * How many rupees may THIS OCR read spend, right now?
   *
   * This is the number the pre-flight `checkBudget` could never produce. A
   * pre-flight answers "may I make a call?"; a page-per-call vision read needs
   * "and how much of it can I afford?", because the answer decides how many
   * pages go to the model and how many go to Tesseract. ocr.service takes this
   * allowance, converts it to a page count with its own measured per-page cost
   * estimate, and re-checks it against ACTUAL accumulated spend between pages.
   *
   * Strictest of:
   *   - the per-read cap (OCR_VISION_MAX_COST_INR_PER_READ),
   *   - remaining per-claim OCR headroom (CLAIM_OCR_HARD_LIMIT_INR − spent),
   *   - remaining hospital daily and monthly headroom.
   *
   * Never throws and never returns a negative or non-finite number. With no
   * claimId and no hospitalId (unattended ingestion) only the per-read cap
   * applies — those callers are already pinned to a 3-page vision budget by
   * `resolveVisionPageBudget`, which is the tighter bound in practice.
   */
  async getOcrReadAllowanceInr(
    claimId?: string | null,
    hospitalId?: string | null,
    db: Queryable = pool,
    opts?: { runId?: string | null; runTriggeredAt?: string | null }
  ): Promise<OcrReadAllowance> {
    const perRead = ocrPerReadCapInr();
    let allowance = perRead;
    let limitedBy: OcrReadAllowance['limitedBy'] = 'per_read_cap';
    let reason = `per-read cap ₹${perRead}`;
    const out: Partial<OcrReadAllowance> = {};

    const tighten = (
      candidate: number,
      by: OcrReadAllowance['limitedBy'],
      why: string
    ) => {
      // NaN-safe: a non-finite candidate means the budget query failed, which
      // must clamp to zero rather than widen the allowance.
      const value = Number.isFinite(candidate) ? candidate : 0;
      if (value < allowance) {
        allowance = value;
        limitedBy = by;
        reason = why;
      }
    };

    if (claimId) {
      const cap = claimOcrHardLimitInr();
      const spent = await this.getClaimOcrSpendInr(claimId, db);
      out.claimOcrSpendInr = spent;
      out.claimOcrCapInr = cap;
      if (!Number.isFinite(spent)) {
        // Budget table unreadable → spend nothing on vision. Tesseract still
        // reads the document; the claim does not stall.
        tighten(0, 'budget_query_failed', 'claim OCR spend query failed — vision disabled for this read');
      } else {
        tighten(
          cap - spent,
          'claim_ocr_cap',
          `claim OCR headroom ₹${(cap - spent).toFixed(2)} (spent ₹${spent.toFixed(2)} of ₹${cap})`
        );
      }
    }

    if (hospitalId) {
      const caps = await this.getHospitalCaps(hospitalId, db);
      const [daily, monthly] = await Promise.all([
        this.getHospitalSpendInr(hospitalId, 'today', db),
        this.getHospitalSpendInr(hospitalId, 'month', db),
      ]);
      out.hospitalDailySpendInr = daily;
      out.hospitalMonthlySpendInr = monthly;
      if (!Number.isFinite(daily) || !Number.isFinite(monthly)) {
        tighten(0, 'budget_query_failed', 'hospital spend query failed — vision disabled for this read');
      } else {
        tighten(
          caps.daily - daily,
          'hospital_daily',
          `hospital daily headroom ₹${(caps.daily - daily).toFixed(2)} of ₹${caps.daily}`
        );
        tighten(
          caps.monthly - monthly,
          'hospital_monthly',
          `hospital monthly headroom ₹${(caps.monthly - monthly).toFixed(2)} of ₹${caps.monthly}`
        );
      }
    }

    // ── The run's approved budget ──────────────────────────────────────────
    //
    // One more dimension, intersected exactly like the others, and the only
    // one a USER can widen. When it is the binding constraint the pump's stop
    // means "you did not approve enough money for this", which is a question
    // to ask rather than a limit to enforce — the caller keys on
    // limitedBy === 'run_budget' to pause the run for consent instead of
    // quietly leaving the tail of the document unread.
    if (opts?.runId) {
      const runRow = await this.loadRunBudgetRow(opts.runId, db);
      const effectiveClaimId = claimId ?? runRow?.claimId ?? null;
      const triggeredAt = opts.runTriggeredAt ?? runRow?.triggeredAt ?? null;
      if (effectiveClaimId && triggeredAt) {
        const spend = await this.getRunSpendInr(opts.runId, effectiveClaimId, triggeredAt, db);
        out.runSpendInr = spend.totalInr;
        out.runApprovedBudgetInr = spend.approvedBudgetInr;
        if (spend.approvedBudgetInr !== null) {
          const headroom = spend.approvedBudgetInr - spend.totalInr;
          tighten(
            headroom,
            'run_budget',
            `run budget headroom ₹${(Number.isFinite(headroom) ? headroom : 0).toFixed(2)} ` +
              `of ₹${spend.approvedBudgetInr} approved ` +
              `(spent ₹${Number.isFinite(spend.totalInr) ? spend.totalInr.toFixed(2) : '?'})`,
          );
        }
      }
    }

    return {
      ...out,
      allowanceInr: Math.max(0, Number.isFinite(allowance) ? allowance : 0),
      limitedBy,
      reason,
    };
  }

  /**
   * Pre-flight budget check. Strictest-wins:
   *   - claim REASONING spend ≥ hard limit -> block (OCR page-transcription
   *     spend is reported as `claimOcrSpendInr` but never blocks — it is
   *     bounded inside the read by `getOcrReadAllowanceInr` instead)
   *   - hospital daily/monthly ≥ 100%  -> block
   *   - run spend ≥ approved budget    -> pause_for_consent  (opts.runId only)
   *   - hospital daily/monthly ≥ 80%   -> throttle
   *   - claim spend ≥ soft limit       -> still 'allow' but reason set
   *
   * Either claimId or hospitalId (or both) may be omitted; the
   * corresponding dimension is then skipped.
   *
   * ─── WHERE THIS SITS IN THE RUN, AND WHAT IT CANNOT DO ────────────────────
   *
   * This is ONE of exactly two places actual spend is re-read mid-run. The
   * other is between pages inside ocr.service's vision pump. Both are BETWEEN
   * units of work, and that is not an implementation detail — a pre-flight
   * cannot bound the call it authorises, so the only honest place to enforce a
   * budget is the gap before the next unit starts. A claim can therefore
   * finish at up to (cap + one maximal call); see `claimHardLimitInr`.
   *
   * Passing `opts.runId` adds the run's user-approved budget as a fourth
   * dimension. Crossing it returns 'pause_for_consent' — NOT 'block'. The
   * caller must park the run and ask for more budget rather than throw: a
   * throw here dead-letters through Bull's three retries against a run that is
   * deliberately waiting for a human.
   */
  async checkBudget(
    claimId?: string | null,
    hospitalId?: string | null,
    db: Queryable = pool,
    opts?: { runId?: string | null }
  ): Promise<BudgetVerdict> {
    const verdict: BudgetVerdict = {
      claimUnderLimit: true,
      hospitalUnderLimit: true,
      action: 'allow',
    };

    // Claim dimension. Both halves are read in one round trip so the OCR
    // number is available for telemetry; ONLY the reasoning half can block.
    if (claimId) {
      const breakdown = await this.getClaimSpendBreakdownInr(claimId, db);
      const claimSpend = breakdown.reasoningInr;
      verdict.claimSpendInr = claimSpend;
      verdict.claimOcrSpendInr = breakdown.ocrInr;
      if (
        Number.isFinite(breakdown.ocrInr) &&
        breakdown.ocrInr >= claimOcrSoftLimitInr()
      ) {
        logger.warn(
          {
            claimId,
            hospitalId,
            claim_ocr_spend_inr: Math.round(breakdown.ocrInr * 100) / 100,
            claim_ocr_cap_inr: claimOcrHardLimitInr(),
          },
          'costAccounting: claim OCR page-transcription spend is past the soft ' +
            'limit — further reads will degrade to Tesseract, not block the claim',
        );
      }
      // Read per call, not at import: an operator tightening or widening the
      // cap mid-incident must take effect on the next extraction.
      const hardLimit = claimHardLimitInr();
      if (claimSpend >= hardLimit) {
        verdict.claimUnderLimit = false;
        verdict.action = 'block';
        verdict.reason = `claim spend ₹${claimSpend.toFixed(2)} ≥ hard limit ₹${hardLimit}`;
        return verdict;
      }
      const softLimit = claimSoftLimitInr();
      if (claimSpend >= softLimit) {
        // Soft warn — don't downgrade the action, but flag the reason.
        verdict.reason = `claim spend ₹${claimSpend.toFixed(2)} ≥ soft limit ₹${softLimit}`;
      }
    }

    // Hospital dimension. A throttle here is held back rather than applied
    // immediately: 'pause_for_consent' outranks it, and a verdict that had
    // already been downgraded to 'throttle' must still be upgradable.
    let throttleReason: string | null = null;
    if (hospitalId) {
      const caps = await this.getHospitalCaps(hospitalId, db);
      verdict.hospitalDailyCapInr = caps.daily;
      verdict.hospitalMonthlyCapInr = caps.monthly;

      const [daily, monthly] = await Promise.all([
        this.getHospitalSpendInr(hospitalId, 'today', db),
        this.getHospitalSpendInr(hospitalId, 'month', db),
      ]);
      verdict.hospitalDailySpendInr = daily;
      verdict.hospitalMonthlySpendInr = monthly;

      const dailyRatio = caps.daily > 0 ? daily / caps.daily : 0;
      const monthlyRatio = caps.monthly > 0 ? monthly / caps.monthly : 0;

      if (dailyRatio >= 1 || monthlyRatio >= 1) {
        verdict.hospitalUnderLimit = false;
        verdict.action = 'block';
        verdict.reason =
          dailyRatio >= 1
            ? `hospital daily spend ₹${daily.toFixed(2)} ≥ cap ₹${caps.daily}`
            : `hospital monthly spend ₹${monthly.toFixed(2)} ≥ cap ₹${caps.monthly}`;
        return verdict;
      }
      if (dailyRatio >= HOSPITAL_THROTTLE_FRACTION || monthlyRatio >= HOSPITAL_THROTTLE_FRACTION) {
        throttleReason =
          dailyRatio >= HOSPITAL_THROTTLE_FRACTION
            ? `hospital daily spend at ${(dailyRatio * 100).toFixed(0)}% of cap`
            : `hospital monthly spend at ${(monthlyRatio * 100).toFixed(0)}% of cap`;
      }
    }

    // ── The run's approved budget ──────────────────────────────────────────
    //
    // Reached only when the static operator caps are satisfied, which is the
    // precedence the whole design turns on: consent buys headroom INSIDE the
    // caps, never through them. A user cannot approve their way past a spend
    // freeze, and 'block' above has already returned.
    if (opts?.runId) {
      verdict.runId = opts.runId;
      const runRow = await this.loadRunBudgetRow(opts.runId, db);
      const effectiveClaimId = claimId ?? runRow?.claimId ?? null;
      if (runRow && effectiveClaimId && runRow.triggeredAt) {
        const spend = await this.getRunSpendInr(
          opts.runId,
          effectiveClaimId,
          runRow.triggeredAt,
          db,
        );
        verdict.runSpendInr = spend.totalInr;
        verdict.runApprovedBudgetInr = spend.approvedBudgetInr;
        if (spend.overBudget) {
          verdict.action = 'pause_for_consent';
          verdict.reason =
            `run spend ₹${Number.isFinite(spend.totalInr) ? spend.totalInr.toFixed(2) : '?'} ` +
            `≥ approved budget ₹${spend.approvedBudgetInr} — pausing for consent`;
          return verdict;
        }
      } else {
        // No run row, or a legacy run with no triggered_at: there is nothing
        // to enforce. Deliberately silent — an unattended caller that passes a
        // stale runId must not have its LLM call blocked by bookkeeping.
        verdict.runApprovedBudgetInr = null;
      }
    }

    if (throttleReason) {
      verdict.action = 'throttle';
      verdict.reason = throttleReason;
    }

    return verdict;
  }
}

export default new CostAccountingService();
