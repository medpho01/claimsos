import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Loader, X, Edit2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import ApiService from '@/services/api';
import {
  DoctorPersonalInfo,
  HospitalDoctorAssignment,
  PersonalInfoFormData,
  HospitalAssignmentFormData,
  TabStatus,
} from './types';
import { PersonalInfoTab } from './PersonalInfoTab';
import { HospitalAssignmentTab } from './HospitalAssignmentTab';
import { CredentialsTab } from './CredentialsTab';

interface DoctorDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hospitalId: string;
  doctor: { doctor_id: string; doctor?: DoctorPersonalInfo } | null;
  hospitalDoctor?: HospitalDoctorAssignment;
  isCreateMode?: boolean;
  onSuccess?: () => void;
}

export const DoctorDetailsModal: React.FC<DoctorDetailsModalProps> = ({
  open,
  onOpenChange,
  hospitalId,
  doctor,
  hospitalDoctor,
  isCreateMode = false,
  onSuccess,
}) => {
  const [activeTab, setActiveTab] = useState<'personal' | 'assignment' | 'credentials'>(
    'personal'
  );
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Edit state for the two view/edit tabs. Lifted from the tabs themselves
  // so the sticky dialog header can render the Edit/Cancel toggle beside
  // the close button — keeps the action visible without eating tab
  // vertical space.
  const [editingPersonal, setEditingPersonal] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState(false);
  // Credentials tab exposes the "open Add Credential dialog" entry point
  // via this ref so the modal header can trigger it.
  const openAddCredentialRef = React.useRef<(() => void) | null>(null);

  const [doctorData, setDoctorData] = useState<DoctorPersonalInfo | null>(null);
  const [hospitalDoctorData, setHospitalDoctorData] = useState<HospitalAssignmentFormData | null>(null);

  // Tab-specific status states
  const [tabStatus, setTabStatus] = useState({
    personal: { isDirty: false, isSaving: false, error: null, success: false },
    assignment: { isDirty: false, isSaving: false, error: null, success: false },
    credentials: { isDirty: false, isSaving: false, error: null, success: false },
  });

  const setTabStatusForKey = (key: 'personal' | 'assignment' | 'credentials', status: TabStatus) => {
    setTabStatus((prev) => ({
      ...prev,
      [key]: status,
    }));
  };

  // Load doctor data on mount
  useEffect(() => {
    if (!open || !doctor) return;

    const loadData = async () => {
      try {
        setIsLoading(true);
        setLoadError(null);

        if (isCreateMode) {
          // For create mode, initialize with empty data
          setDoctorData(null);
          setHospitalDoctorData({
            employmentType: '',
            department: '',
            designation: '',
            specialization: '',
            startDate: '',
            endDate: '',
            status: 'active',
            employeeId: '',
            hospitalPhone: '',
            hospitalEmail: '',
            notes: '',
          });
        } else {
          // For edit mode, load hospital doctor data
          const hdRes = await ApiService.getHospitalDoctor(hospitalId, doctor.doctor_id);
          const hdData = hdRes.data?.data;

          setDoctorData(doctor.doctor || null);
          setHospitalDoctorData({
            employmentType: hdData?.employment_type || '',
            department: hdData?.department || '',
            designation: hdData?.designation || '',
            specialization: hdData?.specialization || '',
            startDate: hdData?.start_date ? hdData.start_date.split('T')[0] : '',
            endDate: hdData?.end_date ? hdData.end_date.split('T')[0] : '',
            employeeId: hdData?.employee_id || '',
            hospitalPhone: hdData?.hospital_phone || '',
            hospitalEmail: hdData?.hospital_email || '',
            notes: hdData?.notes || '',
            status: hdData?.status || '',
          });
        }
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to load doctor details';
        setLoadError(errorMsg);
        console.error('Error loading doctor details:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [open, doctor, hospitalId, isCreateMode]);

  const handleClose = () => {
    // Reset all tab status
    setTabStatus({
      personal: { isDirty: false, isSaving: false, error: null, success: false },
      assignment: { isDirty: false, isSaving: false, error: null, success: false },
      credentials: { isDirty: false, isSaving: false, error: null, success: false },
    });
    setLoadError(null);
    onOpenChange(false);
  };

  const handleSaveSuccess = () => {
    if (onSuccess) {
      onSuccess();
    }
  };

  if (!doctor) return null;

  const personalInfoData: PersonalInfoFormData = {
    firstName: doctorData?.first_name || '',
    lastName: doctorData?.last_name || '',
    email: doctorData?.email || '',
    phone: doctorData?.phone || '',
    primarySpecialization: doctorData?.primary_specialization || '',
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] p-0 flex flex-col">
        {/* Sticky Header */}
        <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <div className="px-6 pt-6 pb-4 flex justify-between items-start gap-2">
            <DialogHeader>
              <DialogTitle>
                {isCreateMode ? 'Add New Doctor' : `Edit Doctor: ${doctorData?.first_name} ${doctorData?.last_name}`}
              </DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-2">
              {/* Tab-specific action: Edit (Personal / Assignment) or
                  Add Credential (Credentials). Replaces the per-tab
                  inline buttons that were eating vertical space and
                  rendering inconsistently across tabs. */}
              {!isLoading && !loadError && activeTab === 'personal' && !editingPersonal && (
                <Button
                  size="sm"
                  onClick={() => setEditingPersonal(true)}
                  className="gap-2 bg-brand-600 hover:bg-brand-700 text-white"
                >
                  <Edit2 className="h-4 w-4" />
                  Edit
                </Button>
              )}
              {!isLoading && !loadError && activeTab === 'assignment' && !editingAssignment && (
                <Button
                  size="sm"
                  onClick={() => setEditingAssignment(true)}
                  className="gap-2 bg-brand-600 hover:bg-brand-700 text-white"
                >
                  <Edit2 className="h-4 w-4" />
                  Edit
                </Button>
              )}
              {!isLoading && !loadError && activeTab === 'credentials' && (
                <Button
                  size="sm"
                  onClick={() => openAddCredentialRef.current?.()}
                  className="gap-2 bg-brand-600 hover:bg-brand-700 text-white"
                >
                  <Plus className="h-4 w-4" />
                  Add Credential
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={handleClose}
                className="text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {/* Sticky Tabs */}
          {!isLoading && !loadError && (
            <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as any)} className="w-full">
              <TabsList className="grid w-full grid-cols-3 mb-0 rounded-none border-b border-slate-200 dark:border-slate-800 mt-2">
                <TabsTrigger value="personal">Personal Information</TabsTrigger>
                <TabsTrigger value="assignment">Hospital Assignment</TabsTrigger>
                <TabsTrigger value="credentials">Credentials</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
        </div>

        {/* Scrollable Content — min-h-0 is required for flex-1 + overflow
            to actually scroll inside a flex column constrained by
            max-h-[90vh]. Without it, the child grows past the parent. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
          {/* Loading State */}
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader className="h-6 w-6 animate-spin text-slate-400 mr-3" />
              <p className="text-slate-600">Loading doctor details...</p>
            </div>
          )}

          {/* Error State */}
          {loadError && !isLoading && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          )}

          {/* Tab Content */}
          {!isLoading && !loadError && (
            <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as any)} className="w-full">
              {/* Tab 1: Personal Information */}
              <TabsContent value="personal" className="space-y-4 mt-6">
              <PersonalInfoTab
                doctorId={doctor.doctor_id}
                initialData={personalInfoData}
                nmcRegistration={doctorData?.nmc_registration_number}
                registrationStatus={doctorData?.registration_status}
                tabStatus={tabStatus.personal}
                setTabStatus={(status) => setTabStatusForKey('personal', status)}
                onSave={handleSaveSuccess}
                isEditing={editingPersonal}
                onEditingChange={setEditingPersonal}
              />
            </TabsContent>

            {/* Tab 2: Hospital Assignment */}
            <TabsContent value="assignment" className="space-y-4">
              {hospitalDoctorData && (
                <HospitalAssignmentTab
                  doctorId={doctor.doctor_id}
                  hospitalId={hospitalId}
                  initialData={hospitalDoctorData}
                  tabStatus={tabStatus.assignment}
                  setTabStatus={(status) => setTabStatusForKey('assignment', status)}
                  onSave={handleSaveSuccess}
                  isEditing={editingAssignment}
                  onEditingChange={setEditingAssignment}
                />
              )}
            </TabsContent>

              {/* Tab 3: Credentials */}
              <TabsContent value="credentials" className="space-y-4 mt-6">
                <CredentialsTab
                  doctorId={doctor.doctor_id}
                  tabStatus={tabStatus.credentials}
                  setTabStatus={(status) => setTabStatusForKey('credentials', status)}
                  registerAddCredential={(open) => { openAddCredentialRef.current = open; }}
                />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
