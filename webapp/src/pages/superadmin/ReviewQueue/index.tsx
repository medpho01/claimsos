import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ChevronRight, RefreshCw, X, Check, Edit3,
  ImageIcon, MapPin, Calendar, UserX, Activity,
} from 'lucide-react';
import apiService from '@/services/api';

/**
 * Iter7 Stage 7 — Review Queue
 *
 * Superadmin surface listing claims whose harmonised episode has any
 * `validation_metadata` flag (Fix 17 foreign-patient, Fix 19 GPS photo
 * clustering, Fix 22 date-incoherent, completeness penalties). Each row
 * collapses into a detail view where the reviewer can accept / reject /
 * correct individual flagged sections.
 *
 * Backend (already shipped):
 *   - GET  /api/v1/review-queue
 *   - GET  /api/v1/review-queue/:claimId
 *   - POST /api/v1/review-queue/:claimId/disposition
 *
 * Mount: /superadmin/review-queue (route added in App.tsx).
 *
 * Not yet wired:
 *   - Correction modal (use existing harmonisationCorrection drawer);
 *     for now we only support accept / reject.
 *   - Section preview thumbnail — placeholder; later we'll fetch the
 *     S3 presigned URL via proxyPhoto endpoint.
 */

type FlagType =
  | 'foreign_patient_section'
  | 'date_incoherent'
  | 'gps_near_duplicate'
  | 'gps_cross_episode_outlier'
  | 'completeness_penalty';

interface QueueRow {
  claim_id: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  hospital_id: string | null;
  hospital_name: string | null;
  generated_at: string;
  flag_types: FlagType[];
  total_flags: number;
  completeness_score: number | null;
  episode_status: string;
}

interface FlaggedSection {
  section_id: string;
  flag_type: FlagType;
  category: string | null;
  page_start: number | null;
  page_end: number | null;
  document_id: string;
  file_name: string | null;
  s3_key: string | null;
  extracted_fields: any;
  detail: any;
}

interface QueueDetail extends QueueRow {
  validation_metadata: any;
  meta: any;
  flagged_sections: FlaggedSection[];
}

const FLAG_META: Record<FlagType, { label: string; icon: any; color: string; hint: string }> = {
  foreign_patient_section: {
    label: 'Foreign patient',
    icon: UserX,
    color: 'bg-rose-100 text-rose-700 border-rose-300',
    hint: "Doc's extracted patient name doesn't match this claim",
  },
  gps_near_duplicate: {
    label: 'GPS near-duplicate',
    icon: ImageIcon,
    color: 'bg-amber-100 text-amber-700 border-amber-300',
    hint: 'Two photos with same GPS + same timestamp',
  },
  gps_cross_episode_outlier: {
    label: 'GPS outlier',
    icon: MapPin,
    color: 'bg-rose-100 text-rose-700 border-rose-300',
    hint: 'Photo at distant GPS + different date from main cluster',
  },
  date_incoherent: {
    label: 'Date incoherent',
    icon: Calendar,
    color: 'bg-orange-100 text-orange-700 border-orange-300',
    hint: 'Section date outside the [admit-7d, discharge+14d] window',
  },
  completeness_penalty: {
    label: 'Completeness penalty',
    icon: Activity,
    color: 'bg-slate-100 text-slate-700 border-slate-300',
    hint: 'Internal-consistency gate fired',
  },
};

