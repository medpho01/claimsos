import { google } from 'googleapis';
import { logger } from '../Utils/logger.js';
import apiError from '../Utils/errorHandler.util.js';
import gmailAuthService from './gmailAuth.service.js';
import { withGmailRetry } from '../Utils/gmailRetry.util.js';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Gmail Send Service
 *
 * Thin wrapper around the Gmail API for sending RFC822-formatted messages
 * from a hospital's authenticated account. Handles MIME assembly with
 * attachments, threading headers (In-Reply-To / References), and captures
 * the resulting Message-Id + Thread-Id for downstream threading.
 *
 * Reads attachments from S3 keys — the caller passes a list of S3 keys
 * + filenames; this service streams each and base64-encodes into the MIME
 * envelope.
 */

export interface OutgoingEmail {
  hospitalId: string;
  fromAddress: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments?: { filename: string; s3Key: string; mimeType: string }[];

  // Threading
  inReplyTo?: string;          // Message-Id of the message we're replying to
  references?: string;         // References header chain
  threadId?: string;           // Gmail thread to attach this reply to
}

export interface SendResult {
  gmailMessageId: string;      // RFC822 Message-Id header
  gmailThreadId: string;       // Gmail's internal thread identifier
  gmailInternalId: string;     // Gmail's per-message internal id
}

const CRLF = '\r\n';
const BOUNDARY_MIXED = 'mixed-boundary-3142';
const BOUNDARY_ALT = 'alt-boundary-3142';

function encodeBase64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encodeHeader(value: string): string {
  // Quoted-printable for non-ASCII — most insurer subjects are plain ASCII
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

async function fetchS3(key: string): Promise<{ buffer: Buffer; size: number }> {
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;
  if (!region || !bucket) {
    throw new apiError(500, 'AWS_REGION / AWS_S3_BUCKET not configured');
  }
  const client = new S3Client({ region });
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) {
    throw new apiError(500, `Empty body fetching s3://${bucket}/${key}`);
  }
  const chunks: Uint8Array[] = [];
  // @ts-expect-error — Node Readable iterator
  for await (const chunk of response.Body) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  return { buffer, size: buffer.length };
}

