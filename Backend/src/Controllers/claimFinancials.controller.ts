/**
 * Claim financials HTTP surface.
 *   GET  /api/v1/claims/:claimId/financials          → the four amounts + deductions
 *   PUT  /api/v1/claims/:claimId/financials/claimed   → admin sets a claimed amount
 *        body: { stage: 'preauth'|'final', amount: number|null }
 *
 * Approved amounts are NOT settable here — they're written when a reviewer
 * applies an email-intelligence draft (human-confirmed extraction).
 */
import type { Request, Response } from 'express';
import { logger } from '../Utils/logger.js';
import claimFinancialsService, { type FinancialStage } from '../Services/claimFinancials.service.js';

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const getFinancials = async (req: Request, res: Response) => {
  try {
    const { claimId } = req.params;
    if (!claimId) return res.status(400).json({ success: false, error: 'claimId required' });
    const data = await claimFinancialsService.getFinancials(claimId);
    return res.json({ success: true, data });
  } catch (err) {
    logger?.error?.('[claimFinancials.getFinancials] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to get financials' });
  }
};

export const setClaimed = async (req: Request, res: Response) => {
  try {
    const { claimId } = req.params;
    const stage = (req.body?.stage as string) ?? '';
    const amountRaw = req.body?.amount;
    if (!claimId || (stage !== 'preauth' && stage !== 'final')) {
      return res.status(400).json({ success: false, error: "claimId and stage ('preauth'|'final') required" });
    }
    const amount =
      amountRaw == null || amountRaw === '' ? null : Number(amountRaw);
    if (amount != null && Number.isNaN(amount)) {
      return res.status(400).json({ success: false, error: 'amount must be a number or null' });
    }
    const userId = ((req as any).user?.id as string) ?? 'unknown';
    await claimFinancialsService.setClaimedAmount(claimId, stage as FinancialStage, amount, userId);
    const data = await claimFinancialsService.getFinancials(claimId);
    return res.json({ success: true, data });
  } catch (err) {
    logger?.error?.('[claimFinancials.setClaimed] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to set claimed amount' });
  }
};

/** PUT /api/v1/claims/:claimId/financials/approved — manual admin entry of an
 *  approved amount (when approval came by phone/portal, not email). */
export const setApproved = async (req: Request, res: Response) => {
  try {
    const { claimId } = req.params;
    const stage = (req.body?.stage as string) ?? '';
    const amountRaw = req.body?.amount;
    if (!claimId || (stage !== 'preauth' && stage !== 'final')) {
      return res.status(400).json({ success: false, error: "claimId and stage ('preauth'|'final') required" });
    }
    const amount = amountRaw == null || amountRaw === '' ? null : Number(amountRaw);
    if (amount != null && Number.isNaN(amount)) {
      return res.status(400).json({ success: false, error: 'amount must be a number or null' });
    }
    const userId = ((req as any).user?.id as string) ?? 'unknown';
    await claimFinancialsService.setApprovedAmount(claimId, stage as FinancialStage, amount, userId);
    const data = await claimFinancialsService.getFinancials(claimId);
    return res.json({ success: true, data });
  } catch (err) {
    logger?.error?.('[claimFinancials.setApproved] ' + msg(err));
    return res.status(500).json({ success: false, error: 'failed to set approved amount' });
  }
};
