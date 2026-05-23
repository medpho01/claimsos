import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import apiError from '../Utils/errorHandler.util.js';
import { recordSubmissionEvent } from './submissionEvents.service.js';

/**
 * Pre-Auth Submission Service
 *
 * Orchestrates the "file claim" flow for an IPD. Channel depends on the
 * IPD's `claim_filing_route`:
 *   - 'cashless_everywhere' — file via email (this service handles it)
 *   - 'network'             — file via insurer portal RPA (not yet built)
 *
 * For cashless_everywhere route, this service:
 *   1. Pre-flight: validates Gmail connected + recipient emails configured
 *   2. Draft: composes the email preview (subject, body, attachments,
 *      auto-attached hospital docs + share link)
 *   3. Send: commits insurance_submissions + emails_outbound (queued)
 *
 * Pre-auth FORM filling is intentionally out of scope:
 *   - Hospital ops downloads the blank form (button on Filings tab),
 *     fills it manually + signs + scans it back
 *   - Uploads as a patient document (ipd_doc table)
 *   - Selects it in the Compose modal's document selector
 *   - It rides along as a normal attachment
 *
 * Threading: subsequent emails for the SAME IPD are sent as replies in
 * thread, not as fresh emails. The thread root is the first emails_outbound
 * row for the IPD; downstream messages pass its gmail_message_id +
 * gmail_thread_id as In-Reply-To / Thread-Id (handled by gmailSend).
 */

interface PreflightResult {
  ready: boolean;
  blockers: { code: string; message: string }[];
  filing_route?: 'cashless_everywhere' | 'network' | null;
  config?: ResolvedPanelConfig;
  gmailAddress?: string;
}

interface ResolvedPanelConfig {
  hospital_panel_id: string;
  panel_id: string;
  panel_name: string;
  panel_code: string;
  claim_submission_method: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject_template: string;
  planned_deadline_hours: number | null;
  emergency_deadline_hours: number | null;
}

interface AutoAttachment {
  filename: string;
  s3_key: string;
  mime_type: string;
  size_bytes: number;
  source: 'hospital_doc' | 'patient_doc';
  source_doc_id?: string;
}

interface DraftRequest {
  ipdId: string;
  hospitalId: string;
  initiatedBy: string;
  /** Optional pre-selection of patient documents (ipd_doc.id). Defaults to none. */
  selectedPatientDocIds?: string[];
}

interface DraftResponse {
  preview: {
    to: string[];
    cc: string[];
    subject: string;
    body_text: string;
    /** All attachments that will go out, including auto-attached hospital docs. */
    attachments: AutoAttachment[];
    /** Patient docs available for selection. UI renders this as the checkbox list. */
    available_patient_documents: {
      id: string;
      file_name: string | null;
      type: string | null;
      s3_key: string | null;
      mime_type: string | null;
      file_size: number | null;
      created_at: string;
      selected: boolean;
    }[];
    /** Hospital-profile docs that are auto-attached for cashless_everywhere. */
    auto_hospital_documents: AutoAttachment[];
    /** Share link included in the body for cashless_everywhere. */
    hospital_share_link?: string;
  };
  hospital_panel_id: string;
  is_threaded_reply: boolean;
  thread_subject_hint?: string;
}

interface SendRequest {
  ipdId: string;
  hospitalId: string;
  submittedBy: string;
  // Client-generated UUID per compose-modal-open. When the same key is seen
  // again (double-click, network retry), we return the existing submission
  // instead of creating a second one + a second email.
  idempotencyKey?: string;
  overrides?: {
    to?: string[];
    cc?: string[];
    subject?: string;
    body_text?: string;
    body_html?: string;
    selectedPatientDocIds?: string[];
  };
}

interface SendResult {
  insurance_submission_id: string;
  email_outbound_id: string;
  status: 'queued';
  is_threaded_reply: boolean;
  // True when this exact send request was already processed and we're
  // returning the prior result without doing anything new.
  idempotent_replay?: boolean;
}

class InsuranceSubmissionService {
  // -----------------------------------------------------------------
  // Pre-flight
  // -----------------------------------------------------------------

