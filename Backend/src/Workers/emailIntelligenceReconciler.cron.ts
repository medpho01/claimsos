/**
 * Email-Intelligence Reconciler + Health Monitor
 *
 * Companion to the inbound pipeline. Two passes, run on an interval in the
 * worker container only (RUN_WORKERS !== 'false').
 *
 *   PASS 1 — RECOVERY (reconcileUnprocessed): finds inbound emails that were
 *     matched to a claim but have NO email_intelligence_draft for the current
 *     EMAIL_INTEL_VERSION (aged > grace period), and re-enqueues the
 *     intelligence pipeline. Heals emails dropped by a transient enqueue
 *     failure / worker outage. Self-terminating: once a draft exists the WHERE
 *     clause flips false and the row stops being re-picked. Bounded per run.
 *
 *   PASS 2 — HEALTH (emitHealthSignals): counts stuck states and (a) updates
 *     Prometheus gauges scraped at /metrics, and (b) logs at WARN/ERROR with
 *     structured fields so a log-based alerter can page. Covers the silent
 *     failures the pipeline previously had no visibility into:
 *       - inbound emails matched but unprocessed (recovery backlog)
 *       - unmatched ops backlog (needs_ops_review)
 *       - failed outbound sends (insurer email never delivered)
 *       - unhealthy Gmail interfaces (token_expired / error / disconnected)
 *       - AI drafts pending review (human-review backlog)
 *
 * Gating: dormant when RUN_WORKERS=false (API container) or
 * EMAIL_INTEL_RECONCILER_ENABLED=false.
 */
import client from 'prom-client';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import { EMAIL_INTEL_VERSION } from '../Services/emailIntelligence.service.js';

const INTERVAL_MS = Number(process.env.EMAIL_INTEL_RECONCILER_INTERVAL_MS ?? 120_000);
const RECOVERY_GRACE_MIN = Number(process.env.EMAIL_INTEL_RECOVERY_GRACE_MIN ?? 3);
const RECOVERY_BATCH = Number(process.env.EMAIL_INTEL_RECOVERY_BATCH ?? 50);
const OUTBOUND_FAILED_AGE_MIN = Number(process.env.OUTBOUND_FAILED_AGE_MIN ?? 10);

// ── Prometheus gauges (registered on the default registry served at /metrics) ─
function gauge(name: string, help: string) {
  return (
    (client.register.getSingleMetric(name) as client.Gauge<string>) ??
    new client.Gauge({ name, help })
  );
}
const gUnprocessed = gauge('claimos_inbound_unprocessed_total', 'Matched inbound emails with no AI draft');
const gUnmatched = gauge('claimos_inbound_unmatched_total', 'Inbound emails needing ops review (unmatched)');
const gOutboundFailed = gauge('claimos_outbound_failed_total', 'Outbound insurer emails in failed state');
const gInterfacesUnhealthy = gauge('claimos_gmail_interfaces_unhealthy_total', 'Gmail interfaces in token_expired/error/disconnected');
const gDraftsPending = gauge('claimos_ai_drafts_pending_total', 'AI drafts awaiting human review');

async function reconcileUnprocessed(): Promise<number> {
  // Matched emails with no draft for the current version, past the grace window.
  const { rows } = await pool.query(
    `SELECT e.id, e.hospital_id, e.matched_ipd_id, e.body_text, e.attachments
       FROM hospital.emails_inbound e
       LEFT JOIN hospital.email_intelligence_drafts d
              ON d.inbound_email_id = e.id AND d.prompt_version = $1
      WHERE e.matched_ipd_id IS NOT NULL
        AND d.id IS NULL
        AND e.received_at < NOW() - ($2 || ' minutes')::interval
      ORDER BY e.received_at DESC
      LIMIT $3`,
    [EMAIL_INTEL_VERSION, String(RECOVERY_GRACE_MIN), RECOVERY_BATCH],
  );
  if (rows.length === 0) return 0;

  const { enqueueEmailIntelligence } = await import('./emailIntelligence.queue.js');
  let requeued = 0;
  for (const e of rows) {
    try {
      const atts = Array.isArray(e.attachments) ? e.attachments : [];
      const s3AttachmentKeys = atts
        .filter((a: any) => a?.s3_key)
        .map((a: any) => ({
          s3Key: a.s3_key,
          filename: a.filename ?? 'attachment',
          mime: a.mime_type ?? 'application/octet-stream',
        }));
      await enqueueEmailIntelligence({
        inboundEmailId: e.id,
        claimId: e.matched_ipd_id,
        hospitalId: e.hospital_id,
        body: e.body_text ?? '',
        s3AttachmentKeys,
      });
      requeued++;
    } catch (err) {
      logger.warn({ err, inboundEmailId: e.id }, 'emailIntelReconciler: re-enqueue failed');
    }
  }
  if (requeued > 0) {
    logger.info({ requeued }, 'emailIntelReconciler: re-drove unprocessed inbound emails');
  }
  return requeued;
}

