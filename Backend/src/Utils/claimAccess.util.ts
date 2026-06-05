import { pool } from '../DB/db.js';
import apiError from './errorHandler.util.js';

/**
 * Tenant-isolation guard for claim-scoped endpoints.
 *
 * Mirrors auth.middleware.checkPatientViewAccess, but takes a claim id (== ipd
 * id) directly so it can be called from controllers whose route key is a draft
 * id / action id rather than a patient id in params.
 *
 *   - superadmin / admin  → platform-level, full access (these users have no
 *     hospital_users binding by design).
 *   - hospital            → must be a member of the claim's hospital
 *     (hospital_users), else 403.
 *
 * Fails closed: a missing claim or a non-member hospital user → 403.
 */
type AuthedUser = { id?: string; role?: string } | undefined;

export async function assertClaimAccess(
  user: AuthedUser,
  claimId: string | null | undefined,
): Promise<void> {
  if (!user?.id) throw new apiError(401, 'Unauthorized');
  if (user.role === 'superadmin' || user.role === 'admin') return;

  if (user.role === 'hospital') {
    if (!claimId) throw new apiError(400, 'claim id is required');
    const r = await pool.query(
      `SELECT 1
         FROM hospital.hospital_users hu
         JOIN hospital.ipds p ON p.hospital_id = hu.hospital_id
        WHERE hu.user_id = $1 AND p.id = $2
        LIMIT 1`,
      [user.id, claimId],
    );
    if (r.rowCount === 0) {
      throw new apiError(403, 'Access denied. You do not have access to this claim.');
    }
    return;
  }

  throw new apiError(403, 'Unauthorized role');
}

/** Resolve the owning claim (ipd) id for an AI draft, then assert access. */
export async function assertDraftAccess(user: AuthedUser, draftId: string): Promise<void> {
  const r = await pool.query(
    'SELECT claim_id FROM hospital.email_intelligence_drafts WHERE id = $1',
    [draftId],
  );
  // No row → let the controller return its own 404 for platform admins; for
  // hospital users, fail closed (assertClaimAccess(null) → 400/403).
  const claimId = r.rows[0]?.claim_id ?? null;
  await assertClaimAccess(user, claimId);
}

/** Resolve the owning claim id for a claim_action, then assert access. */
export async function assertActionAccess(user: AuthedUser, actionId: string): Promise<void> {
  const r = await pool.query(
    'SELECT claim_id FROM hospital.claim_actions WHERE id = $1',
    [actionId],
  );
  const claimId = r.rows[0]?.claim_id ?? null;
  await assertClaimAccess(user, claimId);
}
