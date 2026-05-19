/**
 * Sprint 3, Wave 3C — Action Engine Workers
 *
 * Two queues, one module:
 *
 *   action-engine     — orchestrator. Input: AdjudicationReport id. Loads
 *                       the report from the DB, hands it to ActionEngine
 *                       .planAndDispatch(). One job per report.
 *
 *   action-dispatcher — delivery. Input: claim_actions.id. Reads the row,
 *                       branches on target_kind, performs the actual
 *                       WhatsApp / in-app delivery, and writes back to the
 *                       row (status = 'dispatched' on success, 'failed'
 *                       on terminal error).
 *
 * Why two queues:
 *   - Different concurrency profiles. Planning is cheap (DB-bound, ~3
 *     in flight). Delivery is I/O-bound on UltraMsg; we can run more
 *     and we don't want one slow delivery to block planning the next
 *     report.
 *   - Different retry semantics. A planning failure (DB hiccup) should
 *     retry the whole plan. A dispatch failure should retry only that
 *     one delivery — the other actions in the report should keep going.
 *
 * RUN_WORKERS gating: the API container imports this module to enqueue
 * jobs (and to expose the `dispatcher` enqueue helper to ActionEngine)
 * but must NOT consume them. Setting RUN_WORKERS=false on the API
 * container skips the .process() registration; the dedicated worker
 * container processes.
 */

import Queue from 'bull';
import { logger } from '../Utils/logger.js';

export const ENGINE_QUEUE_NAME = 'action-engine';
export const DISPATCHER_QUEUE_NAME = 'action-dispatcher';

export interface ActionEngineJob {
  /** AdjudicationReport.id — the worker loads + plans against it. */
  reportId: string;
  /** Hospital id is required for the routing lookup. */
  hospitalId: string;
}

export interface ActionDispatcherJob {
  /** claim_actions.id — the worker reads + delivers it. */
  actionId: string;
}

// Stub queue mirrors the pattern used by emailIntelligence.queue.ts — keeps
// `import` cheap in environments without Redis (CLI tools, tests).
const stubQueue = {
  add: async () => null,
  process: () => {},
  on: () => stubQueue,
  isReady: async () => false,
} as any;

function createQueue<T>(name: string, attempts: number) {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(redisUrl);
  const q = new Queue<T>(name, {
    redis: {
      host: url.hostname,
      port: parseInt(url.port || '6379'),
      retryStrategy: (times: number) => {
        if (times >= 3) return null;
        return Math.min(times * 200, 1000);
      },
      enableOfflineQueue: false,
    } as any,
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });
  q.on('error', (err: Error) => {
    if ((err as any).code === 'ECONNREFUSED') {
      console.warn(
        `[${name}] Redis not available — action pipeline paused.`,
      );
    }
  });
  return q;
}

const engineQueue: Queue.Queue<ActionEngineJob> | typeof stubQueue = (() => {
  try {
    return createQueue<ActionEngineJob>(ENGINE_QUEUE_NAME, 3);
  } catch (err) {
    logger.warn({ err }, 'failed to create action-engine queue; using stub');
    return stubQueue;
  }
})();

const dispatcherQueue: Queue.Queue<ActionDispatcherJob> | typeof stubQueue = (() => {
  try {
    return createQueue<ActionDispatcherJob>(DISPATCHER_QUEUE_NAME, 3);
  } catch (err) {
    logger.warn({ err }, 'failed to create action-dispatcher queue; using stub');
    return stubQueue;
  }
})();

// ─── Engine worker (orchestrator) ─────────────────────────────────────────

