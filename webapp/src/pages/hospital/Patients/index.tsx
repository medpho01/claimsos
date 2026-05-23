import React, { useEffect, useMemo, useState } from 'react';
import { useHospitalPatients } from '@/hooks/useHospitalPatients';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Activity, Settings as SettingsIcon, Home, Search, ArrowUpDown, ArrowUp, ArrowDown, RefreshCw, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import apiService from '@/services/api';
import { useHospitalDataContext } from '@/pages/hospital/context/HospitalDataContext';
import { Patient } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';

/**
 * UI Revamp — Hospital workspace "Patients" sub-tab (wireframe screen-hw-patients).
 *
 * Unified view of all patients across all panels in this hospital,
 * with colored status filter pills, search, and a rich row layout.
 *
 * Mounted at /portal/:hospitalId/patients. Reachable from:
 *   - Hospital workspace Overview > Patients sub-tab
 *   - "Open patients →" link in the Patient pipeline card
 *
 * Data: apiService.getHospitalAllPatients(hospitalId) returns the
 * flat patient list with panel_name joined. Filter chip counts are
 * derived client-side from latest_status.
 *
 * Per "hide blocks we can't fill", columns like Docs count, Last
 * action, and Claim ₹ are only shown when their underlying value
 * is present on the row.
 */

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';

const daysSince = (s?: string | null) => {
  if (!s) return null;
  const diff = Date.now() - new Date(s).getTime();
  return Math.max(0, Math.floor(diff / 86400000));
};

// Lifecycle filters (replaces claim-status pills that didn't map to real
// data — only `admitted` ever had non-zero counts). Mirrors the production
// patient list semantics:
//   Active      = is_active && !discharged_at  (currently in hospital)
//   Admitted    = same as Active in current schema; kept as a separate pill
//                 to match the legacy chip ordering users are used to
//   Discharged  = is_active && !!discharged_at (sent home, still on roster)
//   Deactivated = !is_active                   (archived)
type Lifecycle = 'all' | 'active' | 'admitted' | 'discharged' | 'deactivated';

const LIFECYCLE_GROUPS: Array<{ k: Lifecycle; label: string; tone: 'info' | 'ok' | 'warn' | 'danger' | 'muted' }> = [
  { k: 'all',         label: 'All',         tone: 'info'  },
  { k: 'active',      label: 'Active',      tone: 'ok'    },
  { k: 'admitted',    label: 'Admitted',    tone: 'info'  },
  { k: 'discharged',  label: 'Discharged',  tone: 'warn'  },
  { k: 'deactivated', label: 'Deactivated', tone: 'muted' },
];

const lifecycleOf = (p: { is_active?: boolean; discharged_at?: string | null }): Lifecycle => {
  if (p.is_active === false) return 'deactivated';
  if (p.discharged_at) return 'discharged';
  return 'admitted';
};

const statusToneClass = (tone: 'info' | 'ok' | 'warn' | 'danger' | 'muted') =>
  tone === 'ok'     ? 'pill-ok'
  : tone === 'warn'   ? 'pill-warn'
  : tone === 'danger' ? 'pill-danger'
  : tone === 'muted'  ? 'pill-muted'
  : 'pill-info';

// Text-color variant of the tone — used in the patient list table where
// the original pill chrome was too visually noisy (every row had 4 pills).
// Plain text with a tone-coloured shade keeps the semantic signal without
// the chip clutter.
const toneTextClass = (tone: 'info' | 'ok' | 'warn' | 'danger' | 'muted') =>
  tone === 'ok'     ? 'text-ok-700 dark:text-ok-300'
  : tone === 'warn'   ? 'text-warn-700 dark:text-warn-300'
  : tone === 'danger' ? 'text-danger-700 dark:text-danger-300'
  : tone === 'muted'  ? 'text-slate-500 dark:text-slate-400'
  : 'text-info-700 dark:text-info-300';