  async preflight(ipdId: string, hospitalId: string): Promise<PreflightResult> {
    const blockers: { code: string; message: string }[] = [];

    const ipdRes = await pool.query<{
      id: string;
      hospital_id: string;
      panel_id: string | null;
      hospital_panel_id: string | null;
      claim_filing_route: 'cashless_everywhere' | 'network' | null;
    }>(
      `SELECT i.id, i.hospital_id, i.panel_id, i.hospital_panel_id, i.claim_filing_route
         FROM hospital.ipds i
        WHERE i.id = $1 AND i.hospital_id = $2`,
      [ipdId, hospitalId]
    );
    if ((ipdRes.rowCount ?? 0) === 0) {
      throw new apiError(404, `IPD ${ipdId} not found for hospital`);
    }
    const ipd = ipdRes.rows[0]!;

    if (!ipd.hospital_panel_id) {
      blockers.push({
        code: 'no_panel_selected',
        message: 'Patient does not have an insurance panel selected',
      });
      return { ready: false, blockers };
    }

    // Filing route MUST be set for the service to know what to do
    if (!ipd.claim_filing_route) {
      blockers.push({
        code: 'no_filing_route',
        message:
          "Set this patient's filing route (Cashless Everywhere or Network) on the patient edit screen first.",
      });
      return { ready: false, blockers, filing_route: null };
    }

    // 'network' route is not implemented yet — return a structured blocker
    // so the UI can show "Coming Soon" instead of a generic error.
    if (ipd.claim_filing_route === 'network') {
      blockers.push({
        code: 'network_route_coming_soon',
        message:
          'Portal RPA for network-empanelled claims is not yet built. Please file manually for now.',
      });
      return { ready: false, blockers, filing_route: 'network' };
    }

    // From here on: cashless_everywhere route. The Gmail connection lives on
    // hospital.hospital_interfaces (kind='email'), per migration 023. The CEW
    // pseudo-panel was dropped entirely.
    const ifaceRes = await pool.query<{ id: string; gmail_address: string | null }>(
      `SELECT id, config->>'gmail_address' AS gmail_address
         FROM hospital.hospital_interfaces
        WHERE hospital_id = $1
          AND kind = 'email'
          AND secrets_encrypted IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [hospitalId]
    );
    if ((ifaceRes.rowCount ?? 0) === 0) {
      blockers.push({
        code: 'gmail_not_connected',
        message: 'Hospital Gmail account not connected for Cashless Everywhere',
      });
    }

    const config = await this.resolvePanelConfig(ipd.hospital_panel_id);
    if (config.claim_submission_method !== 'email') {
      blockers.push({
        code: 'panel_not_email_configured',
        message: `Panel uses '${config.claim_submission_method}' submission, not email`,
      });
    }
    if (config.to_addresses.length === 0) {
      blockers.push({
        code: 'no_recipient_emails',
        message: 'No "to" addresses configured for this panel',
      });
    }

    // From-line address — pulled from the interface row above.
    const gmailAddress: string | undefined =
      ifaceRes.rows[0]?.gmail_address ?? undefined;

    return {
      ready: blockers.length === 0,
      blockers,
      filing_route: ipd.claim_filing_route,
      config: blockers.length === 0 ? config : undefined,
      gmailAddress,
    };
  }

  private async resolvePanelConfig(hospitalPanelId: string): Promise<ResolvedPanelConfig> {
    const res = await pool.query(
      `SELECT
         hp.id AS hospital_panel_id,
         hp.panel_id,
         p.name AS panel_name,
         p.code AS panel_code,
         pa.attribute_key,
         pa.value_text,
         pa.value_json
       FROM hospital.hospital_panels hp
       JOIN hospital.panels p ON p.id = hp.panel_id
       LEFT JOIN hospital.panel_attributes pa ON pa.hospital_panel_id = hp.id
       WHERE hp.id = $1`,
      [hospitalPanelId]
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new apiError(404, `hospital_panel ${hospitalPanelId} not found`);
    }

    const first = res.rows[0]!;
    const attributes: Record<string, any> = {};
    for (const row of res.rows) {
      if (!row.attribute_key) continue;
      attributes[row.attribute_key] = row.value_text ?? row.value_json ?? null;
    }

    // Migration 026: renamed cashless_* → email_*, dropped duplicate claim_submission_email.
    // We accept the OLD keys too for back-compat in case the migration hasn't run
    // (dev parity). Once 026 is applied everywhere the fallbacks become no-ops.
    const toListRaw =
      attributes['email_to_list']
      ?? attributes['cashless_email_to_list']
      ?? attributes['claim_submission_email']
      ?? '';
    const ccListRaw =
      attributes['email_cc_list']
      ?? attributes['cashless_email_cc_list']
      ?? '';
    const toAddresses = toListRaw
      ? String(toListRaw).split(/[,;\n]/).map((s: string) => s.trim()).filter(Boolean)
      : [];
    const ccAddresses = ccListRaw
      ? String(ccListRaw).split(/[,;\n]/).map((s: string) => s.trim()).filter(Boolean)
      : [];

    return {
      hospital_panel_id: first.hospital_panel_id,
      panel_id: first.panel_id,
      panel_name: first.panel_name,
      panel_code: first.panel_code,
      claim_submission_method: attributes['claim_submission_method'] ?? 'email',
      to_addresses: toAddresses,
      cc_addresses: ccAddresses,
      subject_template:
        attributes['email_subject_template']
        ?? attributes['cashless_subject_template']
        ?? 'Pre-auth required for the patient {patient_name} with Patient UHID {patient_uhid}',
      planned_deadline_hours: this.parseInt(attributes['preauth_deadline_planned_hours']),
      emergency_deadline_hours: this.parseInt(attributes['preauth_deadline_emergency_hours']),
    };
  }

  private parseInt(raw: any): number | null {
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // -----------------------------------------------------------------
  // Context builder (used by subject + body template + attachments)
  // -----------------------------------------------------------------

  private async buildContext(ipdId: string, hospitalId: string): Promise<Record<string, any>> {
    const res = await pool.query(
      `SELECT
         i.id AS ipd_id,
         i.first_name, i.last_name, i.phone,
         i.admission_type, i.admitted_at, i.discharged_at,
         i.beneficiary_id, i.claim_filing_route,
         h.id AS h_id, h.name AS hospital_name, h.city AS hospital_city,
         p.id AS panel_id, p.name AS panel_name, p.code AS panel_code,
         hp.id AS hospital_panel_id, hp.contact AS hospital_panel_contact,
         hp.whatsapp_group_id
       FROM hospital.ipds i
       JOIN hospital.hospitals h ON h.id = i.hospital_id
       LEFT JOIN hospital.panels p ON p.id = i.panel_id
       LEFT JOIN hospital.hospital_panels hp ON hp.id = i.hospital_panel_id
       WHERE i.id = $1 AND i.hospital_id = $2`,
      [ipdId, hospitalId]
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new apiError(404, 'IPD not found for context');
    }
    const row = res.rows[0]!;

    return {
      patient: {
        uhid: row.ipd_id,        // patient UHID = ipd_id in our system (per spec)
        full_name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
        first_name: row.first_name,
        last_name: row.last_name,
        phone: row.phone,
        member_id: row.beneficiary_id,
      },
      ipd: {
        admitted_at: row.admitted_at,
        admission_type: row.admission_type,
        discharged_at: row.discharged_at,
        filing_route: row.claim_filing_route,
      },
      hospital: {
        id: row.h_id,
        name: row.hospital_name,
        city: row.hospital_city,
      },
      panel: {
        name: row.panel_name,
        code: row.panel_code,
        hospital_provider_code: row.hospital_panel_contact,
      },
    };
  }

  // -----------------------------------------------------------------
  // Subject + body templates
  // -----------------------------------------------------------------

  private renderTemplate(template: string, context: Record<string, any>): string {
    return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, path: string) => {
      const parts = path.split('.');
      let cur: any = context;
      for (const part of parts) {
        if (cur == null) return '';
        cur = cur[part];
      }
      if (cur == null) {
        // Convenience short keys
        if (path === 'patient_name') return context.patient?.full_name ?? '';
        if (path === 'patient_uhid') return context.patient?.uhid ?? '';
        if (path === 'hospital_name') return context.hospital?.name ?? '';
        if (path === 'panel_name') return context.panel?.name ?? '';
        if (path === 'policy_no') return context.patient?.member_id ?? '';
        return '';
      }
      return String(cur);
    });
  }

  private defaultBodyText(
    context: Record<string, any>,
    config: ResolvedPanelConfig,
    hospitalShareLink: string | null
  ): string {
    const lines: string[] = [
      `Dear ${config.panel_name} Team,`,
      ``,
      `Please find attached the pre-authorisation request for the following patient.`,
      ``,
      `Patient: ${context.patient?.full_name ?? ''}`,
      `Patient UHID: ${context.patient?.uhid ?? ''}`,
      `Hospital: ${context.hospital?.name ?? ''}`,
      `Admission Date: ${this.formatDate(context.ipd?.admitted_at)}`,
      `Admission Type: ${context.ipd?.admission_type ?? ''}`,
    ];

    if (hospitalShareLink) {
      lines.push(
        ``,
        `For hospital credentials, infrastructure details and compliance documents, please visit:`,
        hospitalShareLink
      );
    }

    lines.push(
      ``,
      `Kindly approve the pre-auth at the earliest. We will follow up if any documents are required.`,
      ``,
      `Regards,`,
      `${context.hospital?.name ?? 'Hospital'} Insurance Desk`
    );

    return lines.join('\n');
  }

  private formatDate(value: any): string {
    if (!value) return '';
    try {
      return new Date(value).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return String(value);
    }
  }

  // -----------------------------------------------------------------
  // Attachment resolution
  // -----------------------------------------------------------------

  /**
   * Fetch the IPD's documents — the user-selectable pool for compose.
   */
  private async listPatientDocs(ipdId: string) {
    const res = await pool.query(
      `SELECT id, file_name, type, s3_key, mime_type, file_size, created_at
         FROM hospital.ipd_doc
        WHERE ipd_id = $1
          AND s3_key IS NOT NULL
        ORDER BY created_at DESC`,
      [ipdId]
    );
    return res.rows;
  }

  /**
   * For cashless_everywhere route: auto-attach hospital-profile documents
   * configured by the hospital (hospital_doc table). Run idempotently;
   * docs without s3_key are skipped.
   */
  private async listHospitalDocs(hospitalId: string): Promise<AutoAttachment[]> {
    const res = await pool.query(
      `SELECT id, name, file_name, type, s3_key, mime_type, file_size
         FROM hospital.hospital_doc
        WHERE hospital_id = $1
          AND s3_key IS NOT NULL
        ORDER BY name NULLS LAST, type`,
      [hospitalId]
    );
    return res.rows.map(r => ({
      filename: r.file_name || r.name || `${r.type ?? 'hospital_doc'}.pdf`,
      s3_key: r.s3_key,
      mime_type: r.mime_type ?? 'application/pdf',
      size_bytes: r.file_size ?? 0,
      source: 'hospital_doc' as const,
      source_doc_id: r.id,
    }));
  }

  /**
   * Generate (or fetch) a publicly shareable URL for the hospital profile.
   * Tries to reuse an active token from public_share_tokens; falls back to
   * a generic profile URL if no token system is available.
   */
  private async resolveHospitalShareLink(hospitalId: string): Promise<string | null> {
    const base = process.env.FRONTEND_URL ?? '';
    try {
      // public_share_tokens is polymorphic (resource_type + resource_id);
      // hospital profiles use 'hospital_profile' resource_type.
      const existing = await pool.query<{ token: string }>(
        `SELECT token
           FROM hospital.public_share_tokens
          WHERE resource_type = 'hospital_profile'
            AND resource_id = $1
            AND is_active = TRUE
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY created_at DESC
          LIMIT 1`,
        [hospitalId]
      );
      if ((existing.rowCount ?? 0) > 0) {
        return `${base}/public-profile/${existing.rows[0]!.token}`;
      }
    } catch (err) {
      logger.warn(
        { err, hospitalId },
        'resolveHospitalShareLink: token lookup failed; falling back to profile URL'
      );
    }
    // Fallback when no public token exists: a profile URL that at least
    // shows hospital ops "this is where the link would go." Hospital admin
    // should generate a real share token from the Profile screen to get a
    // genuinely public URL.
    return base ? `${base}/portal/${hospitalId}/profile` : null;
  }

  /**
   * Look up the user-selected patient docs and turn them into attachment entries.
   */
  private async resolveSelectedPatientDocs(
    ipdId: string,
    selectedIds: string[]
  ): Promise<AutoAttachment[]> {
    if (selectedIds.length === 0) return [];
    const res = await pool.query(
      `SELECT id, file_name, type, s3_key, mime_type, file_size
         FROM hospital.ipd_doc
        WHERE ipd_id = $1
          AND id = ANY($2::uuid[])
          AND s3_key IS NOT NULL`,
      [ipdId, selectedIds]
    );
    return res.rows.map(r => ({
      filename: r.file_name || `${r.type ?? 'patient_doc'}_${r.id.slice(0, 8)}.pdf`,
      s3_key: r.s3_key,
      mime_type: r.mime_type ?? 'application/pdf',
      size_bytes: r.file_size ?? 0,
      source: 'patient_doc' as const,
      source_doc_id: r.id,
    }));
  }

  // -----------------------------------------------------------------
  // Threading lookup
  // -----------------------------------------------------------------

  /**
   * Gmail thread IDs are 16-char hex strings. Validate before passing to
   * Gmail's send API — anything else (synthetic test data, broken state)
   * triggers "Invalid thread_id value" and bounces the send.
   */
  private isGmailThreadId(id: string | null | undefined): id is string {
    return typeof id === 'string' && /^[0-9a-f]{8,32}$/i.test(id);
  }

  /**
   * For threading: find the latest gmail_message_id + thread_id for this
   * IPD across BOTH outbound (sent) and inbound (received) emails, so the
   * next outbound becomes a reply in-thread instead of a fresh email.
   */
  private async findThreadHandle(ipdId: string): Promise<{
    messageIdHeader: string | null;
    threadId: string | null;
    referencesHeader: string | null;
  }> {
    // Latest outbound with a captured message id
    const ob = await pool.query<{
      gmail_message_id: string;
      gmail_thread_id: string | null;
      references_header: string | null;
      sent_at: Date;
    }>(
      `SELECT gmail_message_id, gmail_thread_id, references_header, sent_at
         FROM hospital.emails_outbound
        WHERE ipd_id = $1 AND gmail_message_id IS NOT NULL
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 1`,
      [ipdId]
    );
    // Latest inbound matched to this IPD
    const ib = await pool.query<{
      gmail_message_id: string;
      gmail_thread_id: string | null;
      references_header: string | null;
      received_at: Date;
    }>(
      `SELECT gmail_message_id, gmail_thread_id, references_header, received_at
         FROM hospital.emails_inbound
        WHERE matched_ipd_id = $1
        ORDER BY received_at DESC
        LIMIT 1`,
      [ipdId]
    );

    const candidates: Array<{
      ts: number;
      messageId: string;
      threadId: string | null;
      refs: string | null;
    }> = [];
    if (ob.rowCount && ob.rowCount > 0) {
      candidates.push({
        ts: ob.rows[0]!.sent_at?.getTime() ?? 0,
        messageId: ob.rows[0]!.gmail_message_id,
        threadId: ob.rows[0]!.gmail_thread_id,
        refs: ob.rows[0]!.references_header,
      });
    }
    if (ib.rowCount && ib.rowCount > 0) {
      candidates.push({
        ts: ib.rows[0]!.received_at?.getTime() ?? 0,
        messageId: ib.rows[0]!.gmail_message_id,
        threadId: ib.rows[0]!.gmail_thread_id,
        refs: ib.rows[0]!.references_header,
      });
    }
    if (candidates.length === 0) {
      return { messageIdHeader: null, threadId: null, referencesHeader: null };
    }
    candidates.sort((a, b) => b.ts - a.ts);
    const latest = candidates[0]!;
    // Build References chain: prepend prior refs, append the message we're replying to
    const newRefs = (latest.refs ? latest.refs + ' ' : '') + latest.messageId;
    // Only pass a Gmail thread_id if it looks like a real Gmail thread ID.
    // Synthetic / placeholder values (e.g. 'thread-xxxx') trigger Gmail's
    // "Invalid thread_id value" error and break the send.
    const safeThreadId = this.isGmailThreadId(latest.threadId) ? latest.threadId : null;
    return {
      messageIdHeader: latest.messageId,
      threadId: safeThreadId,
      referencesHeader: newRefs,
    };
  }

  // -----------------------------------------------------------------
  // Public: draft + send
  // -----------------------------------------------------------------

  async draft(req: DraftRequest): Promise<DraftResponse> {
    const preflight = await this.preflight(req.ipdId, req.hospitalId);
    if (!preflight.ready || !preflight.config) {
      throw new apiError(400, JSON.stringify({ blockers: preflight.blockers }));
    }
    const config = preflight.config;
    const context = await this.buildContext(req.ipdId, req.hospitalId);

    const shareLink = await this.resolveHospitalShareLink(req.hospitalId);
    const subject = this.renderTemplate(config.subject_template, context);
    const bodyText = this.defaultBodyText(context, config, shareLink);

    // Auto-attached hospital docs (for cashless_everywhere route always)
    const autoHospitalDocs = await this.listHospitalDocs(req.hospitalId);

    // User-selectable patient docs (caller may pre-select; default = none)
    const patientDocs = await this.listPatientDocs(req.ipdId);
    const selectedIds = new Set(req.selectedPatientDocIds ?? []);
    const selectedPatientAttachments = await this.resolveSelectedPatientDocs(
      req.ipdId,
      req.selectedPatientDocIds ?? []
    );

    const allAttachments = [...autoHospitalDocs, ...selectedPatientAttachments];

    // Thread handle (so the UI can show "this will reply in thread")
    const thread = await this.findThreadHandle(req.ipdId);
    const isThreadedReply = !!thread.messageIdHeader;

    return {
      preview: {
        to: config.to_addresses,
        cc: config.cc_addresses,
        subject: isThreadedReply ? this.replySubject(subject) : subject,
        body_text: bodyText,
        attachments: allAttachments,
        available_patient_documents: patientDocs.map(d => ({
          id: d.id,
          file_name: d.file_name,
          type: d.type,
          s3_key: d.s3_key,
          mime_type: d.mime_type,
          file_size: d.file_size,
          created_at: d.created_at,
          selected: selectedIds.has(d.id),
        })),
        auto_hospital_documents: autoHospitalDocs,
        hospital_share_link: shareLink ?? undefined,
      },
      hospital_panel_id: config.hospital_panel_id,
      is_threaded_reply: isThreadedReply,
      thread_subject_hint: isThreadedReply ? subject : undefined,
    };
  }

  private replySubject(subject: string): string {
    return /^re:\s/i.test(subject) ? subject : `Re: ${subject}`;
  }

  async send(req: SendRequest): Promise<SendResult> {
    // Idempotency check FIRST — before preflight, before any side effects.
    // If we've already processed this exact request, return the existing
    // submission without creating a second email.
    if (req.idempotencyKey) {
      const dupe = await pool.query<{
        id: string;
        email_outbound_id: string | null;
        status: string;
      }>(
        `SELECT id, email_outbound_id, status
           FROM hospital.insurance_submissions
          WHERE idempotency_key = $1
            AND hospital_id = $2
            AND ipd_id = $3`,
        [req.idempotencyKey, req.hospitalId, req.ipdId]
      );
      if (dupe.rowCount && dupe.rows[0]?.email_outbound_id) {
        logger.info(
          {
            idempotencyKey: req.idempotencyKey,
            submissionId: dupe.rows[0].id,
            outboundId: dupe.rows[0].email_outbound_id,
          },
          'idempotent replay — returning existing submission'
        );
        await recordSubmissionEvent({
          insuranceSubmissionId: dupe.rows[0].id,
          ipdId: req.ipdId,
          hospitalId: req.hospitalId,
          eventType: 'replayed',
          payload: { idempotency_key: req.idempotencyKey },
          actor: req.submittedBy,
        });
        return {
          insurance_submission_id: dupe.rows[0].id,
          email_outbound_id: dupe.rows[0].email_outbound_id,
          status: 'queued',
          is_threaded_reply: false,
          idempotent_replay: true,
        };
      }
    }

    const preflight = await this.preflight(req.ipdId, req.hospitalId);
    if (!preflight.ready || !preflight.config || !preflight.gmailAddress) {
      throw new apiError(400, JSON.stringify({ blockers: preflight.blockers }));
    }
    const config = preflight.config;
    const context = await this.buildContext(req.ipdId, req.hospitalId);

    const shareLink = await this.resolveHospitalShareLink(req.hospitalId);
    const renderedSubject = this.renderTemplate(config.subject_template, context);
    const bodyText = req.overrides?.body_text ?? this.defaultBodyText(context, config, shareLink);
    const bodyHtml = req.overrides?.body_html ?? null;
    const to = req.overrides?.to ?? config.to_addresses;
    const cc = req.overrides?.cc ?? config.cc_addresses;

    // Threading
    const thread = await this.findThreadHandle(req.ipdId);
    const isThreadedReply = !!thread.messageIdHeader;
    const subject =
      req.overrides?.subject ??
      (isThreadedReply ? this.replySubject(renderedSubject) : renderedSubject);

    // Attachments: auto hospital docs (always for CE) + selected patient docs
    const autoHospitalDocs = await this.listHospitalDocs(req.hospitalId);
    const selectedAttachments = await this.resolveSelectedPatientDocs(
      req.ipdId,
      req.overrides?.selectedPatientDocIds ?? []
    );
    const attachments = [...autoHospitalDocs, ...selectedAttachments];

    const idempotencyKey = `preauth:${req.ipdId}:${Date.now()}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Race-safe insert: if two parallel requests pass the idempotency check
      // above but reach this INSERT simultaneously, the UNIQUE index on
      // idempotency_key (partial, non-null) ensures only one wins. The
      // ON CONFLICT branch resolves the loser by re-selecting the winner.
      const psRes = await client.query<{ id: string }>(
        `INSERT INTO hospital.insurance_submissions
           (ipd_id, hospital_id, hospital_panel_id, submitted_via,
            doc_bundle, status, submitted_by, idempotency_key)
         VALUES ($1, $2, $3, 'email', $4::jsonb, 'drafted', $5, $6)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
           DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
         RETURNING id`,
        [
          req.ipdId,
          req.hospitalId,
          config.hospital_panel_id,
          JSON.stringify(
            attachments.map(a => ({
              s3_key: a.s3_key,
              source: a.source,
              source_doc_id: a.source_doc_id,
              filename: a.filename,
            }))
          ),
          req.submittedBy,
          req.idempotencyKey ?? null,
        ]
      );
      const submissionId = psRes.rows[0]!.id;

      const eoRes = await client.query<{ id: string }>(
        `INSERT INTO hospital.emails_outbound
           (hospital_id, ipd_id, hospital_panel_id, insurance_submission_id,
            to_addresses, cc_addresses, from_address,
            subject, body_text, body_html, attachments,
            status, idempotency_key, composed_by,
            in_reply_to, references_header, gmail_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'queued', $12, $13,
                 $14, $15, $16)
         RETURNING id`,
        [
          req.hospitalId,
          req.ipdId,
          config.hospital_panel_id,
          submissionId,
          to,
          cc,
          preflight.gmailAddress,
          subject,
          bodyText,
          bodyHtml,
          JSON.stringify(attachments),
          idempotencyKey,
          `user:${req.submittedBy}`,
          thread.messageIdHeader,
          thread.referencesHeader,
          thread.threadId,
        ]
      );
      const outboundId = eoRes.rows[0]!.id;

      await client.query(
        `UPDATE hospital.insurance_submissions
            SET email_outbound_id = $1 WHERE id = $2`,
        [outboundId, submissionId]
      );

      await client.query('COMMIT');

      // Audit log: drafted + queued (A2). Best-effort; failures don't break the parent op.
      await recordSubmissionEvent({
        insuranceSubmissionId: submissionId,
        ipdId: req.ipdId,
        hospitalId: req.hospitalId,
        eventType: 'drafted',
        payload: {
          panel_code: config.panel_code,
          panel_name: config.panel_name,
          attachment_count: attachments.length,
          is_threaded_reply: isThreadedReply,
          to,
        },
        actor: req.submittedBy,
      });
      await recordSubmissionEvent({
        insuranceSubmissionId: submissionId,
        ipdId: req.ipdId,
        hospitalId: req.hospitalId,
        eventType: 'queued',
        payload: { email_outbound_id: outboundId },
        actor: req.submittedBy,
      });

      logger.info(
        {
          submissionId,
          outboundId,
          hospitalId: req.hospitalId,
          ipdId: req.ipdId,
          panelCode: config.panel_code,
          to,
          attachmentCount: attachments.length,
          isThreadedReply,
        },
        'pre-auth submission queued'
      );

      try {
        const { default: outbox } = await import('../Workers/emailOutbox.queue.js');
        await outbox.add({ emailOutboundId: outboundId, idempotencyKey });
      } catch (err) {
        logger.warn({ err }, 'outbox enqueue failed; worker will pick up via poll');
      }

      return {
        insurance_submission_id: submissionId,
        email_outbound_id: outboundId,
        status: 'queued',
        is_threaded_reply: isThreadedReply,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, hospitalId: req.hospitalId, ipdId: req.ipdId }, 'pre-auth send failed');
      throw err;
    } finally {
      client.release();
    }
  }

  // -----------------------------------------------------------------
  // Read: timeline + auxiliary
  // -----------------------------------------------------------------

  async getSubmissionsForIpd(ipdId: string, hospitalId: string) {
    const res = await pool.query(
      `SELECT
         ps.id, ps.submitted_via, ps.status,
         ps.external_claim_id, ps.external_ccn,
         ps.drafted_at, ps.sent_at, ps.acknowledged_at, ps.preauth_deadline_at,
         ps.attempt_number, ps.resubmission_of_id,
         ps.submitted_by,
         u.first_name AS submitted_by_first_name,
         u.last_name  AS submitted_by_last_name,
         u.username   AS submitted_by_username,
         p.name AS panel_name, p.code AS panel_code,
         eo.gmail_message_id, eo.gmail_thread_id,
         eo.subject, eo.to_addresses, eo.cc_addresses,
         eo.body_text AS outbound_body_text,
         eo.from_address AS outbound_from,
         eo.attachments AS outbound_attachments
       FROM hospital.insurance_submissions ps
       JOIN hospital.hospital_panels hp ON hp.id = ps.hospital_panel_id
       JOIN hospital.panels p ON p.id = hp.panel_id
       LEFT JOIN hospital.emails_outbound eo ON eo.id = ps.email_outbound_id
       LEFT JOIN hospital.users u ON u.id = ps.submitted_by
       WHERE ps.ipd_id = $1 AND ps.hospital_id = $2
       ORDER BY ps.drafted_at DESC`,
      [ipdId, hospitalId]
    );

    // Enrich attachments with a view URL the FE can render inline.
    // Uses the same hybrid scheme as Patient Documents (v2 uploads.controller):
    // CloudFront-signed when signing is healthy, falling back to the raw S3
    // URL so a misconfigured CloudFront key can never blank out the chat.
    const { default: S3Service } = await import('./s3.service.js');
    for (const row of res.rows) {
      const atts = (row.outbound_attachments as any[] | null) ?? [];
      row.outbound_attachments = atts.map(a => ({
        ...a,
        view_url: a.s3_key ? S3Service.getViewUrl(a.s3_key) : null,
      }));
    }
    return res.rows;
  }
}

export default new InsuranceSubmissionService();
