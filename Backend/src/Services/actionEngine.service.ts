/**
 * Sprint 3, Wave 3C — Action Engine
 *
 * The Action Engine is the bridge between adjudication output and the human
 * world. It consumes an AdjudicationReport (produced by the Adjudication
 * Engine, Wave 3B) and turns its `recommended_action` + `blocking_gaps` into
 * concrete units of work that are dispatched over WhatsApp / in-app.
 *
 * Why this is a distinct service from the Adjudication Engine:
 *
 *   1. Pure separation of concerns. Adjudication decides "this claim is 62%
 *      ready and is missing a discharge summary + pre-auth letter". The
 *      Action Engine decides "ping the Sadbhawana WhatsApp group with the
 *      two doc requests, ping the ops head with a review card".
 *
 *   2. Idempotency lives here, not there. Adjudication runs every time a
 *      doc lands; each run produces a fresh report. Without an idempotent
 *      action layer, every re-run would spam the panel group. The engine
 *      computes a deterministic key per (claim × kind × target × gap) and
 *      relies on the UNIQUE partial index from migration 037 to swallow
 *      duplicates.
 *
 *   3. Dispatch is async and retry-safe. planAndDispatch writes pending
 *      rows then enqueues `action-dispatcher` jobs; the worker handles the
 *      WhatsApp/in-app call and writes back to the same row. If UltraMsg
 *      is down, Bull retries with backoff.
 *
 * NOT in scope for v1:
 *   - Per-hospital approver routing (we use the first hospital admin for
 *     both `notify_ops` and `approval_request`; revisit when we add a
 *     `hospital_role_assignments` table).
 *   - SLA expiry (`follow_up_sla` actions can be inserted but expiry is
 *     a separate cron sprint).
 */

import { randomUUID, createHash } from 'crypto';
import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { eventDispatcher } from './events/eventDispatcher.service.js';
import { logger } from '../Utils/logger.js';
import {
  ActionTemplatingService,
  type ActionTemplate,
} from './actionTemplating.service.js';

// ─── Types (mirror Wave 1 FE hook types; importer can swap to a shared    ─
//          type module once Wave 3B's adjudicationEngine.service lands)   ─

export interface AdjudicationBlockingGap {
  id: string;
  field?: string;
  doc_category?: string;
  severity: 'blocker' | 'warning';
  message: string;
  fix_hint?: string;
}

export interface AdjudicationWarning {
  id: string;
  message: string;
  severity?: 'low' | 'medium' | 'high';
  source?: string;
}

export interface AdjudicationReport {
  id: string;
  claim_id: string;
  readiness: number;
  recommended_action:
    | 'request_doc'
    | 'review'
    | 'file_now'
    | 'approval_request'
    | 'escalate_to_human';
  blocking_gaps: AdjudicationBlockingGap[];
  warnings: AdjudicationWarning[];
  predicted_outcome?: unknown;
  citations?: { rule_ids?: string[]; pattern_ids?: string[]; case_ids?: string[] };
  generated_at: string;
}

export interface ActionEngineInput {
  report: AdjudicationReport;
  hospital_id: string;
}

export interface DispatchedAction {
  id: string;
  kind: string;
  status: string;
}

// Result of the planning phase — what the engine *wants* to create. The
// idempotent INSERT step may collapse some of these into existing rows.
export interface ActionSpec {
  kind: 'request_doc' | 'notify_ops' | 'approval_request' | 'follow_up_sla' | 'rule_clarification';
  target_kind: 'whatsapp_group' | 'whatsapp_user' | 'in_app_user' | 'in_app_role';
  target_value: string;
  target_user_id: string | null;
  payload: Record<string, unknown>;
  /** Source artefact id (gap id / warning id / 'report' / rule_id) used in the idem key. */
  gap_or_warning_id: string;
}

// ─── Enqueue surface for the dispatcher worker ────────────────────────────

export interface DispatcherEnqueue {
  enqueue(action_id: string): Promise<void>;
}

/**
 * Default enqueue uses the action-dispatcher Bull queue. Lazy-imported so
 * the service module doesn't pull in Bull on environments that only need
 * the planning logic (e.g. tests).
 */
const defaultDispatcherEnqueue: DispatcherEnqueue = {
  async enqueue(action_id: string): Promise<void> {
    const { default: q } = await import('../Workers/actionEngine.queue.js');
    await q.dispatcher.add({ actionId: action_id });
  },
};

// ─── Service ──────────────────────────────────────────────────────────────

export class ActionEngine {
  private readonly pool: Pick<Pool, 'query'>;
  private readonly dispatcherEnqueue: DispatcherEnqueue;
  private readonly templating: ActionTemplatingService;

