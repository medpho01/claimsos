import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Home, Pencil, Upload, MoreHorizontal, Phone } from 'lucide-react';
import apiService from '@/services/api';
import { useHospitalDataContext } from '@/pages/hospital/context/HospitalDataContext';
import { Patient } from '@/types';

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

const STATUS_STEPS: Array<{ key: string; label: string; match: (s?: string) => boolean }> = [
  { key: 'draft',     label: 'Draft',     match: (s) => !s || /draft/i.test(s) },
  { key: 'preauth',   label: 'Pre-auth',  match: (s) => /pre.?auth/i.test(s || '') },
  { key: 'approved',  label: 'Approved',  match: (s) => /approve/i.test(s || '') },
  { key: 'admitted',  label: 'Admitted',  match: (s) => /admit/i.test(s || '') },
  { key: 'submitted', label: 'Submitted', match: (s) => /submit/i.test(s || '') },
  { key: 'settled',   label: 'Settled',   match: (s) => /settle/i.test(s || '') },
];

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
  const [tab, setTab] = useState<'overview' | 'documents'>('overview');

  useEffect(() => {
    if (patient || !hospitalId || !patientId || !hospitalPanels) return;
    let cancelled = false;
    setLoading(true);
    const panelIds = hospitalPanels.map((p: any) => p.panel_id || p.id).filter(Boolean);

    Promise.all(
      panelIds.map((pid: string) =>
        apiService
          .getHospitalPanelPatients(hospitalId, pid, 1, 'all', '')
          .then((r) => {
            const raw = r?.data?.data;
            const list = Array.isArray(raw)
              ? raw
              : Array.isArray(raw?.data)
              ? raw.data
              : [];
            return list as Patient[];
          })
          .catch(() => [])
      )
    )
      .then((groups) => {
        if (cancelled) return;
        const flat = ([] as Patient[]).concat(...groups);
        const found = flat.find((p) => p.id === patientId);
        if (found) setPatient(found);
        else setError('Patient not found in this hospital.');
      })
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [patient, hospitalId, patientId, hospitalPanels]);

  const initials = useMemo(() => {
    if (!patient) return '?';
    return `${patient.first_name?.[0] || ''}${patient.last_name?.[0] || ''}`.toUpperCase() || '?';
  }, [patient]);

  const currentStepIdx = useMemo(() => {
    if (!patient) return 0;
    const idx = STATUS_STEPS.findIndex((s) => s.match(patient.latest_status));
    return idx >= 0 ? idx : 0;
  }, [patient]);

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

  const statusLabel = patient.latest_status || 'Admitted';
  const statusTone =
    /reject|denied/i.test(statusLabel)
      ? 'pill-danger'
      : /quer|pre.?auth/i.test(statusLabel)
      ? 'pill-warn'
      : /settle|approve/i.test(statusLabel)
      ? 'pill-ok'
      : 'pill-info';

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
                <span className={`pill ${statusTone}`}>{statusLabel}</span>
                {patient.panel_name && (
                  <span className="pill pill-muted">{patient.panel_name}</span>
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

        {/* Status pipeline */}
        <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-1.5 text-xs overflow-x-auto pb-1">
            {STATUS_STEPS.map((step, idx) => {
              const isCurrent = idx === currentStepIdx;
              const isPast = idx < currentStepIdx;
              return (
                <React.Fragment key={step.key}>
                  <div
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded shrink-0 ${
                      isCurrent
                        ? statusTone === 'pill-warn'
                          ? 'bg-warn-50 text-warn-700 font-medium'
                          : statusTone === 'pill-danger'
                          ? 'bg-danger-50 text-danger-700 font-medium'
                          : statusTone === 'pill-ok'
                          ? 'bg-ok-50 text-ok-700 font-medium'
                          : 'bg-info-50 text-info-700 font-medium'
                        : isPast
                        ? 'bg-slate-100 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400'
                        : 'text-slate-400'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isCurrent
                          ? statusTone === 'pill-warn'
                            ? 'bg-warn-600'
                            : statusTone === 'pill-danger'
                            ? 'bg-danger-600'
                            : statusTone === 'pill-ok'
                            ? 'bg-ok-600'
                            : 'bg-info-600'
                          : isPast
                          ? 'bg-slate-400'
                          : 'bg-slate-300'
                      }`}
                    />
                    {step.label}
                  </div>
                  {idx < STATUS_STEPS.length - 1 && (
                    <span className="text-slate-300 dark:text-slate-700">›</span>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="border-b border-slate-200 dark:border-slate-800 flex items-center gap-1 text-sm">
        <button
          onClick={() => setTab('overview')}
          className={`px-3 py-2 border-b-2 transition-colors ${
            tab === 'overview'
              ? 'text-slate-900 dark:text-slate-50 font-medium border-brand-600'
              : 'text-slate-500 border-transparent hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setTab('documents')}
          className={`px-3 py-2 border-b-2 transition-colors ${
            tab === 'documents'
              ? 'text-slate-900 dark:text-slate-50 font-medium border-brand-600'
              : 'text-slate-500 border-transparent hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          Documents
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
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'documents' && (
        <div className="bg-white border border-slate-200 rounded-lg p-10 text-center dark:bg-slate-900 dark:border-slate-800">
          <Upload className="h-8 w-8 mx-auto text-slate-300 mb-3" />
          <p className="text-sm text-slate-500">
            Document management opens in a modal from the patient list today.
          </p>
          <button
            onClick={() => navigate(`/portal/${hospitalId}/patients`)}
            className="mt-3 text-sm text-brand-600 hover:underline"
          >
            ← Back to patients list
          </button>
        </div>
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
