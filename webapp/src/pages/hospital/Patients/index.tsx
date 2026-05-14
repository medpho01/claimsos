import React, { useEffect, useMemo, useState } from 'react';
import { useHospitalPatients } from '@/hooks/useHospitalPatients';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Activity, Settings as SettingsIcon, Home, Search } from 'lucide-react';
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

type StatusGroup = 'all' | 'preauth' | 'approved' | 'admitted' | 'submitted' | 'queried' | 'settled' | 'rejected';

const STATUS_GROUPS: Array<{ k: StatusGroup; label: string; tone: 'info' | 'ok' | 'warn' | 'danger' | 'muted' }> = [
  { k: 'all',       label: 'All',       tone: 'info'   },
  { k: 'preauth',   label: 'Pre-auth',  tone: 'warn'   },
  { k: 'approved',  label: 'Approved',  tone: 'ok'     },
  { k: 'admitted',  label: 'Admitted',  tone: 'info'   },
  { k: 'submitted', label: 'Submitted', tone: 'info'   },
  { k: 'queried',   label: 'Queried',   tone: 'warn'   },
  { k: 'settled',   label: 'Settled',   tone: 'ok'     },
  { k: 'rejected',  label: 'Rejected',  tone: 'danger' },
];

const statusToGroup = (s?: string): StatusGroup => {
  const v = (s || '').toLowerCase();
  if (v.includes('pre-auth') || v.includes('preauth')) return 'preauth';
  if (v.includes('approve')) return 'approved';
  if (v.includes('admit')) return 'admitted';
  if (v.includes('submit')) return 'submitted';
  if (v.includes('quer')) return 'queried';
  if (v.includes('settle')) return 'settled';
  if (v.includes('reject') || v.includes('denied')) return 'rejected';
  return 'admitted';
};

const statusToneClass = (tone: 'info' | 'ok' | 'warn' | 'danger' | 'muted') =>
  tone === 'ok'     ? 'pill-ok'
  : tone === 'warn'   ? 'pill-warn'
  : tone === 'danger' ? 'pill-danger'
  : tone === 'muted'  ? 'pill-muted'
  : 'pill-info';

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
  const [activeStatus, setActiveStatus] = useState<StatusGroup>('all');
  const [search, setSearch] = useState('');

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

  const panelIds = useMemo(
    () =>
      (hospitalPanels || [])
        .map((p: any) => p.panel_id || p.id)
        .filter(Boolean),
    [hospitalPanels],
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
    const c: Record<StatusGroup, number> = {
      all: patients.length, preauth: 0, approved: 0, admitted: 0,
      submitted: 0, queried: 0, settled: 0, rejected: 0,
    };
    patients.forEach((p) => {
      const g = statusToGroup(p.latest_status);
      c[g] = (c[g] || 0) + 1;
    });
    return c;
  }, [patients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return patients.filter((p) => {
      if (activeStatus !== 'all' && statusToGroup(p.latest_status) !== activeStatus) return false;
      if (!q) return true;
      const haystack = `${p.first_name} ${p.last_name} ${p.beneficiary_id || ''} ${p.pmjay_case_number || ''} ${p.panel_name || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [patients, activeStatus, search]);

  const admittedTotal = counts.admitted + counts.approved + counts.preauth;
  const historicalTotal = counts.settled + counts.rejected;

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
          className="px-3 py-2 text-slate-500 border-b-2 border-transparent hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
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
          <button className="h-9 px-3 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
            Export
          </button>
          <button
            className="h-9 px-3 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700"
            onClick={() => {
              // Pre-select the first panel if there's only one; otherwise leave empty
              // so the user must pick.
              const onlyPanel =
                hospitalPanels?.length === 1 ? (hospitalPanels[0] as any) : null;
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

      {/* Status filter pills */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {STATUS_GROUPS.map(({ k, label, tone }) => {
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

      {/* Search bar */}
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
                <th className="text-left px-3 py-2">Patient</th>
                <th className="text-left px-3 py-2">Panel</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Admitted</th>
                <th className="text-right px-3 py-2">Claim ₹</th>
                <th className="px-3 py-2 w-6"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((p) => {
                const g = statusToGroup(p.latest_status);
                const meta = STATUS_GROUPS.find((s) => s.k === g) || STATUS_GROUPS[0];
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
                    <td className="px-3 py-2.5">
                      <span className="pill pill-muted">{p.panel_name || '—'}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`pill ${statusToneClass(meta.tone)}`}>
                        {p.latest_status || meta.label}
                      </span>
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
                {(hospitalPanels || []).map((p: any) => (
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
              <select
                id="np-type"
                value={newPatient.admissionType}
                onChange={(e) =>
                  setNewPatient((p) => ({
                    ...p,
                    admissionType: e.target.value as 'conservative' | 'surgical' | '',
                  }))
                }
                className="w-full h-9 px-3 rounded-md border text-sm"
              >
                <option value="">—</option>
                <option value="conservative">Conservative</option>
                <option value="surgical">Surgical</option>
              </select>
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
