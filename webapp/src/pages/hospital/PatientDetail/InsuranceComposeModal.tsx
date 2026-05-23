import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  X,
  Send,
  Loader2,
  AlertCircle,
  Paperclip,
  Link as LinkIcon,
  CheckSquare,
  Square,
  Building,
  FileText,
  FileImage,
  File as FileIcon,
} from 'lucide-react';
import apiService from '@/services/api';

interface AutoAttachment {
  filename: string;
  s3_key: string;
  mime_type: string;
  size_bytes: number;
  source: 'hospital_doc' | 'patient_doc';
  source_doc_id?: string;
}

interface PatientDoc {
  id: string;
  file_name: string | null;
  type: string | null;
  s3_key: string | null;
  mime_type: string | null;
  file_size: number | null;
  created_at: string;
  selected: boolean;
}

interface DraftPayload {
  preview: {
    to: string[];
    cc: string[];
    subject: string;
    body_text: string;
    attachments: AutoAttachment[];
    available_patient_documents: PatientDoc[];
    auto_hospital_documents: AutoAttachment[];
    hospital_share_link?: string;
  };
  hospital_panel_id: string;
  is_threaded_reply: boolean;
  thread_subject_hint?: string;
}

interface Props {
  ipdId: string;
  hospitalId: string;
  patientName: string;
  panelName?: string;
  onClose: () => void;
  onSent: () => void;
}