export default function ReviewQueuePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QueueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterFlag, setFilterFlag] = useState<FlagType | 'all'>('all');

  const fetchList = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiService.listReviewQueue({ limit: 100 });
      const d = res.data?.data ?? { rows: [], total: 0 };
      setRows(d.rows); setTotal(d.total);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'failed to load review queue');
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchList(); }, []);

  useEffect(() => {
    if (!selectedClaimId) { setDetail(null); return; }
    setDetailLoading(true);
    apiService.getReviewQueueClaim(selectedClaimId)
      .then((res) => setDetail(res.data?.data ?? null))
      .catch((e) => setError(e?.response?.data?.error ?? e?.message ?? 'failed to load detail'))
      .finally(() => setDetailLoading(false));
  }, [selectedClaimId]);

  const filteredRows = useMemo(() => {
    if (!rows) return [];
    if (filterFlag === 'all') return rows;
    return rows.filter((r) => r.flag_types.includes(filterFlag));
  }, [rows, filterFlag]);

  const flagCounts = useMemo(() => {
    const m = new Map<FlagType, number>();
    for (const r of rows ?? []) for (const f of r.flag_types) m.set(f, (m.get(f) ?? 0) + 1);
    return m;
  }, [rows]);

  const disposition = async (
    section_id: string,
    flag_type: FlagType,
    action: 'accept' | 'reject',
  ) => {
    if (!selectedClaimId) return;
    const reason = action === 'reject'
      ? window.prompt('Why are you rejecting this section?') ?? undefined
      : undefined;
    try {
      await apiService.dispositionReviewQueueSection(selectedClaimId, {
        section_id, flag_type, action, reason,
      });
      // Refresh detail + list (rejected sections trigger a fresh
      // harmoniser run in the background; the flag list updates
      // immediately because we strip the entry server-side).
      await Promise.all([
        apiService.getReviewQueueClaim(selectedClaimId).then((r) => setDetail(r.data?.data ?? null)),
        fetchList(),
      ]);
    } catch (e: any) {
      window.alert(e?.response?.data?.error ?? e?.message ?? 'disposition failed');
    }
  };

  return (
    <div className="max-w-[1500px] mx-auto px-6 py-6 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Review Queue</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Claims with AI quality-gate flags. {total} flagged · superadmin only.
          </p>
        </div>
        <button
          onClick={fetchList}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 hover:bg-slate-50 text-sm text-slate-700"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </header>

      {/* Flag-type filter strip */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setFilterFlag('all')}
          className={`px-3 py-1 rounded-full text-xs border ${
            filterFlag === 'all'
              ? 'bg-slate-900 text-white border-slate-900'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
          }`}
        >
          All ({rows?.length ?? 0})
        </button>
        {(Object.entries(FLAG_META) as Array<[FlagType, typeof FLAG_META[FlagType]]>).map(([k, meta]) => {
          const n = flagCounts.get(k) ?? 0;
          if (n === 0) return null;
          const Icon = meta.icon;
          return (
            <button
              key={k}
              onClick={() => setFilterFlag(k)}
              title={meta.hint}
              className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs border ${
                filterFlag === k ? meta.color : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Icon className="h-3 w-3" />
              {meta.label} ({n})
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      {/* Split: list on left, detail on right */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-4 items-start">
        {/* LIST */}
        <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
          {loading && <div className="px-4 py-3 text-sm text-slate-500">Loading…</div>}
          {!loading && filteredRows.length === 0 && (
            <div className="px-4 py-6 text-sm text-slate-500 text-center">
              No flagged claims match this filter. 🎉
            </div>
          )}
          <ul className="divide-y divide-slate-100">
            {filteredRows.map((r) => {
              const selected = r.claim_id === selectedClaimId;
              return (
                <li
                  key={r.claim_id}
                  onClick={() => setSelectedClaimId(r.claim_id)}
                  className={`px-4 py-3 cursor-pointer flex items-start gap-3 ${
                    selected ? 'bg-brand-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900 truncate">
                        {[r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ') || r.claim_id.slice(0, 8)}
                      </span>
                      <span className="text-xs text-slate-400">·</span>
                      <span className="text-xs text-slate-500 truncate">{r.hospital_name ?? '—'}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {r.flag_types.map((f) => {
                        const meta = FLAG_META[f];
                        const Icon = meta.icon;
                        return (
                          <span key={f} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] border ${meta.color}`}>
                            <Icon className="h-2.5 w-2.5" /> {meta.label}
                          </span>
                        );
                      })}
                      {r.completeness_score != null && (
                        <span className="text-[10px] text-slate-500 ml-1">
                          completeness {(r.completeness_score * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-400 mt-1.5 shrink-0" />
                </li>
              );
            })}
          </ul>
        </div>

        {/* DETAIL */}
        <div className="rounded-lg border border-slate-200 bg-white">
          {!selectedClaimId && (
            <div className="px-6 py-12 text-sm text-slate-500 text-center">
              Select a claim on the left to inspect its flagged sections.
            </div>
          )}
          {selectedClaimId && detailLoading && (
            <div className="px-6 py-8 text-sm text-slate-500">Loading detail…</div>
          )}
          {selectedClaimId && !detailLoading && detail && (
            <div className="divide-y divide-slate-100">
              <div className="px-5 py-3 flex items-start justify-between">
                <div>
                  <div className="font-semibold text-slate-900">
                    {[detail.patient_first_name, detail.patient_last_name].filter(Boolean).join(' ')}
                  </div>
                  <div className="text-xs text-slate-500">{detail.hospital_name}</div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    claim_id={detail.claim_id.slice(0, 8)} · completeness {detail.completeness_score != null ? (detail.completeness_score * 100).toFixed(0) + '%' : 'n/a'}
                  </div>
                </div>
                <button
                  onClick={() => navigate(`/superadmin/hospitals/${detail.hospital_id}/patients/${detail.claim_id}`)}
                  className="text-xs text-brand-700 hover:underline"
                >
                  Open claim →
                </button>
              </div>

              {detail.flagged_sections.length === 0 ? (
                <div className="px-5 py-4 text-sm text-slate-500">
                  No flagged sections — the underlying flags may have been cleared after disposition.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {detail.flagged_sections.map((s, idx) => {
                    const meta = FLAG_META[s.flag_type];
                    const Icon = meta.icon;
                    return (
                      <li key={`${s.section_id}-${s.flag_type}-${idx}`} className="px-5 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <Icon className="h-3.5 w-3.5 text-slate-500" />
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border ${meta.color}`}>
                                {meta.label}
                              </span>
                              <span className="text-xs text-slate-400">·</span>
                              <span className="text-xs text-slate-600">{s.category ?? 'uncategorised'}</span>
                              {s.page_start != null && (
                                <span className="text-xs text-slate-400">
                                  · p{s.page_start}{s.page_end !== s.page_start ? `–${s.page_end}` : ''}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-xs text-slate-600 truncate">{s.file_name ?? s.document_id.slice(0, 8)}</div>
                            <div className="mt-1.5 text-[11px] font-mono text-slate-500 bg-slate-50 rounded px-2 py-1.5 overflow-x-auto max-h-32">
                              {JSON.stringify(s.detail, null, 2)}
                            </div>
                          </div>
                          <div className="flex flex-col gap-1.5 shrink-0">
                            <button
                              onClick={() => disposition(s.section_id, s.flag_type, 'accept')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-700 text-xs hover:bg-emerald-100"
                            >
                              <Check className="h-3 w-3" /> Accept
                            </button>
                            <button
                              onClick={() => disposition(s.section_id, s.flag_type, 'reject')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-rose-300 bg-rose-50 text-rose-700 text-xs hover:bg-rose-100"
                            >
                              <X className="h-3 w-3" /> Reject
                            </button>
                            <button
                              onClick={() => window.alert('Correction flow comes in next iteration — use the existing harmonised episode correction drawer for now.')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 bg-white text-slate-600 text-xs hover:bg-slate-50"
                              title="Coming soon"
                            >
                              <Edit3 className="h-3 w-3" /> Correct
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-400 pt-4">
        Reject triggers a fresh harmoniser run in the background — refresh after ~30s to see the updated episode.
      </p>
    </div>
  );
}