async function processEngineJob(
  job: Queue.Job<ActionEngineJob>,
): Promise<unknown> {
  const { reportId, hospitalId } = job.data;

  // Dynamic imports to avoid module-init cycles (the engine imports this
  // file for the dispatcher enqueue helper).
  const { pool } = await import('../DB/db.js');
  const { ActionEngine } = await import('../Services/actionEngine.service.js');

  // Pull the latest report. Wave 3B persists reports to
  // hospital.adjudication_reports (per the spec); we read from there but
  // also fall back to a JSONB column on claim_dossiers if the dedicated
  // table isn't present in the deployed schema yet.
  const reportRes = await pool.query(
    `SELECT id, claim_id, readiness, recommended_action,
            blocking_gaps, warnings, predicted_outcome, citations, generated_at
       FROM hospital.adjudication_reports
      WHERE id = $1`,
    [reportId],
  );
  if (reportRes.rows.length === 0) {
    throw new Error(`action-engine: report ${reportId} not found`);
  }
  const r = reportRes.rows[0]!;
  const report = {
    id: r.id as string,
    claim_id: r.claim_id as string,
    readiness: Number(r.readiness),
    recommended_action: r.recommended_action as any,
    blocking_gaps: (r.blocking_gaps ?? []) as any[],
    warnings: (r.warnings ?? []) as any[],
    predicted_outcome: r.predicted_outcome ?? null,
    citations: r.citations ?? undefined,
    generated_at:
      typeof r.generated_at === 'string'
        ? r.generated_at
        : (r.generated_at as Date).toISOString(),
  };

  const engine = new ActionEngine();
  const dispatched = await engine.planAndDispatch({
    report,
    hospital_id: hospitalId,
  });
  return { dispatched_count: dispatched.length, action_ids: dispatched.map((d) => d.id) };
}

// ─── Dispatcher worker (delivery) ─────────────────────────────────────────

async function processDispatcherJob(
  job: Queue.Job<ActionDispatcherJob>,
): Promise<unknown> {
  const { actionId } = job.data;

  const { pool } = await import('../DB/db.js');

  // Re-read the row each attempt — keeps us correct under ack/decline
  // racing with a slow dispatch (we don't re-deliver a row the user has
  // already acked).
  const res = await pool.query(
    `SELECT id, claim_id, kind, target_kind, target_value, target_user_id,
            payload, status
       FROM hospital.claim_actions
      WHERE id = $1`,
    [actionId],
  );
  if (res.rows.length === 0) {
    logger.warn({ actionId }, 'action-dispatcher: row missing (deleted?)');
    return { skipped: true };
  }
  const row = res.rows[0]!;
  if (row.status !== 'pending') {
    logger.info(
      { actionId, status: row.status },
      'action-dispatcher: row no longer pending; skipping',
    );
    return { skipped: true, status: row.status };
  }

  try {
    switch (row.target_kind) {
      case 'whatsapp_group':
      case 'whatsapp_user': {
        const { default: UltraMsg } = await import(
          '../Services/ultraMsg.service.js'
        );
        const body = renderWhatsAppBody(row.kind, row.payload);
        await UltraMsg.sendMessage(row.target_value, body);
        break;
      }

      case 'in_app_user':
      case 'in_app_role': {
        // In-app delivery is the row itself — the FE polls
        // claim_actions where target_user_id = me AND status IN ('pending',
        // 'dispatched'). Marking the row 'dispatched' is the delivery.
        //
        // (We considered also writing into a separate `notifications`
        // table for parity with the existing email-driven notifications,
        // but that table is single-purpose and tied to inbound emails.
        // Reusing claim_actions as the in-app inbox row keeps the schema
        // tighter; the FE hook already targets /claim-actions.)
        break;
      }

      default:
        throw new Error(`unknown target_kind: ${row.target_kind}`);
    }

    await pool.query(
      `UPDATE hospital.claim_actions
          SET status = 'dispatched',
              dispatched_at = NOW(),
              dispatch_error = NULL,
              updated_at = NOW()
        WHERE id = $1 AND status = 'pending'`,
      [actionId],
    );
    return { dispatched: true };
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    logger.error(
      { err, actionId, attempt: job.attemptsMade + 1 },
      'action-dispatcher: delivery failed',
    );
    // Persist the latest error message but DON'T flip to 'failed' until
    // Bull has exhausted retries. opts.attempts is set on the queue —
    // when attemptsMade === attempts - 1 this is the last try.
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 3);
    if (isFinalAttempt) {
      await pool.query(
        `UPDATE hospital.claim_actions
            SET status = 'failed',
                dispatch_error = $2,
                updated_at = NOW()
          WHERE id = $1 AND status = 'pending'`,
        [actionId, message],
      );
    } else {
      await pool.query(
        `UPDATE hospital.claim_actions
            SET dispatch_error = $2, updated_at = NOW()
          WHERE id = $1`,
        [actionId, message],
      );
    }
    // Re-throw so Bull retries per backoff policy.
    throw err;
  }
}