// Maps the IPDs.claim_filing_route enum to a label + pill tone.
// `cashless_everywhere` is the SOP-driven email flow ("CE"); `network` is the
// older portal/empanelment path. `null` means no route has been picked yet.
type ClaimRoute = 'cashless_everywhere' | 'network' | null | undefined;
const routeLabel = (r: ClaimRoute) =>
  r === 'cashless_everywhere' ? 'Cashless Everywhere'
  : r === 'network'             ? 'Network'
  : '—';
const routeTone = (r: ClaimRoute): 'info' | 'ok' | 'warn' | 'danger' | 'muted' =>
  r === 'cashless_everywhere' ? 'ok'
  : r === 'network'             ? 'info'
  : 'muted';

// Stage pill tone — derived from the label so superadmins can add new stage
// labels in master_options without code changes here. Words drive tone:
//   *Approved             → ok (green)
//   *Queried              → warn (amber)
//   Draft / *Discharged   → muted
//   everything else       → info (blue, "in progress")
const stageTone = (stage: string | null | undefined): 'info' | 'ok' | 'warn' | 'danger' | 'muted' => {
  if (!stage) return 'muted';
  if (/approved/i.test(stage)) return 'ok';
  if (/queried/i.test(stage)) return 'warn';
  if (/^draft$|discharged$/i.test(stage)) return 'muted';
  return 'info';
};

// Sortable column keys + cell extractors. Keeping the extractor here (rather
// than inline in render) so toggling sort doesn't have to re-derive how each
// column reads its value.
type SortKey = 'name' | 'panel' | 'status' | 'admitted' | 'claim_route' | 'stage' | 'claim_amount';
type SortDir = 'asc' | 'desc';

const sortValue = (p: any, k: SortKey): string | number => {
  switch (k) {
    case 'name':          return `${(p.first_name || '').toLowerCase()} ${(p.last_name || '').toLowerCase()}`.trim();
    case 'panel':         return (p.panel_name || '').toLowerCase();
    case 'status':        return p.is_active === false ? 'deactivated' : p.discharged_at ? 'discharged' : 'admitted';
    case 'admitted':      return p.admitted_at ? new Date(p.admitted_at).getTime() : 0;
    case 'claim_route':   return p.claim_filing_route || 'zz_none'; // empty sorts last
    case 'stage':         return p.stage || 'zz_none';               // empty sorts last
    case 'claim_amount':  return Number(p.claim_settled ?? p.claim_amount ?? 0);
  }
};

/**
 * Clickable header cell that toggles sort on click. Shows an up/down chevron
 * for the active column and a neutral double-arrow on idle columns.
 * Kept inline to this page since no other table uses this pattern yet.
 */
const SortableTh: React.FC<{
  label: string;
  k: SortKey;
  sortBy: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align?: 'left' | 'right';
}> = ({ label, k, sortBy, sortDir, onClick, align = 'left' }) => {
  const active = sortBy === k;
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'} select-none`}
    >
      <button
        type="button"
        onClick={() => onClick(k)}
        className={`inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200 transition-colors ${
          active ? 'text-slate-900 dark:text-slate-100' : ''
        } ${align === 'right' ? 'ml-auto' : ''}`}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <Icon className={`h-3 w-3 ${active ? '' : 'opacity-50'}`} strokeWidth={2.4} />
      </button>
    </th>
  );
};