async function emitHealthSignals(): Promise<void> {
  const q = async (sql: string, params: any[] = []) =>
    Number((await pool.query(sql, params)).rows[0]?.n ?? 0);

  const [unprocessed, unmatched, outboundFailed, interfacesUnhealthy, draftsPending] = await Promise.all([
    q(`SELECT count(*) AS n FROM hospital.emails_inbound e
        LEFT JOIN hospital.email_intelligence_drafts d
               ON d.inbound_email_id = e.id AND d.prompt_version = $1
       WHERE e.matched_ipd_id IS NOT NULL AND d.id IS NULL
         AND e.received_at < NOW() - ($2 || ' minutes')::interval`, [EMAIL_INTEL_VERSION, String(RECOVERY_GRACE_MIN)]),
    q(`SELECT count(*) AS n FROM hospital.emails_inbound WHERE needs_ops_review = TRUE AND matched_ipd_id IS NULL`),
    q(`SELECT count(*) AS n FROM hospital.emails_outbound WHERE status = 'failed' AND updated_at < NOW() - ($1 || ' minutes')::interval`, [String(OUTBOUND_FAILED_AGE_MIN)]),
    q(`SELECT count(*) AS n FROM hospital.hospital_interfaces WHERE kind = 'email' AND status IN ('token_expired','error','disconnected')`),
    q(`SELECT count(*) AS n FROM hospital.email_intelligence_drafts WHERE status = 'pending_review'`),
  ]);

  gUnprocessed.set(unprocessed);
  gUnmatched.set(unmatched);
  gOutboundFailed.set(outboundFailed);
  gInterfacesUnhealthy.set(interfacesUnhealthy);
  gDraftsPending.set(draftsPending);

  // Alert-worthy conditions → ERROR (a log alerter pages on these). The rest is
  // INFO context. Tunable, but defaults flag genuinely-actionable states.
  if (outboundFailed > 0 || interfacesUnhealthy > 0) {
    logger.error(
      { outboundFailed, interfacesUnhealthy, unprocessed, unmatched, draftsPending },
      'emailIntelReconciler: ALERT — insurer email delivery or Gmail auth is degraded',
    );
  } else if (unprocessed > 0 || unmatched > 5) {
    logger.warn(
      { unprocessed, unmatched, draftsPending },
      'emailIntelReconciler: inbound backlog building',
    );
  } else {
    logger.info({ draftsPending }, 'emailIntelReconciler: pipeline healthy');
  }
}

export function startEmailIntelligenceReconciler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (process.env.RUN_WORKERS === 'false') {
    logger.info('emailIntelReconciler NOT started (RUN_WORKERS=false — API container)');
    return;
  }
  if (process.env.EMAIL_INTEL_RECONCILER_ENABLED === 'false') {
    logger.info('emailIntelReconciler disabled via EMAIL_INTEL_RECONCILER_ENABLED=false');
    return;
  }

  const tick = async () => {
    try {
      await reconcileUnprocessed();
      await emitHealthSignals();
    } catch (err) {
      logger.error({ err }, 'emailIntelReconciler tick failed');
    }
  };

  setInterval(() => void tick(), INTERVAL_MS);
  logger.info({ intervalMs: INTERVAL_MS }, 'emailIntelReconciler started');
  // Kick once shortly after boot (not inline, so startup isn't blocked).
  setTimeout(() => void tick(), 15_000);
}
