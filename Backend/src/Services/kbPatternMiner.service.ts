/**
 * Sprint 3, Wave 4A — KB Pattern Miner (v0, SQL-only)
 *
 * Periodically walks closed claims and emits candidate `kb_patterns` rows.
 * v0 deliberately avoids LLMs — every strategy is a deterministic SQL
 * aggregation against the closed-claim history. Why:
 *
 *   1. Cost. We can re-mine the whole closed-claim corpus nightly for ~free.
 *      An LLM pass would burn tokens for what is essentially `GROUP BY`.
 *
 *   2. Auditability. A reviewer can read the strategy code and trace exactly
 *      why a pattern was raised. LLM-mined patterns (later sprint) get a
 *      `prompt_version` column for the same reason.
 *
 *   3. Day-1 reality. Closed-claim sample is small at launch. The miner is
 *      written to gracefully emit zero candidates when there isn't enough
 *      data — every strategy has a minimum-n threshold that defaults to >=5
 *      or >=10 (per the spec). A panel with two closed claims yields nothing.
 *
 * Output lifecycle: every candidate lands as status='candidate'. A reviewer
 * (Kratika via the admin UI added in Wave 5) inspects + promotes to 'live'.
 * The matcher (kbPatternMatcher.service.ts) only reads 'live' rows.
 *
 * Re-mining: signature-based ON CONFLICT. A re-run that re-discovers a
 * pattern bumps evidence_count and last_seen_at; a pattern that stops
 * appearing in fresh data simply doesn't get its last_seen_at refreshed,
 * which a future cleanup job can use to demote stale rows.
 */

import type { Pool, PoolClient } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

export const MINER_VERSION = 'v0';

export interface MineOptions {
  /** Only consider claims closed within this many days. Default 90. */
  sinceDays?: number;
  /** Hard cap on the number of closed claims scanned. Default 500. */
  maxClaims?: number;
}