  constructor(
    pool: Pick<Pool, 'query'> = defaultPool,
    dispatcherEnqueue: DispatcherEnqueue = defaultDispatcherEnqueue,
    templating?: ActionTemplatingService,
  ) {
    this.pool = pool;
    this.dispatcherEnqueue = dispatcherEnqueue;
    this.templating =
      templating ?? new ActionTemplatingService({ pool: pool as any });
  }

  /**
   * Plan the action specs for a report, INSERT them idempotently, and
   * enqueue dispatch jobs for any new rows.
   *
   * Returns the rows that *were inserted* (i.e. truly new). Rows that
   * collided on idempotency_key are skipped — by design, no duplicate
   * WhatsApp ping.
   */
  async planAndDispatch(input: ActionEngineInput): Promise<DispatchedAction[]> {
    const { report, hospital_id } = input;

    // Look up routing context: panel WhatsApp group + a sensible default
    // user for in-app notifications. Both queries are cheap (single PK
    // lookup) and we do them once per call.
    const routing = await this.loadRouting(report.claim_id, hospital_id);

    // 1. Plan — prefer Wave 11 rule-driven templating (richer copy from
    //    insurance_rules.query_template / remediation_guidance). Fall back
    //    to the Wave 3C generic mapping when the claim has no rule
    //    evaluations yet (e.g. harmonisation hasn't run or no rule set
    //    matched).
    let specs: ActionSpec[] = [];
    try {
      const templates = await this.templating.deriveFromRulesEvaluation(report.claim_id);
      if (templates.length > 0) {
        specs = templates
          .map((t) => actionTemplateToSpec(t, report))
          .filter((s): s is ActionSpec => s !== null);
        logger.info(
          { claimId: report.claim_id, templateCount: templates.length },
          'action engine: using rule-driven templates',
        );
      }
    } catch (err) {
      logger.warn(
        { err, claimId: report.claim_id },
        'action engine: rule-driven templating failed; falling back to report',
      );
    }
    if (specs.length === 0) {
      specs = this.planActions(report, routing);
    }

    // 2. Persist idempotently. ON CONFLICT DO NOTHING per the partial
    //    UNIQUE index in migration 037.
    const inserted: DispatchedAction[] = [];
    for (const spec of specs) {
      const idemKey = computeIdempotencyKey(
        report.claim_id,
        spec.kind,
        spec.target_value,
        spec.gap_or_warning_id,
      );
      const id = randomUUID();

      const result = await this.pool.query<{ id: string; kind: string; status: string }>(
        `INSERT INTO hospital.claim_actions
           (id, claim_id, kind, target_kind, target_value, target_user_id,
            payload, status, source, source_report_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending',
                 'adjudication_engine', $8, $9)
         ON CONFLICT (claim_id, idempotency_key)
           WHERE idempotency_key IS NOT NULL
           DO NOTHING
         RETURNING id, kind, status`,
        [
          id,
          report.claim_id,
          spec.kind,
          spec.target_kind,
          spec.target_value,
          spec.target_user_id,
          JSON.stringify(spec.payload),
          report.id,
          idemKey,
        ],
      );

      if (result.rows.length === 0) {
        // dedup hit — action already exists for this report run combination.
        logger.debug(
          {
            claimId: report.claim_id,
            kind: spec.kind,
            target: spec.target_value,
            idemKey,
          },
          'action engine: idempotency hit, skipping insert',
        );
        continue;
      }

      const row = result.rows[0]!;
      inserted.push({ id: row.id, kind: row.kind, status: row.status });

      // 3. Dispatch firehose event.
      try {
        await eventDispatcher.dispatch({
          kind: 'claim_action_dispatched',
          claimId: report.claim_id,
          hospitalId: hospital_id,
          payload: {
            action_id: row.id,
            action_kind: spec.kind,
            target: `${spec.target_kind}:${spec.target_value}`,
            payload_summary:
              (spec.payload.title as string | undefined) ?? spec.kind,
          },
          idempotencyKey: `action_dispatched:${row.id}`,
        });
      } catch (err) {
        // Event emission failure shouldn't roll back the action — log loudly
        // and continue. The action is still in the DB and will be dispatched.
        logger.warn(
          { err, actionId: row.id },
          'action engine: failed to emit claim_action_dispatched event',
        );
      }

      // 4. Queue the dispatch job. Fire-and-forget on enqueue errors so a
      //    Redis hiccup doesn't lose the action — a cron sweep can pick up
      //    pending rows whose updated_at is older than N seconds.
      try {
        await this.dispatcherEnqueue.enqueue(row.id);
      } catch (err) {
        logger.error(
          { err, actionId: row.id },
          'action engine: failed to enqueue dispatcher job — action will need cron retry',
        );
      }
    }

    logger.info(
      {
        claimId: report.claim_id,
        reportId: report.id,
        planned: specs.length,
        inserted: inserted.length,
      },
      'action engine: planAndDispatch complete',
    );

    return inserted;
  }

