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
              from_address, to_addresses, subject, body_text
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

    // Strategy 2.5: VERP correlation token in the To/Delivered-To address.
    // We set Reply-To: <local>+<token>@<domain> on every outbound; a reply
    // carries the token even in a NEW thread with a REWRITTEN subject. This is
    // the strongest cross-thread signal — it only fails if a human manually
    // changes the recipient.
    const corrToken = this.extractCorrelationToken(inbound.to_addresses);
    if (corrToken) {
      const m = await this.matchByCorrelationToken(inbound.hospital_id, corrToken);
      if (m) return this.applyMatch(inbound.id, m, 'verp_token', 0.97);
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

    // Strategy 5: Sender → panel reverse lookup (exactly one active submission)
    const m = await this.matchBySender(inbound.hospital_id, inbound.from_address);
    if (m) return this.applyMatch(inbound.id, m, 'sender_panel', 0.65);

    // Strategy 6 (C): sender maps to MULTIPLE open claims — disambiguate by the
    // patient name in the email. A clear winner links (0.7); otherwise we write
    // ranked suggestions and leave it for ops to confirm (instead of guessing).
    const disamb = await this.disambiguateBySender(
      inbound.hospital_id, inbound.from_address, inbound.subject, inbound.body_text, inbound.id
    );
    if (disamb.matched && disamb.match) {
      return this.applyMatch(inbound.id, disamb.match, 'sender_disambiguated', 0.7);
    }
    if (disamb.result) return disamb.result; // ambiguous → suggestions written

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
   * Extract our VERP correlation token from any of the inbound To addresses.
   * Token shape: "t" + 12 hex chars (see insuranceSubmission.ensureCorrelationToken),
   * carried as the +suffix on the plus-address the insurer replied to.
   */
  private extractCorrelationToken(toAddresses: string[] | null | undefined): string | null {
    if (!toAddresses || toAddresses.length === 0) return null;
    for (const addr of toAddresses) {
      const m = String(addr).match(/\+(t[0-9a-f]{12})@/i);
      if (m) return m[1]!.toLowerCase();
    }
    return null;
  }

  /**
   * Match by VERP correlation token → IPD. Cross-checks the hospital so a
   * leaked/guessed token can't reach another tenant's claim.
   */
  private async matchByCorrelationToken(
    hospitalId: string,
    token: string
  ): Promise<{ ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null } | null> {
    const res = await pool.query(
      `SELECT i.id AS ipd_id, i.hospital_panel_id,
              (SELECT ps.id FROM hospital.insurance_submissions ps
                 WHERE ps.ipd_id = i.id AND ps.hospital_id = i.hospital_id
                 ORDER BY ps.drafted_at DESC LIMIT 1) AS submission_id
         FROM hospital.ipds i
        WHERE i.correlation_token = $1 AND i.hospital_id = $2
        LIMIT 1`,
      [token, hospitalId]
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
             -- EXACT id match only. The previous LIKE $2 || '%' prefix match
             -- let a short insurer reference (>=6 chars) collide with the
             -- prefix of an unrelated submission/ipd UUID and attach the reply
             -- to the WRONG claim. A full UUID still matches exactly here.
             OR ps.id::text         = $2
             OR ps.ipd_id::text     = $2
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

  /**
   * C — disambiguation. When the sender maps to >1 open claim, score each
   * candidate by how well the patient's name appears in the email. Returns a
   * match only on a clear winner; otherwise writes ranked suggestions to the
   * inbound's parsed_payload and flags needs_ops_review for a human to pick.
   */
  private async disambiguateBySender(
    hospitalId: string,
    fromAddress: string,
    subject: string | null,
    bodyText: string | null,
    inboundId: string
  ): Promise<{
    matched: boolean;
    match?: { ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null };
    result?: MatchResult;
  }> {
    if (!fromAddress) return { matched: false };
    const res = await pool.query(
      `WITH sender_panel AS (
         SELECT DISTINCT pa.panel_id FROM hospital.panel_attributes pa
          WHERE pa.attribute_key IN ('email_to_list', 'cashless_email_to_list',
                                     'claim_submission_email', 'panel_primary_contact_email')
            AND (pa.value_text ILIKE '%' || $2 || '%')
       )
       SELECT ps.ipd_id, ps.id AS submission_id, ps.hospital_panel_id,
              i.first_name, i.last_name
         FROM hospital.insurance_submissions ps
         JOIN hospital.hospital_panels hp ON hp.id = ps.hospital_panel_id
         JOIN hospital.ipds i ON i.id = ps.ipd_id
        WHERE ps.hospital_id = $1
          AND hp.panel_id IN (SELECT panel_id FROM sender_panel)
          AND ps.status NOT IN ('approved', 'rejected', 'failed')
          AND ps.drafted_at > NOW() - INTERVAL '60 days'
        ORDER BY ps.drafted_at DESC`,
      [hospitalId, fromAddress]
    );
    if ((res.rowCount ?? 0) <= 1) return { matched: false }; // 0/1 handled elsewhere

    const text = `${subject ?? ''} ${bodyText ?? ''}`.toLowerCase();
    const scored = res.rows
      .map((r) => {
        const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim().toLowerCase();
        const tokens = name.split(/\s+/).filter((t: string) => t.length >= 3);
        const hits = tokens.filter((t: string) => text.includes(t)).length;
        const score = tokens.length ? hits / tokens.length : 0;
        return { ...r, name, score };
      })
      .sort((a, b) => b.score - a.score);

    const top = scored[0]!;
    const second = scored[1];
    // Clear winner: top matches well AND beats the runner-up by a margin.
    if (top.score >= 0.5 && top.score - (second?.score ?? 0) >= 0.34) {
      return {
        matched: true,
        match: { ipd_id: top.ipd_id, submission_id: top.submission_id, hospital_panel_id: top.hospital_panel_id },
      };
    }

    // Ambiguous → persist ranked suggestions + flag for ops.
    await pool.query(
      `UPDATE hospital.emails_inbound
          SET match_method = 'ambiguous_suggestions',
              needs_ops_review = TRUE,
              processed_at = NOW(),
              parsed_payload = COALESCE(parsed_payload, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [inboundId, JSON.stringify({
        disambiguation_suggestions: scored.slice(0, 3).map((s) => ({
          submission_id: s.submission_id, ipd_id: s.ipd_id,
          patient: s.name, score: Number(s.score.toFixed(2)),
        })),
      })]
    );
    return { matched: false, result: { matched: false, method: 'ambiguous_suggestions', confidence: 0 } };
  }

  /**
   * B-capture: extract the insurer's claim/CCN number from the matched inbound
   * and persist it on the submission (if not already set). This bootstraps
   * strategy-3 matching for every later reply, regardless of thread/subject.
   * Never clobbers an existing value.
   */
  private async captureClaimNumber(inboundId: string, submissionId: string): Promise<void> {
    const inb = await pool.query(
      `SELECT subject, body_text FROM hospital.emails_inbound WHERE id = $1`,
      [inboundId]
    );
    if ((inb.rowCount ?? 0) === 0) return;
    const token =
      this.extractClaimNumber(inb.rows[0].subject) ||
      this.extractClaimNumber(inb.rows[0].body_text);
    if (!token) return;
    await pool.query(
      `UPDATE hospital.insurance_submissions
          SET external_claim_id = $2
        WHERE id = $1 AND (external_claim_id IS NULL OR external_claim_id = '')`,
      [submissionId, token]
    );
  }

  private async applyMatch(
    inboundId: string,
    match: { ipd_id: string | null; submission_id: string | null; hospital_panel_id: string | null },
    method: string,
    confidence: number
  ): Promise<MatchResult> {
    // D — confidence gating. A high-confidence link (token/thread/uhid ≥0.9)
    // auto-applies; a medium one (claim-no 0.85, sender-only 0.65) is linked
    // but flagged so an admin confirms the attribution before it's trusted.
    let needsReview = confidence < 0.9;
    // Inbound sender authentication gate. A high-confidence match (e.g. a VERP
    // plus-address token, 0.97) is otherwise auto-trusted — but that token
    // travels in cleartext headers and is forgeable. If Gmail reported an
    // EXPLICIT SPF/DKIM/DMARC failure, refuse to auto-trust: link the email but
    // flag needs_ops_review so the irreversible side-effects (chart doc-save +
    // ops notification) are deferred until a human confirms it isn't a spoof.
    const authRow = await pool.query(
      `SELECT auth_results FROM hospital.emails_inbound WHERE id = $1`,
      [inboundId],
    );
    const auth = authRow.rows[0]?.auth_results as { authenticated?: boolean } | null;
    if (auth && auth.authenticated === false && !needsReview) {
      needsReview = true;
      logger.warn(
        { inboundId, method, confidence, auth },
        'inbound email failed SPF/DKIM/DMARC — downgrading auto-trust to needs_ops_review (possible spoof)',
      );
    }
    const upd = await pool.query(
      `UPDATE hospital.emails_inbound
          SET matched_ipd_id = $1,
              matched_submission_id = $2,
              hospital_panel_id = $3,
              match_method = $4,
              needs_ops_review = $6,
              processed_at = NOW()
        WHERE id = $5
        RETURNING hospital_id, body_text, attachments`,
      [match.ipd_id, match.submission_id, match.hospital_panel_id, method, inboundId, needsReview]
    );
    const inboundRow = upd.rows[0] ?? {};

    logger.info({ inboundId, method, confidence, needsReview, submissionId: match.submission_id }, 'inbound email matched');

    // B-capture — persist the insurer's claim/CCN number on first contact so
    // every subsequent reply (even a new thread) matches by claim number.
    if (match.submission_id) {
      await this.captureClaimNumber(inboundId, match.submission_id).catch((err) =>
        logger.warn({ err, inboundId }, 'captureClaimNumber failed (non-fatal)')
      );
    }

    // Auto-save insurer's attached documents into the patient's ipd_doc table
    // so they show up in the Documents tab + the next email compose modal.
    //
    // GATE (security): only auto-write into a patient chart for a HIGH-confidence
    // match (>=0.9). A medium/low match (claim-no prefix 0.85, sender 0.65,
    // disambiguated 0.7) could be the WRONG patient — writing the insurer's
    // documents into their chart is irreversible cross-patient leakage. For
    // those we defer the doc-save until an ops user confirms the attribution
    // (needs_ops_review = true).
    if (match.ipd_id && !needsReview) {
      try {
        await this.savePatientDocsFromInbound(inboundId, match.ipd_id);
      } catch (err) {
        logger.error(
          { err, inboundId, ipdId: match.ipd_id },
          'savePatientDocsFromInbound failed (non-fatal)'
        );
      }
    } else if (match.ipd_id && needsReview) {
      logger.info(
        { inboundId, ipdId: match.ipd_id, confidence },
        'deferring savePatientDocsFromInbound — low-confidence match needs ops confirmation',
      );
    }

    // Enqueue notification dispatch — Bull retries 4× with exponential backoff
    // if UltraMsg is briefly down (A8). Previously this was a fire-and-forget
    // try/catch that lost notifications on the first transient failure.
    try {
      const { default: inboundNotificationQueue } = await import(
        '../Workers/inboundNotification.queue.js'
      );
      // jobId dedups: a force-poll racing the cron (no per-hospital lock) could
      // otherwise enqueue the same inbound twice → duplicate WhatsApp revert.
      await inboundNotificationQueue.add({ inboundId }, { jobId: `inbound-notif:${inboundId}` });
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

    // ── Trigger the AI email-intelligence pipeline (OCR → classify → extract →
    //    pending_review draft). This is the production ignition for the whole
    //    intelligence layer; without it no AI drafts are ever produced. The
    //    draft is human-reviewed before any claim effect, so we run it for any
    //    matched claim (even needs_review ones) — the reviewer confirms.
    if (match.ipd_id) {
      try {
        const atts = Array.isArray(inboundRow.attachments) ? inboundRow.attachments : [];
        const s3AttachmentKeys = atts
          .filter((a: any) => a?.s3_key)
          .map((a: any) => ({
            s3Key: a.s3_key as string,
            filename: (a.filename as string) ?? 'attachment',
            mime: (a.mime_type as string) ?? 'application/octet-stream',
          }));
        const { enqueueEmailIntelligence } = await import(
          '../Workers/emailIntelligence.queue.js'
        );
        await enqueueEmailIntelligence({
          inboundEmailId: inboundId,
          claimId: match.ipd_id, // claim id == ipd id across financials/actions/drafts
          hospitalId: inboundRow.hospital_id as string,
          body: (inboundRow.body_text as string) ?? '',
          s3AttachmentKeys,
        });
      } catch (err) {
        // Best-effort: a failed enqueue must not break matching/ingestion. The
        // unprocessed-row reconciler (drafts missing for a matched email) will
        // re-drive it.
        logger.warn({ err, inboundId }, 'enqueueEmailIntelligence failed (non-fatal)');
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
