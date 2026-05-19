import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Home, Pencil, Upload, MoreHorizontal, Phone, FileDown, Send, RefreshCw, Loader2, ChevronDown, Check, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import apiService from '@/services/api';
import { useHospitalDataContext } from '@/pages/hospital/context/HospitalDataContext';
import { Patient } from '@/types';
import PatientPhotosModal from '@/components/modals/PatientPhotosModal';
import PatientDocumentsPanel from './PatientDocumentsPanel';
// Module-level cache map exported by usePhotosData — we delete the patient's
// entry on global refresh so the next mount fetches fresh data instead of
// re-rendering stale rows.
import { photosCache } from '@/components/modals/PatientPhotosModal/hooks/usePhotosData';
import InsuranceComposeModal from './InsuranceComposeModal';
import InsuranceTimelinePanel, { TimelineRef } from './InsuranceTimelinePanel';
import { useHospitalPatients } from '@/hooks/useHospitalPatients';
import { useIpdStages, windowedStages } from '@/hooks/useIpdStages';
import { useGmailHealth } from '@/hooks/useGmailHealth';

/* ------------------------------------------------------------------ */
/* GmailHealthDot — small status indicator next to the Filings tab     */
/* (P8). Green=healthy, amber=warning (pending baseline), red=down.    */
/* Click → navigate to Insurance Interfaces for details.                */
/* ------------------------------------------------------------------ */
const GmailHealthDot: React.FC<{ hospitalId?: string }> = ({ hospitalId }) => {
  const health = useGmailHealth(hospitalId);
  if (health.state === 'loading') {
    return <span className="inline-block h-2 w-2 rounded-full bg-slate-300" aria-label="Gmail status loading" />;
  }
  const { color, title } = (() => {
    switch (health.state) {
      case 'healthy':
        return { color: 'bg-ok-500', title: `Gmail healthy (${health.gmailAddress})` };
      case 'warning':
        return { color: 'bg-warn-500', title: `Gmail: ${health.reason}` };
      case 'unconnected':
        return { color: 'bg-slate-400', title: 'Gmail not connected — see Insurance Interfaces' };
      case 'down':
      default:
        return { color: 'bg-danger-500', title: `Gmail: ${(health as any).reason ?? 'down'}` };
    }
  })();
  return (
    <span
      title={title}
      className={`inline-block h-2 w-2 rounded-full ${color}`}
      aria-label={title}
    />
  );
};

/* ------------------------------------------------------------------ */
/* RunAIButton — operator-triggered intelligence analysis for an IPD.
 * Calls POST /api/v1/claims/:ipdId/intelligence/analyze which kicks off
 * doc segmentation + classification + extraction + adjudication. Returns
 * immediately; user can then navigate to AdjudicationView to see the
 * report once workers finish (usually within a minute or two).
 */
const RunAIButton: React.FC<{
  ipdId: string;
  hospitalId: string;
  patientName?: string;
}> = ({ ipdId, hospitalId, patientName }) => {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiService.post(
        `/claims/${ipdId}/intelligence/analyze`,
        {},
      );
      const data = res.data ?? {};
      const enqueued = data.docs_enqueued_for_segmentation ?? 0;
      const already = data.docs_already_segmented ?? 0;
      const total = data.docs_total ?? 0;
      const reportId = data.adjudication_report_id;
      if (enqueued > 0) {
        toast.success(
          `AI analysis started · ${enqueued}/${total} doc${enqueued === 1 ? '' : 's'} processing${patientName ? ` for ${patientName}` : ''}. Report will be ready in ~1 min.`,
        );
      } else if (reportId) {
        toast.success('AI analysis complete · opening report');
        setTimeout(
          () => navigate(`/portal/${hospitalId}/patient/${ipdId}/ai-summary`),
          250,
        );
        return;
      } else if (total === 0) {
        toast.info('No documents to analyze yet. Upload documents first.');
      } else {
        toast.info(`All ${already} document${already === 1 ? '' : 's'} already processed. Opening report.`);
        setTimeout(
          () => navigate(`/portal/${hospitalId}/patient/${ipdId}/ai-summary`),
          250,
        );
        return;
      }
      // Offer a link to the report (workers will populate it within ~1 min)
      setTimeout(
        () => navigate(`/portal/${hospitalId}/patient/${ipdId}/adjudication`),
        1500,
      );
    } catch (err: any) {
      toast.error(
        err?.response?.data?.message ||
          err?.response?.data?.error ||
          'AI analysis failed',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-violet-300 dark:border-violet-700/60 bg-violet-50 dark:bg-violet-950/40 px-2.5 py-1 text-xs font-medium text-violet-700 dark:text-violet-200 hover:bg-violet-100 dark:hover:bg-violet-900/50 disabled:opacity-60 transition-colors"
      title="Trigger AI document analysis + adjudication for this patient"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
      {busy ? 'Analyzing…' : 'Run AI Analysis'}
    </button>
  );
};

