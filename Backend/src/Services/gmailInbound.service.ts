import { google, gmail_v1 } from 'googleapis';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import apiError from '../Utils/errorHandler.util.js';
import gmailAuthService from './gmailAuth.service.js';
import S3Service from './s3.service.js';
import { withGmailRetry } from '../Utils/gmailRetry.util.js';

/**
 * Gmail Inbound Service (polling mode)
 *
 * Periodically pulls new Gmail messages for each connected hospital via the
 * Gmail History API. Driven by the gmailPoll.queue Bull cron worker.
 *
 * Flow per hospital:
 *   1. Read stored history_id from hospital_interfaces.config['history_id']
 *   2. If null → first poll: read current historyId via getProfile(),
 *      store as baseline, skip this round
 *   3. Otherwise → call users.history.list(startHistoryId=stored) to
 *      enumerate new messages since last poll
 *   4. For each new message: fetch full body, INSERT emails_inbound,
 *      run the matcher
 *   5. Update history_id to the latest seen
 *
 * Idempotent on gmail_message_id (UNIQUE), so duplicate fetches are safe.
 *
 * Why polling instead of Pub/Sub: Google Workspace's domain-restricted
 * sharing org policy blocks granting the gmail-api-push service account
 * Publisher role on the Pub/Sub topic. Polling avoids this whole class of
 * Workspace org-policy friction at the cost of ~1-2 min latency (vs
 * Pub/Sub's <10s). For Cashless Everywhere, the human turnaround on
 * insurer queries is hours; the latency cost is invisible.
 */

class GmailInboundService {
  /**
   * List hospital IDs that have a valid Gmail OAuth connection.
   * Used by the polling worker to know which mailboxes to scan.
   */
  async listConnectedHospitalIds(): Promise<string[]> {
    // Hospitals with at least one connected email interface
    // (migration 023: storage moved from panel_attributes → hospital_interfaces).
    const res = await pool.query<{ hospital_id: string }>(
      `SELECT DISTINCT hospital_id
         FROM hospital.hospital_interfaces
        WHERE kind = 'email'
          AND secrets_encrypted IS NOT NULL`
    );
    return res.rows.map(r => r.hospital_id);
  }

