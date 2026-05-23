import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

/**
 * Email Matching Service
 *
 * Given an emails_inbound row, attempts to link it to a preauth_submission
 * (and thus an IPD/claim). Matching strategies, in priority order:
 *
 *   1. **Thread match** — strongest signal. The inbound's `in_reply_to`
 *      header points to a `gmail_message_id` we sent from emails_outbound.
 *      That row's insurance_submission_id → IPD.
 *
 *   2. **Gmail thread_id match** — Gmail-internal threading. Looks for any
 *      outbound on the same gmail_thread_id.
 *
 *   3. **Claim number regex** — looks for our internal claim number
 *      pattern (CLM-...) or the insurer's external claim id in subject/body.
 *
 *   4. **Sender → panel reverse lookup** — match the from_address back to
 *      a panel via panel_attributes; if there's exactly ONE active recent
 *      submission to that panel for this hospital, attribute the email
 *      to it.
 *
 *   5. **Unmatched** — flag needs_ops_review = true; ops manually links.
 *
 * On match, additionally:
 *   - Resolve the hospital_panel_id from the matched submission
 *   - Trigger the notification dispatcher (separate service)
 */

interface MatchResult {
  matched: boolean;
  method: string;
  ipd_id?: string;
  submission_id?: string;
  hospital_panel_id?: string;
  confidence: number;
}

class EmailMatchingService {
  async match(inboundId: string): Promise<MatchResult> {
    const inRes = await pool.query(
      `SELECT id, hospital_id, in_reply_to, references_header, gmail_thread_id,
              from_address, subject, body_text
         FROM hospital.emails_inbound
        WHERE id = $1`,
      [inboundId]
    );
    if ((inRes.rowCount ?? 0) === 0) {
      return { matched: false, method: 'unknown', confidence: 0 };
    }
    const inbound = inRes.rows[0]!;

    // Strategy 1: In-Reply-To → outbound message-id
    if (inbound.in_reply_to) {
      const m = await this.matchByInReplyTo(inbound.hospital_id, inbound.in_reply_to);
      if (m) return this.applyMatch(inbound.id, m, 'thread', 0.99);
    }

    // Strategy 2: Gmail thread id
    if (inbound.gmail_thread_id) {
      const m = await this.matchByThreadId(inbound.hospital_id, inbound.gmail_thread_id);
      if (m) return this.applyMatch(inbound.id, m, 'gmail_thread', 0.95);
    }

    // Strategy 3: Claim number regex in subject/body
    const claimNoMatch = this.extractClaimNumber(inbound.subject) ||
                        this.extractClaimNumber(inbound.body_text);
    if (claimNoMatch) {
      const m = await this.matchByClaimNumber(inbound.hospital_id, claimNoMatch);
      if (m) return this.applyMatch(inbound.id, m, 'claim_no_regex', 0.85);
    }

    // Strategy 4: UHID-in-subject. Our subject template is deterministic:
    //   "Pre-auth required for the patient <name> with Patient UHID <uuid>"
    // Insurer auto-responders (e.g. no-reply@mediassistindia.com) and any
    // reply that loses threading headers but preserves the subject can still
    // be linked back via the embedded IPD UUID. Searches subject + body so a
    // forwarded reply with the original quoted is also caught.
    const uhid = this.extractIpdUuid(inbound.subject) ||
                 this.extractIpdUuid(inbound.body_text);
    if (uhid) {
      const m = await this.matchByIpdId(inbound.hospital_id, uhid);
      if (m) return this.applyMatch(inbound.id, m, 'uhid_in_subject', 0.92);
    }

    // Strategy 5: Sender → panel reverse lookup
    const m = await this.matchBySender(inbound.hospital_id, inbound.from_address);
    if (m) return this.applyMatch(inbound.id, m, 'sender_panel', 0.65);

    // Unmatched
    await pool.query(
      `UPDATE hospital.emails_inbound
          SET match_method = 'unmatched', needs_ops_review = TRUE, processed_at = NOW()
        WHERE id = $1`,
      [inboundId]
    );
    logger.info({ inboundId, hospitalId: inbound.hospital_id }, 'inbound email unmatched');
    return { matched: false, method: 'unmatched', confidence: 0 };
  }