export interface MineResult {
  candidatesAdded: number;
  existingReinforced: number;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class KbPatternMiner {
  private readonly pool: Pick<Pool, 'query' | 'connect'>;

  constructor(pool: Pick<Pool, 'query' | 'connect'> = defaultPool as any) {
    this.pool = pool;
  }

  /**
   * Run every v0 strategy against the closed-claim corpus and INSERT/UPDATE
   * candidates. Returns counts; callers (cron / admin) log them. The miner
   * never throws on "no data" — strategies that don't have enough rows just
   * return zero candidates.
   */
  async mineCandidatesFromClosedClaims(
    opts: MineOptions = {},
  ): Promise<MineResult> {
    const sinceDays = opts.sinceDays ?? 90;
    const maxClaims = opts.maxClaims ?? 500;

    let candidatesAdded = 0;
    let existingReinforced = 0;

    // Each strategy returns { candidates, evidenceMap } where evidenceMap is
    // pattern_signature → sample claim_ids. We then UPSERT each candidate.
    const strategies: Array<() => Promise<Candidate[]>> = [
      () => this.mineInsurerQueryPatterns(sinceDays, maxClaims),
      () => this.mineDeductionPatterns(sinceDays, maxClaims),
      () => this.mineDocCorrelations(sinceDays, maxClaims),
      () => this.mineStageTransitions(sinceDays, maxClaims),
      () => this.mineAmountVariance(sinceDays, maxClaims),
    ];

    for (const run of strategies) {
      let candidates: Candidate[] = [];
      try {
        candidates = await run();
      } catch (err) {
        // One strategy failing should not poison the others — log and move on.
        logger.warn(
          { err },
          'kbPatternMiner: strategy errored; skipping its candidates',
        );
        continue;
      }
      for (const c of candidates) {
        const inserted = await this.upsertCandidate(c);
        if (inserted) candidatesAdded += 1;
        else existingReinforced += 1;
      }
    }

    return { candidatesAdded, existingReinforced };
  }

  /**
   * Mark a candidate (or any non-live pattern) as live. Used by the
   * reviewer admin UI. Idempotent: re-promoting a live row is a no-op
   * apart from refreshing reviewed_at.
   */
  async promoteCandidate(
    patternId: string,
    reviewerId: string,
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE hospital.kb_patterns
          SET status = 'live',
              reviewed_by = $2,
              reviewed_at = NOW(),
              promotion_reason = $3
        WHERE id = $1`,
      [patternId, reviewerId, reason],
    );
  }

  async demotePattern(
    patternId: string,
    reviewerId: string,
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE hospital.kb_patterns
          SET status = 'demoted',
              reviewed_by = $2,
              reviewed_at = NOW(),
              demotion_reason = $3
        WHERE id = $1`,
      [patternId, reviewerId, reason],
    );
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  /**
   * Insert a candidate, ON CONFLICT (pattern_signature) bumping
   * evidence_count + last_seen_at. Returns true when a new row was inserted,
   * false when an existing row was reinforced.
   *
   * The signature is computed by Postgres (STORED generated column). We rely
   * on `xmax = 0` to disambiguate insert vs update in a single round-trip —
   * standard ON CONFLICT trick.
   */
  private async upsertCandidate(c: Candidate): Promise<boolean> {
    const scopeJson = JSON.stringify(c.scope);
    const conditionJson = JSON.stringify(c.condition);
    const predictionJson = JSON.stringify(c.prediction);
    // Cap evidence_claim_ids stored on the row to ~50 (spec). The full set
    // would balloon the row beyond what's useful for spot-checking; the
    // canonical population size lives in evidence_count.
    const sample = c.evidence_claim_ids.slice(0, 50);

    const res = await this.pool.query<{ inserted: boolean }>(
      `INSERT INTO hospital.kb_patterns (
         pattern_type, title, description,
         scope, condition, prediction,
         confidence, evidence_count, evidence_claim_ids,
         status, miner_version
       )
       VALUES (
         $1, $2, $3,
         $4::jsonb, $5::jsonb, $6::jsonb,
         $7, $8, $9::uuid[],
         'candidate', $10
       )
       ON CONFLICT (pattern_signature) DO UPDATE
         SET evidence_count = hospital.kb_patterns.evidence_count + EXCLUDED.evidence_count,
             last_seen_at  = NOW(),
             -- Refresh sample list when the existing one is empty (avoids
             -- nuking a reviewer's annotated set).
             evidence_claim_ids = CASE
               WHEN cardinality(hospital.kb_patterns.evidence_claim_ids) = 0
                 THEN EXCLUDED.evidence_claim_ids
               ELSE hospital.kb_patterns.evidence_claim_ids
             END,
             -- Confidence updates only if new value is materially higher;
             -- a re-mining shouldn't downgrade a hand-promoted pattern.
             confidence = GREATEST(hospital.kb_patterns.confidence, EXCLUDED.confidence)
       RETURNING (xmax = 0) AS inserted`,
      [
        c.pattern_type,
        c.title,
        c.description,
        scopeJson,
        conditionJson,
        predictionJson,
        c.confidence,
        c.evidence_count,
        sample,
        MINER_VERSION,
      ],
    );
    return res.rows[0]?.inserted === true;
  }

  // ─── Strategies ───────────────────────────────────────────────────────
  // Every strategy is a thin SQL aggregation against hospital.claim_dossiers
  // joined with hospital.ipds for the closed-claim slice. Each returns a
  // (small) array of Candidate rows. Strategies that don't have enough data
  // return [].

  /**
   * STRATEGY 1 — insurer_query_pattern
   *
   * Mine: for each (panel × admission_type), what fraction of closed claims
   * had at least one inbound query, and what was the most-frequently-missing
   * doc-category among queried claims? Threshold: rate > 0.6, n >= 5.
   *
   * Output condition kind: 'doc_missing' (the matcher fires when the same
   * doc-category is absent on a fresh claim with this scope).
   * Output prediction kind: 'query_likely'.
   */
  private async mineInsurerQueryPatterns(
    sinceDays: number,
    maxClaims: number,
  ): Promise<Candidate[]> {
    const sql = `
      WITH closed AS (
        SELECT cd.claim_id, cd.current_panel_id AS panel_id,
               i.admission_type AS admission_type,
               jsonb_array_length(COALESCE(cd.active_queries, '[]'::jsonb))
                 + jsonb_array_length(COALESCE(cd.events_summary, '[]'::jsonb)) AS _dummy,
               cd.events_summary
          FROM hospital.claim_dossiers cd
          JOIN hospital.ipds i ON i.id = cd.claim_id
         WHERE cd.closed_at IS NOT NULL
           AND cd.closed_at >= NOW() - ($1::int || ' days')::interval
         LIMIT $2
      ),
      flagged AS (
        SELECT c.claim_id, c.panel_id, c.admission_type,
               EXISTS (
                 SELECT 1 FROM jsonb_array_elements(c.events_summary) e
                 WHERE e->>'kind' = 'query_raised'
               ) AS had_query
          FROM closed c
      )
      SELECT panel_id, admission_type,
             COUNT(*) AS n,
             SUM(CASE WHEN had_query THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) AS query_rate,
             ARRAY_AGG(claim_id) FILTER (WHERE had_query) AS evidence_ids
        FROM flagged
       WHERE panel_id IS NOT NULL
       GROUP BY panel_id, admission_type
      HAVING COUNT(*) >= 5
         AND (SUM(CASE WHEN had_query THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0)) > 0.6
    `;
    const res = await this.pool.query<{
      panel_id: string;
      admission_type: string | null;
      n: string | number;
      query_rate: string | number;
      evidence_ids: string[] | null;
    }>(sql, [sinceDays, maxClaims]);

    return (res.rows ?? []).map((row) => {
      const n = Number(row.n);
      const rate = Number(row.query_rate);
      return {
        pattern_type: 'insurer_query_pattern',
        title: `Panel ${row.panel_id.slice(0, 8)} ${row.admission_type ?? 'any'}: query rate ${(rate * 100).toFixed(0)}%`,
        description:
          `Panel ${row.panel_id} (admission_type=${row.admission_type ?? 'any'}) had at least one insurer query in ${(rate * 100).toFixed(0)}% of ${n} closed claims.`,
        scope: scopeOf({
          panel_id: row.panel_id,
          diagnosis_class: row.admission_type ?? undefined,
        }),
        condition: {
          kind: 'doc_missing',
          // v0 doesn't know which doc was the culprit — we leave a generic
          // 'insurer_query_letter' marker so the prediction at least fires
          // when the dossier lacks that bucket. A v1 LLM-mining pass can
          // pick the actual culprit category.
          params: { required_doc_category: 'insurer_query_letter' },
        },
        prediction: {
          kind: 'query_likely',
          params: { rate, sample_size: n },
          point_estimate: rate,
        },
        confidence: clamp01(rate),
        evidence_count: n,
        evidence_claim_ids: row.evidence_ids ?? [],
      };
    });
  }

  /**
   * STRATEGY 2 — deduction_pattern
   *
   * Mine: for each (panel × admission_type), the mean claimed→approved cut
   * percentage among closed claims. Threshold: rate of cuts > 0.4, n >= 5.
   *
   * Output: condition fires when amounts.claimed > 0; prediction reports
   * the average cut percentage.
   */
  private async mineDeductionPatterns(
    sinceDays: number,
    maxClaims: number,
  ): Promise<Candidate[]> {
    const sql = `
      WITH closed AS (
        SELECT cd.claim_id, cd.current_panel_id AS panel_id,
               i.admission_type AS admission_type,
               cd.amounts
          FROM hospital.claim_dossiers cd
          JOIN hospital.ipds i ON i.id = cd.claim_id
         WHERE cd.closed_at IS NOT NULL
           AND cd.closed_at >= NOW() - ($1::int || ' days')::interval
           AND cd.amounts ? 'claimed'
         LIMIT $2
      ),
      cut AS (
        SELECT claim_id, panel_id, admission_type,
               (amounts->>'claimed')::numeric AS claimed,
               COALESCE((amounts->>'final_approved')::numeric,
                        (amounts->>'pre_auth_approved')::numeric, 0) AS approved
          FROM closed
         WHERE (amounts->>'claimed')::numeric > 0
      )
      SELECT panel_id, admission_type,
             COUNT(*) AS n,
             AVG(CASE WHEN claimed > 0 THEN (claimed - approved) / claimed ELSE 0 END) AS mean_cut_pct,
             SUM(CASE WHEN approved < claimed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0) AS cut_rate,
             ARRAY_AGG(claim_id) FILTER (WHERE approved < claimed) AS evidence_ids
        FROM cut
       WHERE panel_id IS NOT NULL
       GROUP BY panel_id, admission_type
      HAVING COUNT(*) >= 5
         AND (SUM(CASE WHEN approved < claimed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0)) > 0.4
    `;
    const res = await this.pool.query<{
      panel_id: string;
      admission_type: string | null;
      n: string | number;
      mean_cut_pct: string | number;
      cut_rate: string | number;
      evidence_ids: string[] | null;
    }>(sql, [sinceDays, maxClaims]);

    return (res.rows ?? []).map((row) => {
      const n = Number(row.n);
      const meanCut = Number(row.mean_cut_pct);
      const cutRate = Number(row.cut_rate);
      return {
        pattern_type: 'deduction_pattern',
        title: `Panel ${row.panel_id.slice(0, 8)} ${row.admission_type ?? 'any'}: avg cut ${(meanCut * 100).toFixed(0)}%`,
        description:
          `Panel ${row.panel_id} cuts ~${(meanCut * 100).toFixed(0)}% of claimed amount on ${(cutRate * 100).toFixed(0)}% of ${n} closed claims.`,
        scope: scopeOf({
          panel_id: row.panel_id,
          diagnosis_class: row.admission_type ?? undefined,
        }),
        condition: {
          kind: 'amount_in_range',
          // Fire whenever there's a claimed amount above zero — narrow
          // ranges are a follow-up tuning lever.
          params: { field_path: 'claimed', min: 1 },
        },
        prediction: {
          kind: 'amount_cut_pct',
          params: { sample_size: n, cut_rate: cutRate },
          point_estimate: meanCut,
        },
        confidence: clamp01(cutRate),
        evidence_count: n,
        evidence_claim_ids: row.evidence_ids ?? [],
      };
    });
  }

  /**
   * STRATEGY 3 — doc_correlation
   *
   * Mine: for each panel, by how much does the presence of a particular
   * doc-category change the query-raised rate compared to its absence?
   * Threshold: delta > 0.2 (absolute), n >= 10.
   *
   * This is the "OT notes present → fewer queries" story. Output condition
   * is 'doc_present' (with the doc-category that matters), prediction is
   * 'query_likely' with the *reduced* rate (so the cockpit can render
   * "having this doc historically dropped query rate by Δ").
   */
  private async mineDocCorrelations(
    sinceDays: number,
    maxClaims: number,
  ): Promise<Candidate[]> {
    // We enumerate categories by sniffing the keys present in
    // doc_sections_by_category across the corpus. This keeps the strategy
    // open-ended without needing a hard-coded category list.
    const sql = `
      WITH closed AS (
        SELECT cd.claim_id, cd.current_panel_id AS panel_id,
               cd.doc_sections_by_category AS docs,
               EXISTS (
                 SELECT 1 FROM jsonb_array_elements(COALESCE(cd.events_summary,'[]'::jsonb)) e
                 WHERE e->>'kind' = 'query_raised'
               ) AS had_query
          FROM hospital.claim_dossiers cd
         WHERE cd.closed_at IS NOT NULL
           AND cd.closed_at >= NOW() - ($1::int || ' days')::interval
           AND cd.current_panel_id IS NOT NULL
         LIMIT $2
      ),
      categories AS (
        -- Pivot all (claim, category, present?) rows.
        SELECT c.claim_id, c.panel_id, c.had_query, k.cat,
               (c.docs ? k.cat) AS has_doc
          FROM closed c
          CROSS JOIN LATERAL (
            SELECT DISTINCT key AS cat
              FROM closed c2,
                   jsonb_object_keys(COALESCE(c2.docs, '{}'::jsonb)) AS key
          ) k
      )
      SELECT panel_id, cat,
             COUNT(*) AS n,
             AVG(CASE WHEN had_query THEN 1 ELSE 0 END) FILTER (WHERE has_doc) AS rate_with,
             AVG(CASE WHEN had_query THEN 1 ELSE 0 END) FILTER (WHERE NOT has_doc) AS rate_without,
             COUNT(*) FILTER (WHERE has_doc) AS n_with,
             COUNT(*) FILTER (WHERE NOT has_doc) AS n_without,
             ARRAY_AGG(claim_id) FILTER (WHERE has_doc AND NOT had_query) AS evidence_ids
        FROM categories
       GROUP BY panel_id, cat
      HAVING COUNT(*) >= 10
         AND COUNT(*) FILTER (WHERE has_doc) >= 3
         AND COUNT(*) FILTER (WHERE NOT has_doc) >= 3
         AND (COALESCE(AVG(CASE WHEN had_query THEN 1 ELSE 0 END) FILTER (WHERE NOT has_doc), 0)
              - COALESCE(AVG(CASE WHEN had_query THEN 1 ELSE 0 END) FILTER (WHERE has_doc), 0)) > 0.2
    `;
    const res = await this.pool.query<{
      panel_id: string;
      cat: string;
      n: string | number;
      rate_with: string | number | null;
      rate_without: string | number | null;
      n_with: string | number;
      n_without: string | number;
      evidence_ids: string[] | null;
    }>(sql, [sinceDays, maxClaims]);

    return (res.rows ?? []).map((row) => {
      const n = Number(row.n);
      const rateWith = Number(row.rate_with ?? 0);
      const rateWithout = Number(row.rate_without ?? 0);
      const delta = rateWithout - rateWith;
      return {
        pattern_type: 'doc_correlation',
        title: `Panel ${row.panel_id.slice(0, 8)}: ${row.cat} present → query rate −${(delta * 100).toFixed(0)}%`,
        description:
          `For panel ${row.panel_id}, claims that had a "${row.cat}" attached had query-rate ${(rateWith * 100).toFixed(0)}% vs ${(rateWithout * 100).toFixed(0)}% without (n=${n}).`,
        scope: scopeOf({ panel_id: row.panel_id }),
        condition: {
          kind: 'doc_present',
          params: { required_doc_category: row.cat },
        },
        prediction: {
          kind: 'query_likely',
          params: {
            rate_with_doc: rateWith,
            rate_without_doc: rateWithout,
            delta,
            sample_size: n,
          },
          point_estimate: rateWith,
        },
        confidence: clamp01(delta),
        evidence_count: n,
        evidence_claim_ids: row.evidence_ids ?? [],
      };
    });
  }

  /**
   * STRATEGY 4 — stage_transition_pattern
   *
   * Mine: mean (and p95) hours from entering a stage to exiting it, by
   * (panel × before_stage). Threshold: n >= 10. Useful for SLA forecasting.
   *
   * We walk events_summary in code-space here — Postgres can do it via a
   * lateral join over jsonb_array_elements, but the readability cost is
   * heavy and this strategy only runs nightly.
   */
  private async mineStageTransitions(
    sinceDays: number,
    maxClaims: number,
  ): Promise<Candidate[]> {
    const res = await this.pool.query<{
      claim_id: string;
      panel_id: string | null;
      events: any;
    }>(
      `SELECT cd.claim_id, cd.current_panel_id AS panel_id, cd.events_summary AS events
         FROM hospital.claim_dossiers cd
        WHERE cd.closed_at IS NOT NULL
          AND cd.closed_at >= NOW() - ($1::int || ' days')::interval
          AND cd.current_panel_id IS NOT NULL
        LIMIT $2`,
      [sinceDays, maxClaims],
    );

    // Aggregate dwell hours by (panel_id, stage)
    type DwellBucket = { hours: number[]; claim_ids: string[] };
    const buckets = new Map<string, DwellBucket>();

    for (const row of res.rows ?? []) {
      const events = Array.isArray(row.events) ? row.events : [];
      const transitions = events.filter(
        (e: any) => e?.kind === 'stage_transitioned',
      );
      for (let i = 0; i < transitions.length - 1; i++) {
        const start = transitions[i]!;
        const end = transitions[i + 1]!;
        const stage = start?.salient?.after_stage ?? start?.salient?.before_stage;
        if (!stage || !row.panel_id) continue;
        const t0 = Date.parse(start.at);
        const t1 = Date.parse(end.at);
        if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) continue;
        const hours = (t1 - t0) / (1000 * 60 * 60);
        const key = `${row.panel_id}|${stage}`;
        const b = buckets.get(key) ?? { hours: [], claim_ids: [] };
        b.hours.push(hours);
        if (!b.claim_ids.includes(row.claim_id)) b.claim_ids.push(row.claim_id);
        buckets.set(key, b);
      }
    }

    const candidates: Candidate[] = [];
    for (const [key, b] of buckets) {
      if (b.hours.length < 10) continue;
      const [panelId, stage] = key.split('|');
      const mean = b.hours.reduce((s, x) => s + x, 0) / b.hours.length;
      const sorted = [...b.hours].sort((a, c) => a - c);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? mean;
      // Confidence: tighter distributions are more confident. Use 1/(1+CV).
      const variance =
        b.hours.reduce((s, x) => s + (x - mean) ** 2, 0) / b.hours.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
      const confidence = clamp01(1 / (1 + cv));
      candidates.push({
        pattern_type: 'stage_transition_pattern',
        title: `Panel ${panelId!.slice(0, 8)} ${stage}: ~${mean.toFixed(1)}h dwell (p95 ${p95.toFixed(1)}h)`,
        description:
          `Panel ${panelId} typically spends ${mean.toFixed(1)}h in stage "${stage}" (p95 ${p95.toFixed(1)}h, n=${b.hours.length}).`,
        scope: scopeOf({ panel_id: panelId! }),
        condition: {
          kind: 'stage_dwell',
          params: { stage, min_hours: 0 },
        },
        prediction: {
          kind: 'stage_dwell_forecast',
          params: { mean_hours: mean, p95_hours: p95, sample_size: b.hours.length },
          point_estimate: mean,
        },
        confidence,
        evidence_count: b.hours.length,
        evidence_claim_ids: b.claim_ids,
      });
    }
    return candidates;
  }

