/**
 * IntelligenceController — the run-control plane for claim AI analysis.
 * Mounted in `index.ts` under /api/v1.
 *
 * Seven endpoints, one idea: the user decides what a run costs, and can stop
 * it, extend it, or end it at any point.
 *
 *   POST .../intelligence/estimate   — what would this cost? (no spend, no run)
 *   POST .../intelligence/analyze    — approve a budget and start
 *   POST .../intelligence/pause      — stop starting new work
 *   POST .../intelligence/resume     — carry on (with more budget, if that is
 *                                      why it stopped)
 *   POST .../intelligence/cancel     — end cleanly, keep partial results
 *   GET  .../runs/:runId/unreadable  — the consolidated end-of-run decision
 *   POST .../runs/:runId/unreadable/acknowledge
 *
 * The Run Analysis button remains the SINGLE user entry point for starting
 * analysis. Nothing here starts a run except `analyze`.
 */

import { Request, Response } from 'express';
import { intelligenceOrchestratorService } from '../Services/intelligenceOrchestrator.service.js';
import claimAiRunService from '../Services/claimAiRun.service.js';
import { logger } from '../Utils/logger.js';

// ────────────────────────────────────────────────────────────────────────────
// §0 env knobs, read PER REQUEST so ops can change them without a restart.
// ────────────────────────────────────────────────────────────────────────────

/**
 * 'false' => the server auto-approves at estimate.recommended_budget_inr and
 * records budget_approved_by = NULL. CI and emailIntelligence rely on this.
 * NEVER set false in production: it turns the consent gate into a formality.
 */
function consentRequired(): boolean {
  return process.env.ANALYZE_BUDGET_CONSENT_REQUIRED !== 'false';
}