  /**
   * Mark an action as acked by a user. Used by both the in-app "ack" button
   * and the WhatsApp webhook (when we wire reply parsing in a later wave).
   */
  async ackAction(id: string, ackedBy: string, response?: unknown): Promise<void> {
    const result = await this.pool.query<{ claim_id: string; kind: string }>(
      `UPDATE hospital.claim_actions
          SET status = 'acked',
              acked_at = NOW(),
              acked_by = $2,
              ack_response = $3::jsonb,
              updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'dispatched')
       RETURNING claim_id, kind`,
      [id, ackedBy, response !== undefined ? JSON.stringify(response) : null],
    );
    if (result.rows.length === 0) {
      throw new Error(`action ${id} not in an ackable state (or not found)`);
    }
    const row = result.rows[0]!;
    await eventDispatcher.dispatch({
      kind: 'claim_action_acked',
      claimId: row.claim_id,
      actorUserId: ackedBy,
      payload: { action_id: id, acked_by: ackedBy, response: response ?? null },
      idempotencyKey: `action_acked:${id}`,
    });
  }

  /**
   * Mark an action as declined. `reason` is required (FE enforces, but we
   * defend on the server too) — declines without a reason are useless for
   * the audit trail and the prompt-tuning feedback loop.
   */
  async declineAction(id: string, declinedBy: string, reason: string): Promise<void> {
    if (!reason || !reason.trim()) {
      throw new Error('decline reason is required');
    }
    const result = await this.pool.query<{ claim_id: string; kind: string }>(
      `UPDATE hospital.claim_actions
          SET status = 'declined',
              declined_at = NOW(),
              declined_by = $2,
              decline_reason = $3,
              updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'dispatched')
       RETURNING claim_id, kind`,
      [id, declinedBy, reason],
    );
    if (result.rows.length === 0) {
      throw new Error(`action ${id} not in a declinable state (or not found)`);
    }
    const row = result.rows[0]!;
    await eventDispatcher.dispatch({
      kind: 'claim_action_declined',
      claimId: row.claim_id,
      actorUserId: declinedBy,
      payload: { action_id: id, declined_by: declinedBy, reason },
      idempotencyKey: `action_declined:${id}`,
    });
  }

  async listForUser(userId: string, opts: { status?: string } = {}): Promise<any[]> {
    const status = opts.status ?? 'pending';
    const result = await this.pool.query(
      `SELECT id, claim_id, kind, target_kind, target_value, target_user_id,
              payload, status, source, source_report_id,
              dispatched_at, acked_at, acked_by, ack_response,
              declined_at, declined_by, decline_reason, dispatch_error,
              created_at, updated_at
         FROM hospital.claim_actions
        WHERE target_user_id = $1
          AND ($2 = 'all' OR status = $2)
        ORDER BY created_at DESC
        LIMIT 200`,
      [userId, status],
    );
    return result.rows;
  }

