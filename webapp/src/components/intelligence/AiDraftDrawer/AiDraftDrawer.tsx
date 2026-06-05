import React, { useEffect, useMemo, useState } from 'react';
import { X, Paperclip, Mail, AlertCircle, FileText, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAiDrafts, AiDraft } from '@/hooks/intelligence/useAiDrafts';
import { ConfidenceBadge, CategoryPill } from '@/components/intelligence/primitives';
import { AiDraftExtractionEditor } from './AiDraftExtractionEditor';
import { AiDraftRejectionDialog } from './AiDraftRejectionDialog';

/**
 * Wave 2D — AI Draft Drawer.
 *
 * Slide-in panel from the right edge for reviewing a single AI draft.
 *
 * Layout (>=md):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ header: actor + category + confidence              ✕    │
 *   ├──────────────────────────┬───────────────────────────────┤
 *   │ Email body + attachments │  Editable extraction          │
 *   ├──────────────────────────┴───────────────────────────────┤
 *   │ footer: Reject · Apply · Edit & Apply                    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Source claim/email metadata is sometimes embedded in `extracted_payload`
 * (Wave 2A/2B haven't finalised this); we render whatever shape is present
 * defensively and TODO-tag the gaps.
 */

/**
 * Wave 2A/2B haven't finalised what email/attachment context comes back
 * alongside a draft. We expect them on extracted_payload under `source`.
 * TODO: lift these into the AiDraft type once the contract is locked.
 */
interface SourceEmail {
  subject?: string;
  from?: string;
  received_at?: string;
  body?: string;
  attachments?: Array<{
    id: string;
    filename: string;
    thumbnail_url?: string;
    size_bytes?: number;
    mime?: string | null;
    /** Presigned S3 URL — lets us embed the actual letter (the document of
     *  record the amount is read from) inline, beside the extraction. */
    view_url?: string | null;
  }>;
}

export interface AiDraftDrawerProps {
  /** Active draft id. When null, drawer is hidden. */
  draftId: string | null;
  /** Claim the draft belongs to. Required to load the draft list. */
  claimId?: string | null;
  onClose: () => void;
  /** Optional callback fired after a successful apply/reject. */
  onApplied?: (draftId: string) => void;
  onRejected?: (draftId: string) => void;
  /** Override the data source. Useful in dev/demo pages without an API. */
  draftOverride?: AiDraft | null;
}

const Skeleton: React.FC = () => (
  <div className="animate-pulse space-y-3 p-6">
    <div className="h-4 w-1/3 rounded bg-slate-200 dark:bg-slate-800" />
    <div className="h-3 w-2/3 rounded bg-slate-200 dark:bg-slate-800" />
    <div className="h-40 w-full rounded bg-slate-200 dark:bg-slate-800" />
    <div className="h-40 w-full rounded bg-slate-200 dark:bg-slate-800" />
  </div>
);

/**
 * Inline viewer for the source document — the sanction/pre-auth letter the
 * amount is actually read from. We embed it (PDF → browser-native viewer via
 * <iframe>, image → <img>) so the reviewer reconciles the extracted value
 * against the document of record without leaving the drawer.
 *
 * Deliberately NOT react-pdf: embedding the presigned S3 URL in an <iframe>
 * uses the browser's built-in PDF viewer and avoids the pdf.js-worker-from-CDN
 * crash seen on locked-down clinic networks.
 */
const SourceDocViewer: React.FC<{
  attachments?: SourceEmail['attachments'];
}> = ({ attachments }) => {
  const embeddable = (attachments ?? []).filter((a) => a.view_url);
  // Prefer a PDF (the letter); else fall back to the first viewable file.
  const doc =
    embeddable.find((a) => (a.mime ?? '').includes('pdf')) ??
    embeddable.find((a) => (a.mime ?? '').startsWith('image/')) ??
    embeddable[0];

  if (!doc?.view_url) return null;
  const isPdf = (doc.mime ?? '').includes('pdf') || /\.pdf($|\?)/i.test(doc.filename);
  const isImage = (doc.mime ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp)($|\?)/i.test(doc.filename);

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center gap-2">
        <FileText className="h-3.5 w-3.5 text-rose-600 dark:text-rose-300" />
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Source document
        </span>
        <span className="truncate text-[11px] text-slate-500 dark:text-slate-400" title={doc.filename}>
          · {doc.filename}
        </span>
        <a
          href={doc.view_url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-300"
        >
          Open <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
        {isPdf ? (
          <iframe
            src={doc.view_url}
            title={doc.filename}
            className="h-[60vh] w-full"
          />
        ) : isImage ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img src={doc.view_url} alt={doc.filename} className="max-h-[60vh] w-full object-contain" />
        ) : (
          <div className="p-4 text-xs text-slate-500">
            Preview not available for this file type.{' '}
            <a href={doc.view_url} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline">
              Open in a new tab
            </a>
            .
          </div>
        )}
      </div>
      <p className="mt-1 text-[10px] text-slate-400">
        Reconcile the extracted amount against this letter before applying.
      </p>
    </div>
  );
};

