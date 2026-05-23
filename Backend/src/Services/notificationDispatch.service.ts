import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import UltraMsgService from './ultraMsg.service.js';

/**
 * Notification Dispatch Service
 *
 * Fired when an emails_inbound row gets matched to an IPD. Composes the
 * notification using the rule-based classifier's `action` text so the
 * message is specific instead of generic.
 *
 * Submission status cascade: maps classification → submission status so
 * the IPD's Filings tab badge reflects what happened.
 *   approval     → 'approved'
 *   rejection    → 'rejected'
 *   query        → 'queried'
 *   settlement   → 'approved' (settlement implies prior approval; we
 *                  don't yet track a separate settlement state at submission level)
 *   ack | other  → no change (submission stays 'sent')
 */

interface DispatchResult {
  whatsapp_sent: boolean;
  whatsapp_group_id?: string;
  whatsapp_error?: string;
  status_cascaded?: string;
}

class NotificationDispatchService {
  async dispatchInboundRevert(inboundId: string): Promise<DispatchResult> {
    const result: DispatchResult = { whatsapp_sent: false };

    // WhatsApp group is per (hospital × panel) — bigger hospitals run separate
    // groups per insurer/TPA, so the dispatcher stays strictly panel-scoped.
    // Augment with attachment_count so the message can flag when an insurer
    // sent a document worth opening.
    const dataRes = await pool.query(
      `SELECT
         ei.id, ei.hospital_id, ei.from_address, ei.subject, ei.body_text,
         ei.received_at, ei.match_method,
         ei.matched_ipd_id, ei.matched_submission_id, ei.hospital_panel_id,
         ei.classification, ei.parsed_payload,
         hp.whatsapp_group_id,
         p.name AS panel_name, p.code AS panel_code,
         i.first_name, i.last_name, i.id AS patient_uhid, i.stage AS ipd_stage,
         (SELECT COUNT(*)::int FROM jsonb_array_elements(COALESCE(ei.attachments, '[]'::jsonb))) AS attachment_count,
         ps.external_claim_id, ps.status AS submission_status
       FROM hospital.emails_inbound ei
       LEFT JOIN hospital.hospital_panels hp ON hp.id = ei.hospital_panel_id
       LEFT JOIN hospital.panels p ON p.id = hp.panel_id
       LEFT JOIN hospital.ipds i ON i.id = ei.matched_ipd_id
       LEFT JOIN hospital.insurance_submissions ps ON ps.id = ei.matched_submission_id
       WHERE ei.id = $1`,
      [inboundId]
    );

    if ((dataRes.rowCount ?? 0) === 0) {
      logger.warn({ inboundId }, 'dispatchInboundRevert: row not found');
      return result;
    }
    const row = dataRes.rows[0]!;

    if (!row.matched_ipd_id) {
      logger.info(
        { inboundId },
        'dispatchInboundRevert: unmatched inbound; nothing to dispatch'
      );
      return result;
    }

    const patientName =
      `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'patient';
    const action = row.parsed_payload?.action ?? 'Reply received — please open and review';
    const classification = row.classification ?? 'received';
    const subjectSnippet = (row.subject ?? '').slice(0, 100);
    const bodySnippet = (row.body_text ?? '').replace(/\s+/g, ' ').slice(0, 220);
    const attachmentCount: number = Number(row.attachment_count ?? 0);
    // Short UHID for human readability; the full UUID is in the deep link below.
    const shortUhid = (row.patient_uhid as string | undefined)?.slice(0, 8) ?? '—';

    const classificationEmoji = ({
      approval: '✅',
      rejection: '❌',
      query: '🟡',
      settlement: '💰',
      ack: '📨',
      other: '🔔',
      received: '🔔',
    } as Record<string, string>)[classification] ?? '🔔';

    // Deep link straight to the patient's Filings & Communications tab.
    // FRONTEND_URL is already configured (set during the cashless OAuth setup);
    // falls back gracefully if not.
    const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const deepLink = frontendUrl && row.hospital_id && row.matched_ipd_id
      ? `${frontendUrl}/portal/${row.hospital_id}/patient/${row.matched_ipd_id}`
      : null;

    const messageBody = [
      `${classificationEmoji} *${this.titleForClassification(classification, row.ipd_stage)}*`,
      `*Panel:* ${row.panel_name ?? row.panel_code ?? '—'}`,
      ``,
      `*Patient:* ${patientName}  _(UHID ${shortUhid})_`,
      row.external_claim_id ? `*Claim Ref:* ${row.external_claim_id}` : null,
      `*From:* ${row.from_address}`,
      attachmentCount > 0
        ? `*Attachments:* 📎 ${attachmentCount} file${attachmentCount === 1 ? '' : 's'} auto-saved to patient documents`
        : null,
      ``,
      `*Next step:* ${action}`,
      ``,
      `_Subject:_ ${subjectSnippet}`,
      bodySnippet ? `_Preview:_ ${bodySnippet}${bodySnippet.length >= 220 ? '…' : ''}` : null,
      ``,
      deepLink ? `Open in ClaimOS → ${deepLink}` : `Open the claim in ClaimOS to review and respond.`,
    ]
      .filter(Boolean)
      .join('\n');

    // WhatsApp dispatch (only if hospital_panels.whatsapp_group_id is set)
    if (row.whatsapp_group_id) {
      try {
        await UltraMsgService.sendMessage(row.whatsapp_group_id, messageBody);
        result.whatsapp_sent = true;
        result.whatsapp_group_id = row.whatsapp_group_id;
        logger.info(
          {
            inboundId,
            whatsappGroupId: row.whatsapp_group_id,
            classification,
            patientUhid: row.patient_uhid,
          },
          'whatsapp notification sent'
        );
      } catch (err) {
        result.whatsapp_error = (err as Error).message;
        logger.error({ err, inboundId }, 'whatsapp send failed');
      }
    }

    // INTENTIONALLY NOT cascading submission status from the rule-based
    // classifier. Keyword matches are too noisy (e.g. body containing
    // "kindly approve" trips the approval classifier) and produce factually
    // wrong status flips in the UI. The classifier output stays in
    // emails_inbound.classification + parsed_payload for downstream features
    // (analytics, future LLM training set), but the submission stays in
    // 'sent' state until a real LLM-driven classifier ships in Phase 2.

    return result;
  }

  private titleForClassification(
    classification: string,
    ipdStage?: string | null,
  ): string {
    // Pick the base title from classification, then prefix with the IPD's
    // current lifecycle stage so the title is unambiguous about *what was
    // approved/queried*. Examples:
    //   stage='Pre-auth Submitted' + classification='approval'    → "Pre-auth — Approved"
    //   stage='Discharge Submitted' + classification='approval'   → "Discharge — Approved"
    //   stage='Claim Filed' + classification='query'              → "Claim — Query (Action Required)"
    const base = (() => {
      switch (classification) {
        case 'approval':   return 'Approved';
        case 'rejection':  return 'Rejected';
        case 'query':      return 'Query (Action Required)';
        case 'settlement': return 'Settlement';
        case 'ack':        return 'Acknowledged';
        default:           return 'Reply';
      }
    })();
    if (!ipdStage) return `Insurer ${base}`;
    // Derive a short stage prefix from the lifecycle label.
    // "Pre-auth Submitted" → "Pre-auth"; "Discharge Approved" → "Discharge";
    // "Claim Filed" → "Claim"; falls back to full label if no known prefix.
    const stagePrefix = (() => {
      const s = ipdStage.toLowerCase();
      if (s.startsWith('pre-auth'))    return 'Pre-auth';
      if (s.startsWith('enhancement')) return 'Enhancement';
      if (s.startsWith('discharge'))   return 'Discharge';
      if (s.startsWith('claim'))       return 'Claim';
      if (s === 'admitted')            return 'Admitted';
      if (s === 'discharged')          return 'Post-discharge';
      if (s === 'draft')               return 'Pre-auth'; // first stage; insurer reply is almost always pre-auth
      return ipdStage; // unknown stage label — pass through
    })();
    return `${stagePrefix} — ${base}`;
  }
}

export default new NotificationDispatchService();
