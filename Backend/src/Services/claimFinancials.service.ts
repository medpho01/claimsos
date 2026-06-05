import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

/**
 * Claim financials — the four amounts (pre-auth & final × claimed & approved).
 *
 *   - claimed amounts  : admin-entered (setClaimedAmount)
 *   - approved amounts : extracted from the insurer email by the email-
 *     intelligence pipeline and written when the reviewer APPLIES the draft
 *     (recordApprovedAmount) — i.e. a human has confirmed it. Provenance
 *     (source inbound email + confidence) is stored alongside.
 */

export type FinancialStage = 'preauth' | 'final';

// Minimal query interface so this works with both the pool and a transaction
// client passed from applyDraft.
interface Queryable {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

const STAGES: ReadonlySet<string> = new Set<FinancialStage>(['preauth', 'final']);

function assertStage(stage: string): asserts stage is FinancialStage {
  if (!STAGES.has(stage)) throw new Error(`invalid financial stage: ${stage}`);
}

class ClaimFinancialsService {
  /** Infer the financial stage from the claim's adjudication context. */
  async inferStage(claimId: string, db: Queryable = pool): Promise<FinancialStage> {
    const res = await db.query(
      `SELECT stage FROM hospital.claim_context WHERE claim_id = $1`,
      [claimId],
    );
    const stage = String(res.rows[0]?.stage ?? '').toLowerCase();
    if (/discharge|final|settle|bill/.test(stage)) return 'final';
    // Default to preauth (most insurer traffic), but a missing/unrecognized
    // stage risks mis-bucketing a FINAL approval into the pre-auth amount.
    // Surface it so it's auditable rather than silently wrong.
    if (!stage || !/pre.?auth|admission|initial|intimation/.test(stage)) {
      logger.warn(
        { claimId, rawStage: res.rows[0]?.stage ?? null },
        'claimFinancials.inferStage: stage missing/unrecognized — defaulting to preauth (verify the financial bucket)',
      );
    }
    return 'preauth';
  }

  /** Admin-entered claimed amount for a stage. */
  async setClaimedAmount(
    claimId: string,
    stage: FinancialStage,
    amount: number | null,
    updatedBy: string,
  ): Promise<void> {
    assertStage(stage);
    const col = `${stage}_claimed_amount`;
    await pool.query(
      `INSERT INTO hospital.claim_financials (claim_id, ${col}, updated_by)
            VALUES ($1, $2, $3)
       ON CONFLICT (claim_id) DO UPDATE
            SET ${col} = EXCLUDED.${col}, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [claimId, amount, updatedBy],
    );
  }

  /**
   * Manual admin entry of an approved amount (e.g. approval came by phone/portal,
   * not email). Clears the email provenance for that stage since it's now
   * human-entered rather than LLM-extracted.
   */
  async setApprovedAmount(
    claimId: string,
    stage: FinancialStage,
    amount: number | null,
    updatedBy: string,
  ): Promise<void> {
    assertStage(stage);
    const amtCol = `${stage}_approved_amount`;
    const srcCol = `${stage}_approved_source_inbound_id`;
    const confCol = `${stage}_approved_confidence`;
    await pool.query(
      `INSERT INTO hospital.claim_financials (claim_id, ${amtCol}, ${srcCol}, ${confCol}, updated_by)
            VALUES ($1, $2, NULL, NULL, $3)
       ON CONFLICT (claim_id) DO UPDATE
            SET ${amtCol} = EXCLUDED.${amtCol}, ${srcCol} = NULL, ${confCol} = NULL,
                updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [claimId, amount, updatedBy],
    );
  }

  /**
   * Approved amount extracted from an insurer email + confirmed on draft apply.
   * Accepts a transaction client so it commits atomically with the apply.
   */
  async recordApprovedAmount(
    db: Queryable,
    claimId: string,
    stage: FinancialStage,
    amount: number | null,
    sourceInboundId: string | null,
    confidence: number | null,
    updatedBy: string,
  ): Promise<void> {
    assertStage(stage);
    if (amount == null) return; // nothing to record
    const amtCol = `${stage}_approved_amount`;
    const srcCol = `${stage}_approved_source_inbound_id`;
    const confCol = `${stage}_approved_confidence`;
    await db.query(
      `INSERT INTO hospital.claim_financials
            (claim_id, ${amtCol}, ${srcCol}, ${confCol}, updated_by)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (claim_id) DO UPDATE
            SET ${amtCol} = EXCLUDED.${amtCol},
                ${srcCol} = EXCLUDED.${srcCol},
                ${confCol} = EXCLUDED.${confCol},
                updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [claimId, amount, sourceInboundId, confidence, updatedBy],
    );
  }

  /** Read the financials row (+ derived deductions) for a claim. */
  async getFinancials(claimId: string): Promise<Record<string, unknown> | null> {
    const res = await pool.query(
      `SELECT *,
              (preauth_claimed_amount - preauth_approved_amount) AS preauth_deduction,
              (final_claimed_amount   - final_approved_amount)   AS final_deduction
         FROM hospital.claim_financials
        WHERE claim_id = $1`,
      [claimId],
    );
    return res.rows[0] ?? null;
  }
}

const claimFinancialsService = new ClaimFinancialsService();
export default claimFinancialsService;
