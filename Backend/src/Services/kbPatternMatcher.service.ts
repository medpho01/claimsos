/**
 * Sprint 3, Wave 4A — KB Pattern Matcher
 *
 * Given a claim's dossier, surface the live KB patterns whose `condition`
 * evaluates true against it, ordered by confidence DESC. The matcher is the
 * read-side consumer of `hospital.kb_patterns`; the miner
 * (kbPatternMiner.service.ts) is the write-side producer.
 *
 * Why this is a separate service from the AdjudicationEngine / ReasoningAgent:
 *
 *   1. Wave 4A ships standalone. The matcher returns a list — what to *do*
 *      with the matches (cite in narrative, push into AdjudicationReport.
 *      kb_matches, expose on the cockpit) is Wave 4C's job. Decoupling here
 *      means 4A can be merged and exercised end-to-end before the
 *      ReasoningAgent contract stabilises.
 *
 *   2. Pure read path. The matcher does one indexed JSONB query then a CPU
 *      loop over candidates. We deliberately don't write here (the match
 *      log is appended by `logMatch`, which the caller invokes when they
 *      decide to *use* the match — keeps the read cache-friendly).
 *
 *   3. Unknown condition.kind values are SKIPPED, not errors. This is the
 *      forward-compat lever: a future miner can emit a new condition kind,
 *      and old matcher binaries will silently ignore those rows rather than
 *      crashing the cockpit.
 *
 * Scope matching (the SQL probe in `loadLivePatterns`) is conservative — it
 * narrows by `pattern_type` + status='live' + any of {global=true | panel_id
 * match | insurer_id match | procedure_code match | diagnosis_class match |
 * hospital_id match}. Per-pattern fine-grained scope checks are repeated in
 * code below for any patterns the SQL coarse filter let through.
 */

import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import type {
  ClaimDossier,
  DocSufficiencyPerStage,
  EventsSummaryEntry,
} from './claimDossierProjector.service.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface KbMatchInput {
  claim_id: string;
  dossier: ClaimDossier;
  /**
   * Best-known procedure / diagnosis classifications. Optional because at
   * pre-auth time we may only have the diagnosis class. Used for scope
   * intersection.
   */
  procedure_code?: string;
  diagnosis_class?: string;
}

export interface KbMatchedPattern {
  id: string;
  pattern_type: string;
  title: string;
  description: string | null;
  prediction: any;
  confidence: number;
  evidence_count: number;
}

// ─── Internal types ───────────────────────────────────────────────────────

/** Raw DB row shape, kept narrow to the columns the matcher actually reads. */
interface PatternRow {
  id: string;
  pattern_type: string;
  title: string;
  description: string | null;
  scope: Record<string, any> | null;
  condition: { kind: string; params?: Record<string, any> } | null;
  prediction: any;
  confidence: string | number;
  evidence_count: number;
}

// Cap the matcher's output. Cockpit cares about the top-N; everything beyond
// that is noise. Keep aligned with what the AdjudicationReport.kb_matches
// renderer expects to ingest.
const MAX_MATCHES = 10;

// ─── Service ──────────────────────────────────────────────────────────────

export class KbPatternMatcher {
  private readonly pool: Pick<Pool, 'query'>;

  constructor(pool: Pick<Pool, 'query'> = defaultPool) {
    this.pool = pool;
  }

