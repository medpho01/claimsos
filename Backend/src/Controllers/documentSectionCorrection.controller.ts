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

  /**
   * POST /api/v1/document-sections/:sectionId/fields/:fieldKey
   * Body: { new_value: any, reason?: string }
   *
   * Per-field human override of an LLM extraction. The corrected field is
   * persisted into `extracted_fields[fieldKey]`, the per-field confidence
   * is bumped to 1.0, and the field's key is added to a reserved
   * `_corrected_fields` list in `extraction_confidence` so a future
   * extractor re-run (forced or otherwise) won't overwrite the human
   * value. If the field previously failed automatic validation
   * (e.g. Verhoeff checksum on an Aadhaar number), the corresponding
   * entry under `_validation_errors` is cleared.
   *
   * Always writes an `ai_corrections` row (surface='extracted_field') so
   * Wave-10's KB miner can later mine (category, field_key, ai_value →
   * human_value) patterns into prompt hints.
   */
  static async correctField(req: Request, res: Response): Promise<void> {
    const sectionId = req.params.sectionId;
    const fieldKey = req.params.fieldKey;
    const { new_value, reason } = req.body ?? {};

    if (!sectionId || !fieldKey) {
      res.status(400).json({ error: 'sectionId + fieldKey required' });
      return;
    }
    if (new_value === undefined) {
      res
        .status(400)
        .json({ error: 'new_value required in body (use null to clear)' });
      return;
    }

    try {
      // Pull the existing section state so we can record before/after
      // diffs and detect whether the field is schema-known.
      const cur = await pool.query<{
        id: string;
        claim_id: string;
        document_id: string;
        category: string;
        extracted_fields: Record<string, any> | null;
        extraction_confidence: Record<string, any> | null;
      }>(
        `SELECT id, claim_id, document_id, category,
                extracted_fields, extraction_confidence
           FROM hospital.document_sections
          WHERE id = $1`,
        [sectionId],
      );
      const row = cur.rows[0];
      if (!row) {
        res.status(404).json({ error: 'section not found' });
        return;
      }

      const beforeFields = row.extracted_fields ?? {};
      const beforeConfidence = row.extraction_confidence ?? {};
      const beforeValue = beforeFields[fieldKey];

      // Build the after state. We:
      //   1. Set the field to the new value (null → delete the key).
      //   2. Bump per_field_confidence[field] = 1.0 (human is canonical).
      //   3. Drop any _validation_errors entry for this field.
      //   4. Add the field to _corrected_fields so the extractor re-run
      //      guard knows not to overwrite it.
      const nextFields = { ...beforeFields };
      if (new_value === null) {
        delete nextFields[fieldKey];
      } else {
        nextFields[fieldKey] = new_value;
      }

      const nextConfidence: Record<string, any> = { ...beforeConfidence };
      if (new_value !== null) {
        nextConfidence[fieldKey] = 1.0;
      } else {
        delete nextConfidence[fieldKey];
      }
      // Clear validation error on this field (the human says it's
      // correct now; checksums etc. will be re-validated only if a fresh
      // extractor run happens, which we explicitly block via _corrected_fields).
      if (
        nextConfidence._validation_errors &&
        typeof nextConfidence._validation_errors === 'object'
      ) {
        const errs = { ...nextConfidence._validation_errors };
        delete errs[fieldKey];
        if (Object.keys(errs).length === 0) {
          delete nextConfidence._validation_errors;
        } else {
          nextConfidence._validation_errors = errs;
        }
      }
      // Track corrected fields explicitly. Stored as an array under a
      // reserved key in extraction_confidence so it survives the JSONB
      // round-trip without needing a new column.
      const correctedList: string[] = Array.isArray(
        nextConfidence._corrected_fields,
      )
        ? [...nextConfidence._corrected_fields]
        : [];
      if (new_value !== null && !correctedList.includes(fieldKey)) {
        correctedList.push(fieldKey);
      }
      if (new_value === null) {
        // Cleared field — remove from corrected list too. The extractor
        // can re-attempt this field on next run.
        const idx = correctedList.indexOf(fieldKey);
        if (idx >= 0) correctedList.splice(idx, 1);
      }
      if (correctedList.length > 0) {
        nextConfidence._corrected_fields = correctedList;
      } else {
        delete nextConfidence._corrected_fields;
      }

      // Persist.
      await pool.query(
        `UPDATE hospital.document_sections
            SET extracted_fields = $2::jsonb,
                extraction_confidence = $3::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [
          sectionId,
          JSON.stringify(nextFields),
          JSON.stringify(nextConfidence),
        ],
      );

      // Audit-trail row. action='edit_fields' is the value the section
      // corrections schema (migration 032) reserved exactly for this.
      await pool.query(
        `INSERT INTO hospital.document_section_corrections
           (document_id, action, before, after, corrected_by, corrected_at, notes)
         VALUES ($1, 'edit_fields',
                 jsonb_build_object('section_id', $2::text, 'field_key', $3::text, 'value', $4::jsonb),
                 jsonb_build_object('section_id', $2::text, 'field_key', $3::text, 'value', $5::jsonb),
                 $6, NOW(), $7)`,
        [
          row.document_id,
          sectionId,
          fieldKey,
          JSON.stringify(beforeValue ?? null),
          JSON.stringify(new_value),
          (req as any).user?.id ?? null,
          reason ?? null,
        ],
      );

      // Unified correction stream — used by Wave-10's KB miner. The
      // miner's category_confusion strategy keys on surface; we use a
      // distinct 'extracted_field' surface so the field-level miner
      // (Strategy 7, to be added) can pick these up cleanly.
      await recordCorrectionBestEffort({
        surface: 'extracted_field',
        claim_id: row.claim_id,
        target_id: sectionId,
        target_kind: `${row.category}:${fieldKey}`,
        ai_value: { field_key: fieldKey, value: beforeValue ?? null },
        human_value: { field_key: fieldKey, value: new_value },
        reason: reason ?? null,
        corrected_by: (req as any).user?.id ?? '00000000-0000-0000-0000-000000000000',
      });

      // Emit a section_corrected event so the dossier projector knows
      // the row changed (e.g. for sufficiency checks downstream).
      try {
        await eventDispatcher.dispatch({
          kind: 'section_corrected',
          claimId: row.claim_id,
          payload: {
            section_id: sectionId,
            action: 'edit_fields',
            before: { [fieldKey]: beforeValue ?? null },
            after: { [fieldKey]: new_value },
            corrected_by: (req as any).user?.id ?? 'unknown',
          },
        });
      } catch (err: any) {
        logger.warn(
          { err, sectionId, fieldKey },
          'sectionCorrection.correctField: dispatch failed (non-blocking)',
        );
      }

      res.status(200).json({
        ok: true,
        section_id: sectionId,
        field_key: fieldKey,
        before_value: beforeValue ?? null,
        new_value,
      });
    } catch (err: any) {
      logger.error(
        { err, sectionId, fieldKey },
        'sectionCorrection.correctField failed',
      );
      res.status(500).json({
        error: 'correction failed',
        message: err?.message ?? String(err),
      });
    }
  }
}