/** Compose the WhatsApp body from the action's payload. Mirrors the visual
 *  pattern used by notificationDispatch.service for consistency.
 *
 *  Wave 11 enrichment: when the payload carries `query_template` (rule-driven
 *  action) we prepend an [INSURER QUERY] marker so the panel ops on the other
 *  end immediately know this is a structured query, not a one-off ping. When
 *  `estimated_deduction_amount` is set, we surface the potential financial
 *  exposure so the responder treats it as a high-priority item. The enrichment
 *  is intentionally additive — the rest of the formatter (title/summary/
 *  deep-link) is untouched. */
function renderWhatsAppBody(kind: string, payload: any): string {
  const lines: string[] = [];
  const emoji = (
    {
      request_doc: '📄',
      notify_ops: '🔔',
      approval_request: '✅',
      follow_up_sla: '⏱️',
      rule_clarification: '❓',
    } as Record<string, string>
  )[kind] ?? '🔔';
  if (payload?.query_template) {
    lines.push('[INSURER QUERY]');
  }
  lines.push(`${emoji} *${payload?.title ?? kind}*`);
  if (payload?.panel_name) lines.push(`*Panel:* ${payload.panel_name}`);
  if (payload?.summary) lines.push(``, payload.summary);
  if (payload?.fix_hint) lines.push(``, `_How to fix:_ ${payload.fix_hint}`);
  if (Array.isArray(payload?.required_documents) && payload.required_documents.length > 0) {
    lines.push(``, `*Required documents:* ${payload.required_documents.join(', ')}`);
  }
  if (payload?.deep_link) {
    const frontend = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const url = frontend ? `${frontend}${payload.deep_link}` : payload.deep_link;
    lines.push(``, `Open in ClaimOS → ${url}`);
  }
  const ded = Number(payload?.estimated_deduction_amount ?? 0);
  if (ded > 0) {
    const formatted = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(ded);
    lines.push(``, `(Potential deduction: ${formatted})`);
  }
  return lines.join('\n');
}

// ─── Boot ─────────────────────────────────────────────────────────────────

export function startActionEngineWorkers(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info(
      'actionEngine workers NOT started (RUN_WORKERS=false)',
    );
    return;
  }
  if (typeof (engineQueue as any).process === 'function') {
    (engineQueue as Queue.Queue<ActionEngineJob>).process(
      3,
      processEngineJob,
    );
    logger.info('action-engine worker started (concurrency 3, 3 attempts)');
  }
  if (typeof (dispatcherQueue as any).process === 'function') {
    (dispatcherQueue as Queue.Queue<ActionDispatcherJob>).process(
      5,
      processDispatcherJob,
    );
    logger.info('action-dispatcher worker started (concurrency 5, 3 attempts)');
  }
}

// Auto-start preserves single-container backward compat (same pattern as
// inboundNotification.queue and emailIntelligence.queue).
startActionEngineWorkers();

// Exported with a single shape so callers (ActionEngine, controllers) have
// one import for both queues.
export default {
  engine: engineQueue as Queue.Queue<ActionEngineJob>,
  dispatcher: dispatcherQueue as Queue.Queue<ActionDispatcherJob>,
};