/* StagePicker — inline-editable IPD lifecycle stage                    */
/* ------------------------------------------------------------------ */

/**
 * Renders the current IPD stage as a clickable pill. On click, opens a
 * dropdown of all active stages (sourced from master_options via the
 * shared useIpdStages hook — same cache the pipeline strip + PatientEdit
 * read from). Picking a value PUTs /api/v1/ipds/:id/stage and surfaces
 * the result via a toast.
 */
const StagePicker: React.FC<{
  ipdId: string;
  hospitalId: string;
  currentStage: string | null | undefined;
  onChange: (newStage: string | null) => void;
}> = ({ ipdId, hospitalId, currentStage, onChange }) => {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Shared cache — same hook the pipeline strip uses, so the master_options
  // round-trip happens at most once per page load.
  const { stages: options } = useIpdStages();

  const pick = async (newLabel: string | null) => {
    if (newLabel === (currentStage ?? null)) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await apiService.setIpdStage(ipdId, hospitalId, newLabel);
      onChange(newLabel);
      toast.success(newLabel ? `Stage → ${newLabel}` : 'Stage cleared');
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to update stage');
    } finally {
      setSaving(false);
    }
  };

  // Tone derived from the stage word. Keeps the pill colour informative
  // without baking enum knowledge into the picker — *Approved goes green,
  // *Queried goes amber, transitional states stay info-blue, terminal/none
  // stays muted.
  const tone = (() => {
    if (!currentStage) return 'pill-muted';
    if (/approved/i.test(currentStage)) return 'pill-ok';
    if (/queried/i.test(currentStage)) return 'pill-warn';
    if (/draft|discharged$/i.test(currentStage)) return 'pill-muted';
    return 'pill-info';
  })();

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => {
          if (saving) return;
          setOpen((o) => !o);
        }}
        className={`pill ${tone} inline-flex items-center gap-1.5 cursor-pointer hover:ring-2 hover:ring-brand-500/30 transition disabled:opacity-50`}
        disabled={saving}
        title="Click to change stage"
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Stage: {currentStage ?? '— Set —'}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full mt-1 z-30 min-w-[260px] max-h-[420px] overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Allow ops to clear the stage entirely */}
          <button
            onClick={() => pick(null)}
            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 italic text-slate-500 ${
              !currentStage ? 'bg-slate-50 dark:bg-slate-800/40' : ''
            }`}
          >
            — Clear stage —
          </button>
          <div className="border-t border-slate-200 dark:border-slate-700" />
          {options.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
          ) : (
            options.map((o) => {
              const isCurrent = o.label === currentStage;
              return (
                <button
                  key={o.code}
                  onClick={() => pick(o.label)}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center justify-between gap-2 ${
                    isCurrent ? 'bg-brand-50 dark:bg-brand-900/30 font-medium' : ''
                  }`}
                >
                  <span className="truncate">{o.label}</span>
                  {isCurrent && <Check className="h-3 w-3 text-brand-600" />}
                </button>
              );
            })
          )}
        </div>
      )}
      {/* Backdrop to close on outside click */}
      {open && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
    </div>
  );
};

