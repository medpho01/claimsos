import React, { useEffect, useImperativeHandle, useState, forwardRef } from 'react';
import {
  AlertCircle,
  Loader2,
  Wallet,
  Construction,
  Send,
  Reply,
  Paperclip,
  FileText,
  FileImage,
  File as FileIcon,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { toast } from 'sonner';
import apiService from '@/services/api';

interface PreflightResponse {
  ready: boolean;
  blockers: { code: string; message: string }[];
  filing_route?: 'cashless_everywhere' | 'network' | null;
}

interface Attachment {
  filename: string;
  s3_key: string;
  mime_type: string;
  size_bytes: number;
  source?: string;
  view_url?: string | null;
  // Authenticated backend proxy URL (mirrors Patient Documents). Preferred over
  // view_url because it works even when the S3 bucket is private and the
  // CloudFront signing key isn't configured.
  proxy_url?: string | null;
  ipd_doc_id?: string | null;
}

interface SubmissionRow {
  id: string;
  status: string;
  external_claim_id: string | null;
  drafted_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  attempt_number: number;
  panel_name: string;
  panel_code: string;
  subject: string | null;
  to_addresses: string[] | null;
  cc_addresses: string[] | null;
  outbound_body_text: string | null;
  outbound_from: string | null;
  outbound_attachments: Attachment[] | null;
  // Audit trail (P6) — who composed this submission. Joined from hospital.users
  // in listSubmissions. Used to render "Sent by … at …" line under SENT cards.
  submitted_by?: string | null;
  submitted_by_first_name?: string | null;
  submitted_by_last_name?: string | null;
  submitted_by_username?: string | null;
}

interface InboundEmailRow {
  id: string;
  received_at: string;
  from_address: string;
  subject: string;
  body_text: string;
  classification: string;
  match_method: string;
  gmail_message_id: string;
  matched_submission_id: string | null;
  attachments: Attachment[];
  // AI read of this email (from the latest email_intelligence_draft):
  ai_category?: string | null;
  ai_draft_status?: string | null;
  ai_draft_id?: string | null;
  ai_deficiency_count?: number | null;
}

export interface TimelineRef {
  refresh: () => Promise<{ processed: number }>;
  /** Scroll an inbound email card into view and briefly highlight it. Used by
   *  the AI Suggestions card to jump to the source email ("proof"). */
  focusEmail: (inboundEmailId: string) => void;
}

interface Props {
  ipdId: string;
  hospitalId: string;
  // Called when user clicks "Reply" on an inbound card (P1). Parent typically
  // opens the InsuranceComposeModal — threading happens automatically because
  // the send-path looks up the latest thread for this IPD.
  onReplyToInbound?: () => void;
}

// ----- helpers -----

const fmtTime = (s: string | null | undefined) => {
  if (!s) return '—';
  const d = new Date(s);
  const now = Date.now();
  const delta = (now - d.getTime()) / 1000;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtSize = (bytes?: number | null) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const statusStyles = (status: string) => {
  if (/approved/i.test(status)) return 'pill-ok';
  if (/queried|action/i.test(status)) return 'pill-warn';
  if (/rejected|failed/i.test(status)) return 'pill-danger';
  if (/sent|acknowledged/i.test(status)) return 'pill-info';
  return 'pill-muted';
};

type CommItem =
  | { kind: 'outbound'; ts: Date; row: SubmissionRow }
  | { kind: 'inbound'; ts: Date; row: InboundEmailRow };

// ----- attachment preview -----

/**
 * Fetch a backend-proxied attachment with auth and turn it into an object URL.
 * Mirrors `fetchAuthedBlob` in PatientDocumentsPanel — uses axios so the
 * refresh-token interceptor handles 401s. Caller is responsible for revoking
 * the URL when no longer needed.
 */
async function fetchAuthedAttachmentBlob(proxyUrl: string): Promise<string> {
  const blob = await apiService.downloadBlob(proxyUrl);
  return URL.createObjectURL(blob);
}

const AttachmentPreview: React.FC<{ attachment: Attachment }> = ({ attachment }) => {
  const isImage = attachment.mime_type?.startsWith('image/');
  const isPdf = (attachment.mime_type ?? '').includes('pdf');

  // Prefer the authenticated proxy URL (works against private S3 buckets) over
  // the CloudFront/raw-S3 view URL. Falls back when the attachment didn't get
  // auto-mirrored to ipd_doc for some reason.
  const proxyUrl = attachment.proxy_url ?? null;
  const fallbackUrl = attachment.view_url ?? null;

  // For images: pre-load via the auth-proxy and render the blob URL inline.
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage || !proxyUrl) return;
    let revoke: string | null = null;
    let cancelled = false;
    fetchAuthedAttachmentBlob(proxyUrl)
      .then(url => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        revoke = url;
        setImageSrc(url);
      })
      .catch(() => {
        // proxy failed — fall back to view_url (raw S3) which the public path
        // already handles, no need to surface an error in the thumbnail
      });
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [isImage, proxyUrl]);

  // Click-to-open handler: fetch via authed proxy, open the resulting blob
  // URL in a new tab. Used for PDFs and as the image click target.
  const openProxied = async (e: React.MouseEvent) => {
    if (!proxyUrl) return; // fall through to native link
    e.preventDefault();
    try {
      const url = await fetchAuthedAttachmentBlob(proxyUrl);
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      // Revoke after the tab has had a chance to load. 60s is conservative;
      // a missed revoke is a small memory leak, never a functional bug.
      if (win) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast.error('Failed to open attachment');
    }
  };

  // Image: small thumbnail with click-to-open
  if (isImage && (imageSrc || fallbackUrl)) {
    const src = imageSrc ?? fallbackUrl!;
    return (
      <a
        href={proxyUrl ? '#' : fallbackUrl ?? '#'}
        target="_blank"
        rel="noopener noreferrer"
        onClick={proxyUrl ? openProxied : undefined}
        className="group block flex-shrink-0 relative"
        title={attachment.filename}
      >
        <img
          src={src}
          alt={attachment.filename}
          loading="lazy"
          className="h-20 w-20 object-cover rounded border border-slate-200 dark:border-slate-700 group-hover:ring-2 group-hover:ring-brand-500 transition"
        />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent text-[10px] text-white px-1 py-0.5 truncate rounded-b">
          {attachment.filename}
        </div>
      </a>
    );
  }

  // PDF or other: file card
  const Icon = isPdf ? FileText : FileIcon;
  const iconColor = isPdf
    ? 'text-rose-600 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40'
    : 'text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800';

  const hasOpener = !!(proxyUrl || fallbackUrl);
  return (
    <a
      href={proxyUrl ? '#' : fallbackUrl ?? '#'}
      target={proxyUrl ? undefined : (fallbackUrl ? '_blank' : undefined)}
      rel="noopener noreferrer"
      onClick={proxyUrl ? openProxied : (!fallbackUrl ? e => e.preventDefault() : undefined)}
      className={`flex items-center gap-2 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 hover:border-brand-400 hover:bg-slate-50 dark:hover:bg-slate-800/70 max-w-[260px] transition group ${
        !hasOpener ? 'cursor-not-allowed opacity-50' : ''
      }`}
      title={attachment.filename}
    >
      <div className={`flex-shrink-0 h-8 w-8 rounded flex items-center justify-center ${iconColor}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
          {attachment.filename}
        </div>
        <div className="text-[10px] text-slate-500">
          {isPdf ? 'PDF' : (attachment.mime_type ?? 'File')} · {fmtSize(attachment.size_bytes)}
        </div>
      </div>
      {hasOpener && (
        <ExternalLink className="h-3 w-3 text-slate-400 group-hover:text-brand-600 flex-shrink-0" />
      )}
    </a>
  );
};

// ----- attachment row -----

const Attachments: React.FC<{ items?: Attachment[] | null }> = ({ items }) => {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.map((a, i) => (
        <AttachmentPreview key={i} attachment={a} />
      ))}
    </div>
  );
};

// ----- AI email badge (per-email classification + action-needed) -----

// Tone per insurer-outcome category. Both the matcher's quick spelling
// ('approval'/'query'/'rejection') and the intelligence draft's category
// ('approved'/'queried'/'rejected') map to the same badge.
const AI_BADGE: Record<string, { label: string; cls: string; action?: boolean }> = {
  approval: { label: 'Approval', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/50' },
  approved: { label: 'Approval', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/50' },
  partially_approved: { label: 'Partial approval', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/50' },
  enhancement_approved: { label: 'Enhancement approved', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/50' },
  query: { label: 'Query', cls: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/50', action: true },
  queried: { label: 'Query', cls: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900/50', action: true },
  rejection: { label: 'Rejected', cls: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900/50', action: true },
  rejected: { label: 'Rejected', cls: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900/50', action: true },
  withdrawn: { label: 'Withdrawn', cls: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900/50' },
  settlement: { label: 'Settlement', cls: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900/50' },
  acknowledged: { label: 'Acknowledged', cls: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700' },
  ack: { label: 'Acknowledged', cls: 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700' },
};

const AiEmailBadge: React.FC<{ row: InboundEmailRow }> = ({ row }) => {
  // Prefer the intelligence draft's category; fall back to the matcher's label.
  const cat = (row.ai_category || row.classification || '').toLowerCase();
  const meta = AI_BADGE[cat];
  if (!meta) return null; // 'received' / 'other' / unknown → no badge
  const defs = row.ai_deficiency_count ?? 0;
  const isQuery = cat === 'query' || cat === 'queried';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ${meta.cls}`}
      title={
        meta.action
          ? isQuery && defs > 0
            ? `Action needed — insurer requested ${defs} document${defs > 1 ? 's' : ''}`
            : 'Action needed'
          : `AI read this email as: ${meta.label}`
      }
    >
      {meta.action && <AlertCircle className="h-3 w-3" />}
      {meta.label}
      {isQuery && defs > 0 && (
        <span className="font-bold">· {defs} doc{defs > 1 ? 's' : ''} requested</span>
      )}
    </span>
  );
};

