/**
 * Sprint Intelligence Layer, Wave 11 — Action Templating Service.
 *
 * Bridges Wave 8's rich rule-evaluation rows (`hospital.claim_rule_evaluations`
 * JOIN `hospital.insurance_rules`) into operator-ready action templates that
 * the Wave 3C ActionEngine then persists + dispatches.
 *
 * Two entry points:
 *
 *   deriveFromRulesEvaluation(claim_id)
 *     — preferred path. Every failed rule for the claim becomes one
 *       ActionTemplate, routed by (severity, impact) and rendered against
 *       a claim context (harmonised episode if present, otherwise dossier
 *       patient_summary + ipds row). The strings come from the rule's
 *       `query_template`, `failure_message`, and `remediation_guidance`
 *       columns — i.e. content authored by clinical / panel ops, not
 *       hard-coded in the engine.
 *
 *   deriveFromAdjudicationReport(report)
 *     — fallback path for claims without Wave 8 rule evaluations (no rule
 *       set matched, harmonisation not yet run, or pre-Wave 8 backlog).
 *       Mirrors the original Wave 3C generic mapping, refactored here for
 *       a single place to look.
 *
 * The actual INSERT into `hospital.claim_actions` and the WhatsApp / in-app
 * dispatch still live in ActionEngine + actionEngine.queue.ts. This service
 * is pure templating + routing planning.
 */

import type { Pool } from 'pg';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import { harmonisationService, type HarmonisationService } from './harmonisation.service.js';
import { render as renderTemplate } from './rules/templateRenderer.js';
import type {
  AdjudicationReport,
} from './actionEngine.service.js';

// ─── Public types ─────────────────────────────────────────────────────────

export type ActionTemplateKind =
  | 'request_doc'
  | 'notify_ops'
  | 'approval_request'
  | 'rule_clarification';

export type ActionTargetKind =
  | 'whatsapp_group'
  | 'whatsapp_user'
  | 'in_app_user'
  | 'in_app_role';

export type ActionPriority = 'critical' | 'high' | 'normal' | 'low';

export interface ActionTemplate {
  kind: ActionTemplateKind;
  target_kind: ActionTargetKind;
  /** Resolved when known (UUID for in-app, JID for whatsapp). May be empty
   *  when the routing context is missing — caller decides what to do. */
  target_value: string;
  /** Same as target_value when target is a user; null otherwise. */
  target_user_id: string | null;
  title: string;
  summary: string;
  deep_link?: string;
  priority: ActionPriority;
  /** Component pieces used to build the idempotency hash. ActionEngine
   *  derives the final key from these + claim_id. */
  idempotency_dimensions: string[];
  metadata: {
    source_rule_id?: string;
    source_rule_set_id?: string;
    estimated_deduction_amount?: number;
    required_documents?: string[];
    query_template?: string;
    severity?: string;
    impact?: string;
    panel_name?: string | null;
  };
}

export interface ActionTemplatingDeps {
  pool?: Pick<Pool, 'query'>;
  harmonisation?: Pick<HarmonisationService, 'getEpisode'>;
}

// Routing context — duplicated from ActionEngine.RoutingContext (private
// there) so this service doesn't reach into the other service's internals.
interface RoutingContext {
  hospital_id: string | null;
  whatsapp_group_id: string | null;
  panel_name: string | null;
  ops_head_user_id: string | null;
  approver_user_id: string | null;
  clinical_user_id: string | null;
}

// Row shape after JOIN of claim_rule_evaluations × insurance_rules.
interface FailedRuleRow {
  rule_evaluation_id: string;
  rule_set_id: string;
  rule_id: string;
  rule_name: string | null;
  severity: string;
  impact: string;
  message: string | null;
  evidence: any;
  deduction_estimate: number | null;
  failure_message: string | null;
  remediation_guidance: string | null;
  required_documents: string[];
  estimated_deduction_amount: number | null;
  query_template: string | null;
}

interface ClaimRenderContext {
  patient_name: string | null;
  uhid: string | null;
  insurer_name: string | null;
  procedure: string | null;
  hospital_id: string | null;
  required_docs: string[];
  deduction_amount: number | null;
  rule_name: string | null;
  rule_id: string | null;
  panel_name: string | null;
  // Pass-throughs for templates authored against the harmonised episode.
  episode?: any;
}

// ─── Service ──────────────────────────────────────────────────────────────

export class ActionTemplatingService {
  private readonly pool: Pick<Pool, 'query'>;
  private readonly harmonisation: Pick<HarmonisationService, 'getEpisode'>;

