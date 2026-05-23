/**
 * KB Hints — read-side bridge from the kbPatternMiner output into the
 * inference path of other services.
 *
 * The miner produces `kb_patterns` rows of various pattern_types (Wave 10):
 * category_confusion, missing_doc_for_diagnosis, etc. Each row carries a
 * `status` lifecycle (candidate → live → demoted/archived). This service
 * reads ONLY status='live' rows and projects them into compact hint shapes
 * that the inference path can splice into its prompt.
 *
 * Why a separate service?
 * - kbPatternMatcher.service.ts is dossier-scoped (matches patterns against
 *   a SINGLE claim's state). The classifier needs the GLOBAL hint corpus,
 *   not per-claim matches.
 * - The hint corpus is tiny (dozens of rows once mined) and changes only
 *   when a SuperAdmin promotes a pattern. We cache it module-level with a
 *   short TTL so the classifier hot path never pays the round-trip.
 *
 * Public surface (intentionally narrow):
 * - getApprovedCategoryHints() → array of (previous_category, corrected_category,
 *   sample_size). Empty array when no patterns are live yet.
 *
 * Future hint kinds (when their respective patterns are mined) go in here as
 * separate functions, NOT mixed into the existing payload.
 */

import { pool as defaultPool } from '../DB/db.js';
import type { Pool } from 'pg';
import { logger } from '../Utils/logger.js';

export interface CategoryHint {
  /** The category the classifier most commonly *gets wrong* on this signature. */
  previous_category: string;
  /** The category humans corrected it to (the right answer). */
  corrected_category: string;
  /** How many distinct claims observed this correction — drives the
   *  "Strong/Suggestive" framing in the prompt. */
  sample_size: number;
  /** Optional KB pattern id, mostly for debug / lineage. */
  pattern_id: string;
}

interface CachedHints {
  fetched_at: number;
  hints: CategoryHint[];
}

/**
 * Module-level cache. The hint corpus is small (dozens of rows post-mining),
 * read on every classify call, and only changes when a SuperAdmin promotes a
 * pattern in the KB review UI — perfect for in-process caching with a short
 * TTL. We invalidate by time (CACHE_TTL_MS) rather than by event because the
 * miner runs in a separate worker process and we don't have a cross-process
 * cache-bust mechanism in place yet.
 */
const CACHE_TTL_MS = 60_000; // 1 min — long enough to amortise, short enough that a freshly-promoted pattern is live within a minute.
let cache: CachedHints | null = null;

export interface KbHintsDeps {
  pool?: Pick<Pool, 'query'>;
}

export class KbHintsService {
  private readonly pool: Pick<Pool, 'query'>;

  constructor(deps: KbHintsDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
  }

  /**
   * Fetch the active set of (previous → corrected) category hints. Returns
   * an empty array (NEVER throws) when the patterns table doesn't exist yet
   * or when no patterns have been promoted — both are valid states early
   * in the system's life and the classifier should degrade gracefully.
   */
  async getApprovedCategoryHints(): Promise<CategoryHint[]> {
    const now = Date.now();
    if (cache && now - cache.fetched_at < CACHE_TTL_MS) {
      return cache.hints;
    }
    try {
      const res = await this.pool.query<{
        id: string;
        condition: any;
        prediction: any;
        evidence_count: number;
      }>(
        `SELECT id, condition, prediction, evidence_count
           FROM hospital.kb_patterns
          WHERE status = 'live'
            AND pattern_type = 'category_confusion'`,
      );
      const hints: CategoryHint[] = [];
      for (const row of res.rows) {
        // Defensive: kbPatternMiner.service.ts:STRATEGY 6 emits these in a
        // specific shape, but a future strategy might emit a different
        // category_confusion variant. Skip rows we can't parse rather than
        // throw — the classifier still runs without hints.
        const previous = row.condition?.params?.previous_category;
        const corrected = row.prediction?.params?.category;
        if (typeof previous !== 'string' || typeof corrected !== 'string') {
          continue;
        }
        if (previous === corrected) continue;
        hints.push({
          previous_category: previous,
          corrected_category: corrected,
          sample_size:
            row.prediction?.params?.sample_size ?? row.evidence_count ?? 0,
          pattern_id: row.id,
        });
      }
      cache = { fetched_at: now, hints };
      return hints;
    } catch (err: any) {
      // The kb_patterns table may not exist in older test schemas, and we
      // never want a missing-table error to break the classifier.
      logger.warn(
        { err: err?.message ?? String(err) },
        'kbHints: getApprovedCategoryHints failed; returning empty list',
      );
      return [];
    }
  }

  /** Test seam — clear the module cache. */
  static resetCacheForTests(): void {
    cache = null;
  }
}

export const kbHintsService = new KbHintsService();