  async listForClaim(claimId: string, opts: { status?: string } = {}): Promise<any[]> {
    const status = opts.status ?? 'all';
    const result = await this.pool.query(
      `SELECT id, claim_id, kind, target_kind, target_value, target_user_id,
              payload, status, source, source_report_id,
              dispatched_at, acked_at, acked_by, ack_response,
              declined_at, declined_by, decline_reason, dispatch_error,
              created_at, updated_at
         FROM hospital.claim_actions
        WHERE claim_id = $1
          AND ($2 = 'all' OR status = $2)
        ORDER BY created_at DESC
        LIMIT 200`,
      [claimId, status],
    );
    return result.rows;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Pure planner. Given a report + routing context, decide what actions to
   * create. Exposed as a method (not inlined into planAndDispatch) so tests
   * can assert on the spec list without round-tripping through the DB.
   */
  planActions(report: AdjudicationReport, routing: RoutingContext): ActionSpec[] {
    const specs: ActionSpec[] = [];

    const deepLink = `/hospital/${routing.hospital_id}/patients/${report.claim_id}`;

    switch (report.recommended_action) {
      case 'request_doc': {
        // One WhatsApp action per blocking gap. Target = panel group; falls
        // back to ops head in-app if the panel has no group configured.
        if (report.blocking_gaps.length === 0) {
          // Defensive: if the engine recommended 'request_doc' with no
          // gaps, treat as a review nudge instead of silently dropping.
          specs.push(this.notifyOpsSpec(report, routing, deepLink));
          break;
        }
        for (const gap of report.blocking_gaps) {
          if (routing.whatsapp_group_id) {
            specs.push({
              kind: 'request_doc',
              target_kind: 'whatsapp_group',
              target_value: routing.whatsapp_group_id,
              target_user_id: null,
              payload: {
                title: `Document required — ${gap.doc_category ?? gap.field ?? 'evidence'}`,
                summary: gap.message,
                fix_hint: gap.fix_hint ?? null,
                gap_id: gap.id,
                deep_link: deepLink,
                panel_name: routing.panel_name,
              },
              gap_or_warning_id: gap.id,
            });
          } else if (routing.ops_head_user_id) {
            // No panel group — surface in-app to ops head so the request
            // doesn't disappear.
            specs.push({
              kind: 'request_doc',
              target_kind: 'in_app_user',
              target_value: routing.ops_head_user_id,
              target_user_id: routing.ops_head_user_id,
              payload: {
                title: `Document required — ${gap.doc_category ?? gap.field ?? 'evidence'}`,
                summary: gap.message,
                fix_hint: gap.fix_hint ?? null,
                gap_id: gap.id,
                deep_link: deepLink,
              },
              gap_or_warning_id: gap.id,
            });
          }
        }
        break;
      }

      case 'review':
      case 'file_now': {
        specs.push(this.notifyOpsSpec(report, routing, deepLink));
        break;
      }

      case 'approval_request': {
        // Approval needs both in-app (so the approver sees it in the queue)
        // AND WhatsApp (so they get pinged). v1: same hospital admin for
        // both; later, configurable per hospital.
        const approverId = routing.approver_user_id ?? routing.ops_head_user_id;
        if (approverId) {
          specs.push({
            kind: 'approval_request',
            target_kind: 'in_app_user',
            target_value: approverId,
            target_user_id: approverId,
            payload: {
              title: 'Approval requested',
              summary: `Adjudication readiness ${Math.round(report.readiness * 100)}%`,
              readiness: report.readiness,
              deep_link: deepLink,
              report_id: report.id,
            },
            gap_or_warning_id: 'report',
          });
        }
        if (routing.whatsapp_group_id) {
          specs.push({
            kind: 'approval_request',
            target_kind: 'whatsapp_group',
            target_value: routing.whatsapp_group_id,
            target_user_id: null,
            payload: {
              title: 'Approval requested',
              summary: `Claim ready for approval — readiness ${Math.round(report.readiness * 100)}%`,
              deep_link: deepLink,
              report_id: report.id,
            },
            gap_or_warning_id: 'report',
          });
        }
        break;
      }

      case 'escalate_to_human': {
        if (routing.ops_head_user_id) {
          specs.push({
            kind: 'notify_ops',
            target_kind: 'in_app_user',
            target_value: routing.ops_head_user_id,
            target_user_id: routing.ops_head_user_id,
            payload: {
              title: 'Escalation — human review needed',
              summary: `Adjudication could not auto-resolve (readiness ${Math.round(report.readiness * 100)}%)`,
              priority: 'high',
              warnings_count: report.warnings.length,
              deep_link: deepLink,
              report_id: report.id,
            },
            gap_or_warning_id: 'report',
          });
        }
        break;
      }
    }

    return specs;
  }

  private notifyOpsSpec(
    report: AdjudicationReport,
    routing: RoutingContext,
    deepLink: string,
  ): ActionSpec {
    return {
      kind: 'notify_ops',
      target_kind: 'in_app_user',
      target_value: routing.ops_head_user_id ?? '00000000-0000-0000-0000-000000000000',
      target_user_id: routing.ops_head_user_id,
      payload: {
        title:
          report.recommended_action === 'file_now'
            ? 'Ready to file'
            : 'Review needed',
        summary: `Adjudication ${report.recommended_action} (readiness ${Math.round(report.readiness * 100)}%)`,
        deep_link: deepLink,
        report_id: report.id,
      },
      gap_or_warning_id: 'report',
    };
  }

  /**
   * Look up the panel WhatsApp group + a sensible fallback in-app user for
   * this claim. We deliberately accept "no row found" silently (the
   * planner downgrades the spec set accordingly).
   *
   * For v1 the in-app fallback is the first hospital_users row with a role
   * containing 'admin' or 'superadmin' — i.e. one of the hospital's
   * superadmins. Revisit once we have a dedicated approver/ops role table.
   */
  private async loadRouting(
    claimId: string,
    hospitalId: string,
  ): Promise<RoutingContext> {
    const ctx: RoutingContext = {
      hospital_id: hospitalId,
      whatsapp_group_id: null,
      panel_name: null,
      ops_head_user_id: null,
      approver_user_id: null,
    };

    // Panel WhatsApp group for this claim.
    const panelRes = await this.pool.query<{
      whatsapp_group_id: string | null;
      panel_name: string | null;
    }>(
      `SELECT hp.whatsapp_group_id, p.name AS panel_name
         FROM hospital.ipds i
         LEFT JOIN hospital.hospital_panels hp ON hp.id = i.hospital_panel_id
         LEFT JOIN hospital.panels p ON p.id = hp.panel_id
        WHERE i.id = $1`,
      [claimId],
    );
    if (panelRes.rows.length > 0) {
      const row = panelRes.rows[0]!;
      ctx.whatsapp_group_id = row.whatsapp_group_id;
      ctx.panel_name = row.panel_name;
    }

    // Ops head / approver: first admin user for the hospital.
    const userRes = await this.pool.query<{ user_id: string }>(
      `SELECT user_id
         FROM hospital.hospital_users
        WHERE hospital_id = $1
          AND ('admin' = ANY(role) OR 'superadmin' = ANY(role))
        ORDER BY user_id
        LIMIT 1`,
      [hospitalId],
    );
    if (userRes.rows.length > 0) {
      ctx.ops_head_user_id = userRes.rows[0]!.user_id;
      ctx.approver_user_id = userRes.rows[0]!.user_id; // v1: same person
    }

    return ctx;
  }
}

interface RoutingContext {
  hospital_id: string;
  whatsapp_group_id: string | null;
  panel_name: string | null;
  ops_head_user_id: string | null;
  approver_user_id: string | null;
}

/**
 * Deterministic dedup key. SHA-256 truncated to 64 hex chars — well inside
 * the VARCHAR(128) column. Including kind + target_value keeps "same gap,
 * two transports" as two distinct actions (we WANT both the WhatsApp ping
 * and the in-app card to exist).
 */
function computeIdempotencyKey(
  claim_id: string,
  kind: string,
  target_value: string,
  gap_or_warning_id: string,
): string {
  return createHash('sha256')
    .update(`${claim_id}|${kind}|${target_value}|${gap_or_warning_id}`)
    .digest('hex')
    .slice(0, 64);
}

export const actionEngine = new ActionEngine();

// Re-exported so tests can assert on it without re-implementing.
export { computeIdempotencyKey };

/**
 * Convert a Wave 11 ActionTemplate into an ActionSpec consumable by the
 * existing planAndDispatch INSERT loop. Drops templates whose target_value
 * couldn't be resolved by the templating service (we'd insert a row that
 * the dispatcher can't deliver).
 *
 * ActionEngine still owns the idempotency hashing — we pass the rule_id
 * (or first idempotency_dimension) as the gap_or_warning_id so the
 * existing UNIQUE constraint stays meaningful.
 */
function actionTemplateToSpec(
  tpl: ActionTemplate,
  report: AdjudicationReport,
): ActionSpec | null {
  if (!tpl.target_value) return null;
  // request_doc / notify_ops / approval_request map 1:1 to ActionSpec kinds.
  // rule_clarification is a Wave 11 introduction — kept distinct so the FE
  // can render it differently. Persisted as-is in claim_actions.kind.
  const kind = tpl.kind as ActionSpec['kind'];
  const idemSeed =
    tpl.metadata.source_rule_id ?? tpl.idempotency_dimensions[0] ?? 'rule';
  return {
    kind,
    target_kind: tpl.target_kind,
    target_value: tpl.target_value,
    target_user_id: tpl.target_user_id,
    payload: {
      title: tpl.title,
      summary: tpl.summary,
      deep_link: tpl.deep_link ?? null,
      priority: tpl.priority,
      source_rule_id: tpl.metadata.source_rule_id,
      source_rule_set_id: tpl.metadata.source_rule_set_id,
      query_template: tpl.metadata.query_template,
      required_documents: tpl.metadata.required_documents ?? [],
      estimated_deduction_amount: tpl.metadata.estimated_deduction_amount,
      severity: tpl.metadata.severity,
      impact: tpl.metadata.impact,
      panel_name: tpl.metadata.panel_name ?? null,
      report_id: report.id,
    },
    gap_or_warning_id: idemSeed,
  };
}