  private async matchByInReplyTo(
    hospitalId: string,
    inReplyTo: string
  ): Promise<{ ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null } | null> {
    const cleaned = inReplyTo.replace(/^<|>$/g, '');
    const res = await pool.query(
      `SELECT eo.ipd_id, eo.insurance_submission_id, eo.hospital_panel_id
         FROM hospital.emails_outbound eo
        WHERE eo.hospital_id = $1
          AND eo.gmail_message_id = $2
        LIMIT 1`,
      [hospitalId, cleaned]
    );
    return res.rows[0]
      ? {
          ipd_id: res.rows[0].ipd_id,
          submission_id: res.rows[0].insurance_submission_id,
          hospital_panel_id: res.rows[0].hospital_panel_id,
        }
      : null;
  }

  private async matchByThreadId(
    hospitalId: string,
    threadId: string
  ): Promise<{ ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null } | null> {
    const res = await pool.query(
      `SELECT eo.ipd_id, eo.insurance_submission_id, eo.hospital_panel_id
         FROM hospital.emails_outbound eo
        WHERE eo.hospital_id = $1
          AND eo.gmail_thread_id = $2
        ORDER BY eo.sent_at DESC NULLS LAST
        LIMIT 1`,
      [hospitalId, threadId]
    );
    return res.rows[0]
      ? {
          ipd_id: res.rows[0].ipd_id,
          submission_id: res.rows[0].insurance_submission_id,
          hospital_panel_id: res.rows[0].hospital_panel_id,
        }
      : null;
  }

