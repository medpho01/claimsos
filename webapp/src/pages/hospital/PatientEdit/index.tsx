import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Home, ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useHospitalDataContext } from '@/pages/hospital/context/HospitalDataContext';
import apiService from '@/services/api';
import { Patient } from '@/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/forms/SelectField';

/**
 * UI Revamp — inline patient-edit form (wireframe screen-hw-patient-edit).
 *
 * Mounted at /portal/:hospitalId/patient/:patientId/edit. Editable fields
 * mirror what apiService.updatePatient accepts:
 *   - First name (required) + Last name
 *   - Phone
 *   - Admitted on (date)
 *   - Admission type (conservative / surgical)
 *   - PMJAY case number, scheme, treatment procedure
 *   - Latest status, claim amount
 *
 * Data source priority:
 *   1. location.state.patient (passed from the detail page Edit button)
 *   2. Fan-out over hospitalPanels + getHospitalPanelPatients, then
 *      find by id. Same shape as the list/detail pages so deep links
 *      and refresh work.
 *
 * On save we PATCH /patient/:id and navigate back to the detail page
 * so the form acts like a focused editor, not a separate flow.
 */
const PatientEditPage: React.FC = () => {
  const { hospitalId, patientId } = useParams<{ hospitalId: string; patientId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { hospital, hospitalPanels } = useHospitalDataContext();
  const stateP = (location.state as any)?.patient as Patient | undefined;

  const [patient, setPatient] = useState<Patient | undefined>(stateP);
  const [loading, setLoading] = useState(!stateP);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    admittedAt: '',
    admissionType: '' as 'conservative' | 'surgical' | '',
    pmjayCaseNumber: '',
    scheme: '',
    treatmentProcedure: '',
    latestStatus: '',
    claimAmount: '',
  });

  // Populate form from patient
  useEffect(() => {
    if (!patient) return;
    setForm({
      firstName: patient.first_name || '',
      lastName: patient.last_name || '',
      phone: patient.phone || '',
      admittedAt: patient.admitted_at
        ? new Date(patient.admitted_at).toISOString().split('T')[0]
        : '',
      admissionType: (patient.admission_type as any) || '',
      pmjayCaseNumber: patient.pmjay_case_number || '',
      scheme: patient.scheme || '',
      treatmentProcedure: patient.treatment_procedure || '',
      latestStatus: patient.latest_status || '',
      claimAmount: patient.claim_amount ? String(patient.claim_amount) : '',
    });
  }, [patient]);

  // If no state, fan out to find the patient
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
            return Array.isArray(raw)
              ? raw
              : Array.isArray(raw?.data)
              ? raw.data
              : [];
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientId) return;
    if (!form.firstName.trim()) {
      toast.error('First name is required.');
      return;
    }
    setSaving(true);
    try {
      await apiService.updatePatient(patientId, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim() || undefined,
        phone: (form.phone || '').replace(/[^\d]/g, ''),
        admittedAt: form.admittedAt
          ? new Date(form.admittedAt).toISOString()
          : new Date().toISOString(),
        admissionType: form.admissionType || undefined,
        pmjayCaseNumber: form.pmjayCaseNumber || undefined,
        scheme: form.scheme || undefined,
        treatmentProcedure: form.treatmentProcedure || undefined,
        latestStatus: form.latestStatus || undefined,
        claimAmount: form.claimAmount ? Number(form.claimAmount) : undefined,
      });
      toast.success('Patient updated.');
      navigate(`/portal/${hospitalId}/patient/${patientId}`, { replace: true });
    } catch (err: any) {
      toast.error(err?.response?.data?.message || 'Failed to update patient.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6">
        <p className="text-sm text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading patient…
        </p>
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
        <button
          onClick={() =>
            navigate(`/portal/${hospitalId}/patient/${patientId}`, { state: { patient } })
          }
          className="hover:text-brand-700"
        >
          {patient.first_name} {patient.last_name}
        </button>
        <span className="text-slate-300">/</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">Edit</span>
      </nav>

      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Edit patient
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {patient.first_name} {patient.last_name}
            {patient.panel_name && <> · {patient.panel_name}</>}
          </p>
        </div>
        <button
          onClick={() =>
            navigate(`/portal/${hospitalId}/patient/${patientId}`, { state: { patient } })
          }
          className="h-9 px-3 inline-flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to patient
        </button>
      </div>

      {/* Form */}
      <form
        onSubmit={handleSave}
        className="bg-white border border-slate-200 rounded-lg p-5 space-y-5 dark:bg-slate-900 dark:border-slate-800"
      >
        {/* Identity */}
        <Section title="Identity">
          <Field label="First name *" htmlFor="fn">
            <Input
              id="fn"
              required
              value={form.firstName}
              onChange={(e) => setForm((p) => ({ ...p, firstName: e.target.value }))}
            />
          </Field>
          <Field label="Last name" htmlFor="ln">
            <Input
              id="ln"
              value={form.lastName}
              onChange={(e) => setForm((p) => ({ ...p, lastName: e.target.value }))}
            />
          </Field>
          <Field label="Phone" htmlFor="ph">
            <Input
              id="ph"
              value={form.phone}
              onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
              placeholder="+91 9xxxxxxxxx"
            />
          </Field>
        </Section>

        {/* Admission */}
        <Section title="Admission">
          <Field label="Admitted on" htmlFor="adm">
            <Input
              id="adm"
              type="date"
              value={form.admittedAt}
              onChange={(e) => setForm((p) => ({ ...p, admittedAt: e.target.value }))}
            />
          </Field>
          <div className="grid gap-1.5">
            <SelectField
              id="atype"
              label="Admission type"
              value={form.admissionType}
              placeholder="—"
              onChange={(v) =>
                setForm((p) => ({
                  ...p,
                  admissionType: v as 'conservative' | 'surgical' | '',
                }))
              }
              options={[
                { value: 'conservative', label: 'Conservative' },
                { value: 'surgical', label: 'Surgical' },
              ]}
            />
          </div>
          <Field label="Treatment procedure" htmlFor="tp">
            <Input
              id="tp"
              value={form.treatmentProcedure}
              onChange={(e) => setForm((p) => ({ ...p, treatmentProcedure: e.target.value }))}
            />
          </Field>
        </Section>

        {/* Claim */}
        <Section title="Claim">
          <Field label="PMJAY case number" htmlFor="pmjay">
            <Input
              id="pmjay"
              value={form.pmjayCaseNumber}
              onChange={(e) =>
                setForm((p) => ({ ...p, pmjayCaseNumber: e.target.value }))
              }
            />
          </Field>
          <Field label="Scheme" htmlFor="sch">
            <Input
              id="sch"
              value={form.scheme}
              onChange={(e) => setForm((p) => ({ ...p, scheme: e.target.value }))}
            />
          </Field>
          <Field label="Latest status" htmlFor="status">
            <Input
              id="status"
              value={form.latestStatus}
              onChange={(e) => setForm((p) => ({ ...p, latestStatus: e.target.value }))}
              placeholder="Pre-auth · Admitted · Settled · …"
            />
          </Field>
          <Field label="Claim amount (₹)" htmlFor="amt">
            <Input
              id="amt"
              type="number"
              min="0"
              step="1"
              value={form.claimAmount}
              onChange={(e) => setForm((p) => ({ ...p, claimAmount: e.target.value }))}
            />
          </Field>
        </Section>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              navigate(`/portal/${hospitalId}/patient/${patientId}`, { state: { patient } })
            }
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving}
            className="bg-brand-600 hover:bg-brand-700 text-white"
          >
            {saving ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving…
              </span>
            ) : (
              'Save changes'
            )}
          </Button>
        </div>
      </form>
    </motion.div>
  );
};

// ────────────── small helpers ──────────────

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div>
    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">
      {title}
    </h3>
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
      {children}
    </div>
  </div>
);

const Field: React.FC<{
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, children }) => (
  <div className="grid gap-1.5">
    <Label htmlFor={htmlFor} className="text-xs font-medium text-slate-700 dark:text-slate-300">
      {label}
    </Label>
    {children}
  </div>
);

export default PatientEditPage;
