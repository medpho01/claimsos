import type { Pool, PoolClient } from 'pg';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

/**
 * Cost Accounting Service — Sprint 4
 *
 * Records every LLM call to hospital.llm_cost_log and enforces per-claim
 * and per-hospital spend caps. The LLM bridge (Services/llm/*) is the only
 * code path that should hit `recordCall`; everything else just reads.
 *
 * Budget model:
 *   - Per claim: hard ₹15, soft warn ₹10. Hitting the hard cap blocks any
 *     further LLM work for that claim until a human raises it manually.
 *   - Per hospital, per day:   default ₹3,000, overrideable in hospital_cost_caps.
 *     Soft = 80% of cap (throttle: queue-only, non-realtime calls allowed).
 *     Hard = 100% of cap (block: no LLM calls at all).
 *   - Per hospital, per month: default ₹50,000. Same soft/hard scheme.
 *
 * `checkBudget` returns the strictest verdict across all dimensions
 * supplied (claim, hospital-daily, hospital-monthly). The LLM bridge is
 * expected to call this BEFORE the provider call and throw
 * LlmBudgetExceededError on 'block'.
 */

type Queryable = Pool | PoolClient;

// Defaults when no row exists in hospital_cost_caps.
const DEFAULT_DAILY_CAP_INR = 3000;
const DEFAULT_MONTHLY_CAP_INR = 50000;

// Per-claim guardrail. Not per-hospital configurable today — it's a
// product invariant (no single claim should cost more than ₹15 of LLM
// inference to process end-to-end). Bump deliberately in code if the
// pipeline genuinely needs more.
export const CLAIM_HARD_LIMIT_INR = 15;
export const CLAIM_SOFT_LIMIT_INR = 10;

// Throttle threshold as a fraction of the cap.
const HOSPITAL_THROTTLE_FRACTION = 0.8;

export interface RecordCallInput {
  claimId?: string | null; // typically the IPD id
  hospitalId?: string | null;
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
  action: 'allow' | 'throttle' | 'block';
  reason?: string;
  // Helpful telemetry the caller can log / surface in dashboards.
  claimSpendInr?: number;
  hospitalDailySpendInr?: number;
  hospitalMonthlySpendInr?: number;
  hospitalDailyCapInr?: number;
  hospitalMonthlyCapInr?: number;
}

class CostAccountingService {
  /**
   * Insert a row into llm_cost_log. Best-effort: if the insert fails the
   * parent operation must NOT be aborted — the LLM result is already
   * computed. We log loudly so the gap shows up in observability.
   */
  async recordCall(input: RecordCallInput, db: Queryable = pool): Promise<void> {
    try {
      await db.query(
        `INSERT INTO hospital.llm_cost_log
           (claim_id, hospital_id, task, provider, model, prompt_version,
            tokens_input_uncached, tokens_input_cached, tokens_output,
            latency_ms, cost_inr, succeeded, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
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
        ]
      );
    } catch (err) {
      logger.warn(
        { err, task: input.task, claimId: input.claimId, hospitalId: input.hospitalId },
        'costAccounting.recordCall: insert failed (audit-only, parent op unaffected)'
      );
    }
  }

  /**
   * Total INR spent on a single claim across all tasks, succeeded or not.
   * Failed calls still cost tokens (Anthropic bills on partial responses),
   * so they count against the cap.
   */
  async getClaimSpendInr(claimId: string, db: Queryable = pool): Promise<number> {
    try {
      const res = await db.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(cost_inr), 0)::TEXT AS total
           FROM hospital.llm_cost_log
          WHERE claim_id = $1`,
        [claimId]
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
   * Pre-flight budget check. Strictest-wins:
   *   - claim spend ≥ hard limit       -> block
   *   - hospital daily/monthly ≥ 100%  -> block
   *   - hospital daily/monthly ≥ 80%   -> throttle
   *   - claim spend ≥ soft limit       -> still 'allow' but reason set
   *
   * Either claimId or hospitalId (or both) may be omitted; the
   * corresponding dimension is then skipped.
   */
  async checkBudget(
    claimId?: string | null,
    hospitalId?: string | null,
    db: Queryable = pool
  ): Promise<BudgetVerdict> {
    const verdict: BudgetVerdict = {
      claimUnderLimit: true,
      hospitalUnderLimit: true,
      action: 'allow',
    };

    // Claim dimension.
    if (claimId) {
      const claimSpend = await this.getClaimSpendInr(claimId, db);
      verdict.claimSpendInr = claimSpend;
      if (claimSpend >= CLAIM_HARD_LIMIT_INR) {
        verdict.claimUnderLimit = false;
        verdict.action = 'block';
        verdict.reason = `claim spend ₹${claimSpend.toFixed(2)} ≥ hard limit ₹${CLAIM_HARD_LIMIT_INR}`;
        return verdict;
      }
      if (claimSpend >= CLAIM_SOFT_LIMIT_INR) {
        // Soft warn — don't downgrade the action, but flag the reason.
        verdict.reason = `claim spend ₹${claimSpend.toFixed(2)} ≥ soft limit ₹${CLAIM_SOFT_LIMIT_INR}`;
      }
    }

    // Hospital dimension.
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
        // Only downgrade if we weren't already at 'block'.
        verdict.action = 'throttle';
        verdict.reason =
          dailyRatio >= HOSPITAL_THROTTLE_FRACTION
            ? `hospital daily spend at ${(dailyRatio * 100).toFixed(0)}% of cap`
            : `hospital monthly spend at ${(monthlyRatio * 100).toFixed(0)}% of cap`;
      }
    }

    return verdict;
  }
}

export default new CostAccountingService();
