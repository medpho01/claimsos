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
import claimAiRunService from '../Services/claimAiRun.service.js';
import docPhaseLedgerService from '../Services/docPhaseLedger.service.js';

interface StatusResponse {
  claim_id: string;
  /**
   * Claim-level run cursor (migration 060, May 2026). The FE binds the
   * Documents tab visibility to `run.status`:
   *   - null               → no run has ever been triggered → Ready to analyze
   *   - 'queued'/'running' → show progress banner, hide Documents tab
   *   - 'succeeded'        → show stable Documents tab
   *   - 'partial'          → show Documents tab + highlight failed docs
   *   - 'failed'           → show retry CTA + error
   *   - 'superseded'       → ignored, a newer run took over
   * Replaces the old "activity-window" `is_pending` heuristic which
   * couldn't tell "one doc done, another still queued" from "all done".
   */
  run: {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'superseded';
    phase: string | null;
    total_docs: number;
    docs_completed: number;
    docs_failed: number;
    triggered_at: string;
    finished_at: string | null;
    error: string | null;
  } | null;
  /**
   * Per-phase roll-up for the current run (migration 061, P6).
   * Each phase aggregates across all docs in the run.
   *
   *   total      = number of docs/rows in this phase
   *   done       = status='done' + 'skipped'
   *   running    = status='running'
   *   failed     = status='failed'
   *
   * The FE renders a progress bar per phase from this rollup. Null when
   * no run cursor exists (legacy claims pre-rearch).
   */
  phases: {
    ingest:    { total: number; done: number; running: number; failed: number };
    classify:  { total: number; done: number; running: number; failed: number };
    dedup:     { total: number; done: number; running: number; failed: number };
    extract:   { total: number; done: number; running: number; failed: number };
    harmonise: { total: number; done: number; running: number; failed: number };
  } | null;
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
  /**
   * Section-level listing for a claim.
   *
   * The dossier's `doc_sections_by_category` map stores bare section_ids,
   * which the FE can't translate into the source document needed to render
   * a PDF/image preview. This endpoint joins document_sections → ipd_doc
   * so the Documents panel can group sections under real ipd_doc IDs (and
   * surface the original file_name + mime_type for the preview header).
   *
   * Cheap: a single indexed query on document_sections + a JOIN to ipd_doc.
   */
  static async getSections(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    if (!claimId) {
      res.status(400).json({ error: 'claimId required' });
      return;
    }
    try {
      const result = await pool.query<{
        id: string;
        document_id: string | null;
        page_start: number | null;
        page_end: number | null;
        category: string | null;
        classification_confidence: number | null;
        status: string;
        extractor_model: string | null;
        extracted_fields_present: boolean;
        extracted_fields: any;
        extraction_confidence: any;
        file_name: string | null;
        mime_type: string | null;
      }>(
        // extracted_fields included verbatim. Typical payload per section
        // is sub-1KB (most sections have no_schema → {}; real extractions
        // average ~500-2000 bytes), so even a 30-section claim stays
        // well under 100KB total. Sending it inline avoids the FE
        // having to make a second per-section roundtrip when the user
        // expands a row to view JSON, and removes the dependency on a
        // /documents/:id/sections endpoint that was never built.
        // dedup_of fields surfaced so the FE can filter to canonical
        // sections only AND know how many duplicates exist (for the
        // "X duplicates identified" header). doc_dedup_of distinguishes
        // file-level duplicates (whole file is dup of another) from
        // section-level duplicates (specific page range is dup).
        `SELECT ds.id,
                ds.document_id,
                ds.page_start,
                ds.page_end,
                ds.category,
                ds.classification_confidence,
                ds.status,
                ds.extractor_model,
                (ds.extracted_fields IS NOT NULL) AS extracted_fields_present,
                ds.extracted_fields,
                ds.extraction_confidence,
                ds.dedup_of            AS section_dedup_of,
                ds.dedup_method        AS section_dedup_method,
                doc.file_name,
                doc.mime_type,
                doc.dedup_of           AS doc_dedup_of,
                doc.dedup_method       AS doc_dedup_method
           FROM hospital.document_sections ds
           LEFT JOIN hospital.ipd_doc doc ON doc.id = ds.document_id
          WHERE ds.claim_id = $1
          ORDER BY ds.document_id, ds.page_start NULLS LAST`,
        [claimId],
      );
      res.status(200).json({ data: result.rows });
    } catch (err: any) {
      res
        .status(500)
        .json({ error: 'failed to load sections', message: err?.message ?? String(err) });
    }
  }

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
          // "extracted" counts both genuinely-extracted rows AND those the
          // extractor explicitly skipped (no field_schema for the category) —
          // both are terminal states, so the banner shouldn't keep spinning.
          `SELECT COUNT(*)::text AS total,
                  COUNT(*) FILTER (WHERE category IS NOT NULL)::text AS classified,
                  COUNT(*) FILTER (
                    WHERE extracted_fields IS NOT NULL
                       OR extractor_model = 'no_schema'
                  )::text AS extracted
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

      // ─── Refresh the run cursor (Step 1 of pipeline rearch) ──────────
      // recomputeFromState() aggregates section + harmoniser state and
      // updates the latest claim_ai_runs row. The FE will read this row
      // to decide whether to render the Documents tab (only on terminal
      // success/partial states) vs a progress banner (queued/running).
      // Cheap: 1 aggregate SELECT + at most 1 UPDATE.
      let runRow: StatusResponse['run'] = null;
      let phaseRollup: StatusResponse['phases'] = null;
      try {
        const r = await claimAiRunService.recomputeFromState(claimId);
        if (r) {
          runRow = {
            id: r.id,
            status: r.status,
            phase: r.phase,
            total_docs: r.total_docs,
            docs_completed: r.docs_completed,
            docs_failed: r.docs_failed,
            triggered_at: typeof r.triggered_at === 'string'
              ? r.triggered_at
              : new Date(r.triggered_at as any).toISOString(),
            finished_at: r.finished_at
              ? (typeof r.finished_at === 'string'
                  ? r.finished_at
                  : new Date(r.finished_at as any).toISOString())
              : null,
            error: r.error,
          };

          // Roll up doc_phase_ledger rows for this run (P6).
          // Cheap: indexed query, ≤ N×5 rows where N = total_docs.
          try {
            const rows = await docPhaseLedgerService.getRowsForRun(r.id);
            const empty = () => ({ total: 0, done: 0, running: 0, failed: 0 });
            phaseRollup = {
              ingest: empty(),
              classify: empty(),
              dedup: empty(),
              extract: empty(),
              harmonise: empty(),
            };
            for (const row of rows) {
              const bucket = phaseRollup[row.phase as keyof typeof phaseRollup];
              if (!bucket) continue;
              bucket.total += 1;
              if (row.status === 'done' || row.status === 'skipped') {
                bucket.done += 1;
              } else if (row.status === 'running') {
                bucket.running += 1;
              } else if (row.status === 'failed') {
                bucket.failed += 1;
              }
              // 'pending' counts toward total but not done/running/failed
              // — it's an explicit "queued, not yet picked up" state.
            }
          } catch (err) {
            // Phase rollup is observability-only; failure here doesn't
            // affect run-cursor correctness.
          }
        }
      } catch (err) {
        // Non-fatal: legacy is_pending logic below still works.
      }

      const pendingComponents: string[] = [];
      // ─── "Actively in progress" detection — now authoritative ───────
      // If a run cursor exists, IT is the source of truth: status in
      // ('queued','running') == is_pending. The legacy activity-window
      // heuristic below remains as a fallback for claims whose runs
      // pre-date migration 060 (never had a run row opened).
      const harmStatus = (harm?.status ?? 'absent') as StatusResponse['harmoniser']['status'];
      let isPending = false;

      if (runRow) {
        isPending = runRow.status === 'queued' || runRow.status === 'running';
        if (isPending) {
          pendingComponents.push(
            `${runRow.phase ?? 'pipeline'} (${runRow.docs_completed}/${runRow.total_docs})`,
          );
        }
      } else {
        // Pre-rearch fallback: 60-second activity window. Same logic as
        // before. Once all old runs roll off this branch is dead code.
        const ACTIVITY_WINDOW_SECONDS = 60;
        const recentSectionActivity = await pool.query<{ recent: string }>(
          `SELECT COUNT(*)::text AS recent
             FROM hospital.document_sections
            WHERE claim_id = $1
              AND updated_at > NOW() - ($2 || ' seconds')::interval`,
          [claimId, String(ACTIVITY_WINDOW_SECONDS)],
        );
        const sectionsTouchedRecently = Number(
          recentSectionActivity.rows[0]?.recent ?? 0,
        );
        if (
          sectionsTotal > 0 &&
          sectionsClassified < sectionsTotal &&
          sectionsTouchedRecently > 0
        ) {
          pendingComponents.push(`classifier (${sectionsClassified}/${sectionsTotal})`);
        }
        if (
          sectionsClassified > 0 &&
          sectionsExtracted < sectionsClassified &&
          sectionsTouchedRecently > 0
        ) {
          pendingComponents.push(`extractor (${sectionsExtracted}/${sectionsClassified})`);
        }
        if (harmStatus === 'pending') pendingComponents.push('harmoniser');
        isPending = pendingComponents.length > 0;
      }

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
        run: runRow,
        phases: phaseRollup,
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
