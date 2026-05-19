/**
 * Intelligence pipeline status — a single endpoint the Claim AI Summary
 * page polls while async work is in flight. Returns granular counters
 * across each pipeline stage (sections, harmoniser, adjudication, rules,
 * episodic) plus a derived `is_pending` + `eta_seconds` for UX.
 *
 * Cheap: 4 indexed SELECTs + 1 join. Safe to poll every 3-5 seconds.
 */

import { Request, Response } from 'express';
import { pool } from '../DB/db.js';

interface StatusResponse {
  claim_id: string;
  sections: {
    total: number;
    classified: number;
    extracted: number;
  };
  segmenter: { pending: boolean };
  harmoniser: {
    status: 'fresh' | 'stale' | 'pending' | 'failed' | 'absent';
    generated_at: string | null;
    cost_inr: number | null;
    error_message: string | null;
  };
  adjudication: {
    latest_at: string | null;
    readiness_score: number | null;
    recommended_action: string | null;
  };
  rules_v2: {
    latest_at: string | null;
    total: number;
    failed: number;
    skipped: number;
    rule_set_id: string | null;
  };
  is_pending: boolean;
  pending_components: string[];
  eta_seconds: number | null;
  last_updated_at: string;
}

export class IntelligenceStatusController {
  static async getStatus(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    if (!claimId) {
      res.status(400).json({ error: 'claimId required' });
      return;
    }
    try {
      const [secRes, harmRes, adjRes, rulesRes] = await Promise.all([
        pool.query<{
          total: string;
          classified: string;
          extracted: string;
        }>(
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE category IS NOT NULL)::text AS classified,
                  COUNT(*) FILTER (WHERE extracted_fields IS NOT NULL)::text AS extracted
             FROM hospital.document_sections WHERE claim_id = $1`,
          [claimId],
        ),
        pool.query<{
          status: string;
          generated_at: Date | null;
          cost_inr: string | null;
          error_message: string | null;
        }>(
          `SELECT status, generated_at, cost_inr, error_message
             FROM hospital.claim_harmonised_episodes WHERE claim_id = $1`,
          [claimId],
        ),
        pool.query<{
          generated_at: Date | null;
          readiness_score: number | null;
          recommended_action: string | null;
        }>(
          `SELECT generated_at, readiness_score, recommended_action
             FROM hospital.adjudication_reports
            WHERE claim_id = $1
            ORDER BY generated_at DESC LIMIT 1`,
          [claimId],
        ),
        pool.query<{
          total: string;
          failed: string;
          skipped: string;
          rule_set_id: string | null;
          evaluated_at: Date | null;
        }>(
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE status = 'FAIL')::text AS failed,
                  COUNT(*) FILTER (WHERE status = 'SKIP')::text AS skipped,
                  MIN(rule_set_id::text) AS rule_set_id,
                  MAX(evaluated_at) AS evaluated_at
             FROM hospital.claim_rule_evaluations WHERE claim_id = $1`,
          [claimId],
        ),
      ]);

      const sec = secRes.rows[0]!;
      const harm = harmRes.rows[0];
      const adj = adjRes.rows[0];
      const rules = rulesRes.rows[0]!;

      const sectionsTotal = Number(sec.total);
      const sectionsClassified = Number(sec.classified);
      const sectionsExtracted = Number(sec.extracted);

      const pendingComponents: string[] = [];
      // A section was created but classifier hasn't filled category → pending.
      if (sectionsTotal > 0 && sectionsClassified < sectionsTotal) {
        pendingComponents.push(`classifier (${sectionsClassified}/${sectionsTotal})`);
      }
      // All classified but not all extracted → extractor pending.
      if (sectionsClassified > 0 && sectionsExtracted < sectionsClassified) {
        pendingComponents.push(`extractor (${sectionsExtracted}/${sectionsClassified})`);
      }
      // No sections yet but docs exist → segmenter is what's missing.
      if (sectionsTotal === 0) {
        const docCount = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM hospital.ipd_doc WHERE ipd_id = $1 AND s3_key IS NOT NULL`,
          [claimId],
        );
        if (Number(docCount.rows[0]?.n ?? 0) > 0) {
          pendingComponents.push('segmenter (sections not yet created)');
        }
      }
      // Harmoniser pending if status is 'pending' or absent but sections exist.
      const harmStatus = (harm?.status ?? 'absent') as StatusResponse['harmoniser']['status'];
      if (harmStatus === 'pending') pendingComponents.push('harmoniser');
      else if (harmStatus === 'absent' && sectionsClassified > 0) {
        pendingComponents.push('harmoniser (not started)');
      }

      const isPending = pendingComponents.length > 0;

      // ETA heuristic — rough, intentionally pessimistic so users aren't
      // surprised by long Sonnet calls.
      //   segmenter:  ~15-30s per doc (OCR + LLM segmentation; depends on PDF complexity)
      //   classifier: ~3-5s per section (Haiku)
      //   extractor:  ~5-8s per section (Haiku → Sonnet fallback)
      //   harmoniser: ~30-60s (Sonnet, 6-8k tokens)
      let eta = 0;
      if (sectionsTotal === 0) {
        eta += 30; // assume one doc segmenting now
      }
      const remainingClassify = Math.max(0, sectionsTotal - sectionsClassified);
      eta += remainingClassify * 4;
      const remainingExtract = Math.max(0, sectionsClassified - sectionsExtracted);
      eta += remainingExtract * 6;
      if (harmStatus === 'pending' || (harmStatus === 'absent' && sectionsClassified > 0)) {
        eta += 45;
      }

      const result: StatusResponse = {
        claim_id: claimId,
        sections: {
          total: sectionsTotal,
          classified: sectionsClassified,
          extracted: sectionsExtracted,
        },
        segmenter: { pending: sectionsTotal === 0 && pendingComponents.some((c) => c.startsWith('segmenter')) },
        harmoniser: {
          status: harmStatus,
          generated_at: harm?.generated_at ? new Date(harm.generated_at).toISOString() : null,
          cost_inr: harm?.cost_inr == null ? null : Number(harm.cost_inr),
          error_message: harm?.error_message ?? null,
        },
        adjudication: {
          latest_at: adj?.generated_at ? new Date(adj.generated_at).toISOString() : null,
          readiness_score: adj?.readiness_score ?? null,
          recommended_action: adj?.recommended_action ?? null,
        },
        rules_v2: {
          latest_at: rules.evaluated_at ? new Date(rules.evaluated_at).toISOString() : null,
          total: Number(rules.total),
          failed: Number(rules.failed),
          skipped: Number(rules.skipped),
          rule_set_id: rules.rule_set_id ?? null,
        },
        is_pending: isPending,
        pending_components: pendingComponents,
        eta_seconds: isPending ? eta : null,
        last_updated_at: new Date().toISOString(),
      };
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: 'failed to load status', message: err?.message ?? String(err) });
    }
  }
}
