/**
 * Wave 10 — AI Corrections Service.
 *
 * Single write-path for the hospital.ai_corrections table. The four existing
 * correction-writing surfaces (document section reclassify, email-intel
 * draft override, harmonisation JSONPath edit, rule override) call into
 * `record()` AFTER their domain-specific INSERT — see the listener wiring
 * in those services for the integration points.
 *
 * Design notes:
 *
 *   * record() is best-effort. Callers wrap it in their own try/catch and
 *     must NOT block the underlying correction write on a failure here.
 *     This file does its own try/catch on the actual insert and logs but
 *     does not throw on duplicate / DB hiccups.
 *
 *   * listUnmined() is the mining-side reader. The miner calls it with a
 *     surface filter, groups in-memory, and then calls markMined() with
 *     the contributing ids once a candidate pattern lands.
 *
 *   * getRecent(claim_id) backs the per-claim FE drawer.
 *
 *   * All three methods accept a Pool-or-stub via constructor so unit tests
 *     can drive them with a fake (matching kbPatternMiner.service.ts style).
 */

import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export type AiCorrectionSurface =
  | 'document_category'
  | 'extraction_field'
  | 'harmonised_field'
  | 'rule_override'
  | 'ai_draft_field'
  | 'audit_call_wrong';

export interface AiCorrectionInput {
  surface: AiCorrectionSurface;
  claim_id?: string | null;
  target_id?: string | null;
  target_kind?: string | null;
  ai_value?: unknown;
  human_value: unknown;
  reason?: string | null;
  corrected_by: string;
}

export interface AiCorrectionRow {
  id: string;
  surface: AiCorrectionSurface;
  claim_id: string | null;
  target_id: string | null;
  target_kind: string | null;
  ai_value: unknown;
  human_value: unknown;
  reason: string | null;
  corrected_by: string;
  corrected_at: string;
  applied_to_kb: boolean;
  mined_pattern_id: string | null;
}

export interface ListUnminedOpts {
  since_days?: number;
  surface?: AiCorrectionSurface;
  limit?: number;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class AiCorrectionsService {
  private readonly pool: Pick<Pool, 'query'>;

  constructor(pool: Pick<Pool, 'query'> = defaultPool as any) {
    this.pool = pool;
  }

  /**
   * Insert one ai_corrections row. Returns the new id.
   *
   * Callers from the existing correction-writing paths wrap this in their
   * own try/catch — record() never throws on best-effort callers, but the
   * unit tests want the inserted id back, so we DO surface DB errors here.
   */
  async record(input: AiCorrectionInput): Promise<{ id: string }> {
    const aiVal =
      input.ai_value === undefined ? null : JSON.stringify(input.ai_value);
    const humanVal = JSON.stringify(input.human_value);

    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO hospital.ai_corrections (
         surface, claim_id, target_id, target_kind,
         ai_value, human_value, reason, corrected_by
       ) VALUES (
         $1, $2, $3, $4,
         $5::jsonb, $6::jsonb, $7, $8
       )
       RETURNING id`,
      [
        input.surface,
        input.claim_id ?? null,
        input.target_id ?? null,
        input.target_kind ?? null,
        aiVal,
        humanVal,
        input.reason ?? null,
        input.corrected_by,
      ],
    );
    const id = res.rows[0]?.id;
    if (!id) {
      throw new Error('aiCorrections.record: no id returned from INSERT');
    }
    return { id };
  }

  /**
   * Rows where applied_to_kb=false, optionally filtered by surface and a
   * recency cutoff. Defaults: since_days=180 (broad enough to catch the
   * trailing tail of human review), limit=2000 (the miner will refuse to
   * scan unbounded sets).
   */
  async listUnmined(opts: ListUnminedOpts = {}): Promise<AiCorrectionRow[]> {
    const sinceDays = opts.since_days ?? 180;
    const limit = Math.min(opts.limit ?? 2000, 10000);
    const params: unknown[] = [sinceDays, limit];
    let sql = `
      SELECT id, surface, claim_id, target_id, target_kind,
             ai_value, human_value, reason, corrected_by, corrected_at,
             applied_to_kb, mined_pattern_id
        FROM hospital.ai_corrections
       WHERE applied_to_kb = false
         AND corrected_at >= NOW() - ($1::int || ' days')::interval`;
    if (opts.surface) {
      params.push(opts.surface);
      sql += ` AND surface = $${params.length}`;
    }
    sql += ` ORDER BY corrected_at DESC LIMIT $2`;
    const res = await this.pool.query<AiCorrectionRow>(sql, params);
    return res.rows ?? [];
  }

  /**
   * Flag the given correction ids as mined and link them to the resulting
   * pattern. Used by the miner once a candidate lands. Idempotent — re-
   * running on an already-mined row is a no-op apart from refreshing the
   * mined_pattern_id (which may have changed if a re-mining replaced the
   * upstream pattern).
   */
  async markMined(ids: string[], pattern_id: string): Promise<void> {
    if (!Array.isArray(ids) || ids.length === 0) return;
    await this.pool.query(
      `UPDATE hospital.ai_corrections
          SET applied_to_kb = true,
              mined_pattern_id = $2
        WHERE id = ANY($1::uuid[])`,
      [ids, pattern_id],
    );
  }

  /**
   * Recent corrections for a single claim — backs the per-claim FE drawer.
   * Limit defaults to 50 (a single claim rarely has more than that).
   */
  async getRecent(claim_id: string, limit = 50): Promise<AiCorrectionRow[]> {
    const res = await this.pool.query<AiCorrectionRow>(
      `SELECT id, surface, claim_id, target_id, target_kind,
              ai_value, human_value, reason, corrected_by, corrected_at,
              applied_to_kb, mined_pattern_id
         FROM hospital.ai_corrections
        WHERE claim_id = $1
        ORDER BY corrected_at DESC
        LIMIT $2`,
      [claim_id, Math.min(limit, 200)],
    );
    return res.rows ?? [];
  }

  /**
   * Roll-up counts by surface for the admin dashboard. Cheap aggregate
   * over the partial-indexed table.
   */
  async countsBySurface(opts: { since_days?: number } = {}): Promise<
    Array<{ surface: AiCorrectionSurface; total: number; unmined: number }>
  > {
    const sinceDays = opts.since_days ?? 180;
    const res = await this.pool.query<{
      surface: AiCorrectionSurface;
      total: string | number;
      unmined: string | number;
    }>(
      `SELECT surface,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE applied_to_kb = false) AS unmined
         FROM hospital.ai_corrections
        WHERE corrected_at >= NOW() - ($1::int || ' days')::interval
        GROUP BY surface
        ORDER BY surface ASC`,
      [sinceDays],
    );
    return (res.rows ?? []).map((r) => ({
      surface: r.surface,
      total: Number(r.total),
      unmined: Number(r.unmined),
    }));
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────
// Module-level singleton mirrors the kbPatternMiner.service.ts pattern;
// callers from listener integration points import this default. Unit tests
// instantiate a fresh AiCorrectionsService(mockPool).

const aiCorrectionsService = new AiCorrectionsService();
export default aiCorrectionsService;

/**
 * Best-effort wrapper used by listener integration points. Swallows all
 * errors and logs them — the goal is "never break the upstream write".
 */
export async function recordCorrectionBestEffort(
  input: AiCorrectionInput,
): Promise<void> {
  try {
    await aiCorrectionsService.record(input);
  } catch (err) {
    logger.warn(
      { err, surface: input.surface, target_id: input.target_id },
      'aiCorrections.recordBestEffort: insert failed (non-blocking)',
    );
  }
}