  constructor(deps: ActionTemplatingDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
    this.harmonisation = deps.harmonisation ?? harmonisationService;
  }

  /**
   * Build ActionTemplates from each failed rule on a claim. Returns [] when
   * the claim has no FAIL rows yet — callers should fall back to the
   * adjudication-report path.
   */
  async deriveFromRulesEvaluation(claim_id: string): Promise<ActionTemplate[]> {
    const failed = await this.loadFailedRules(claim_id);
    if (failed.length === 0) return [];

    const routing = await this.loadRouting(claim_id);
    const context = await this.loadClaimContext(claim_id);

    const deepLink = routing.hospital_id
      ? `/hospital/${routing.hospital_id}/patients/${claim_id}`
      : `/patients/${claim_id}`;

    const templates: ActionTemplate[] = [];
    for (const rule of failed) {
      const tpl = this.mapRuleToTemplate(rule, routing, context, deepLink);
      if (tpl) templates.push(tpl);
    }
    return templates;
  }

  /**
   * Generic fallback — refactored from Wave 3C's hard-coded mapping in
   * ActionEngine.planActions(). Returns templates parametrised by the
   * adjudication recommended_action + blocking gaps. Kept lean: this path
   * is only exercised when Wave 8 rules haven't fired yet for a claim.
   */
  async deriveFromAdjudicationReport(
    report: AdjudicationReport,
    hospital_id?: string,
  ): Promise<ActionTemplate[]> {
    const routing = await this.loadRouting(report.claim_id, hospital_id);
    const deepLink = `/hospital/${routing.hospital_id ?? hospital_id ?? ''}/patients/${report.claim_id}`;
    const out: ActionTemplate[] = [];

    switch (report.recommended_action) {
      case 'request_doc': {
        const gaps = report.blocking_gaps ?? [];
        if (gaps.length === 0) {
          if (routing.ops_head_user_id) {
            out.push(genericReviewTemplate(report, routing, deepLink, 'normal'));
          }
          break;
        }
        for (const gap of gaps) {
          const title = `Document required — ${gap.doc_category ?? gap.field ?? 'evidence'}`;
          if (routing.whatsapp_group_id) {
            out.push({
              kind: 'request_doc',
              target_kind: 'whatsapp_group',
              target_value: routing.whatsapp_group_id,
              target_user_id: null,
              title,
              summary: gap.message,
              deep_link: deepLink,
              priority: 'high',
              idempotency_dimensions: [report.claim_id, 'request_doc', 'whatsapp_group', routing.whatsapp_group_id, gap.id],
              metadata: { panel_name: routing.panel_name },
            });
          } else if (routing.ops_head_user_id) {
            out.push({
              kind: 'request_doc',
              target_kind: 'in_app_user',
              target_value: routing.ops_head_user_id,
              target_user_id: routing.ops_head_user_id,
              title,
              summary: gap.message,
              deep_link: deepLink,
              priority: 'high',
              idempotency_dimensions: [report.claim_id, 'request_doc', 'in_app_user', routing.ops_head_user_id, gap.id],
              metadata: {},
            });
          }
        }
        break;
      }
      case 'approval_request': {
        const approverId = routing.approver_user_id ?? routing.ops_head_user_id;
        if (approverId) {
          out.push({
            kind: 'approval_request',
            target_kind: 'in_app_user',
            target_value: approverId,
            target_user_id: approverId,
            title: 'Approval requested',
            summary: `Adjudication readiness ${Math.round(report.readiness * 100)}%`,
            deep_link: deepLink,
            priority: 'critical',
            idempotency_dimensions: [report.claim_id, 'approval_request', 'in_app_user', approverId, 'report'],
            metadata: {},
          });
        }
        if (routing.whatsapp_group_id) {
          out.push({
            kind: 'approval_request',
            target_kind: 'whatsapp_group',
            target_value: routing.whatsapp_group_id,
            target_user_id: null,
            title: 'Approval requested',
            summary: `Claim ready — readiness ${Math.round(report.readiness * 100)}%`,
            deep_link: deepLink,
            priority: 'critical',
            idempotency_dimensions: [report.claim_id, 'approval_request', 'whatsapp_group', routing.whatsapp_group_id, 'report'],
            metadata: { panel_name: routing.panel_name },
          });
        }
        break;
      }
      case 'escalate_to_human':
      case 'review':
      case 'file_now':
      default: {
        if (routing.ops_head_user_id) {
          out.push(genericReviewTemplate(report, routing, deepLink,
            report.recommended_action === 'escalate_to_human' ? 'high' : 'normal'));
        }
        break;
      }
    }
    return out;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private mapRuleToTemplate(
    rule: FailedRuleRow,
    routing: RoutingContext,
    context: ClaimRenderContext,
    deepLink: string,
  ): ActionTemplate | null {
    const severity = (rule.severity ?? '').toUpperCase();
    const impact = (rule.impact ?? '').toUpperCase();

    // Per-rule context: extend the claim-wide context with the rule's own
    // bits (required_docs override, deduction estimate).
    const renderCtx: ClaimRenderContext = {
      ...context,
      required_docs: rule.required_documents ?? context.required_docs,
      deduction_amount: rule.estimated_deduction_amount ?? context.deduction_amount,
      rule_name: rule.rule_name,
      rule_id: rule.rule_id,
    };

    // 1. Decide kind / target / priority.
    let kind: ActionTemplateKind;
    let target_kind: ActionTargetKind;
    let target_value = '';
    let target_user_id: string | null = null;
    let priority: ActionPriority;

    if (severity === 'CRITICAL' || impact === 'CLAIM_REJECTION') {
      kind = 'approval_request';
      target_kind = 'in_app_user';
      const approverId = routing.approver_user_id ?? routing.ops_head_user_id;
      if (!approverId) return null;
      target_value = approverId;
      target_user_id = approverId;
      priority = 'critical';
    } else if (impact === 'QUERY' && (rule.required_documents?.length ?? 0) > 0) {
      kind = 'request_doc';
      if (routing.whatsapp_group_id) {
        target_kind = 'whatsapp_group';
        target_value = routing.whatsapp_group_id;
      } else if (routing.clinical_user_id ?? routing.ops_head_user_id) {
        target_kind = 'in_app_user';
        target_value = (routing.clinical_user_id ?? routing.ops_head_user_id)!;
        target_user_id = target_value;
      } else {
        return null;
      }
      priority = 'high';
    } else if (impact === 'DEDUCTION' && (rule.estimated_deduction_amount ?? 0) > 0) {
      kind = 'approval_request';
      target_kind = 'in_app_user';
      const approverId = routing.approver_user_id ?? routing.ops_head_user_id;
      if (!approverId) return null;
      target_value = approverId;
      target_user_id = approverId;
      priority = 'high';
    } else if (impact === 'WARNING' || impact === 'INFO') {
      kind = 'notify_ops';
      target_kind = 'in_app_user';
      const opsId = routing.ops_head_user_id;
      if (!opsId) return null;
      target_value = opsId;
      target_user_id = opsId;
      priority = 'normal';
    } else {
      // Default — surface as ops notification on the in-app inbox.
      kind = 'rule_clarification';
      target_kind = 'in_app_user';
      const opsId = routing.ops_head_user_id;
      if (!opsId) return null;
      target_value = opsId;
      target_user_id = opsId;
      priority = 'normal';
    }

    // 2. Render strings. WhatsApp uses query_template (insurer-voice); in-app
    //    cards use failure_message + remediation_guidance (operator-voice).
    let title: string;
    let summary: string;
    if (target_kind === 'whatsapp_group' || target_kind === 'whatsapp_user') {
      title = rule.rule_name ?? 'Insurer query';
      const baseQ = rule.query_template ?? rule.failure_message ?? '';
      summary = renderTemplate(baseQ, renderCtx as unknown as Record<string, any>);
      if (!summary && rule.remediation_guidance) {
        summary = renderTemplate(rule.remediation_guidance, renderCtx as unknown as Record<string, any>);
      }
    } else {
      title = rule.rule_name ?? rule.failure_message ?? 'Rule failure';
      const msg = rule.failure_message ?? rule.message ?? '';
      const guidance = rule.remediation_guidance ?? '';
      const parts: string[] = [];
      const renderedMsg = renderTemplate(msg, renderCtx as unknown as Record<string, any>);
      if (renderedMsg) parts.push(renderedMsg);
      const renderedGuide = renderTemplate(guidance, renderCtx as unknown as Record<string, any>);
      if (renderedGuide) parts.push(renderedGuide);
      summary = parts.join('\n\n');
    }

    return {
      kind,
      target_kind,
      target_value,
      target_user_id,
      title,
      summary,
      deep_link: deepLink,
      priority,
      idempotency_dimensions: [
        renderCtx.rule_id ?? rule.rule_id,
        'rule',
        target_kind,
        target_value,
      ],
      metadata: {
        source_rule_id: rule.rule_id,
        source_rule_set_id: rule.rule_set_id,
        estimated_deduction_amount: rule.estimated_deduction_amount ?? undefined,
        required_documents: rule.required_documents,
        query_template: rule.query_template ?? undefined,
        severity,
        impact,
        panel_name: routing.panel_name,
      },
    };
  }

  // ─── Loaders ─────────────────────────────────────────────────────────────

  private async loadFailedRules(claim_id: string): Promise<FailedRuleRow[]> {
    try {
      const res = await this.pool.query(
        `SELECT cre.id              AS rule_evaluation_id,
                cre.rule_set_id     AS rule_set_id,
                cre.rule_id         AS rule_id,
                cre.severity        AS severity,
                cre.impact          AS impact,
                cre.message         AS message,
                cre.evidence        AS evidence,
                cre.deduction_estimate AS deduction_estimate,
                ir.rule_name        AS rule_name,
                ir.failure_message  AS failure_message,
                ir.remediation_guidance AS remediation_guidance,
                ir.required_documents AS required_documents,
                ir.estimated_deduction_amount AS estimated_deduction_amount,
                ir.query_template   AS query_template
           FROM hospital.claim_rule_evaluations cre
           LEFT JOIN hospital.insurance_rules ir
             ON ir.rule_set_id = cre.rule_set_id
            AND ir.rule_id = cre.rule_id
          WHERE cre.claim_id = $1
            AND cre.status = 'FAIL'
          ORDER BY ir.order_index ASC NULLS LAST, cre.rule_id ASC`,
        [claim_id],
      );
      return (res.rows ?? []).map((r: any) => ({
        rule_evaluation_id: r.rule_evaluation_id,
        rule_set_id: r.rule_set_id,
        rule_id: r.rule_id,
        rule_name: r.rule_name ?? null,
        severity: r.severity ?? 'MEDIUM',
        impact: r.impact ?? '',
        message: r.message ?? null,
        evidence: r.evidence ?? null,
        deduction_estimate:
          r.deduction_estimate != null ? Number(r.deduction_estimate) : null,
        failure_message: r.failure_message ?? null,
        remediation_guidance: r.remediation_guidance ?? null,
        required_documents: Array.isArray(r.required_documents) ? r.required_documents : [],
        estimated_deduction_amount:
          r.estimated_deduction_amount != null ? Number(r.estimated_deduction_amount) : null,
        query_template: r.query_template ?? null,
      })) as FailedRuleRow[];
    } catch (err) {
      // Most likely the table doesn't exist (pre-Wave 8 environment) — caller
      // will fall back to the report path.
      logger?.warn?.(
        '[actionTemplating] failed to load rule evaluations; falling back: ' +
          (err instanceof Error ? err.message : String(err)),
      );
      return [];
    }
  }

  private async loadRouting(
    claim_id: string,
    hospital_id_hint?: string,
  ): Promise<RoutingContext> {
    const ctx: RoutingContext = {
      hospital_id: hospital_id_hint ?? null,
      whatsapp_group_id: null,
      panel_name: null,
      ops_head_user_id: null,
      approver_user_id: null,
      clinical_user_id: null,
    };

    try {
      const panelRes = await this.pool.query(
        `SELECT i.hospital_id, hp.whatsapp_group_id, p.name AS panel_name
           FROM hospital.ipds i
           LEFT JOIN hospital.hospital_panels hp ON hp.id = i.hospital_panel_id
           LEFT JOIN hospital.panels p ON p.id = hp.panel_id
          WHERE i.id = $1`,
        [claim_id],
      );
      if ((panelRes.rows?.length ?? 0) > 0) {
        const row = panelRes.rows[0];
        ctx.hospital_id = ctx.hospital_id ?? row.hospital_id ?? null;
        ctx.whatsapp_group_id = row.whatsapp_group_id ?? null;
        ctx.panel_name = row.panel_name ?? null;
      }
    } catch (err) {
      logger?.warn?.('[actionTemplating] panel routing lookup failed: ' + (err instanceof Error ? err.message : String(err)));
    }

    if (ctx.hospital_id) {
      try {
        const userRes = await this.pool.query(
          `SELECT user_id, role
             FROM hospital.hospital_users
            WHERE hospital_id = $1
              AND ('admin' = ANY(role) OR 'superadmin' = ANY(role)
                   OR 'clinical' = ANY(role))
            ORDER BY user_id`,
          [ctx.hospital_id],
        );
        for (const row of userRes.rows ?? []) {
          const roles: string[] = row.role ?? [];
          if (!ctx.ops_head_user_id && (roles.includes('admin') || roles.includes('superadmin'))) {
            ctx.ops_head_user_id = row.user_id;
            ctx.approver_user_id = row.user_id;
          }
          if (!ctx.clinical_user_id && roles.includes('clinical')) {
            ctx.clinical_user_id = row.user_id;
          }
        }
      } catch (err) {
        logger?.warn?.('[actionTemplating] user routing lookup failed: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    return ctx;
  }

  /**
   * Build the render context used to fill `{{patient_name}}`, `{{uhid}}`,
   * `{{procedure}}`, etc. Tries the harmonised episode first (Wave 7 — has
   * normalised fields), then falls back to the dossier projection's
   * patient_summary and a direct ipds lookup.
   */
  private async loadClaimContext(claim_id: string): Promise<ClaimRenderContext> {
    const ctx: ClaimRenderContext = {
      patient_name: null,
      uhid: null,
      insurer_name: null,
      procedure: null,
      hospital_id: null,
      required_docs: [],
      deduction_amount: null,
      rule_name: null,
      rule_id: null,
      panel_name: null,
    };

    // Try harmonised episode.
    try {
      const ep = await this.harmonisation.getEpisode(claim_id);
      const e: any = ep?.episode ?? null;
      if (e) {
        ctx.episode = e;
        ctx.patient_name = e?.patient?.name ?? e?.demographics?.patient_name ?? null;
        ctx.uhid = e?.patient?.uhid ?? e?.demographics?.uhid ?? null;
        ctx.insurer_name = e?.coverage?.insurer ?? e?.hospital_context?.panel_name ?? null;
        ctx.procedure =
          e?.procedure?.primary_procedure ??
          e?.diagnosis?.primary_diagnosis ??
          e?.meta?.episode_subtype ??
          null;
      }
    } catch (err) {
      logger?.debug?.('[actionTemplating] harmonised episode lookup failed: ' + (err instanceof Error ? err.message : String(err)));
    }

    // Fall back to dossier + ipds.
    if (!ctx.patient_name || !ctx.uhid) {
      try {
        const res = await this.pool.query(
          `SELECT i.hospital_id,
                  i.patient_name AS ipd_patient_name,
                  i.uhid AS ipd_uhid,
                  cd.patient_summary,
                  p.name AS panel_name
             FROM hospital.ipds i
             LEFT JOIN hospital.claim_dossiers cd ON cd.claim_id = i.id
             LEFT JOIN hospital.hospital_panels hp ON hp.id = i.hospital_panel_id
             LEFT JOIN hospital.panels p ON p.id = hp.panel_id
            WHERE i.id = $1
            LIMIT 1`,
          [claim_id],
        );
        const row = res.rows?.[0];
        if (row) {
          ctx.hospital_id = ctx.hospital_id ?? row.hospital_id ?? null;
          const ps = row.patient_summary ?? {};
          ctx.patient_name = ctx.patient_name ?? ps.patient_name ?? row.ipd_patient_name ?? null;
          ctx.uhid = ctx.uhid ?? ps.uhid ?? row.ipd_uhid ?? null;
          ctx.insurer_name = ctx.insurer_name ?? row.panel_name ?? null;
          ctx.procedure = ctx.procedure ?? ps.procedure ?? ps.primary_procedure ?? null;
          ctx.panel_name = row.panel_name ?? null;
        }
      } catch (err) {
        logger?.debug?.('[actionTemplating] dossier/ipds fallback failed: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    return ctx;
  }
}

// ─── Helpers (module scope) ───────────────────────────────────────────────

function genericReviewTemplate(
  report: AdjudicationReport,
  routing: RoutingContext,
  deepLink: string,
  priority: ActionPriority,
): ActionTemplate {
  return {
    kind: 'notify_ops',
    target_kind: 'in_app_user',
    target_value: routing.ops_head_user_id ?? '',
    target_user_id: routing.ops_head_user_id,
    title:
      report.recommended_action === 'file_now'
        ? 'Ready to file'
        : report.recommended_action === 'escalate_to_human'
          ? 'Escalation — human review needed'
          : 'Review needed',
    summary: `Adjudication ${report.recommended_action} (readiness ${Math.round(report.readiness * 100)}%)`,
    deep_link: deepLink,
    priority,
    idempotency_dimensions: [report.claim_id, 'notify_ops', 'in_app_user', routing.ops_head_user_id ?? '', 'report'],
    metadata: {},
  };
}

export const actionTemplatingService = new ActionTemplatingService();
export default ActionTemplatingService;