function minBudgetInr(): number {
  const n = Number(process.env.AI_RUN_MIN_APPROVED_BUDGET_INR ?? '5');
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function maxBudgetInr(): number {
  const n = Number(process.env.AI_RUN_MAX_APPROVED_BUDGET_INR ?? '1000');
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

async function resolveHospitalId(
  claimId: string,
  bodyHospitalId?: unknown,
): Promise<string | undefined> {
  if (typeof bodyHospitalId === 'string' && bodyHospitalId) return bodyHospitalId;
  const { pool } = await import('../DB/db.js');
  const r = await pool.query<{ hospital_id: string | null }>(
    `SELECT hospital_id FROM hospital.ipds WHERE id = $1`,
    [claimId],
  );
  return r.rows[0]?.hospital_id ?? undefined;
}

/** The kill switch, checked before anything that could lead to spend. */
function killSwitchBlocks(claimId: string): boolean {
  if (process.env.AI_ANALYSIS_ENABLED !== 'false') return false;
  const allowList = (process.env.AI_ANALYSIS_ALLOWED_CLAIMS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return !allowList.includes(claimId);
}

const KILL_SWITCH_BODY = {
  ok: false,
  paused: true,
  message:
    'AI analysis is currently paused (AI_ANALYSIS_ENABLED=false). Contact ops to resume, or add this claim to AI_ANALYSIS_ALLOWED_CLAIMS.',
};

/** Shape the run row into the compact form §E.3/§E.4 return. */
function runSummary(r: any) {
  return {
    id: r.id,
    status: r.status,
    pause_reason: r.pause_reason ?? null,
    paused_at: r.paused_at
      ? new Date(r.paused_at).toISOString()
      : null,
    approved_budget_inr:
      r.approved_budget_inr == null ? null : Number(r.approved_budget_inr),
    spend_at_pause_inr:
      r.spend_at_pause_inr == null ? null : Number(r.spend_at_pause_inr),
    resume_count: r.resume_count ?? 0,
    end_reason: r.end_reason ?? null,
    finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    docs_completed: r.docs_completed,
    total_docs: r.total_docs,
  };
}

export class IntelligenceController {
  // ══════════════════════════════════════════════════════════════════════
  // §E.1 — POST /claims/:claimId/intelligence/estimate
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Pre-flight cost estimate. CPU-only page census, ZERO LLM spend, creates
   * NO run row, idempotent and safe to call repeatedly.
   *
   * The FE does NOT need this on the happy path — `analyze` returns the same
   * estimate embedded in its 428. This exists for the "show me the cost
   * before I decide" affordance and for re-quoting after a 409.
   */
  static async estimate(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    if (!claimId) {
      res.status(400).json({ error: 'claimId required in path' });
      return;
    }
    try {
      if (killSwitchBlocks(claimId)) {
        res.status(503).json(KILL_SWITCH_BODY);
        return;
      }
      const hospitalId = await resolveHospitalId(claimId, req.body?.hospital_id);
      if (!hospitalId) {
        res.status(404).json({ error: 'claim or hospital not found' });
        return;
      }
      const estimate = await intelligenceOrchestratorService.estimateRun({
        claim_id: claimId,
        hospital_id: hospitalId,
      });
      res.status(200).json({
        ok: true,
        claim_id: claimId,
        estimate,
        consent_required: consentRequired(),
        min_budget_inr: minBudgetInr(),
        max_budget_inr: maxBudgetInr(),
      });
    } catch (err: any) {
      logger.error({ err, claimId }, 'intelligenceController.estimate failed');
      res.status(500).json({
        error: 'estimate failed',
        message: err?.message ?? String(err),
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // §E.2 — POST /claims/:claimId/intelligence/analyze
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Approve a budget and start the run.
   *
   * Server-side rules, in order:
   *   1. consent on + no budget        => 428 with the estimate embedded.
   *                                       NO run row is created.
   *   2. budget outside [min,max]      => 400. NEVER a silent clamp — a
   *                                       silent clamp is how consent
   *                                       becomes theatre.
   *   3. estimate_token mismatch       => 409 with a fresh estimate.
   *   4. otherwise                     => 202, run opened with the approved
   *                                       budget and the frozen estimate.
   */
  static async analyzeClaim(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    const force = req.body?.force === true;
    const targetStage =
      typeof req.body?.target_stage === 'string' ? req.body.target_stage : undefined;

    if (!claimId) {
      res.status(400).json({ error: 'claimId required in path' });
      return;
    }

    try {
      const hospitalId = await resolveHospitalId(claimId, req.body?.hospital_id);
      if (!hospitalId) {
        res.status(404).json({ error: 'claim or hospital not found' });
        return;
      }

      // Kill switch first — before the census, which costs S3 reads.
      if (killSwitchBlocks(claimId)) {
        res.status(503).json({
          ...KILL_SWITCH_BODY,
          claim_id: claimId,
          warnings: ['ai_analysis_disabled'],
        });
        return;
      }

      const min = minBudgetInr();
      const max = maxBudgetInr();
      const rawBudget = req.body?.approved_budget_inr;
      const hasBudget = rawBudget != null && rawBudget !== '';
      const suppliedToken =
        typeof req.body?.estimate_token === 'string'
          ? req.body.estimate_token
          : null;

      let approvedBudgetInr: number | null = null;
      let approvedBy: string | null = null;
      let estimate = null as Awaited<
        ReturnType<typeof intelligenceOrchestratorService.estimateRun>
      > | null;

      if (!hasBudget && consentRequired()) {
        // RULE 1 — consent not yet given. Compute the estimate and hand it
        // back so the FE renders its dialog from ONE round trip. No run row.
        estimate = await intelligenceOrchestratorService.estimateRun({
          claim_id: claimId,
          hospital_id: hospitalId,
        });
        res.status(428).json({
          ok: false,
          error: 'budget_approval_required',
          message: 'This run needs a budget approval before it can start.',
          estimate,
          min_budget_inr: min,
          max_budget_inr: max,
        });
        return;
      }

      if (hasBudget) {
        // RULE 2 — range check. Reject, never clamp.
        const n = Number(rawBudget);
        if (!Number.isFinite(n) || n < min || n > max) {
          res.status(400).json({
            error: 'budget_out_of_range',
            min_budget_inr: min,
            max_budget_inr: max,
          });
          return;
        }
        approvedBudgetInr = n;
        approvedBy = (req as any).user?.id ?? null;
      }

      // RULE 3 — the estimate the user approved must still describe the
      // document set we are about to run against. Omitting the token is
      // allowed (the FE may approve a number the user typed).
      //
      // We compute the estimate unconditionally, even when no token was sent.
      // It costs S3 reads and zero LLM, and it is what gets frozen onto the
      // run row: without it there is no way to answer "what were they told?"
      // after the document set changes, which is the whole point of keeping a
      // consent record rather than just a number.
      estimate = await intelligenceOrchestratorService.estimateRun({
        claim_id: claimId,
        hospital_id: hospitalId,
      });
      if (suppliedToken && estimate.estimate_token !== suppliedToken) {
        res.status(409).json({ error: 'estimate_stale', estimate });
        return;
      }

      if (approvedBudgetInr == null) {
        // Consent disabled: auto-approve at the recommended budget and record
        // budget_approved_by = NULL so the audit trail says "nobody approved
        // this, the config did".
        approvedBudgetInr = estimate?.recommended_budget_inr ?? min;
        approvedBy = null;
        logger.warn(
          { claim_id: claimId, approved_budget_inr: approvedBudgetInr },
          'intelligenceController: budget AUTO-APPROVED (ANALYZE_BUDGET_CONSENT_REQUIRED=false)',
        );
      }

      const result = await intelligenceOrchestratorService.analyzeClaim({
        claim_id: claimId,
        hospital_id: hospitalId,
        force,
        target_stage: targetStage,
        triggered_by_user_id: (req as any).user?.id,
        approved_budget_inr: approvedBudgetInr,
        budget_approved_by: approvedBy,
        estimate,
      });

      if (result.warnings.includes('ai_analysis_disabled')) {
        res.status(503).json({ ...KILL_SWITCH_BODY, ...result });
        return;
      }

      res.status(202).json({
        ok: true,
        ...result,
        approved_budget_inr: approvedBudgetInr,
        estimate,
        message:
          result.docs_enqueued_for_segmentation > 0
            ? `Started — ${result.docs_enqueued_for_segmentation} docs being analyzed. Check back in a minute.`
            : result.adjudication_report_id
              ? 'Analysis complete.'
              : result.docs_total === 0
                ? 'No documents to analyze yet.'
                : 'All documents already processed.',
      });
    } catch (err: any) {
      logger.error({ err, claimId }, 'intelligenceController.analyzeClaim failed');
      res.status(500).json({
        error: 'intelligence analysis failed',
        message: err?.message ?? String(err),
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // §E.3 — POST /claims/:claimId/intelligence/pause
  // ══════════════════════════════════════════════════════════════════════

  static async pauseRun(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    if (!claimId) {
      res.status(400).json({ error: 'claimId required in path' });
      return;
    }
    try {
      const run = await claimAiRunService.resolveRun(
        claimId,
        typeof req.body?.run_id === 'string' ? req.body.run_id : null,
      );
      if (!run) {
        res.status(404).json({ error: 'no_run_for_claim' });
        return;
      }
      const paused = await claimAiRunService.pauseRun({
        run_id: run.id,
        paused_by: (req as any).user?.id ?? null,
      });
      if (!paused) {
        // The guarded UPDATE matched nothing: the run is already terminal or
        // already paused. Report its CURRENT status, not the one we read
        // before trying.
        const fresh = await claimAiRunService.getRunById(run.id);
        res.status(409).json({
          error: 'run_not_pausable',
          status: fresh?.status ?? run.status,
        });
        return;
      }
      const spend = await claimAiRunService
        .getRunSpend(paused)
        .catch(() => null);
      res.status(200).json({
        ok: true,
        run: {
          ...runSummary(paused),
          spend_so_far_inr: spend?.totalInr ?? paused.spend_at_pause_inr ?? 0,
        },
        message:
          'Paused. Work already in flight will finish; nothing new will start.',
      });
    } catch (err: any) {
      logger.error({ err, claimId }, 'intelligenceController.pauseRun failed');
      res.status(500).json({ error: 'pause failed', message: err?.message ?? String(err) });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // §E.4 — POST /claims/:claimId/intelligence/resume
  // ══════════════════════════════════════════════════════════════════════

  static async resumeRun(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    if (!claimId) {
      res.status(400).json({ error: 'claimId required in path' });
      return;
    }
    try {
      const run = await claimAiRunService.resolveRun(
        claimId,
        typeof req.body?.run_id === 'string' ? req.body.run_id : null,
      );
      if (!run) {
        res.status(404).json({ error: 'no_run_for_claim' });
        return;
      }

      // The body's approved_budget_inr is the NEW TOTAL, not a delta. Range
      // checked here for the same reason as on analyze: no silent clamp.
      const raw = req.body?.approved_budget_inr;
      let nextBudget: number | null = null;
      if (raw != null && raw !== '') {
        const n = Number(raw);
        const min = minBudgetInr();
        const max = maxBudgetInr();
        if (!Number.isFinite(n) || n < min || n > max) {
          res.status(400).json({
            error: 'budget_out_of_range',
            min_budget_inr: min,
            max_budget_inr: max,
          });
          return;
        }
        nextBudget = n;
      }

      const out = await claimAiRunService.resumeRun({
        run_id: run.id,
        approved_budget_inr: nextBudget,
        budget_approved_by: nextBudget == null ? null : (req as any).user?.id ?? null,
      });

      if (!out.ok || !out.resumed) {
        if (out.error === 'budget_not_increased') {
          res.status(400).json({
            error: 'budget_not_increased',
            approved_budget_inr:
              out.run?.approved_budget_inr == null
                ? null
                : Number(out.run.approved_budget_inr),
            requested: nextBudget,
          });
          return;
        }
        res.status(409).json({
          error: 'run_not_paused',
          status: out.run?.status ?? null,
        });
        return;
      }

      const r = out.resumed;
      res.status(200).json({
        ok: true,
        run: runSummary(out.run!),
        resumed: r,
        message: `Resumed — ${r.docs_reenqueued} document${r.docs_reenqueued === 1 ? '' : 's'} and ${r.sections_reenqueued} section${r.sections_reenqueued === 1 ? '' : 's'} requeued; ${r.phases_skipped_already_done} completed phases skipped.`,
      });
    } catch (err: any) {
      logger.error({ err, claimId }, 'intelligenceController.resumeRun failed');
      res.status(500).json({ error: 'resume failed', message: err?.message ?? String(err) });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // §E.5 — POST /claims/:claimId/intelligence/cancel
  // ══════════════════════════════════════════════════════════════════════

  /**
   * "Finish with what we have" — the DECLINE half of the mid-run consent
   * question. Partial results are KEPT; nothing is deleted.
   */
  static async cancelRun(req: Request, res: Response): Promise<void> {
    const claimId = req.params.claimId;
    if (!claimId) {
      res.status(400).json({ error: 'claimId required in path' });
      return;
    }
    try {
      const run = await claimAiRunService.resolveRun(
        claimId,
        typeof req.body?.run_id === 'string' ? req.body.run_id : null,
      );
      if (!run) {
        res.status(404).json({ error: 'no_run_for_claim' });
        return;
      }
      const reason =
        req.body?.reason === 'user_cancelled' ? 'user_cancelled' : 'budget_declined';

      const cancelled = await claimAiRunService.cancelRun({
        run_id: run.id,
        reason,
      });
      if (!cancelled) {
        const fresh = await claimAiRunService.getRunById(run.id);
        res.status(409).json({
          error: 'run_not_cancellable',
          status: fresh?.status ?? run.status,
        });
        return;
      }

      const unreadable = await claimAiRunService
        .getUnreadableSummary(cancelled.id)
        .catch(() => null);

      const analysed = cancelled.docs_completed ?? 0;
      const total = cancelled.total_docs ?? 0;
      const pages = unreadable?.unreadable_pages_total ?? 0;
      res.status(200).json({
        ok: true,
        run: runSummary(cancelled),
        unreadable,
        message: `Run ended. ${analysed} of ${total} documents were fully analysed; ${pages} page${pages === 1 ? '' : 's'} were not read.`,
      });
    } catch (err: any) {
      logger.error({ err, claimId }, 'intelligenceController.cancelRun failed');
      res.status(500).json({ error: 'cancel failed', message: err?.message ?? String(err) });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // §E.7 — GET /claims/:claimId/intelligence/runs/:runId/unreadable
  // ══════════════════════════════════════════════════════════════════════

  static async getUnreadableSummary(req: Request, res: Response): Promise<void> {
    const { claimId, runId } = req.params;
    if (!claimId || !runId) {
      res.status(400).json({ error: 'claimId and runId required in path' });
      return;
    }
    try {
      const summary = await claimAiRunService.getUnreadableSummary(runId);
      if (!summary || summary.claim_id !== claimId) {
        res.status(404).json({ error: 'run_not_found' });
        return;
      }
      res.status(200).json(summary);
    } catch (err: any) {
      logger.error(
        { err, claimId, runId },
        'intelligenceController.getUnreadableSummary failed',
      );
      res.status(500).json({
        error: 'failed to load unreadable summary',
        message: err?.message ?? String(err),
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // §E.8 — POST .../runs/:runId/unreadable/acknowledge
  // ══════════════════════════════════════════════════════════════════════

  static async acknowledgeUnreadable(req: Request, res: Response): Promise<void> {
    const { claimId, runId } = req.params;
    if (!claimId || !runId) {
      res.status(400).json({ error: 'claimId and runId required in path' });
      return;
    }
    try {
      const run = await claimAiRunService.getRunById(runId);
      if (!run || run.claim_id !== claimId) {
        res.status(404).json({ error: 'run_not_found' });
        return;
      }
      const ack = await claimAiRunService.acknowledgeUnreadable(
        runId,
        (req as any).user?.id ?? null,
      );
      if (!ack) {
        res.status(404).json({ error: 'run_not_found' });
        return;
      }
      res.status(200).json({
        ok: true,
        acknowledged_at: ack.acknowledged_at,
        acknowledged_by: ack.acknowledged_by,
        decision_required: false,
      });
    } catch (err: any) {
      logger.error(
        { err, claimId, runId },
        'intelligenceController.acknowledgeUnreadable failed',
      );
      res.status(500).json({
        error: 'acknowledge failed',
        message: err?.message ?? String(err),
      });
    }
  }
}