/**
 * UI Revamp — Patient detail (wireframe screen-hw-patient-detail).
 *
 * Mounted at /portal/:hospitalId/patient/:patientId.
 *
 * Sections rendered when data is present:
 *   - Breadcrumb
 *   - Patient header card: brand-700 initials avatar, name, status pill,
 *     panel pill, age/gender, IPD ID, admission date + days, treating
 *     doctor, phone. Action buttons: Edit patient, Upload documents.
 *   - Status pipeline strip (Draft -> Pre-auth -> Approved -> Admitted ->
 *     Submitted -> Settled), with the current step highlighted.
 *   - Sub-tabs: Overview (active), Documents.  Claim / Timeline /
 *     Notifications are marked Coming soon — hidden when not implemented.
 *   - Overview content: Patient information + Admission info blocks
 *     populated from the existing patient row.
 *
 * Data source priority:
 *   1. location.state.patient (passed from the row click on hw-patients)
 *   2. Fan-out over hospitalPanels + getHospitalPanelPatients, then find
 *      by id. Same shape as the list page so the page works on direct
 *      load / refresh.
 */

// Pipeline strip width. With 19 stages in the master, showing all of them
// in the header is too cluttered. We render a 5-item window centered on the
// current stage so the user sees what they just left + what's coming next.
const PIPELINE_WINDOW_SIZE = 5;

const fmtDateTime = (s?: string | null) =>
  s
    ? new Date(s).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const fmtDate = (s?: string | null) =>
  s
    ? new Date(s).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '—';

const daysSince = (s?: string | null) => {
  if (!s) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 86400000));
};

const maskPhone = (p?: string) => (p ? p.replace(/^(.{3}).+(.{2})$/, '$1•••••$2') : '');