const fmtSize = (bytes?: number | null) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const InsuranceComposeModal: React.FC<Props> = ({
  ipdId,
  hospitalId,
  patientName,
  panelName,
  onClose,
  onSent,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftPayload | null>(null);

  // Editable fields
  const [to, setTo] = useState<string>('');
  const [cc, setCc] = useState<string>('');
  const [subject, setSubject] = useState<string>('');
  const [bodyText, setBodyText] = useState<string>('');
  const [selectedPatientDocIds, setSelectedPatientDocIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  // P11: doc-picker UX — search + type filter for big admissions (30+ docs).
  const [docSearch, setDocSearch] = useState('');
  const [docTypeFilter, setDocTypeFilter] = useState<'all' | 'pdf' | 'image' | 'other'>('all');

  // Stable idempotency key for the lifetime of this modal instance.
  // Generated ONCE per open — survives double-clicks, network retries, and
  // accidental re-Sends. Backend's `idempotency_key` UNIQUE constraint dedupes.
  const idempotencyKey = useMemo(
    () =>
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const fetchDraft = async () => {
      try {
        setLoading(true);
        const response = await apiService.insuranceDraft(ipdId, hospitalId);
        if (cancelled) return;
        const data = response.data?.data as DraftPayload;
        setDraft(data);
        setTo((data.preview.to ?? []).join(', '));
        setCc((data.preview.cc ?? []).join(', '));
        setSubject(data.preview.subject ?? '');
        setBodyText(data.preview.body_text ?? '');
        const preSelected = new Set(
          (data.preview.available_patient_documents ?? [])
            .filter(d => d.selected)
            .map(d => d.id)
        );
        setSelectedPatientDocIds(preSelected);
      } catch (err: any) {
        if (cancelled) return;
        const respErr = err?.response?.data?.error || err?.message || 'Failed to build draft';
        try {
          const parsed = JSON.parse(respErr);
          if (parsed.blockers) {
            setError(
              `Cannot send pre-auth — fix these first:\n` +
                parsed.blockers.map((b: any) => `• ${b.message}`).join('\n')
            );
            return;
          }
        } catch {}
        setError(respErr);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchDraft();
    return () => {
      cancelled = true;
    };
  }, [ipdId, hospitalId]);

  const togglePatientDoc = (id: string) => {
    setSelectedPatientDocIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalAttachmentCount = useMemo(() => {
    const hospital = draft?.preview.auto_hospital_documents.length ?? 0;
    return hospital + selectedPatientDocIds.size;
  }, [draft, selectedPatientDocIds]);

  const parseAddresses = (s: string) =>
    s.split(/[,;\n]/).map(a => a.trim()).filter(Boolean);

  const handleSend = async () => {
    if (!draft) return;
    const toList = parseAddresses(to);
    if (toList.length === 0) {
      toast.error('At least one "to" address required');
      return;
    }
    try {
      setSending(true);
      await apiService.insuranceSend(
        ipdId,
        hospitalId,
        {
          to: toList,
          cc: parseAddresses(cc),
          subject,
          body_text: bodyText,
          selectedPatientDocIds: Array.from(selectedPatientDocIds),
        },
        idempotencyKey,
      );
      toast.success(
        draft.is_threaded_reply
          ? 'Reply queued (in-thread)'
          : 'Email queued for send'
      );
      onSent();
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to send pre-auth';
      toast.error(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-4xl max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800 sticky top-0 bg-white dark:bg-slate-900">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {draft?.is_threaded_reply ? 'Reply to Insurer' : 'Send Email'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {patientName}
              {panelName ? <> · {panelName}</> : null}
              {draft?.is_threaded_reply && (
                <> · <span className="text-brand-600">Will reply to existing thread</span></>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading && (
          <div className="px-5 py-10 flex flex-col items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mb-2" />
            <p className="text-sm">Building pre-auth draft…</p>
          </div>
        )}

        {error && (
          <div className="px-5 py-6">
            <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900">
              <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <pre className="text-sm text-amber-900 dark:text-amber-100 whitespace-pre-wrap font-sans">
                {error}
              </pre>
            </div>
          </div>
        )}

        {!loading && !error && draft && (
          <div className="px-5 py-4 space-y-4">
            {/* Recipient + subject + body */}
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                To
              </label>
              <input
                type="text"
                value={to}
                readOnly
                tabIndex={-1}
                className="w-full px-3 py-2 text-sm border border-slate-200 dark:border-slate-800 rounded-md bg-slate-50 dark:bg-slate-800/50 text-slate-700 dark:text-slate-300 cursor-not-allowed select-text"
              />
              <p className="text-xs text-slate-500 mt-1">
                Configured at the panel level. Edit in <strong>Panel Attributes</strong> to change.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                CC
              </label>
              <input
                type="text"
                value={cc}
                onChange={e => setCc(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Body
              </label>
              <textarea
                rows={11}
                value={bodyText}
                onChange={e => setBodyText(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-mono"
              />
              {draft.preview.hospital_share_link && (
                <p className="text-xs text-slate-500 mt-1 inline-flex items-center gap-1">
                  <LinkIcon className="h-3 w-3" />
                  Hospital profile share link is included in the body.
                </p>
              )}
            </div>

            {/* Auto-attached hospital docs */}
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Building className="h-3.5 w-3.5 text-brand-600" />
                <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                  Hospital documents (auto-attached)
                </h4>
                <span className="text-xs text-slate-500">
                  {draft.preview.auto_hospital_documents.length} document(s)
                </span>
              </div>
              {draft.preview.auto_hospital_documents.length === 0 ? (
                <p className="text-xs text-slate-500 italic">
                  No hospital documents configured. The hospital admin can upload them in
                  Profile → Documents — they'll then be auto-attached to every Cashless Everywhere email.
                </p>
              ) : (
                <ul className="space-y-1">
                  {draft.preview.auto_hospital_documents.map((a, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs">
                      <Paperclip className="h-3 w-3 text-slate-500" />
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {a.filename}
                      </span>
                      <span className="text-slate-500 ml-auto">
                        {fmtSize(a.size_bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Patient document selector */}
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <FileText className="h-3.5 w-3.5 text-brand-600" />
                <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-50">
                  Patient documents — pick what to attach
                </h4>
                <span className="text-xs text-slate-500">
                  {selectedPatientDocIds.size} of{' '}
                  {draft.preview.available_patient_documents.length} selected
                </span>
                {/* P11: Select-all / Clear toggles. Operates on the currently-
                    filtered list (search + type), not the full set — matches user
                    expectation of "select what I'm looking at". */}
                {draft.preview.available_patient_documents.length > 0 && (() => {
                  const filtered = draft.preview.available_patient_documents.filter(d => {
                    const name = (d.file_name || d.type || '').toLowerCase();
                    if (docSearch && !name.includes(docSearch.toLowerCase())) return false;
                    const m = d.mime_type ?? '';
                    if (docTypeFilter === 'pdf' && !m.includes('pdf')) return false;
                    if (docTypeFilter === 'image' && !m.startsWith('image/')) return false;
                    if (docTypeFilter === 'other' && (m.includes('pdf') || m.startsWith('image/'))) return false;
                    return true;
                  });
                  const allSelected = filtered.length > 0 && filtered.every(d => selectedPatientDocIds.has(d.id));
                  return (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPatientDocIds(prev => {
                          const next = new Set(prev);
                          if (allSelected) filtered.forEach(d => next.delete(d.id));
                          else filtered.forEach(d => next.add(d.id));
                          return next;
                        });
                      }}
                      className="ml-auto text-xs text-brand-600 hover:text-brand-700 hover:underline"
                    >
                      {allSelected ? 'Clear filtered' : `Select all ${filtered.length}`}
                    </button>
                  );
                })()}
              </div>
              {/* P11: Search + type filter row */}
              {draft.preview.available_patient_documents.length > 0 && (
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <input
                    type="search"
                    value={docSearch}
                    onChange={(e) => setDocSearch(e.target.value)}
                    placeholder="Search documents…"
                    className="flex-1 min-w-[200px] h-7 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                  <div className="inline-flex gap-1 text-[11px]">
                    {(['all', 'pdf', 'image', 'other'] as const).map(k => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setDocTypeFilter(k)}
                        className={`px-2 py-0.5 rounded border capitalize ${
                          docTypeFilter === k
                            ? 'bg-brand-600 text-white border-brand-600'
                            : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {draft.preview.available_patient_documents.length === 0 ? (
                <p className="text-xs text-slate-500 italic">
                  This patient has no uploaded documents. Upload at least the filled pre-auth form
                  and supporting docs from the Documents tab first.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-64 overflow-y-auto rounded border border-slate-200 dark:border-slate-700">
                  {draft.preview.available_patient_documents
                    .filter(d => {
                      const name = (d.file_name || d.type || '').toLowerCase();
                      if (docSearch && !name.includes(docSearch.toLowerCase())) return false;
                      const m = d.mime_type ?? '';
                      if (docTypeFilter === 'pdf' && !m.includes('pdf')) return false;
                      if (docTypeFilter === 'image' && !m.startsWith('image/')) return false;
                      if (docTypeFilter === 'other' && (m.includes('pdf') || m.startsWith('image/'))) return false;
                      return true;
                    })
                    .map(d => {
                    const checked = selectedPatientDocIds.has(d.id);
                    const isImage = (d.mime_type ?? '').startsWith('image/');
                    const isPdf = (d.mime_type ?? '').includes('pdf');
                    const FileTypeIcon = isImage ? FileImage : isPdf ? FileText : FileIcon;
                    const displayName =
                      d.file_name || `${d.type ?? 'document'}_${d.id.slice(0, 8)}`;
                    return (
                      <li key={d.id}>
                        <button
                          onClick={() => togglePatientDoc(d.id)}
                          className={`w-full text-left flex items-start gap-3 px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/70 transition-colors ${
                            checked
                              ? 'bg-brand-50/70 dark:bg-brand-950/40'
                              : ''
                          }`}
                        >
                          {/* Checkbox */}
                          <div className="flex-shrink-0 mt-0.5">
                            {checked ? (
                              <CheckSquare className="h-4 w-4 text-brand-600" />
                            ) : (
                              <Square className="h-4 w-4 text-slate-400" />
                            )}
                          </div>

                          {/* File-type icon */}
                          <div
                            className={`flex-shrink-0 h-8 w-8 rounded flex items-center justify-center mt-0.5 ${
                              isPdf
                                ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300'
                                : isImage
                                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-300'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                            }`}
                          >
                            <FileTypeIcon className="h-4 w-4" />
                          </div>

                          {/* Filename + meta — flex-1 + min-w-0 lets truncate work */}
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
                              {displayName}
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                              {d.type && (
                                <>
                                  <span className="capitalize">{d.type.replace(/_/g, ' ')}</span>
                                  <span className="text-slate-400">·</span>
                                </>
                              )}
                              <span>{fmtSize(d.file_size)}</span>
                              <span className="text-slate-400">·</span>
                              <span>{fmtDate(d.created_at)}</span>
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="text-xs text-slate-500 mt-2">
                💡 Filled pre-auth form: download the blank form from your panel config,
                fill + sign + scan, then upload to <strong>Documents</strong> tab. It'll appear
                here for selection.
              </p>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 dark:border-slate-800 sticky bottom-0 bg-white dark:bg-slate-900">
          <div className="text-xs text-slate-500">
            {draft && (
              <>
                <strong>{totalAttachmentCount}</strong> attachment(s)
                {draft.is_threaded_reply && ' · in-thread reply'}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={sending}
              className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSend}
              disabled={!draft || sending}
              className="px-3 py-2 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded-md inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InsuranceComposeModal;