  /**
   * Heuristic claim-number detector. Matches any of:
   *   - CLM-<8-12 alnum>
   *   - "Claim #<number>"
   *   - "CCN: <token>"
   *   - "Claim ID: <token>"
   * Returns the captured token or null.
   */
  private extractClaimNumber(text: string | null | undefined): string | null {
    if (!text) return null;
    const patterns = [
      /\bCLM-[A-Z0-9]{6,}\b/i,
      /Claim\s*#\s*([A-Z0-9-]{6,})/i,
      /CCN\s*[:#]\s*([A-Z0-9-]{6,})/i,
      /Claim\s*ID\s*[:#]\s*([A-Z0-9-]{6,})/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m[1] ?? m[0];
    }
    return null;
  }

  /**
   * Extract an IPD UUID from text — keys off our deterministic subject
   * template: "Pre-auth required for the patient <name> with Patient UHID <uuid>".
   * The UHID we embed IS the IPD id (see insuranceSubmission.service compose
   * step). So any reply that preserves the subject can be linked back to
   * the patient even if threading headers are lost.
   */
  private extractIpdUuid(text: string | null | undefined): string | null {
    if (!text) return null;
    // Look for "Patient UHID <uuid>" first (specific), then any bare UUID
    // (defensive — catches accidental reformatting).
    const specific = text.match(/Patient\s*UHID\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (specific) return specific[1]!.toLowerCase();
    const bare = text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    return bare ? bare[1]!.toLowerCase() : null;
  }

  /**
   * Direct match by IPD id — confirms the IPD belongs to this hospital
   * (defensive: prevents cross-tenant leak if a UUID was guessed) and
   * returns the most recent submission on that IPD if any exists.
   */
  private async matchByIpdId(
    hospitalId: string,
    ipdId: string
  ): Promise<{ ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null } | null> {
    const res = await pool.query(
      `SELECT i.id AS ipd_id, i.hospital_panel_id,
              (SELECT ps.id FROM hospital.insurance_submissions ps
                 WHERE ps.ipd_id = i.id AND ps.hospital_id = i.hospital_id
                 ORDER BY ps.drafted_at DESC LIMIT 1) AS submission_id
         FROM hospital.ipds i
        WHERE i.id = $1 AND i.hospital_id = $2
        LIMIT 1`,
      [ipdId, hospitalId]
    );
    return res.rows[0]
      ? {
          ipd_id: res.rows[0].ipd_id,
          submission_id: res.rows[0].submission_id,
          hospital_panel_id: res.rows[0].hospital_panel_id,
        }
      : null;
  }

  private async matchByClaimNumber(
    hospitalId: string,
    claimToken: string
  ): Promise<{ ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null } | null> {
    // Check both our internal claim_no derivation AND the external_claim_id
    const res = await pool.query(
      `SELECT ps.ipd_id, ps.id AS submission_id, ps.hospital_panel_id
         FROM hospital.insurance_submissions ps
        WHERE ps.hospital_id = $1
          AND (
                ps.external_claim_id = $2
             OR ps.external_ccn     = $2
             OR ps.id::text         LIKE $2 || '%'
             OR ps.ipd_id::text     LIKE $2 || '%'
          )
        ORDER BY ps.drafted_at DESC
        LIMIT 1`,
      [hospitalId, claimToken]
    );
    return res.rows[0]
      ? {
          ipd_id: res.rows[0].ipd_id,
          submission_id: res.rows[0].submission_id,
          hospital_panel_id: res.rows[0].hospital_panel_id,
        }
      : null;
  }

  /**
   * Match sender email → panel via panel_attributes, then pick the most
   * recent open submission to that panel.
   *
   * Only returns a match if there's exactly one recent (last 30 days)
   * active submission — otherwise too ambiguous.
   */
  private async matchBySender(
    hospitalId: string,
    fromAddress: string
  ): Promise<{ ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null } | null> {
    if (!fromAddress) return null;

    const res = await pool.query(
      `WITH sender_panel AS (
         SELECT DISTINCT pa.panel_id
           FROM hospital.panel_attributes pa
          WHERE pa.attribute_key IN ('email_to_list', 'cashless_email_to_list',
                                     'claim_submission_email', 'panel_primary_contact_email')
            AND (pa.value_text ILIKE '%' || $2 || '%')
       )
       SELECT ps.ipd_id, ps.id AS submission_id, ps.hospital_panel_id
         FROM hospital.insurance_submissions ps
         JOIN hospital.hospital_panels hp ON hp.id = ps.hospital_panel_id
        WHERE ps.hospital_id = $1
          AND hp.panel_id IN (SELECT panel_id FROM sender_panel)
          AND ps.status NOT IN ('approved', 'rejected', 'failed')
          AND ps.drafted_at > NOW() - INTERVAL '30 days'
        ORDER BY ps.drafted_at DESC`,
      [hospitalId, fromAddress]
    );

    if (res.rowCount === 1) {
      return {
        ipd_id: res.rows[0]!.ipd_id,
        submission_id: res.rows[0]!.submission_id,
        hospital_panel_id: res.rows[0]!.hospital_panel_id,
      };
    }
    return null;
  }

  private async applyMatch(
    inboundId: string,
    match: { ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null },
    method: string,
    confidence: number
  ): Promise<MatchResult> {
    await pool.query(
      `UPDATE hospital.emails_inbound
          SET matched_ipd_id = $1,
              matched_submission_id = $2,
              hospital_panel_id = $3,
              match_method = $4,
              needs_ops_review = FALSE,
              processed_at = NOW()
        WHERE id = $5`,
      [match.ipd_id, match.submission_id, match.hospital_panel_id, method, inboundId]
    );

    logger.info({ inboundId, method, confidence, submissionId: match.submission_id }, 'inbound email matched');

    // Auto-save insurer's attached documents into the patient's ipd_doc table
    // so they show up in the Documents tab + the next email compose modal.
    if (match.ipd_id) {
      try {
        await this.savePatientDocsFromInbound(inboundId, match.ipd_id);
      } catch (err) {
        logger.error(
          { err, inboundId, ipdId: match.ipd_id },
          'savePatientDocsFromInbound failed (non-fatal)'
        );
      }
    }

    // Enqueue notification dispatch — Bull retries 4× with exponential backoff
    // if UltraMsg is briefly down (A8). Previously this was a fire-and-forget
    // try/catch that lost notifications on the first transient failure.
    try {
      const { default: inboundNotificationQueue } = await import(
        '../Workers/inboundNotification.queue.js'
      );
      await inboundNotificationQueue.add({ inboundId });
    } catch (err) {
      // Bull enqueue itself failed (Redis offline?). Fall back to inline
      // dispatch so the notification still has a chance to fire — Bull
      // worker would re-enqueue but we don't have a poll path here. This
      // is a best-effort safety net.
      logger.warn({ err, inboundId }, 'inboundNotification enqueue failed; falling back inline');
      try {
        const { default: dispatcher } = await import('./notificationDispatch.service.js');
        await dispatcher.dispatchInboundRevert(inboundId);
      } catch (fallbackErr) {
        logger.error({ err: fallbackErr, inboundId }, 'inline dispatch fallback also failed');
      }
    }

    return {
      matched: true,
      method,
      ipd_id: match.ipd_id ?? undefined,
      submission_id: match.submission_id ?? undefined,
      hospital_panel_id: match.hospital_panel_id ?? undefined,
      confidence,
    };
  }

  /**
   * For each attachment on a matched inbound email, persist a row in
   * hospital.ipd_doc so it appears in the patient's Documents tab and is
   * available for selection in future Compose drafts.
   *
   * Idempotent on s3_key — re-running won't create duplicates.
   * type = 'insurer_response' so these are visually distinguishable from
   * hospital-ops uploads (admission notes, KYC, etc.).
   */
  private async savePatientDocsFromInbound(
    inboundId: string,
    ipdId: string
  ): Promise<{ saved: number; skipped_duplicates: number }> {
    const inRes = await pool.query<{
      attachments: Array<{
        filename: string;
        s3_key: string;
        mime_type: string;
        size_bytes: number;
      }> | null;
      from_address: string;
      subject: string;
      gmail_message_id: string;
    }>(
      `SELECT attachments, from_address, subject, gmail_message_id
         FROM hospital.emails_inbound
        WHERE id = $1`,
      [inboundId]
    );
    if ((inRes.rowCount ?? 0) === 0) return { saved: 0, skipped_duplicates: 0 };

    const { attachments, from_address, subject, gmail_message_id } = inRes.rows[0]!;
    if (!attachments || attachments.length === 0) return { saved: 0, skipped_duplicates: 0 };

    const region = process.env.AWS_REGION;
    const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || '';

    let saved = 0;
    let skipped = 0;
    for (const att of attachments) {
      if (!att.s3_key) continue;
      // Skip if an ipd_doc with this s3_key + ipd_id already exists.
      const existing = await pool.query(
        `SELECT 1 FROM hospital.ipd_doc WHERE ipd_id = $1 AND s3_key = $2 LIMIT 1`,
        [ipdId, att.s3_key]
      );
      if ((existing.rowCount ?? 0) > 0) {
        skipped++;
        continue;
      }

      const s3Link = bucket && region
        ? `https://${bucket}.s3.${region}.amazonaws.com/${att.s3_key}`
        : null;

      await pool.query(
        `INSERT INTO hospital.ipd_doc
           (ipd_id, s3_key, s3_link, type, file_name, file_size, mime_type,
            storage_provider, doc_description, doc_metadata)
         VALUES ($1, $2, $3, 'insurer_response', $4, $5, $6, 's3', $7, $8::jsonb)`,
        [
          ipdId,
          att.s3_key,
          s3Link,
          att.filename,
          att.size_bytes,
          att.mime_type,
          `Auto-saved from insurer email: ${subject}`.slice(0, 500),
          JSON.stringify({
            source: 'inbound_email',
            inbound_id: inboundId,
            from_address,
            gmail_message_id,
            original_filename: att.filename,
          }),
        ]
      );
      saved++;
    }

    if (saved > 0) {
      logger.info(
        { inboundId, ipdId, saved, skipped },
        'savePatientDocsFromInbound: persisted insurer attachments to patient docs'
      );
    }
    return { saved, skipped_duplicates: skipped };
  }
}

export default new EmailMatchingService();