  /**
   * Poll a single hospital's Gmail inbox for new messages.
   *
   * First call (no baseline historyId): reads current historyId via
   * getProfile(), stores as baseline, returns early. The next poll picks
   * up real changes since this baseline.
   *
   * Returns counts: processed = new messages ingested, skipped =
   * duplicates or first-poll-baseline, failed = per-message errors.
   */
  async pollHospital(hospitalId: string): Promise<{
    processed: number;
    skipped: number;
    failed: number;
    hospitalId: string;
    skippedReason?: 'first_poll_baseline' | 'no_changes';
  }> {
    // Auth + clients
    const client = await gmailAuthService.getAuthenticatedClient(hospitalId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    // Read stored history_id from watch_state
    const stored = await gmailAuthService.getStoredCredentials(hospitalId);
    if (!stored) {
      logger.warn({ hospitalId }, 'pollHospital: no stored credentials, skipping');
      return { processed: 0, skipped: 1, failed: 0, hospitalId };
    }
    const lastHistoryId = stored.watch_state.history_id;

    // First-poll baseline: capture current historyId, return.
    if (!lastHistoryId) {
      const profile = await withGmailRetry(
        () => gmail.users.getProfile({ userId: 'me' }),
        { context: { hospitalId, op: 'getProfile/baseline' } },
      );
      const currentHistoryId = profile.data.historyId ?? null;
      if (!currentHistoryId) {
        logger.warn({ hospitalId }, 'pollHospital: getProfile returned no historyId');
        return { processed: 0, skipped: 1, failed: 0, hospitalId };
      }
      await gmailAuthService.updateWatchState(hospitalId, {
        history_id: currentHistoryId,
        last_verified_at: Date.now(),
        status: 'active',
        last_error: null,
      });
      logger.info({ hospitalId, baseline: currentHistoryId }, 'pollHospital: baseline established');
      return {
        processed: 0,
        skipped: 1,
        failed: 0,
        hospitalId,
        skippedReason: 'first_poll_baseline',
      };
    }

    // Enumerate history since last poll. Pagination handles long gaps
    // (e.g. if the worker was down for a while).
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let nextPageToken: string | undefined;
    let latestHistoryId: string = lastHistoryId;
    const messageIds = new Set<string>();

    try {
      do {
        const historyRes = await withGmailRetry(
          () => gmail.users.history.list({
            userId: 'me',
            startHistoryId: lastHistoryId,
            historyTypes: ['messageAdded'],
            pageToken: nextPageToken,
          }),
          { context: { hospitalId, op: 'history.list', startHistoryId: lastHistoryId } },
        );
        for (const h of historyRes.data.history ?? []) {
          for (const m of h.messagesAdded ?? []) {
            if (m.message?.id) messageIds.add(m.message.id);
          }
        }
        if (historyRes.data.historyId) latestHistoryId = historyRes.data.historyId;
        nextPageToken = historyRes.data.nextPageToken ?? undefined;
      } while (nextPageToken);

      if (messageIds.size === 0) {
        // Still advance the pointer so next poll uses a fresh baseline
        await gmailAuthService.updateWatchState(hospitalId, {
          history_id: latestHistoryId,
          last_verified_at: Date.now(),
          status: 'active',
          last_error: null,
        });
        return { processed: 0, skipped: 0, failed: 0, hospitalId, skippedReason: 'no_changes' };
      }

      logger.info(
        { hospitalId, fromHistoryId: lastHistoryId, toHistoryId: latestHistoryId, newMessages: messageIds.size },
        'pollHospital: ingesting new messages'
      );

      for (const msgId of messageIds) {
        try {
          const result = await this.ingestMessage(gmail, msgId, hospitalId);
          if (result === 'inserted') processed++;
          else if (result === 'duplicate') skipped++;
        } catch (err) {
          failed++;
          logger.error({ err, msgId, hospitalId }, 'pollHospital: ingest failed');
        }
      }

      // Advance pointer only after successful processing
      await gmailAuthService.updateWatchState(hospitalId, {
        history_id: latestHistoryId,
        last_verified_at: Date.now(),
        status: 'active',
        last_error: null,
      });
    } catch (err) {
      // 404 with reason "notFound" from history.list means the historyId
      // is too old (Gmail keeps ~30 days). Recover by re-baselining.
      const message = (err as Error).message || '';
      if (message.includes('Requested entity was not found') || message.includes('historyId')) {
        logger.warn({ hospitalId, err: message }, 'pollHospital: historyId expired; re-baselining');
        const profile = await withGmailRetry(
          () => gmail.users.getProfile({ userId: 'me' }),
          { context: { hospitalId, op: 'getProfile/rebase' } },
        );
        await gmailAuthService.updateWatchState(hospitalId, {
          history_id: profile.data.historyId ?? null,
          last_verified_at: Date.now(),
          status: 'active',
          last_error: 'historyId expired, re-baselined',
        });
        return { processed: 0, skipped: 1, failed: 0, hospitalId, skippedReason: 'first_poll_baseline' };
      }
      logger.error({ err, hospitalId }, 'pollHospital: history list failed');
      await gmailAuthService.updateWatchState(hospitalId, {
        status: 'error',
        last_error: message,
        last_verified_at: Date.now(),
      });
      throw err;
    }

    return { processed, skipped, failed, hospitalId };
  }

  /**
   * Fetch a single Gmail message in full, INSERT into emails_inbound,
   * trigger the matcher. Returns 'inserted' on new row, 'duplicate' if
   * gmail_message_id already exists.
   */
  private async ingestMessage(
    gmail: gmail_v1.Gmail,
    gmailInternalId: string,
    hospitalId: string
  ): Promise<'inserted' | 'duplicate'> {
    const full = await withGmailRetry(
      () => gmail.users.messages.get({
        userId: 'me',
        id: gmailInternalId,
        format: 'full',
      }),
      { context: { hospitalId, op: 'messages.get', gmailInternalId } },
    );

    const payload = full.data.payload;
    if (!payload) {
      logger.warn({ gmailInternalId }, 'gmail message has no payload; skipping');
      return 'duplicate';
    }

    const headersByName = new Map<string, string>();
    for (const h of payload.headers ?? []) {
      if (h.name) headersByName.set(h.name.toLowerCase(), h.value ?? '');
    }
    const messageIdHeader = headersByName.get('message-id') ?? gmailInternalId;
    const subject = headersByName.get('subject') ?? '';
    const fromAddr = this.extractEmail(headersByName.get('from') ?? '');
    const toAddrs = this.splitAddresses(headersByName.get('to') ?? '');
    const ccAddrs = this.splitAddresses(headersByName.get('cc') ?? '');

    // Self-loop guard: skip messages we sent ourselves. The polling worker
    // reads `users.history.list` which includes messages added to the SENT
    // folder, so our own outbound mail otherwise gets ingested as a fake
    // inbound. Look up the hospital's connected gmail_address from its
    // hospital_interfaces row (migration 023).
    const ownAddressRes = await pool.query<{ gmail_address: string }>(
      `SELECT config->>'gmail_address' AS gmail_address
         FROM hospital.hospital_interfaces
        WHERE hospital_id = $1
          AND kind = 'email'
        ORDER BY created_at ASC
        LIMIT 1`,
      [hospitalId]
    );
    const ownAddress = ownAddressRes.rows[0]?.gmail_address?.toLowerCase() ?? '';
    if (ownAddress && fromAddr.toLowerCase() === ownAddress) {
      logger.debug(
        { hospitalId, gmailInternalId, fromAddr },
        'gmail inbound: skipping self-sent message'
      );
      return 'duplicate';
    }
    const inReplyTo = (headersByName.get('in-reply-to') ?? '').replace(/^<|>$/g, '');
    const references = headersByName.get('references') ?? '';
    const dateStr = headersByName.get('date') ?? new Date().toUTCString();
    const receivedAt = new Date(dateStr);

    // Extract bodies + attachments
    const { bodyText, bodyHtml, attachmentsMeta } = this.flattenParts(payload, gmail, gmailInternalId);
    const attachments = await this.persistAttachments(
      attachmentsMeta,
      gmail,
      gmailInternalId,
      hospitalId
    );

    // Archive the raw RFC822 source (best-effort)
    let rawS3Key: string | null = null;
    try {
      if (full.data.raw) {
        const buf = Buffer.from(full.data.raw, 'base64url');
        rawS3Key = `inbound-raw/${hospitalId}/${gmailInternalId}.eml`;
        await S3Service.upload(rawS3Key, buf, 'message/rfc822');
      }
    } catch (err) {
      logger.warn({ err, gmailInternalId }, 'raw email archive failed (non-fatal)');
    }

    // Classify the inbound by keyword rules. parsed_payload carries the
    // action text + matched keywords for downstream notification copy.
    const { classifyInboundEmail } = await import('./inboundClassifier.service.js');
    const classifyResult = classifyInboundEmail({
      subject,
      bodyText,
      bodyHtml,
    });

    const insertRes = await pool.query<{ id: string }>(
      `INSERT INTO hospital.emails_inbound
         (hospital_id, gmail_message_id, gmail_thread_id, in_reply_to, references_header,
          from_address, to_addresses, cc_addresses, subject,
          body_text, body_html, raw_email_s3_key, attachments,
          received_at, classification, parsed_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16::jsonb)
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING id`,
      [
        hospitalId,
        messageIdHeader,
        full.data.threadId,
        inReplyTo || null,
        references || null,
        fromAddr,
        toAddrs,
        ccAddrs,
        subject,
        bodyText,
        bodyHtml,
        rawS3Key,
        JSON.stringify(attachments),
        receivedAt,
        classifyResult.classification,
        JSON.stringify({
          action: classifyResult.action,
          confidence: classifyResult.confidence,
          matched_keywords: classifyResult.matched_keywords,
        }),
      ]
    );

    if ((insertRes.rowCount ?? 0) === 0) {
      return 'duplicate';
    }

    const inboundId = insertRes.rows[0]!.id;

    // Run the matcher synchronously — fast, no LLM
    try {
      const { default: matcher } = await import('./emailMatching.service.js');
      await matcher.match(inboundId);
    } catch (err) {
      logger.error({ err, inboundId }, 'matcher failed (will retry in background)');
    }

    return 'inserted';
  }

  private extractEmail(headerValue: string): string {
    const match = headerValue.match(/<([^>]+)>/);
    return (match ? match[1] : headerValue).trim();
  }

  private splitAddresses(headerValue: string): string[] {
    if (!headerValue) return [];
    return headerValue
      .split(',')
      .map(s => this.extractEmail(s.trim()))
      .filter(Boolean);
  }

  /**
   * Recursively walk MIME parts, collecting text/html bodies + attachment metadata.
   */
  private flattenParts(
    payload: gmail_v1.Schema$MessagePart,
    _gmail: gmail_v1.Gmail,
    _gmailInternalId: string
  ): {
    bodyText: string;
    bodyHtml: string;
    attachmentsMeta: { filename: string; mimeType: string; attachmentId: string; size: number }[];
  } {
    let bodyText = '';
    let bodyHtml = '';
    const attachmentsMeta: { filename: string; mimeType: string; attachmentId: string; size: number }[] = [];

    const visit = (part: gmail_v1.Schema$MessagePart) => {
      const mime = part.mimeType ?? '';
      const filename = part.filename ?? '';
      if (mime === 'text/plain' && part.body?.data) {
        bodyText += Buffer.from(part.body.data, 'base64url').toString('utf8');
      } else if (mime === 'text/html' && part.body?.data) {
        bodyHtml += Buffer.from(part.body.data, 'base64url').toString('utf8');
      } else if (filename && part.body?.attachmentId) {
        attachmentsMeta.push({
          filename,
          mimeType: mime,
          attachmentId: part.body.attachmentId,
          size: part.body.size ?? 0,
        });
      }
      for (const sub of part.parts ?? []) visit(sub);
    };
    visit(payload);

    return { bodyText, bodyHtml, attachmentsMeta };
  }

  /**
   * Download each attachment and persist to S3 under inbound-attachments/.
   */
  private async persistAttachments(
    metas: { filename: string; mimeType: string; attachmentId: string; size: number }[],
    gmail: gmail_v1.Gmail,
    gmailInternalId: string,
    hospitalId: string
  ): Promise<{ filename: string; s3_key: string; mime_type: string; size_bytes: number }[]> {
    const persisted: { filename: string; s3_key: string; mime_type: string; size_bytes: number }[] = [];

    for (const meta of metas) {
      try {
        const attRes = await withGmailRetry(
          () => gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: gmailInternalId,
            id: meta.attachmentId,
          }),
          { context: { hospitalId, op: 'attachments.get', gmailInternalId, filename: meta.filename } },
        );
        if (!attRes.data.data) continue;
        const buf = Buffer.from(attRes.data.data, 'base64url');
        const safeName = meta.filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
        const s3Key = `inbound-attachments/${hospitalId}/${gmailInternalId}/${Date.now()}_${safeName}`;
        await S3Service.upload(s3Key, buf, meta.mimeType || 'application/octet-stream');
        persisted.push({
          filename: meta.filename,
          s3_key: s3Key,
          mime_type: meta.mimeType,
          size_bytes: buf.length,
        });
      } catch (err) {
        logger.warn(
          { err, filename: meta.filename, gmailInternalId },
          'inbound attachment download failed (non-fatal)'
        );
      }
    }

    return persisted;
  }
}

export default new GmailInboundService();