export const AiDraftDrawer: React.FC<AiDraftDrawerProps> = ({
  draftId,
  claimId,
  onClose,
  onApplied,
  onRejected,
  draftOverride,
}) => {
  const open = !!draftId;
  // Mounted state controls the slide animation (mount → next frame → open).
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const t = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(t);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const {
    data: drafts,
    loading,
    applyDraft,
    rejectDraft,
    applying,
    rejecting,
  } = useAiDrafts(draftOverride ? null : claimId ?? null);

  const draft: AiDraft | null = useMemo(() => {
    if (draftOverride) return draftOverride;
    if (!draftId) return null;
    return drafts.find((d) => d.id === draftId) ?? null;
  }, [draftOverride, drafts, draftId]);

  const originalPayload = useMemo(
    () => (draft ? structuredCloneSafe(draft.extracted_payload ?? {}) : {}),
    [draft],
  );
  const [payload, setPayload] = useState<Record<string, any>>({});
  const [editMode, setEditMode] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  useEffect(() => {
    setPayload(originalPayload);
    setEditMode(false);
  }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null;

  const source: SourceEmail | undefined =
    (draft?.extracted_payload?.source as SourceEmail | undefined) ??
    (draft?.extracted_payload?._source as SourceEmail | undefined);

  const onApply = async () => {
    if (!draft) return;
    const overrides = editMode ? payload : undefined;
    try {
      await applyDraft(draft.id, overrides);
      onApplied?.(draft.id);
      onClose();
    } catch {
      // Toast/error surface owned by integration sprint — keep silent here.
    }
  };

  const onConfirmReject = async (reason: string) => {
    if (!draft) return;
    try {
      await rejectDraft(draft.id, reason);
      onRejected?.(draft.id);
      setRejectOpen(false);
      onClose();
    } catch {
      // Same — integration sprint will surface failures.
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[1px] transition-opacity duration-200',
          visible ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        onClick={onClose}
        aria-hidden
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label="AI draft review"
        className={cn(
          'fixed top-0 right-0 z-50 flex h-full w-full md:w-[50vw] min-w-[420px] max-w-[900px] flex-col border-l border-slate-200 bg-white shadow-2xl transition-transform duration-200 dark:border-slate-800 dark:bg-slate-950',
          visible ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                AI Draft Review
              </span>
              {draft && (
                <CategoryPill
                  category={draft.kind || 'unknown'}
                  ontologyCategory="insurer_outcome"
                  size="xs"
                />
              )}
              {draft && (
                <ConfidenceBadge confidence={draft.confidence} mode="auto" size="sm" />
              )}
            </div>
            {draft && (
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="font-mono">{draft.llm_provider}/{draft.llm_model}</span>
                {' · '}
                {new Date(draft.created_at).toLocaleString()}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {loading && !draftOverride ? (
            <Skeleton />
          ) : !draft ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <AlertCircle className="h-8 w-8 text-amber-500" />
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Draft not found
              </div>
              <div className="max-w-xs text-xs text-slate-500 dark:text-slate-400">
                The draft may have been applied or rejected by another reviewer. Try
                refreshing the inbox.
              </div>
            </div>
          ) : (
            <div className="grid h-full grid-cols-1 md:grid-cols-2">
              {/* Left: source email */}
              <section className="overflow-y-auto border-b border-slate-200 px-5 py-4 dark:border-slate-800 md:border-b-0 md:border-r">
                {/* The document of record — embed the sanction letter first
                    so the reviewer reconciles against it, not the email body. */}
                <SourceDocViewer attachments={source?.attachments} />

                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  <Mail className="h-3.5 w-3.5" />
                  Source Email
                </div>
                {source?.subject ? (
                  <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {source.subject}
                  </div>
                ) : (
                  <div className="mt-2 text-sm italic text-slate-400">
                    No subject available
                  </div>
                )}
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {source?.from ?? 'Unknown sender'}
                  {source?.received_at && (
                    <> · {new Date(source.received_at).toLocaleString()}</>
                  )}
                </div>
                <pre className="mt-3 max-h-72 whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 font-sans text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
{source?.body ?? '(Email body not attached to this draft.)'}
                </pre>

                <div className="mt-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Attachments
                  </div>
                  {source?.attachments?.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {source.attachments.map((a) => (
                        <li
                          key={a.id}
                          className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-slate-800 dark:bg-slate-900"
                        >
                          {a.thumbnail_url ? (
                            <img
                              src={a.thumbnail_url}
                              alt=""
                              className="h-8 w-8 rounded object-cover"
                            />
                          ) : (
                            <Paperclip className="h-4 w-4 text-slate-400" />
                          )}
                          <span className="flex-1 truncate text-slate-700 dark:text-slate-200">
                            {a.filename}
                          </span>
                          {a.size_bytes != null && (
                            <span className="text-[10px] text-slate-400">
                              {Math.round(a.size_bytes / 1024)} KB
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-1 text-xs italic text-slate-400">No attachments</div>
                  )}
                </div>
              </section>

              {/* Right: extraction */}
              <section className="overflow-y-auto px-5 py-4">
                <AiDraftExtractionEditor
                  category={draft.kind}
                  extractedPayload={payload}
                  originalPayload={originalPayload}
                  onChange={setPayload}
                  readOnly={!editMode}
                />
                {!editMode && (
                  <div className="mt-3 text-[11px] text-slate-500 dark:text-slate-400">
                    Read-only. Click <strong>Edit &amp; Apply</strong> to make changes
                    before applying.
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        {draft && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/40">
            <button
              type="button"
              onClick={() => setRejectOpen(true)}
              disabled={rejecting}
              className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/40"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => setEditMode((v) => !v)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors',
                editMode
                  ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800',
              )}
            >
              {editMode ? 'Editing…' : 'Edit & Apply'}
            </button>
            <button
              type="button"
              onClick={onApply}
              disabled={applying}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {applying ? 'Applying…' : editMode ? 'Apply with edits' : 'Apply'}
            </button>
          </footer>
        )}
      </aside>

      <AiDraftRejectionDialog
        isOpen={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onSubmit={onConfirmReject}
        submitting={rejecting}
      />
    </>
  );
};

function structuredCloneSafe<T>(x: T): T {
  try {
    return typeof structuredClone === 'function'
      ? structuredClone(x)
      : JSON.parse(JSON.stringify(x));
  } catch {
    return x;
  }
}

export default AiDraftDrawer;