class GmailSendService {
  /**
   * Compose a MIME multipart message ready for Gmail send.
   * Always uses multipart/mixed (top) and multipart/alternative (text + html).
   */
  private async buildMime(email: OutgoingEmail): Promise<string> {
    const headers: string[] = [];
    headers.push(`From: ${email.fromAddress}`);
    headers.push(`To: ${email.to.join(', ')}`);
    if (email.cc && email.cc.length) headers.push(`Cc: ${email.cc.join(', ')}`);
    if (email.bcc && email.bcc.length) headers.push(`Bcc: ${email.bcc.join(', ')}`);
    if (email.replyTo) headers.push(`Reply-To: ${email.replyTo}`);
    headers.push(`Subject: ${encodeHeader(email.subject)}`);
    headers.push('MIME-Version: 1.0');
    if (email.inReplyTo) headers.push(`In-Reply-To: <${email.inReplyTo.replace(/^<|>$/g, '')}>`);
    if (email.references) headers.push(`References: ${email.references}`);

    const hasAttachments = (email.attachments?.length ?? 0) > 0;

    if (hasAttachments) {
      headers.push(`Content-Type: multipart/mixed; boundary="${BOUNDARY_MIXED}"`);

      const textBody = email.bodyText ?? '';
      const htmlBody = email.bodyHtml ?? `<pre>${textBody}</pre>`;

      const altPart =
        `--${BOUNDARY_MIXED}${CRLF}` +
        `Content-Type: multipart/alternative; boundary="${BOUNDARY_ALT}"${CRLF}${CRLF}` +
        `--${BOUNDARY_ALT}${CRLF}` +
        `Content-Type: text/plain; charset="UTF-8"${CRLF}` +
        `Content-Transfer-Encoding: 7bit${CRLF}${CRLF}` +
        `${textBody}${CRLF}${CRLF}` +
        `--${BOUNDARY_ALT}${CRLF}` +
        `Content-Type: text/html; charset="UTF-8"${CRLF}` +
        `Content-Transfer-Encoding: 7bit${CRLF}${CRLF}` +
        `${htmlBody}${CRLF}${CRLF}` +
        `--${BOUNDARY_ALT}--${CRLF}${CRLF}`;

      // Attachment parts (streamed from S3)
      const attachmentParts: string[] = [];
      for (const att of email.attachments ?? []) {
        const { buffer } = await fetchS3(att.s3Key);
        const b64 = buffer.toString('base64').replace(/.{76}/g, '$&' + CRLF);
        attachmentParts.push(
          `--${BOUNDARY_MIXED}${CRLF}` +
            `Content-Type: ${att.mimeType}; name="${att.filename}"${CRLF}` +
            `Content-Transfer-Encoding: base64${CRLF}` +
            `Content-Disposition: attachment; filename="${att.filename}"${CRLF}${CRLF}` +
            b64 +
            `${CRLF}`
        );
      }

      return (
        headers.join(CRLF) +
        CRLF +
        CRLF +
        altPart +
        attachmentParts.join('') +
        `--${BOUNDARY_MIXED}--${CRLF}`
      );
    }

    // No attachments — simple multipart/alternative
    headers.push(`Content-Type: multipart/alternative; boundary="${BOUNDARY_ALT}"`);
    const textBody = email.bodyText ?? '';
    const htmlBody = email.bodyHtml ?? `<pre>${textBody}</pre>`;
    return (
      headers.join(CRLF) +
      CRLF +
      CRLF +
      `--${BOUNDARY_ALT}${CRLF}` +
      `Content-Type: text/plain; charset="UTF-8"${CRLF}${CRLF}` +
      `${textBody}${CRLF}${CRLF}` +
      `--${BOUNDARY_ALT}${CRLF}` +
      `Content-Type: text/html; charset="UTF-8"${CRLF}${CRLF}` +
      `${htmlBody}${CRLF}${CRLF}` +
      `--${BOUNDARY_ALT}--${CRLF}`
    );
  }

  /**
   * Send an email via Gmail API using the hospital's stored OAuth.
   * Returns Gmail's Message-Id / Thread-Id for downstream threading.
   */
  async send(email: OutgoingEmail): Promise<SendResult> {
    if (!email.to || email.to.length === 0) {
      throw new apiError(400, 'At least one "to" address required');
    }

    const client = await gmailAuthService.getAuthenticatedClient(email.hospitalId);
    const gmail = google.gmail({ version: 'v1', auth: client });

    const mime = await this.buildMime(email);
    const raw = encodeBase64Url(Buffer.from(mime));

    const sendRes = await withGmailRetry(
      () => gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId: email.threadId },
      }),
      { context: { hospitalId: email.hospitalId, op: 'messages.send' } },
    );

    const messageId = sendRes.data.id;
    const threadId = sendRes.data.threadId;
    if (!messageId || !threadId) {
      throw new apiError(500, 'Gmail send returned no message_id / thread_id');
    }

    // Fetch the headers to capture the Message-Id header (different from
    // Gmail's internal id; used for threading by external recipients).
    const metaRes = await withGmailRetry(
      () => gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['Message-Id'],
      }),
      { context: { hospitalId: email.hospitalId, op: 'messages.get' } },
    );
    const messageIdHeader =
      metaRes.data.payload?.headers?.find(h => h.name?.toLowerCase() === 'message-id')?.value ??
      messageId;

    logger.info(
      {
        hospitalId: email.hospitalId,
        to: email.to,
        subject: email.subject,
        gmailMessageId: messageIdHeader,
        gmailThreadId: threadId,
      },
      'Gmail send succeeded'
    );

    return {
      gmailMessageId: messageIdHeader,
      gmailThreadId: threadId,
      gmailInternalId: messageId,
    };
  }
}

export default new GmailSendService();