const HospitalPatientsPage: React.FC = () => {
  const { hospitalId } = useParams<{ hospitalId: string }>();
  const navigate = useNavigate();
  // QA T / FE H3: patient list now flows through react-query
  // (useHospitalPatients) — fan-out happens once across panels, the
  // result is cached, and the same query reused by PatientDetail and
  // PatientEdit so no duplicate fetches.
  //
  // Local `patients` mirror is kept so the "Add patient" optimistic
  // insertion at line ~426 still works without immediate refetch.
  // Effects below sync the local mirror to query data.
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<Lifecycle>('all');
  const [panelFilter, setPanelFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  // Default sort: admitted desc (newest first), matching the previous
  // server-side ORDER BY so the initial render order is unchanged.
  const [sortBy, setSortBy] = useState<SortKey>('admitted');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  // React-query cache invalidation handle. The per-panel fan-out query lives
  // under ['hospital-patients', hospitalId, sortedPanelIds] — invalidating
  // that key forces useHospitalPatients to refetch every panel.
  const queryClient = useQueryClient();
  const refreshList = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ['hospital-patients', hospitalId] });
      setLastRefreshed(new Date());
    } finally {
      setRefreshing(false);
    }
  };
  const toggleSort = (k: SortKey) => {
    if (k === sortBy) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortBy(k); setSortDir(k === 'admitted' || k === 'claim_amount' ? 'desc' : 'asc'); }
  };

  // Add-patient dialog state
  const [showAdd, setShowAdd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newPatient, setNewPatient] = useState({
    panelId: '',
    firstName: '',
    lastName: '',
    phone: '',
    admittedAt: new Date().toISOString().split('T')[0],
    admissionType: '' as 'conservative' | 'surgical' | '',
  });

  const { hospital, hospitalPanels } = useHospitalDataContext();

  // All hospital_panels rows are real insurer/TPA relationships now —
  // migration 023 dropped the CASHLESS_EVERYWHERE pseudo-panel; comms
  // channels live on hospital_interfaces. No FE filter needed anymore.
  const insurerPanels = hospitalPanels || [];

  const panelIds = useMemo(
    () =>
      insurerPanels
        .map((p: any) => p.panel_id || p.id)
        .filter(Boolean),
    [insurerPanels],
  );

  const {
    data: queryPatients,
    isLoading: queryLoading,
    error: queryError,
  } = useHospitalPatients(hospitalId, panelIds);

  // Mirror query result into local state for optimistic mutations.
  useEffect(() => {
    if (!queryPatients) return;
    // Attach panel_name to each row from hospitalPanels (the query hook
    // doesn't have access to the lookup map).
    const enriched = queryPatients.map((p: any) => {
      const panelInfo = (hospitalPanels || []).find(
        (hp: any) => (hp.panel_id || hp.id) === p.panel_id,
      ) as any;
      return {
        ...p,
        panel_name:
          p.panel_name || panelInfo?.panel_name || panelInfo?.name,
      };
    });
    setPatients(enriched);
  }, [queryPatients, hospitalPanels]);

  useEffect(() => {
    setLoading(queryLoading);
    setError(queryError ? String(queryError) : null);
  }, [queryLoading, queryError]);

  const counts = useMemo(() => {
    const c: Record<Lifecycle, number> = {
      all: patients.length, active: 0, admitted: 0, discharged: 0, deactivated: 0,
    };
    patients.forEach((p) => {
      const g = lifecycleOf(p);
      c[g] = (c[g] || 0) + 1;
      // "Active" = anything that isn't deactivated — covers admitted + discharged.
      if (g !== 'deactivated') c.active += 1;
    });
    return c;
  }, [patients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = patients.filter((p) => {
      if (activeStatus !== 'all') {
        const g = lifecycleOf(p);
        if (activeStatus === 'active' ? g === 'deactivated' : g !== activeStatus) return false;
      }
      if (panelFilter !== 'all' && p.panel_id !== panelFilter) return false;
      if (!q) return true;
      const haystack = `${p.first_name} ${p.last_name} ${p.beneficiary_id || ''} ${p.pmjay_case_number || ''} ${p.panel_name || ''}`.toLowerCase();
      return haystack.includes(q);
    });
    // Client-side sort. Stable: we ride on Array.prototype.sort's stability
    // guarantee (V8/Webkit/Firefox all stable since 2019) so equal keys keep
    // their server order.
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sortBy);
      const bv = sortValue(b, sortBy);
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [patients, activeStatus, panelFilter, search, sortBy, sortDir]);

  const admittedTotal = counts.admitted;
  const historicalTotal = counts.discharged + counts.deactivated;

  if (!hospital) return null;

  return (
    <motion.div
      className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6 space-y-4"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Breadcrumb */}
      <nav className="text-sm text-slate-500 flex items-center gap-1.5">
        <Home className="h-3.5 w-3.5" />
        <button onClick={() => navigate('/')} className="hover:text-brand-700">
          Hospitals
        </button>
        <span className="text-slate-300">/</span>
        <button
          onClick={() => navigate(`/portal/${hospitalId}`)}
          className="hover:text-brand-700"
        >
          {hospital.name}
        </button>
        <span className="text-slate-300">/</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">Patients</span>
      </nav>

      {/* Mode toggle (Operations active) */}
      <div className="flex items-center justify-between">
        <div className="inline-flex p-[3px] gap-[2px] rounded-md bg-slate-100 border border-slate-200 dark:bg-slate-900 dark:border-slate-700">
          <button
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] text-xs font-medium bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.06),0_0_0_1px_rgba(15,23,42,.04)] dark:bg-slate-800 dark:text-slate-50"
            aria-pressed="true"
          >
            <Activity className="h-3.5 w-3.5" />
            Operations
          </button>
          <button
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] text-xs font-medium text-slate-500 hover:text-slate-700"
            onClick={() => navigate(`/portal/${hospitalId}/profile`)}
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            Configuration
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="border-b border-slate-200 dark:border-slate-800 flex items-center gap-1 text-sm">
        <button
          className="px-3 py-2 text-slate-500 border-b-2 border-transparent hover:text-slate-900 dark:text-slate-50 dark:hover:text-slate-100 transition-colors"
          onClick={() => navigate(`/portal/${hospitalId}`)}
        >
          Overview
        </button>
        <button className="px-3 py-2 text-slate-900 dark:text-slate-50 font-medium border-b-2 border-brand-600">
          Patients{' '}
          <span className="ml-1 text-[11px] text-slate-400">{patients.length}</span>
        </button>
      </div>

      {/* Title + actions */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Patients
          </h2>
          <p className="text-xs text-slate-500">
            {admittedTotal} admitted · {historicalTotal} historical
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={refreshList}
            disabled={refreshing}
            className="h-9 px-3 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-2 disabled:opacity-50"
            title={lastRefreshed ? `Last refreshed at ${lastRefreshed.toLocaleTimeString('en-IN')}` : 'Refresh patient list'}
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
          <button className="h-9 px-3 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
            Export
          </button>
          <button
            className="h-9 px-3 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700"
            onClick={() => {
              // Pre-select the first panel if there's only one; otherwise leave empty
              // so the user must pick. Excludes interface-only panels.
              const onlyPanel =
                insurerPanels?.length === 1 ? (insurerPanels[0] as any) : null;
              setNewPatient((p) => ({
                ...p,
                panelId: onlyPanel?.panel_id || onlyPanel?.id || '',
              }));
              setShowAdd(true);
            }}
          >
            + New patient
          </button>
        </div>
      </div>

      {/* Lifecycle filter pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {LIFECYCLE_GROUPS.map(({ k, label, tone }) => {
          const isActive = activeStatus === k;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setActiveStatus(k)}
              className={`pill ${statusToneClass(tone)} ${
                isActive ? 'ring-2 ring-brand-600/30' : 'opacity-70 hover:opacity-100'
              } shrink-0 transition-opacity`}
            >
              {label} · {counts[k] || 0}
            </button>
          );
        })}
      </div>

      {/* Search + Panel filter */}
      <div className="flex items-center gap-2 text-sm">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or claim id"
            className="w-full h-8 px-3 pl-8 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          />
        </div>
        <select
          value={panelFilter}
          onChange={(e) => setPanelFilter(e.target.value)}
          className="h-8 px-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          aria-label="Filter by panel"
        >
          <option value="all">All panels</option>
          {insurerPanels.map((hp: any) => {
            const id = hp.panel_id || hp.id;
            const name = hp.panel_name || hp.name;
            return (
              <option key={id} value={id}>{name}</option>
            );
          })}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        {loading ? (
          <p className="px-5 py-12 text-center text-sm text-slate-500">Loading patients…</p>
        ) : error ? (
          <p className="px-5 py-12 text-center text-sm text-danger-700">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-slate-500">
            {patients.length === 0
              ? 'No patients yet.'
              : 'No patients match your search or filter.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 dark:bg-slate-800/40 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              <tr>
                <SortableTh label="Patient"    k="name"         sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Claim Type" k="claim_route"  sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Panel"      k="panel"        sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Stage"      k="stage"        sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Status"     k="status"       sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Admitted"   k="admitted"     sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortableTh label="Claim ₹"    k="claim_amount" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                <th className="px-3 py-2 w-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((p) => {
                const g = lifecycleOf(p);
                const meta = LIFECYCLE_GROUPS.find((s) => s.k === g) || LIFECYCLE_GROUPS[0];
                const admittedDays = daysSince(p.admitted_at);
                return (
                  <tr
                    key={p.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer transition-colors"
                    onClick={() =>
                      navigate(
                        `/portal/${hospitalId}/patient/${p.id}`,
                        { state: { hospitalId, patient: p } }
                      )
                    }
                  >
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-900 dark:text-slate-100">
                        {p.first_name} {p.last_name}
                      </div>
                      {(p.beneficiary_id || p.pmjay_case_number) && (
                        <div className="text-xs text-slate-500 font-mono">
                          {p.beneficiary_id || p.pmjay_case_number}
                        </div>
                      )}
                    </td>
                    {/* Plain-text cells (replaced pills for visual calm). Tone
                        survives as a text-color so semantic emphasis remains. */}
                    <td className={`px-3 py-2.5 text-sm ${toneTextClass(routeTone(p.claim_filing_route))}`}>
                      {routeLabel(p.claim_filing_route)}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-slate-700 dark:text-slate-200">
                      {p.panel_name || <span className="text-slate-400">—</span>}
                    </td>
                    <td className={`px-3 py-2.5 text-sm whitespace-nowrap ${p.stage ? toneTextClass(stageTone(p.stage)) : 'text-slate-400'}`}>
                      {p.stage || '—'}
                    </td>
                    <td className={`px-3 py-2.5 text-sm ${toneTextClass(meta.tone)}`}>
                      {meta.label}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-slate-900 dark:text-slate-100">
                        {fmtDate(p.admitted_at)}
                      </div>
                      {admittedDays !== null && (
                        <div className="text-xs text-slate-500">{admittedDays}d</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                      {p.claim_settled
                        ? `₹${(Number(p.claim_settled) / 1).toLocaleString('en-IN')}`
                        : p.claim_amount
                        ? `₹${(Number(p.claim_amount) / 1).toLocaleString('en-IN')}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 text-right">›</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Add-patient dialog (panel picker + form) */}
      <Dialog open={showAdd} onOpenChange={(o) => !o && setShowAdd(false)}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Add new patient</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newPatient.panelId || !newPatient.firstName) {
                toast.error('Pick a panel and enter first name.');
                return;
              }
              setSubmitting(true);
              try {
                const res = await apiService.addPatient({
                  firstName: newPatient.firstName,
                  lastName: newPatient.lastName,
                  phone: (newPatient.phone || '').replace(/[^\d]/g, ''),
                  hospitalId: hospitalId!,
                  panelId: newPatient.panelId,
                  admittedAt: newPatient.admittedAt
                    ? new Date(newPatient.admittedAt).toISOString()
                    : new Date().toISOString(),
                  admissionType: newPatient.admissionType || undefined,
                });
                const created = res.data?.data;
                const panelInfo = (hospitalPanels || []).find(
                  (p: any) => (p.panel_id || p.id) === newPatient.panelId
                ) as any;
                if (created) {
                  setPatients((prev) => [
                    {
                      ...created,
                      is_active: true,
                      panel_id: newPatient.panelId,
                      panel_name: panelInfo?.panel_name || panelInfo?.name,
                    },
                    ...prev,
                  ]);
                }
                toast.success('Patient added.');
                setShowAdd(false);
                setNewPatient({
                  panelId: '',
                  firstName: '',
                  lastName: '',
                  phone: '',
                  admittedAt: new Date().toISOString().split('T')[0],
                  admissionType: '',
                });
                // Invalidate the cache so the next render swaps the optimistic
                // row for the canonical server row — picks up any field the
                // optimistic insert couldn't compute on the client.
                queryClient.invalidateQueries({ queryKey: ['hospital-patients', hospitalId] });
              } catch (err: any) {
                toast.error(err?.response?.data?.message || 'Failed to add patient.');
              } finally {
                setSubmitting(false);
              }
            }}
            className="grid gap-3 py-1"
          >
            <div className="grid gap-1.5">
              <Label htmlFor="np-panel">Panel *</Label>
              <select
                id="np-panel"
                value={newPatient.panelId}
                onChange={(e) =>
                  setNewPatient((p) => ({ ...p, panelId: e.target.value }))
                }
                required
                className="w-full h-9 px-3 rounded-md border text-sm"
              >
                <option value="">— Choose a panel —</option>
                {insurerPanels.map((p: any) => (
                  <option key={p.panel_id || p.id} value={p.panel_id || p.id}>
                    {p.panel_name || p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="np-fn">First name *</Label>
                <Input
                  id="np-fn"
                  value={newPatient.firstName}
                  onChange={(e) =>
                    setNewPatient((p) => ({ ...p, firstName: e.target.value }))
                  }
                  required
                  placeholder="Ramesh"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="np-ln">Last name</Label>
                <Input
                  id="np-ln"
                  value={newPatient.lastName}
                  onChange={(e) =>
                    setNewPatient((p) => ({ ...p, lastName: e.target.value }))
                  }
                  placeholder="Patil"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="np-phone">Phone</Label>
                <Input
                  id="np-phone"
                  value={newPatient.phone}
                  onChange={(e) =>
                    setNewPatient((p) => ({ ...p, phone: e.target.value }))
                  }
                  placeholder="+91 9xxxxxxxxx"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="np-date">Admitted on</Label>
                <Input
                  id="np-date"
                  type="date"
                  value={newPatient.admittedAt}
                  onChange={(e) =>
                    setNewPatient((p) => ({ ...p, admittedAt: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="np-type">Admission type</Label>
              {/* Sprint 0.15: native <select> replaced with the Radix-based
                  shadcn Select so this control matches the design language of
                  every other dropdown in the app (panel filter on this same
                  page is also a native <select> for now; that one stays until
                  the broader 2C consolidation pass). */}
              <Select
                value={newPatient.admissionType || '_none'}
                onValueChange={(value) =>
                  setNewPatient((p) => ({
                    ...p,
                    admissionType:
                      value === '_none'
                        ? ''
                        : (value as 'conservative' | 'surgical'),
                  }))
                }
              >
                <SelectTrigger id="np-type" className="w-full h-9">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_none">—</SelectItem>
                  <SelectItem value="conservative">Conservative</SelectItem>
                  <SelectItem value="surgical">Surgical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowAdd(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="bg-brand-600 hover:bg-brand-700 text-white"
              >
                {submitting ? 'Saving…' : 'Add patient'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default HospitalPatientsPage;