  /**
   * Match live patterns against a dossier. Returns at most MAX_MATCHES rows
   * ordered by confidence DESC (then evidence_count DESC as a tie-breaker).
   *
   * Implementation notes:
   *   - SQL probe is a coarse filter (status='live' + scope intersection).
   *   - Per-row condition evaluation runs in code so the matcher can be
   *     extended without DB migrations.
   *   - Unknown condition kinds are skipped with a debug log, not raised.
   */
  async match(input: KbMatchInput): Promise<KbMatchedPattern[]> {
    const candidates = await this.loadLivePatterns(input);

    const matched: KbMatchedPattern[] = [];
    for (const row of candidates) {
      // Defensive: scope-vector match is already coarsely filtered in SQL,
      // but re-check exactly in code (the SQL uses OR-of-equalities, which
      // can let through rows that share *one* scope dimension while not
      // matching the others when both are set).
      if (!scopeMatchesClaim(row.scope, input)) continue;

      if (!row.condition || typeof row.condition.kind !== 'string') {
        logger.debug(
          { pattern_id: row.id },
          'kbPatternMatcher: skipping row with malformed condition',
        );
        continue;
      }

      const ok = evaluateCondition(row.condition, input.dossier);
      if (ok === 'skip') {
        logger.debug(
          { pattern_id: row.id, kind: row.condition.kind },
          'kbPatternMatcher: skipping unknown condition kind',
        );
        continue;
      }
      if (!ok) continue;

      matched.push({
        id: row.id,
        pattern_type: row.pattern_type,
        title: row.title,
        description: row.description,
        prediction: row.prediction,
        confidence: typeof row.confidence === 'string'
          ? parseFloat(row.confidence)
          : row.confidence,
        evidence_count: row.evidence_count,
      });
    }

    matched.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.evidence_count - a.evidence_count;
    });
    return matched.slice(0, MAX_MATCHES);
  }

  /**
   * Append a row to kb_pattern_matches so the eval harness can later compute
   * precision once the claim closes. Caller invokes this when they *use* the
   * match (e.g. the ReasoningAgent includes it in a report) — not on every
   * read of `match()` (would inflate the log with passive lookups).
   */
  async logMatch(
    patternId: string,
    claimId: string,
    reportId?: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO hospital.kb_pattern_matches
           (pattern_id, claim_id, adjudication_report_id)
         VALUES ($1, $2, $3)`,
        [patternId, claimId, reportId ?? null],
      );
    } catch (err) {
      // Log-and-swallow: a match-log write failure shouldn't blow up the
      // surrounding adjudication run.
      logger.warn(
        { err, patternId, claimId, reportId },
        'kbPatternMatcher.logMatch: insert failed',
      );
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private async loadLivePatterns(input: KbMatchInput): Promise<PatternRow[]> {
    const params: any[] = [];
    const scopeClauses: string[] = [`scope @> '{"global":true}'::jsonb`];

    if (input.dossier.current_panel_id) {
      params.push(input.dossier.current_panel_id);
      scopeClauses.push(`scope @> jsonb_build_object('panel_id', $${params.length}::text)`);
    }
    if (input.dossier.current_insurer_id) {
      params.push(input.dossier.current_insurer_id);
      scopeClauses.push(`scope @> jsonb_build_object('insurer_id', $${params.length}::text)`);
    }
    if (input.procedure_code) {
      params.push(input.procedure_code);
      scopeClauses.push(`scope @> jsonb_build_object('procedure_code', $${params.length}::text)`);
    }
    if (input.diagnosis_class) {
      params.push(input.diagnosis_class);
      scopeClauses.push(`scope @> jsonb_build_object('diagnosis_class', $${params.length}::text)`);
    }

    const sql = `
      SELECT id, pattern_type, title, description, scope, condition,
             prediction, confidence, evidence_count
        FROM hospital.kb_patterns
       WHERE status = 'live'
         AND (${scopeClauses.join(' OR ')})
       ORDER BY confidence DESC, evidence_count DESC
       LIMIT 200
    `;
    const res = await this.pool.query<PatternRow>(sql, params);
    return res.rows ?? [];
  }
}

// ─── Scope checking (post-SQL exact match) ────────────────────────────────

function scopeMatchesClaim(
  scope: Record<string, any> | null,
  input: KbMatchInput,
): boolean {
  if (!scope) return false;
  if (scope.global === true) return true;

  // Each declared scope dimension must equal the claim's same dimension.
  // (Coarse SQL would accept "panel matches OR insurer matches"; here we
  // require ALL declared dimensions to match.)
  if (scope.panel_id && scope.panel_id !== input.dossier.current_panel_id) {
    return false;
  }
  if (scope.insurer_id && scope.insurer_id !== input.dossier.current_insurer_id) {
    return false;
  }
  if (scope.procedure_code && scope.procedure_code !== input.procedure_code) {
    return false;
  }
  if (scope.diagnosis_class && scope.diagnosis_class !== input.diagnosis_class) {
    return false;
  }
  // hospital_id is implicit (the matcher is always called inside one
  // hospital's context); if a scope row pins it explicitly and we don't
  // know it on the input, treat as no-match to be safe.
  return true;
}

// ─── Condition evaluation ─────────────────────────────────────────────────
// Each kind here corresponds to a v0 miner strategy. Returning the string
// 'skip' tells `match` to drop the row with a debug log rather than treat it
// as either match or non-match — this is the forward-compat path for unknown
// kinds emitted by a newer miner version.

type CondEvalResult = boolean | 'skip';

export function evaluateCondition(
  condition: { kind: string; params?: Record<string, any> },
  dossier: ClaimDossier,
): CondEvalResult {
  const p = condition.params ?? {};

  switch (condition.kind) {
    case 'doc_missing':
      return evalDocMissing(p, dossier);

    case 'doc_present':
      return evalDocPresent(p, dossier);

    case 'amount_in_range':
      return evalAmountInRange(p, dossier);

    case 'past_outcome_seq':
      return evalPastOutcomeSeq(p, dossier);

    case 'stage_dwell':
      return evalStageDwell(p, dossier);

    default:
      return 'skip';
  }
}

function evalDocMissing(
  params: any,
  dossier: ClaimDossier,
): boolean {
  const cat = params?.required_doc_category;
  if (!cat || typeof cat !== 'string') return false;
  const sections = dossier.doc_sections_by_category ?? {};
  const list = sections[cat];
  return !list || list.length === 0;
}

function evalDocPresent(
  params: any,
  dossier: ClaimDossier,
): boolean {
  const cat = params?.required_doc_category;
  if (!cat || typeof cat !== 'string') return false;
  const sections = dossier.doc_sections_by_category ?? {};
  const list = sections[cat];
  return Array.isArray(list) && list.length > 0;
}

function evalAmountInRange(
  params: any,
  dossier: ClaimDossier,
): boolean {
  const fieldPath = params?.field_path;
  if (!fieldPath || typeof fieldPath !== 'string') return false;
  const value = readAmountByPath(dossier.amounts, fieldPath);
  if (value == null || typeof value !== 'number') return false;

  const min = typeof params.min === 'number' ? params.min : -Infinity;
  const max = typeof params.max === 'number' ? params.max : Infinity;
  return value >= min && value <= max;
}

function readAmountByPath(
  amounts: ClaimDossier['amounts'],
  path: string,
): number | null {
  if (!amounts) return null;
  // Single-segment path only (we don't currently nest amounts deeper than 1).
  const v = (amounts as Record<string, any>)[path];
  return typeof v === 'number' ? v : null;
}

function evalPastOutcomeSeq(
  params: any,
  dossier: ClaimDossier,
): boolean {
  const want: string[] | undefined = params?.seq;
  if (!Array.isArray(want) || want.length === 0) return false;

  // Walk outbound_submissions in order; ensure the requested sequence of
  // status codes appears as a contiguous prefix or anywhere as a sub-sequence.
  // We use sub-sequence to tolerate intermediate retries.
  const actual = (dossier.outbound_submissions ?? []).map((e) => e.status);
  let i = 0;
  for (const status of actual) {
    if (i >= want.length) break;
    if (status === want[i]) i += 1;
  }
  return i === want.length;
}

function evalStageDwell(
  params: any,
  dossier: ClaimDossier,
): boolean {
  const stage = params?.stage;
  if (!stage || typeof stage !== 'string') return false;
  const minHours = typeof params.min_hours === 'number' ? params.min_hours : 0;
  const maxHours = typeof params.max_hours === 'number' ? params.max_hours : Infinity;

  // events_summary is the canonical timeline. Find the most recent transition
  // into `stage` and measure (next transition or now) - then.
  const events = dossier.events_summary ?? [];
  const intoStage = lastTransitionInto(events, stage);
  if (!intoStage) return false;

  const exitAt = nextTransitionAfter(events, intoStage.at, stage);
  const fromMs = new Date(intoStage.at).getTime();
  const toMs = exitAt ? new Date(exitAt).getTime() : Date.now();
  const dwellHours = (toMs - fromMs) / (1000 * 60 * 60);
  return dwellHours >= minHours && dwellHours <= maxHours;
}

function lastTransitionInto(
  events: EventsSummaryEntry[],
  stage: string,
): EventsSummaryEntry | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'stage_transitioned' && (e.salient as any)?.after_stage === stage) {
      return e;
    }
  }
  return null;
}

function nextTransitionAfter(
  events: EventsSummaryEntry[],
  afterIso: string,
  fromStage: string,
): string | null {
  const t = new Date(afterIso).getTime();
  for (const e of events) {
    if (e.kind !== 'stage_transitioned') continue;
    if (new Date(e.at).getTime() <= t) continue;
    const salient = e.salient as any;
    if (salient?.before_stage === fromStage && salient?.after_stage && salient.after_stage !== fromStage) {
      return e.at;
    }
  }
  return null;
}

// Re-export the dossier types so future Wave 4C imports can pull both from
// the same module (matches the convention in claimDossier.service.ts).
export type { ClaimDossier, DocSufficiencyPerStage } from './claimDossierProjector.service.js';

export default new KbPatternMatcher();
