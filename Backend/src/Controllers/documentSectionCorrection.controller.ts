/**
 * Document section category-correction controller (Wave 9 FE gap fill).
 * Captures human override of the AI's category assignment + writes the
 * correction event so Wave 10's pattern miner can consume it.
 */

import { Request, Response } from 'express';
import { pool } from '../DB/db.js';
import { eventDispatcher } from '../Services/events/eventDispatcher.service.js';
import { recordCorrectionBestEffort } from '../Services/aiCorrections.service.js';
import { logger } from '../Utils/logger.js';

export class DocumentSectionCorrectionController {
  /**
   * POST /api/v1/document-sections/:sectionId/category
   * Body: { new_category: string, reason?: string }
   */
  static async correctCategory(req: Request, res: Response): Promise<void> {
    const sectionId = req.params.sectionId;
    const { new_category, reason } = req.body ?? {};

    if (!sectionId || typeof new_category !== 'string' || !new_category) {
      res.status(400).json({ error: 'sectionId + new_category required' });
      return;
    }

    try {
      // Look up the existing section so we can record the before-state
      // and surface claim_id for the event.
      const cur = await pool.query<{
        id: string;
        claim_id: string;
        document_id: string;
        category: string | null;
        classification_confidence: number | null;
      }>(
        `SELECT id, claim_id, document_id, category, classification_confidence
           FROM hospital.document_sections
          WHERE id = $1`,
        [sectionId],
      );
      const row = cur.rows[0];
      if (!row) {
        res.status(404).json({ error: 'section not found' });
        return;
      }

      // Update the row, marking the section reviewed by the human.
      await pool.query(
        `UPDATE hospital.document_sections
            SET category = $2,
                classification_confidence = 1.0,
                status = 'corrected',
                reviewed_by = $3,
                reviewed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [sectionId, new_category, (req as any).user?.id ?? null],
      );

      // Write the corrections-log row.
      await pool.query(
        `INSERT INTO hospital.document_section_corrections
           (document_id, action, before, after, corrected_by, corrected_at, notes)
         VALUES ($1, 'reclassify',
                 jsonb_build_object('section_id', $2::text, 'category', $3::text, 'confidence', $4::numeric),
                 jsonb_build_object('section_id', $2::text, 'category', $5::text),
                 $6, NOW(), $7)`,
        [
          row.document_id,
          sectionId,
          row.category,
          row.classification_confidence,
          new_category,
          (req as any).user?.id ?? null,
          reason ?? null,
        ],
      );

      // Wave 10 — record into the unified ai_corrections stream so the
      // pattern miner can mine category_confusion signatures. Best-effort
      // — never block the underlying correction write.
      await recordCorrectionBestEffort({
        surface: 'document_category',
        claim_id: row.claim_id,
        target_id: sectionId,
        target_kind: row.category ?? null,
        ai_value: { category: row.category, confidence: row.classification_confidence },
        human_value: { category: new_category },
        reason: reason ?? null,
        corrected_by: (req as any).user?.id ?? '00000000-0000-0000-0000-000000000000',
      });

      // Emit the event so Wave 10 miner picks it up.
      try {
        await eventDispatcher.dispatch({
          kind: 'section_corrected',
          claimId: row.claim_id,
          payload: {
            section_id: sectionId,
            action: 'reclassify',
            before: { category: row.category, confidence: row.classification_confidence },
            after: { category: new_category },
            corrected_by: (req as any).user?.id ?? 'unknown',
          },
        });
      } catch (err: any) {
        logger.warn({ err, sectionId }, 'sectionCorrection: dispatch failed (non-blocking)');
      }

      res.status(200).json({
        ok: true,
        section_id: sectionId,
        before_category: row.category,
        new_category,
      });
    } catch (err: any) {
      logger.error({ err, sectionId }, 'sectionCorrection.correctCategory failed');
      res.status(500).json({ error: 'correction failed', message: err?.message ?? String(err) });
    }
  }
}