const PatientDetailPage: React.FC = () => {
  const { hospitalId, patientId } = useParams<{ hospitalId: string; patientId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { hospital, hospitalPanels } = useHospitalDataContext();

  const stateP = (location.state as any)?.patient as Patient | undefined;

  const [patient, setPatient] = useState<Patient | undefined>(stateP);
  const [loading, setLoading] = useState(!stateP);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'documents' | 'preauth'>('overview');
  const [showPhotos, setShowPhotos] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [showInsuranceCompose, setShowInsuranceCompose] = useState(false);
  // bumped to force the timeline panel to refetch after a send
  const [timelineRefreshKey, setTimelineRefreshKey] = useState(0);
  // bumped to force the documents panel to refetch (e.g. after insurer attachments auto-save)
  const [documentsRefreshKey, setDocumentsRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const timelineRef = useRef<TimelineRef>(null);

  // Page-level refresh — pulls latest from Gmail + reloads timeline + bumps doc panel refetch.
  // Wired to a button in the patient header so it applies across Overview/Documents/Filings tabs.
  const handlePageRefresh = async () => {
    if (refreshing || !hospitalId) return;
    setRefreshing(true);
    try {
      // Force Gmail poll first so any waiting insurer replies (and their attachments
      // → ipd_doc) get ingested before we re-read the data
      const timelineResult = await (timelineRef.current?.refresh() ??
        apiService.forceGmailPoll(hospitalId).then(r => ({ processed: r.data?.data?.processed ?? 0 })));
      // Bust the module-level photos cache for this patient BEFORE remounting the panel.
      // Without this, the remount reads stale data and a freshly-arrived insurer
      // attachment stays invisible until the 50-min cache TTL elapses or the user
      // clicks the panel's own refresh button.
      photosCache.delete(patient.id);
      // Force the documents panel to refetch (insurer attachments may have just landed)
      setDocumentsRefreshKey(k => k + 1);
      setLastRefreshed(new Date());
      const processed = (timelineResult as { processed: number }).processed ?? 0;
      toast.success(
        processed > 0
          ? `Refreshed — ${processed} new message(s) pulled`
          : 'Refreshed — no new messages'
      );
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  // E2E find: the legacy patient table had a "Generate PDF" action but the
  // new PatientDetail page didn't surface it. Wire the same apiService call
  // (which now passes ?sync=true so the backend returns 200 + done instead
  // of the 202+jobId polling shape the FE can't consume yet).
  const handleGeneratePdf = async () => {
    if (!patientId || generatingPdf) return;
    setGeneratingPdf(true);
    try {
      await apiService.generatePDF(patientId);
      toast.success('PDFs generated successfully');
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Failed to generate PDFs');
    } finally {
      setGeneratingPdf(false);
    }
  };

  // Look up the patient via the shared react-query cache. If the Patients
  // list page mounted recently the result is instant; otherwise the hook
  // fires the same fan-out it would have done inline.
  const panelIds = (hospitalPanels || [])
    .map((p: any) => p.panel_id || p.id)
    .filter(Boolean);
  const { data: queryPatients, isLoading: queryLoading } = useHospitalPatients(
    !patient ? hospitalId : undefined,
    panelIds,
  );
  useEffect(() => {
    if (patient) {
      setLoading(false);
      return;
    }
    if (queryLoading) {
      setLoading(true);
      return;
    }
    if (queryPatients) {
      const found = queryPatients.find((p) => p.id === patientId);
      if (found) setPatient(found);
      else setError('Patient not found in this hospital.');
      setLoading(false);
    }
  }, [patient, queryPatients, queryLoading, patientId]);

  const initials = useMemo(() => {
    if (!patient) return '?';
    return `${patient.first_name?.[0] || ''}${patient.last_name?.[0] || ''}`.toUpperCase() || '?';
  }, [patient]);

  // Pipeline strip: source of truth is master_options(ipd_stage), and we
  // show only a window of ±2 around the current stage. When patient.stage
  // is unset, the window opens at the start of the lifecycle (Draft → …).
  const { stages: allStages } = useIpdStages();
  const { window: pipelineWindow, currentIndexInWindow } = useMemo(
    () => windowedStages(allStages, patient?.stage ?? null, PIPELINE_WINDOW_SIZE),
    [allStages, patient?.stage],
  );

  const admittedDays = daysSince(patient?.admitted_at);

  if (loading) {
    return (
      <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6">
        <p className="text-sm text-slate-500">Loading patient…</p>
      </div>
    );
  }

  if (error || !patient) {
    return (
      <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6">
        <p className="text-sm text-danger-700">{error || 'Patient not found.'}</p>
        <button
          onClick={() => navigate(`/portal/${hospitalId}/patients`)}
          className="mt-3 text-sm text-brand-600 hover:underline"
        >
          ← Back to patients
        </button>
      </div>
    );
  }

  // P10: removed statusLabel/statusTone — were used only for the legacy
  // "Admitted" pill which is now superseded by the StagePicker. Stage tone
  // is computed inline inside StagePicker from patient.stage.

  return (
    <motion.div
      className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6 space-y-4"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Breadcrumb */}
      <nav className="text-sm text-slate-500 flex items-center gap-1.5 flex-wrap">
        <Home className="h-3.5 w-3.5" />
        <button onClick={() => navigate('/')} className="hover:text-brand-700">
          Hospitals
        </button>
        <span className="text-slate-300">/</span>
        <button
          onClick={() => navigate(`/portal/${hospitalId}`)}
          className="hover:text-brand-700"
        >
          {hospital?.name}
        </button>
        <span className="text-slate-300">/</span>
        <button
          onClick={() => navigate(`/portal/${hospitalId}/patients`)}
          className="hover:text-brand-700"
        >
          Patients
        </button>
        <span className="text-slate-300">/</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {patient.first_name} {patient.last_name}
        </span>
      </nav>

      {/* Patient header card */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 dark:bg-slate-900 dark:border-slate-800">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex items-start gap-4 min-w-0">
            <div className="h-14 w-14 rounded-full bg-brand-700 text-white text-xl font-semibold flex items-center justify-center shrink-0">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50 truncate">
                  {patient.first_name} {patient.last_name}
                </h1>
                {/* P10: dropped the legacy "Admitted" pill (read from
                    claims.latest_status). Source of truth for lifecycle is
                    now ipds.stage, surfaced via the StagePicker pill below. */}
                {patient.panel_name && (
                  <span className="pill pill-muted">{patient.panel_name}</span>
                )}
                {/* Claim Type pill — mirrors the column on the patient list.
                    Cashless Everywhere (email-driven SOP flow) gets the ok tone,
                    Network (portal/empanelment) gets info, unset stays muted. */}
                {(() => {
                  const r = (patient as any).claim_filing_route as
                    'cashless_everywhere' | 'network' | null | undefined;
                  const label = r === 'cashless_everywhere' ? 'Cashless Everywhere'
                              : r === 'network'             ? 'Network'
                              : null;
                  if (!label) return null;
                  const cls = r === 'cashless_everywhere' ? 'pill-ok' : 'pill-info';
                  return <span className={`pill ${cls}`}>{label}</span>;
                })()}
                {/* Lifecycle stage picker — inline-editable, sourced from
                    master_options(ipd_stage). Updates patient.stage on save
                    so the dependent FE state stays in sync without refetch. */}
                {hospitalId && patient.id && (
                  <StagePicker
                    ipdId={patient.id}
                    hospitalId={hospitalId}
                    currentStage={patient.stage ?? null}
                    onChange={(s) => setPatient((p) => (p ? { ...p, stage: s } : p))}
                  />
                )}
                {hospitalId && patient.id && (
                  <RunAIButton
                    ipdId={patient.id}
                    hospitalId={hospitalId}
                    patientName={patient.first_name ?? undefined}
                  />
                )}
              </div>
              <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 flex-wrap">
                {(patient.beneficiary_id || patient.pmjay_case_number) && (
                  <>
                    <span className="font-mono text-xs">
                      {patient.beneficiary_id || patient.pmjay_case_number}
                    </span>
                    <span>·</span>
                  </>
                )}
                <span>
                  Admitted {fmtDate(patient.admitted_at)}
                  {admittedDays !== null && ` · ${admittedDays}d`}
                </span>
                {patient.phone && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 font-mono text-xs">
                      <Phone className="h-3 w-3" />
                      {maskPhone(patient.phone)}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Page-level Refresh — pulls latest from Gmail + reloads timeline + documents.
                Works regardless of which tab is active. */}
            <button
              onClick={handlePageRefresh}
              disabled={refreshing}
              className="h-9 px-3 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-2 disabled:opacity-50"
              title={
                lastRefreshed
                  ? `Last refreshed at ${lastRefreshed.toLocaleTimeString('en-IN')}`
                  : 'Pull latest from insurer + reload'
              }
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              className="h-9 px-3 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-2"
              onClick={() =>
                navigate(`/portal/${hospitalId}/patient/${patientId}/edit`, {
                  state: { patient },
                })
              }
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit patient
            </button>
            <button
              className="h-9 px-3 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700 inline-flex items-center gap-2"
              onClick={() => setTab('documents')}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload documents
            </button>
            <button className="h-9 w-9 border border-slate-200 dark:border-slate-700 rounded-md text-sm flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Stage pipeline (windowed view).
            Source: master_options(category='ipd_stage') via useIpdStages.
            We render only PIPELINE_WINDOW_SIZE items around the current stage
            because the full 19-stage list is too cluttered for the header. */}
        {pipelineWindow.length > 0 && (
          <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-1.5 text-xs overflow-x-auto pb-1">
              {pipelineWindow.map((step, idx) => {
                // Stage labels can be long ("Pre-auth Query Responded"); whitespace-nowrap
                // keeps each pill on one line. Current step gets the brand-coloured
                // emphasis; past steps muted; future steps very-muted.
                const isCurrent = idx === currentIndexInWindow;
                const isPast =
                  currentIndexInWindow >= 0 && idx < currentIndexInWindow;
                // Stage-aware tone for the current pill — matches the StagePicker
                // and the patient-list Stage column.
                const currentTone = (() => {
                  const s = step.label;
                  if (/approved/i.test(s)) return 'ok';
                  if (/queried/i.test(s)) return 'warn';
                  if (/^draft$|discharged$/i.test(s)) return 'muted';
                  return 'info';
                })();
                return (
                  <React.Fragment key={step.code}>
                    <div
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded shrink-0 whitespace-nowrap ${
                        isCurrent
                          ? currentTone === 'warn'
                            ? 'bg-warn-50 text-warn-700 font-medium'
                            : currentTone === 'ok'
                            ? 'bg-ok-50 text-ok-700 font-medium'
                            : currentTone === 'muted'
                            ? 'bg-slate-100 text-slate-700 font-medium dark:bg-slate-800 dark:text-slate-200'
                            : 'bg-info-50 text-info-700 font-medium'
                          : isPast
                          ? 'bg-slate-100 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400'
                          : 'text-slate-400'
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          isCurrent
                            ? currentTone === 'warn'
                              ? 'bg-warn-600'
                              : currentTone === 'ok'
                              ? 'bg-ok-600'
                              : currentTone === 'muted'
                              ? 'bg-slate-500'
                              : 'bg-info-600'
                            : isPast
                            ? 'bg-slate-400'
                            : 'bg-slate-300'
                        }`}
                      />
                      {step.label}
                    </div>
                    {idx < pipelineWindow.length - 1 && (
                      <span className="text-slate-300 dark:text-slate-700">›</span>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="border-b border-slate-200 dark:border-slate-800 flex items-center gap-1 text-sm">
        <button
          onClick={() => setTab('overview')}
          className={`px-3 py-2 border-b-2 transition-colors ${
            tab === 'overview'
              ? 'text-slate-900 dark:text-slate-50 font-medium border-brand-600'
              : 'text-slate-500 border-transparent hover:text-slate-900 dark:text-slate-50 dark:hover:text-slate-100'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setTab('documents')}
          className={`px-3 py-2 border-b-2 transition-colors ${
            tab === 'documents'
              ? 'text-slate-900 dark:text-slate-50 font-medium border-brand-600'
              : 'text-slate-500 border-transparent hover:text-slate-900 dark:text-slate-50 dark:hover:text-slate-100'
          }`}
        >
          Documents
        </button>
        <button
          onClick={() => setTab('preauth')}
          className={`px-3 py-2 border-b-2 transition-colors inline-flex items-center gap-2 ${
            tab === 'preauth'
              ? 'text-slate-900 dark:text-slate-50 font-medium border-brand-600'
              : 'text-slate-500 border-transparent hover:text-slate-900 dark:text-slate-50 dark:hover:text-slate-100'
          }`}
        >
          Filings &amp; Communications
          {/* P8: Gmail health dot — pre-empts "I clicked Send and it failed" */}
          <GmailHealthDot hospitalId={hospitalId} />
        </button>
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="lg:col-span-2 space-y-5">
            {/* Patient information */}
            <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Patient information
                </h3>
                <button
                  onClick={() =>
                    navigate(`/portal/${hospitalId}/patient/${patientId}/edit`, {
                      state: { patient },
                    })
                  }
                  className="text-xs text-brand-600 hover:underline"
                >
                  Edit ↗
                </button>
              </div>
              <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                <Field label="Full name" value={`${patient.first_name} ${patient.last_name}`} />
                <Field label="Phone" value={patient.phone ? maskPhone(patient.phone) : '—'} mono />
                {patient.pmjay_case_number && (
                  <Field label="PMJAY case #" value={patient.pmjay_case_number} mono />
                )}
                {patient.beneficiary_id && (
                  <Field label="Beneficiary ID" value={patient.beneficiary_id} mono />
                )}
              </div>
            </div>

            {/* Admission */}
            <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Admission
                </h3>
              </div>
              <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                <Field label="Admitted at" value={fmtDateTime(patient.admitted_at)} />
                <Field
                  label="Discharge date"
                  value={patient.discharged_at ? fmtDate(patient.discharged_at) : '—'}
                />
                <Field
                  label="Stay so far"
                  value={admittedDays !== null ? `${admittedDays} days` : '—'}
                />
                {patient.panel_name && <Field label="Panel" value={patient.panel_name} />}
                {patient.admission_type && (
                  <Field label="Admission type" value={patient.admission_type} />
                )}
                {patient.treatment_procedure && (
                  <Field
                    label="Treatment"
                    value={patient.treatment_procedure}
                    colSpan="sm:col-span-2 lg:col-span-3"
                  />
                )}
              </div>
            </div>

            {/* Claim summary - only render if there's claim data */}
            {(patient.claim_amount ||
              patient.claim_approved ||
              patient.claim_settled) ? (
              <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
                <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                    Claim summary
                  </h3>
                </div>
                <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
                  {patient.claim_amount && (
                    <Field
                      label="Claim raised"
                      value={`₹${Number(patient.claim_amount).toLocaleString('en-IN')}`}
                    />
                  )}
                  {patient.claim_approved && (
                    <Field
                      label="Claim approved"
                      value={`₹${Number(patient.claim_approved).toLocaleString('en-IN')}`}
                    />
                  )}
                  {patient.claim_settled && (
                    <Field
                      label="Settled"
                      value={`₹${Number(patient.claim_settled).toLocaleString('en-IN')}`}
                    />
                  )}
                  {patient.deduction && (
                    <Field
                      label="Deduction"
                      value={`₹${Number(patient.deduction).toLocaleString('en-IN')}`}
                    />
                  )}
                  {patient.deduction_reason && (
                    <Field
                      label="Deduction reason"
                      value={patient.deduction_reason}
                      colSpan="sm:col-span-3"
                    />
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {/* Right column (smaller — placeholders only for now) */}
          <div className="space-y-5">
            <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
              <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  Quick actions
                </h3>
              </div>
              <div className="px-5 py-4 space-y-2 text-sm">
                <button
                  onClick={() => setTab('documents')}
                  className="w-full text-left px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-2"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload documents
                </button>
                <button
                  onClick={() =>
                    navigate(`/portal/${hospitalId}/patient/${patientId}/edit`, {
                      state: { patient },
                    })
                  }
                  className="w-full text-left px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-2"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit patient
                </button>
                <button
                  onClick={handleGeneratePdf}
                  disabled={generatingPdf}
                  className="w-full text-left px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  {generatingPdf ? 'Generating PDFs…' : 'Generate PDFs'}
                </button>
                <button
                  onClick={() => setShowInsuranceCompose(true)}
                  className="w-full text-left px-3 py-2 border border-brand-300 dark:border-brand-700 bg-brand-50 dark:bg-brand-950 rounded-md hover:bg-brand-100 dark:hover:bg-brand-900 inline-flex items-center gap-2 text-brand-700 dark:text-brand-300 font-medium"
                >
                  <Send className="h-3.5 w-3.5" />
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'preauth' && hospitalId && patientId && (
        <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
          <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              Filings &amp; Communications
            </h3>
            <button
              onClick={() => setShowInsuranceCompose(true)}
              className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-700 text-white rounded-md inline-flex items-center gap-1.5"
            >
              <Send className="h-3 w-3" />
              Send
            </button>
          </div>
          <InsuranceTimelinePanel
            ref={timelineRef}
            key={timelineRefreshKey}
            ipdId={patientId}
            hospitalId={hospitalId}
            onReplyToInbound={() => setShowInsuranceCompose(true)}
          />
        </div>
      )}

      {tab === 'documents' && (
        <PatientDocumentsPanel key={documentsRefreshKey} patient={patient} />
      )}

      {/* Patient documents modal (Bug 3 fix) */}
      {showPhotos && patient && (
        <PatientPhotosModal
          patient={patient}
          onClose={() => setShowPhotos(false)}
        />
      )}

      {/* Insurance Compose modal */}
      {showInsuranceCompose && hospitalId && patientId && patient && (
        <InsuranceComposeModal
          ipdId={patientId}
          hospitalId={hospitalId}
          patientName={`${patient.first_name ?? ''} ${patient.last_name ?? ''}`.trim()}
          panelName={patient.panel_name}
          onClose={() => setShowInsuranceCompose(false)}
          onSent={() => {
            setTimelineRefreshKey(k => k + 1);
            setTab('preauth');
          }}
        />
      )}
    </motion.div>
  );
};

// — local helper —
const Field: React.FC<{
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  colSpan?: string;
}> = ({ label, value, mono, colSpan }) => (
  <div className={colSpan || ''}>
    <div className="text-xs text-slate-500">{label}</div>
    <div
      className={`font-medium text-slate-900 dark:text-slate-100 ${
        mono ? 'font-mono text-xs' : ''
      }`}
    >
      {value}
    </div>
  </div>
);

export default PatientDetailPage;
