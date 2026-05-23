/**
 * Extraction Corrections Controller.
 *
 *   POST /api/v1/claims/:claimId/corrections
 *       Record a single reviewer correction. `claim_id` comes from the
 *       URL — the body matches RecordCorrectionInput minus claim_id.
 *       Requires auth (any authenticated user; reviewer_id is taken
 *       from the JWT if not provided in the body).
 *
 *   GET /api/v1/claims/:claimId/corrections
 *       List all corrections for a claim (most recent first), used by
 *       the per-claim FE drawer.
 *
 *   GET /api/v1/admin/extraction-corrections/systemic
 *       Admin-only systemic-error rollup: (hospital_id, field_path) pairs
 *       with > 3 active corrections, ordered by count DESC. Drives the
 *       prompt-iteration backlog view.
 */

import type { Request, Response } from 'express';

import extractionCorrectionsService, {
  type ExtractionCorrectionTargetKind,
  type RecordCorrectionInput,
} from '../Services/extractionCorrections.service.js';
import { logger } from '../Utils/logger.js';

const VALID_TARGET_KINDS = new Set<ExtractionCorrectionTargetKind>([
  'section_extracted_field',
  'harmonised_episode_field',
  'canonical_patient',
  'foreign_document_flag',
  'id_conflict',
]);

function isUuidish(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v1/claims/:claimId/corrections
// ──────────────────────────────────────────────────────────────────────────

export const recordCorrection = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!isUuidish(claimId)) {
      return res.status(400).json({ success: false, error: 'invalid claimId' });
    }

    const body = (req.body ?? {}) as Partial<RecordCorrectionInput> & {
      target_kind?: string;
    };

    if (!body.hospital_id || !isUuidish(body.hospital_id)) {
      return res
        .status(400)
        .json({ success: false, error: 'hospital_id is required (uuid)' });
    }
    if (
      !body.target_kind ||
      !VALID_TARGET_KINDS.has(body.target_kind as ExtractionCorrectionTargetKind)
    ) {
      return res
        .status(400)
        .json({ success: false, error: 'invalid target_kind' });
    }
    if (typeof body.field_path !== 'string' || body.field_path.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'field_path is required' });
    }
    if (body.section_id !== undefined && !isUuidish(body.section_id)) {
      return res
        .status(400)
        .json({ success: false, error: 'section_id must be uuid if provided' });
    }

    // Reviewer id falls back to the authenticated user when the FE
    // doesn't pass it explicitly. authMiddleware sets req.user.
    const reviewerFromAuth = (req as any).user?.id as string | undefined;
    const reviewer_id =
      body.reviewer_id && isUuidish(body.reviewer_id)
        ? body.reviewer_id
        : reviewerFromAuth;

    const input: RecordCorrectionInput = {
      claim_id: claimId,
      hospital_id: body.hospital_id,
      target_kind: body.target_kind as ExtractionCorrectionTargetKind,
      section_id: body.section_id,
      field_path: body.field_path,
      ai_value: body.ai_value,
      corrected_value: body.corrected_value,
      reason: body.reason,
      reviewer_id,
    };

    const out = await extractionCorrectionsService.recordCorrection(input);
    return res.status(201).json({ success: true, data: { id: out.id } });
  } catch (err) {
    logger?.error?.(
      '[extractionCorrections.recordCorrection] ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return res
      .status(500)
      .json({ success: false, error: 'failed to record correction' });
  }
};

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v1/claims/:claimId/corrections
// ──────────────────────────────────────────────────────────────────────────

export const listForClaim = async (req: Request, res: Response) => {
  try {
    const claimId = req.params.claimId;
    if (!isUuidish(claimId)) {
      return res.status(400).json({ success: false, error: 'invalid claimId' });
    }
    const rows = await extractionCorrectionsService.listForClaim(claimId);
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger?.error?.(
      '[extractionCorrections.listForClaim] ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return res
      .status(500)
      .json({ success: false, error: 'failed to list corrections' });
  }
};

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v1/admin/extraction-corrections/systemic
// ──────────────────────────────────────────────────────────────────────────

export const listSystemicErrors = async (req: Request, res: Response) => {
  try {
    const hospitalQ = req.query.hospital_id;
    const limitQ = req.query.limit;

    let hospital_id: string | undefined;
    if (typeof hospitalQ === 'string' && hospitalQ.length > 0) {
      if (!isUuidish(hospitalQ)) {
        return res
          .status(400)
          .json({ success: false, error: 'invalid hospital_id' });
      }
      hospital_id = hospitalQ;
    }

    let limit = 50;
    if (typeof limitQ === 'string' && limitQ.length > 0) {
      const n = Number.parseInt(limitQ, 10);
      if (Number.isFinite(n) && n > 0) limit = Math.min(n, 500);
    }

    const rows = await extractionCorrectionsService.listSystemicErrors(
      hospital_id,
      limit,
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger?.error?.(
      '[extractionCorrections.listSystemicErrors] ' +
        (err instanceof Error ? err.message : String(err)),
    );
    return res
      .status(500)
      .json({ success: false, error: 'failed to load systemic errors' });
  }
};
