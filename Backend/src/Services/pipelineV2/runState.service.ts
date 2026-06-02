/**
 * Pipeline v2 — Stage 7: the run SIGNALS report.
 *
 * ARCHITECTURAL BOUNDARY — the pipeline INTERPRETS, it does not ADJUDICATE.
 * Its only job is to read the uploaded files and emit an accurate JSON of the
 * patient's treatment journey, plus a set of NON-BLOCKING signals that flag
 * anything a reviewer (or the separate rules layer) might want to look at:
 * foreign pages that were removed, pages that might belong to a different
 * episode, coverage gaps, values it could not confidently resolve.
 *
 * It NEVER decides whether to hold, file, or block a claim. That adjudication
 * lives in the rules layer (Wave 8 harmonisation), which evaluates insurer rule
 * sets against the harmonised episode + these signals DOWNSTREAM. There is no
 * veto here by design — every signal is advisory.
 *
 * This stage also rolls up the run's REAL cost (sum of per-page INR; zero on a
 * fully-replayed offline run) and the page-disposition counts, so the harness
 * reports true spend and true page accounting alongside the signals.
 */

import { PipelinePage, CoverageReport } from './types.js';
import { IdentityGateResult } from './identityGate.service.js';
import { ValidationReport } from './validators.service.js';
import { DedupResult } from './dedup.service.js';

/** The kinds of advisory signal the interpretation pass can raise. */
export type SignalKind =
  /** A different patient's pages were excluded from the JSON (correct interpretation). */
  | 'foreign_pages_removed'
  /** ≥2 distinct patient/episode ids remain in an incoherent bundle. */
  | 'multiple_identities'
  /** Pages flagged as a possible DIFFERENT EPISODE still contributed facts. */
  | 'possible_contamination'
  /** A Layer-A source under-rendered — the JSON may be missing pages. */
  | 'coverage_gap'
  /** A value the pipeline could not confidently read or resolve. */
  | 'low_confidence_field';

export type SignalSeverity = 'info' | 'warn';

export interface RunSignal {
  kind: SignalKind;
  /** Advisory weight only. 'info' = expected/handled; 'warn' = worth a look. NEVER blocks. */
  severity: SignalSeverity;
  /** Human-readable explanation for the review UI and the rules layer. */
  reason: string;
  /** Page ids this signal points at (empty for field-level signals). */
  pageIds: string[];
  /** Field names this signal points at (empty for page-level signals). */
  fields: string[];
}

export interface RunStateInput {
  coverage: CoverageReport;
  identity: IdentityGateResult;
  validation: ValidationReport;
  /** Optional — when present, dedup counts feed the run summary. */
  dedup?: DedupResult;
  /** All read pages — used for cost rollup and counts. */
  pages: PipelinePage[];
}

export interface RunState {
  /** Advisory signals that ride alongside the JSON. NEVER a gate. */
  signals: RunSignal[];
  cost: {
    /** Sum of per-page INR actually billed (0 on a fully-replayed run). */
    totalInr: number;
    /** true ⇔ every page was free (served from record/replay). */
    fullyReplayed: boolean;
  };
  counts: {
    sources: number;
    pagesRendered: number;
    pagesKept: number;
    duplicates: number;
    quarantined: number;
    review: number;
  };
}

/**
 * Compute the run's signals + cost + counts from the upstream stage outputs.
 *
 * Pure + deterministic. Raises advisory signals; it does NOT decide whether the
 * JOB succeeded (the orchestrator's concern) NOR whether the claim should be
 * held/filed (the rules layer's concern).
 */
export function evaluateRunState(input: RunStateInput): RunState {
  const { coverage, identity, validation, dedup, pages } = input;
  const signals: RunSignal[] = [];

  // Coverage gap (Stage 0 / E6) — some Layer-A pages never rendered, so the JSON
  // may be missing facts. Advisory, not a block: an incomplete journey is still
  // an honest interpretation of the pages we DID read.
  if (!coverage.ok) {
    const shortfall = coverage.missing.reduce(
      (n, m) => n + (m.expectedPages - m.renderedPages),
      0,
    );
    signals.push({
      kind: 'coverage_gap',
      severity: 'warn',
      reason: `${coverage.missing.length} source(s) under-rendered (${shortfall} page(s) missing)${
        coverage.orphanSourceDocIds.length ? `; ${coverage.orphanSourceDocIds.length} orphan render(s)` : ''
      }`,
      pageIds: [],
      fields: [],
    });
  }

  // Foreign pages removed (Stage 2) — a different patient's pages were excluded
  // from the JSON. This is CORRECT interpretation (those pages aren't this
  // patient's journey), surfaced as INFO so a reviewer can confirm the removal.
  if (identity.quarantinedPageIds.length) {
    signals.push({
      kind: 'foreign_pages_removed',
      severity: 'info',
      reason: `${identity.quarantinedPageIds.length} page(s) excluded as a different patient's records`,
      pageIds: [...identity.quarantinedPageIds],
      fields: [],
    });
  }

  // Multiple identities (Stage 2) — the gate judged the bundle INCOHERENT and
  // ≥2 distinct patient/episode ids remain. The bundle may still mix patients
  // or episodes; flag it for a reviewer rather than silently fusing.
  if (
    !identity.coherent &&
    (identity.distinctUhids.length > 1 || identity.distinctIpdNumbers.length > 1)
  ) {
    const parts: string[] = [];
    if (identity.distinctUhids.length > 1) parts.push(`${identity.distinctUhids.length} distinct uhids`);
    if (identity.distinctIpdNumbers.length > 1) {
      parts.push(`${identity.distinctIpdNumbers.length} distinct ipd numbers`);
    }
    signals.push({
      kind: 'multiple_identities',
      severity: 'warn',
      reason: `bundle carries ${parts.join(' and ')} — may mix patients or episodes`,
      pageIds: [],
      fields: [],
    });
  }

  // Possible contamination (Stage 2 episode-outliers) — pages flagged as a
  // POSSIBLE DIFFERENT EPISODE that still contributed facts to the JSON. These
  // are the pages most likely to leak a wrong date/diagnosis, so they are the
  // headline "suspicious files" signal a reviewer should inspect first.
  if (identity.reviewPageIds.length) {
    signals.push({
      kind: 'possible_contamination',
      severity: 'warn',
      reason: `${identity.reviewPageIds.length} page(s) may belong to a different episode`,
      pageIds: [...identity.reviewPageIds],
      fields: [],
    });
  }

  // Low-confidence fields (Stage 6) — values the pipeline could not confidently
  // read/resolve (decimal shift, impossible LOS, ambiguous laterality, unsourced
  // diagnosis). Surfaced per-field so the JSON can carry the uncertainty.
  if (validation.abstainedFields.length) {
    signals.push({
      kind: 'low_confidence_field',
      severity: 'warn',
      reason: `low-confidence / unresolved: ${validation.abstainedFields.join(', ')}`,
      pageIds: [],
      fields: [...validation.abstainedFields],
    });
  }

  const totalInr = pages.reduce((sum, p) => sum + (p.costInr ?? 0), 0);
  const fullyReplayed = pages.length > 0 && pages.every((p) => (p.costInr ?? 0) === 0);

  return {
    signals,
    cost: { totalInr: round2(totalInr), fullyReplayed },
    counts: {
      sources: coverage.totalSources,
      pagesRendered: pages.length,
      pagesKept: dedup ? dedup.keepPageIds.length : pages.length,
      duplicates: dedup ? dedup.duplicatePageIds.length : 0,
      quarantined: identity.quarantinedPageIds.length,
      review: identity.reviewPageIds.length,
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