// ----- communication card -----

const CommCard: React.FC<{
  item: CommItem;
  // P1: callback for "Reply" button on inbound cards. The parent opens the
  // compose modal which threads off the existing gmail_thread_id by default,
  // so all we need to do is open it — the modal handles the threading.
  onReply?: () => void;
  // When true, this card is the deep-link target (the AI suggestion's source
  // email) — render a temporary highlight ring.
  highlighted?: boolean;
}> = ({ item, onReply, highlighted }) => {
  const [expanded, setExpanded] = useState(false);
  const isOutbound = item.kind === 'outbound';

  const subject = isOutbound ? item.row.subject : item.row.subject;
  const body = isOutbound ? item.row.outbound_body_text : item.row.body_text;
  const attachments: Attachment[] = isOutbound
    ? (item.row.outbound_attachments ?? [])
    : (item.row.attachments ?? []);

  const snippet = (body ?? '').replace(/\s+/g, ' ').slice(0, 140);
  const hasMoreToShow = (body ?? '').length > snippet.length;

  return (
    <div
      id={`${isOutbound ? 'out' : 'in'}-${item.row.id}`}
      className={`border bg-white dark:bg-slate-900 rounded-lg overflow-hidden transition-all duration-500 ${
        highlighted
          ? 'border-indigo-400 ring-2 ring-indigo-300/70 dark:border-indigo-500 dark:ring-indigo-700/60'
          : 'border-slate-200 dark:border-slate-700'
      }`}
    >
      <div className="px-4 py-3">
        {/* Header row */}
        <div className="flex items-start gap-3">
          {/* Direction badge */}
          <div
            className={`flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center ring-1 ${
              isOutbound
                ? 'bg-brand-600/15 ring-brand-600/30 text-brand-700 dark:text-brand-300'
                : 'bg-info-600/15 ring-info-600/30 text-info-700 dark:text-info-300'
            }`}
            title={isOutbound ? 'Sent' : 'Received'}
          >
            {isOutbound ? (
              <Send className="h-4 w-4" strokeWidth={2.2} />
            ) : (
              <Reply className="h-4 w-4" strokeWidth={2.2} />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`text-[11px] uppercase tracking-wide font-semibold ${
                  isOutbound
                    ? 'text-brand-700 dark:text-brand-300'
                    : 'text-info-700 dark:text-info-300'
                }`}
              >
                {isOutbound ? 'Sent' : 'Received'}
              </span>
              {isOutbound && (
                <span className={`pill ${statusStyles(item.row.status)} text-[10px]`}>
                  {item.row.status}
                </span>
              )}
              {/* AI read of the insurer reply — flags "action needed" on
                  query/rejection emails, with the requested-doc count. */}
              {!isOutbound && <AiEmailBadge row={item.row as InboundEmailRow} />}
              <span className="text-xs text-slate-500">·</span>
              <span className="text-xs text-slate-500" title={item.ts.toLocaleString()}>
                {fmtTime(item.ts.toISOString())}
              </span>
              {attachments.length > 0 && (
                <>
                  <span className="text-xs text-slate-500">·</span>
                  <span className="text-xs text-slate-500 inline-flex items-center gap-1">
                    <Paperclip className="h-3 w-3" />
                    {attachments.length}
                  </span>
                </>
              )}
              {/* P6 audit trail: who composed this outbound. Only shown for
                  SENT cards because inbound has no submitter (it's the insurer). */}
              {isOutbound && (() => {
                const r = item.row as SubmissionRow;
                const name = [r.submitted_by_first_name, r.submitted_by_last_name]
                  .filter(Boolean).join(' ').trim() || r.submitted_by_username;
                if (!name) return null;
                return (
                  <>
                    <span className="text-xs text-slate-500">·</span>
                    <span className="text-xs text-slate-500" title={`Submitted by ${name}`}>
                      by {name}
                    </span>
                  </>
                );
              })()}
            </div>

            {/* Subject */}
            {subject && (
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50 mt-1 truncate">
                {subject}
              </div>
            )}

            {/* From/To line */}
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {isOutbound ? (
                <>
                  <span>From: {item.row.outbound_from || 'Hospital'}</span>
                  <span className="mx-1.5">·</span>
                  <span>To: {item.row.to_addresses?.join(', ') ?? '—'}</span>
                </>
              ) : (
                <span>From: {item.row.from_address}</span>
              )}
            </div>

            {/* Body snippet OR full */}
            {body && !expanded && (
              <div className="text-xs text-slate-600 dark:text-slate-400 mt-2 line-clamp-2">
                {snippet}
                {hasMoreToShow && '…'}
              </div>
            )}
            {body && expanded && (
              <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-sans bg-slate-50 dark:bg-slate-800/60 p-3 rounded mt-2 max-h-96 overflow-y-auto">
                {body}
              </pre>
            )}

            {/* Attachments */}
            {expanded && attachments.length > 0 && <Attachments items={attachments} />}

            {/* Footer controls */}
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              {(body || attachments.length > 0) && (
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
                >
                  {expanded ? (
                    <>
                      <ChevronUp className="h-3 w-3" />
                      Show less
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3 w-3" />
                      {attachments.length > 0
                        ? `Show full · ${attachments.length} attachment(s)`
                        : 'Show full'}
                    </>
                  )}
                </button>
              )}
              {/* P1: Reply CTA on inbound cards only. Outbound cards have no
                  reply concept; the user composes a fresh send instead.
                  Click → opens InsuranceComposeModal which threads off
                  thread_id automatically (already in send-path logic). */}
              {!isOutbound && onReply && (
                <button
                  onClick={onReply}
                  className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium border border-brand-200 dark:border-brand-800 rounded px-2 py-1 hover:bg-brand-50 dark:hover:bg-brand-950/30 transition-colors"
                  title="Reply on the same thread"
                >
                  <Reply className="h-3 w-3" />
                  Reply
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ----- main panel -----

const InsuranceTimelinePanel = forwardRef<TimelineRef, Props>(({ ipdId, hospitalId, onReplyToInbound }, ref) => {
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [inbound, setInbound] = useState<InboundEmailRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingRoute, setSavingRoute] = useState(false);
  // Email card to scroll-to + highlight (set by focusEmail via the ref).
  const [focusedEmailId, setFocusedEmailId] = useState<string | null>(null);

  const fetch = async (showLoader: boolean) => {
    try {
      if (showLoader) {
        setLoading(true);
        setError(null);
      }
      const [preflightRes, subsRes, inboundRes] = await Promise.all([
        apiService.insurancePreflight(ipdId, hospitalId).catch((err: any) => {
          const errJson = err?.response?.data;
          if (errJson?.error) {
            try {
              const parsed = JSON.parse(errJson.error);
              if (parsed.blockers) {
                return { data: { data: { ready: false, blockers: parsed.blockers } } };
              }
            } catch {}
          }
          throw err;
        }),
        apiService.listInsuranceSubmissions(ipdId, hospitalId),
        apiService.listIpdInboundEmails(ipdId, hospitalId),
      ]);
      setPreflight(preflightRes.data?.data);
      setSubmissions(subsRes.data?.data ?? []);
      setInbound(inboundRes.data?.data ?? []);
    } catch (err: any) {
      if (showLoader) {
        setError(err?.response?.data?.error || err?.message || 'Failed to load timeline');
      }
    } finally {
      if (showLoader) setLoading(false);
    }
  };

  // Expose imperative refresh to parent (so the patient-level Refresh button can drive this panel)
  useImperativeHandle(ref, () => ({
    refresh: async () => {
      const pollRes = await apiService.forceGmailPoll(hospitalId).catch(() => null);
      await fetch(false);
      return { processed: pollRes?.data?.data?.processed ?? 0 };
    },
    focusEmail: (inboundEmailId: string) => {
      setFocusedEmailId(inboundEmailId);
      // Defer until the card is in the DOM (tab may have just switched).
      const tryScroll = (attempt: number) => {
        const el = document.getElementById(`in-${inboundEmailId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (attempt < 25) {
          // Card may not be in the DOM yet — tab just switched and the
          // timeline is still loading its inbound emails. Keep retrying ~3s.
          setTimeout(() => tryScroll(attempt + 1), 120);
        }
      };
      tryScroll(0);
      // Clear the highlight after a few seconds.
      setTimeout(() => setFocusedEmailId((cur) => (cur === inboundEmailId ? null : cur)), 4000);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    const wrappedFetch = async (showLoader: boolean) => {
      if (cancelled) return;
      await fetch(showLoader);
    };
    wrappedFetch(true);
    const intervalId = setInterval(() => wrappedFetch(false), 8000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ipdId, hospitalId]);

  const setFilingRoute = async (route: 'cashless_everywhere' | 'network') => {
    try {
      setSavingRoute(true);
      await apiService.setIpdFilingRoute(ipdId, hospitalId, route);
      toast.success(
        `Filing route set to ${route === 'cashless_everywhere' ? 'Cashless Everywhere' : 'Network'}`
      );
      await fetch(true);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to set filing route');
    } finally {
      setSavingRoute(false);
    }
  };

  if (loading) {
    return (
      <div className="px-5 py-6 flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading communications…
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-5 py-6 text-sm text-danger-700 flex items-center gap-2">
        <AlertCircle className="h-4 w-4" /> {error}
      </div>
    );
  }

  const route = preflight?.filing_route;
  if (!route) {
    return (
      <div className="px-5 py-8">
        <div className="max-w-xl mx-auto text-center">
          <Wallet className="h-10 w-10 text-slate-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Set the filing route for this patient
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            How will the claim be submitted to the insurer? This is independent of which insurer
            actually pays — it sets the <em>mechanism</em>.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-5 text-left">
            <button
              disabled={savingRoute}
              onClick={() => setFilingRoute('cashless_everywhere')}
              className="border border-slate-200 dark:border-slate-700 rounded-lg p-4 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Cashless Everywhere
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Hospital is NOT empanelled with the insurer. File via email.
              </div>
            </button>
            <button
              disabled={savingRoute}
              onClick={() => setFilingRoute('network')}
              className="border border-slate-200 dark:border-slate-700 rounded-lg p-4 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Network
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Hospital is empanelled. Portal RPA — coming soon.
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (route === 'network') {
    return (
      <div className="px-5 py-12">
        <div className="max-w-md mx-auto text-center">
          <Construction className="h-10 w-10 text-slate-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Network (portal) filing — Coming Soon
          </h3>
          <p className="text-sm text-slate-500 mt-2">
            Automated portal submissions for network-empanelled claims are not yet built. File this
            claim manually through the insurer's portal for now.
          </p>
        </div>
      </div>
    );
  }

  if (!preflight?.ready && preflight?.blockers?.length) {
    return (
      <div className="px-5 py-6">
        <div className="p-3 rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="text-sm">
              <div className="font-medium text-amber-900 dark:text-amber-100 mb-1">
                Cashless Everywhere is not fully configured yet:
              </div>
              <ul className="list-disc pl-5 space-y-1 text-amber-800 dark:text-amber-200">
                {preflight.blockers.map((b, i) => (
                  <li key={i}>{b.message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Build flat list, sorted RECENT-FIRST (newest at top)
  const items: CommItem[] = [];
  for (const sub of submissions) {
    items.push({
      kind: 'outbound',
      ts: new Date(sub.sent_at ?? sub.drafted_at),
      row: sub,
    });
  }
  for (const ib of inbound) {
    items.push({ kind: 'inbound', ts: new Date(ib.received_at), row: ib });
  }
  items.sort((a, b) => b.ts.getTime() - a.ts.getTime());

  if (items.length === 0) {
    return (
      <div className="px-5 py-12 text-sm text-slate-500 text-center">
        No communications yet. Click <strong>Send</strong> above to send the first email.
      </div>
    );
  }

  return (
    <div className="px-5 py-4 space-y-2.5">
      {items.map(it => (
        <CommCard
          key={it.kind === 'outbound' ? `out-${it.row.id}` : `in-${it.row.id}`}
          item={it}
          onReply={it.kind === 'inbound' ? onReplyToInbound : undefined}
          highlighted={it.kind === 'inbound' && it.row.id === focusedEmailId}
        />
      ))}
    </div>
  );
});

InsuranceTimelinePanel.displayName = 'InsuranceTimelinePanel';

export default InsuranceTimelinePanel;
