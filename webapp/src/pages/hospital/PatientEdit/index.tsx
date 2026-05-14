import React from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Home, ArrowLeft } from 'lucide-react';
import { useHospitalDataContext } from '@/pages/hospital/context/HospitalDataContext';
import { Patient } from '@/types';

/**
 * UI Revamp — hw-patient-edit placeholder.
 *
 * Full inline patient-edit form (wireframe screen-hw-patient-edit)
 * is a follow-up. Today, editing happens via the AddPatientModal
 * inside the per-panel patients page. This page exists so the
 * "Edit patient" button from PatientDetail has a target — it shows
 * the patient name + an explanation + a "Continue to panel editor"
 * button that takes the user to the panel where they can launch
 * the existing edit modal.
 */
const PatientEditPage: React.FC = () => {
  const { hospitalId, patientId } = useParams<{ hospitalId: string; patientId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { hospital } = useHospitalDataContext();
  const stateP = (location.state as any)?.patient as Patient | undefined;

  return (
    <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6 space-y-4">
      <nav className="text-sm text-slate-500 flex items-center gap-1.5 flex-wrap">
        <Home className="h-3.5 w-3.5" />
        <button onClick={() => navigate('/')} className="hover:text-brand-700">
          Hospitals
        </button>
        <span className="text-slate-300">/</span>
        <button onClick={() => navigate(`/portal/${hospitalId}`)} className="hover:text-brand-700">
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
            navigate(`/portal/${hospitalId}/patient/${patientId}`, {
              state: { patient: stateP },
            })
          }
          className="hover:text-brand-700"
        >
          {stateP ? `${stateP.first_name} ${stateP.last_name}` : 'Patient'}
        </button>
        <span className="text-slate-300">/</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">Edit</span>
      </nav>

      <div className="bg-white border border-slate-200 rounded-lg p-10 text-center dark:bg-slate-900 dark:border-slate-800">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50 mb-2">
          Edit patient details
        </h2>
        <p className="text-sm text-slate-500 max-w-md mx-auto mb-5">
          Inline patient editing on this screen is coming soon. For now,
          continue to the panel view to use the existing edit flow — your
          changes will reflect back here.
        </p>
        <div className="flex justify-center gap-2">
          <button
            onClick={() =>
              navigate(`/portal/${hospitalId}/patient/${patientId}`, {
                state: { patient: stateP },
              })
            }
            className="h-9 px-3 border border-slate-200 dark:border-slate-700 rounded-md text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to patient
          </button>
          {stateP?.panel_id && (
            <button
              onClick={() =>
                navigate(`/portal/${hospitalId}/panel/${stateP.panel_id}`, {
                  state: { openEditFor: patientId },
                })
              }
              className="h-9 px-3 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700"
            >
              Continue to panel editor →
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PatientEditPage;