  /**
   * STRATEGY 5 — amount_variance_pattern
   *
   * Mine: claimed→approved ratio (mean ± stddev) by (panel × admission_type).
   * Threshold: n >= 10. Complement to deduction_pattern — same population but
   * different shape (ratio rather than cut %).
   */
  private async mineAmountVariance(
    sinceDays: number,
    maxClaims: number,
  ): Promise<Candidate[]> {
    const sql = `
      WITH closed AS (
        SELECT cd.claim_id, cd.current_panel_id AS panel_id,
               i.admission_type AS admission_type,
               cd.amounts
          FROM hospital.claim_dossiers cd
          JOIN hospital.ipds i ON i.id = cd.claim_id
         WHERE cd.closed_at IS NOT NULL
           AND cd.closed_at >= NOW() - ($1::int || ' days')::interval
           AND cd.amounts ? 'claimed'
         LIMIT $2
      ),
      r AS (
        SELECT claim_id, panel_id, admission_type,
               COALESCE((amounts->>'final_approved')::numeric,
                        (amounts->>'pre_auth_approved')::numeric, 0)
                  / NULLIF((amounts->>'claimed')::numeric, 0) AS ratio
          FROM closed
         WHERE (amounts->>'claimed')::numeric > 0
      )
      SELECT panel_id, admission_type,
             COUNT(*) AS n,
             AVG(ratio) AS mean_ratio,
             STDDEV_SAMP(ratio) AS std_ratio,
             ARRAY_AGG(claim_id) AS evidence_ids
        FROM r
       WHERE panel_id IS NOT NULL
       GROUP BY panel_id, admission_type
      HAVING COUNT(*) >= 10
    `;
    const res = await this.pool.query<{
      panel_id: string;
      admission_type: string | null;
      n: string | number;
      mean_ratio: string | number | null;
      std_ratio: string | number | null;
      evidence_ids: string[] | null;
    }>(sql, [sinceDays, maxClaims]);

    return (res.rows ?? []).map((row) => {
      const n = Number(row.n);
      const mean = Number(row.mean_ratio ?? 0);
      const std = Number(row.std_ratio ?? 0);
      // Confidence: tight distributions (low std) get higher confidence.
      const confidence = clamp01(1 - Math.min(std, 1));
      return {
        pattern_type: 'amount_variance_pattern',
        title: `Panel ${row.panel_id.slice(0, 8)} ${row.admission_type ?? 'any'}: approved ${(mean * 100).toFixed(0)}% ± ${(std * 100).toFixed(0)}%`,
        description:
          `Panel ${row.panel_id} approves on average ${(mean * 100).toFixed(0)}% of claimed amount (σ=${(std * 100).toFixed(0)}%, n=${n}).`,
        scope: scopeOf({
          panel_id: row.panel_id,
          diagnosis_class: row.admission_type ?? undefined,
        }),
        condition: {
          kind: 'amount_in_range',
          params: { field_path: 'claimed', min: 1 },
        },
        prediction: {
          kind: 'approval_ratio',
          params: { sample_size: n, std: std },
          point_estimate: mean,
          distribution: { mean, std },
        },
        confidence,
        evidence_count: n,
        evidence_claim_ids: row.evidence_ids ?? [],
      };
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

interface Candidate {
  pattern_type: string;
  title: string;
  description: string;
  scope: Record<string, any>;
  condition: { kind: string; params: Record<string, any> };
  prediction: Record<string, any>;
  confidence: number;
  evidence_count: number;
  evidence_claim_ids: string[];
}

function scopeOf(dims: {
  panel_id?: string;
  insurer_id?: string;
  procedure_code?: string;
  diagnosis_class?: string;
  hospital_id?: string;
  global?: boolean;
}): Record<string, any> {
  const out: Record<string, any> = {};
  if (dims.global) out.global = true;
  if (dims.panel_id) out.panel_id = dims.panel_id;
  if (dims.insurer_id) out.insurer_id = dims.insurer_id;
  if (dims.procedure_code) out.procedure_code = dims.procedure_code;
  if (dims.diagnosis_class) out.diagnosis_class = dims.diagnosis_class;
  if (dims.hospital_id) out.hospital_id = dims.hospital_id;
  if (Object.keys(out).length === 0) out.global = true;
  return out;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export default new KbPatternMiner();

// Marking PoolClient as used to keep ts-unused-import linters quiet — the
// type is here for future write-side use that does multi-statement xactions.
export type _PoolClientPlaceholder = PoolClient;
