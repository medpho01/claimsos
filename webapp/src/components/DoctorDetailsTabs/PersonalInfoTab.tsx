import React, { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Save, Loader, Edit2 } from 'lucide-react';
import { toast } from 'sonner';
import ApiService from '@/services/api';
import { PersonalInfoFormData, TabStatus } from './types';
import { useTabFormState } from './hooks/useTabFormState';

// Validation schema
const personalInfoSchema = z.object({
  firstName: z.string().min(2, 'First name must be at least 2 characters'),
  lastName: z.string().optional(),
  email: z.string().email('Invalid email address'),
  phone: z
    .string()
    .optional()
    .refine(
      (val) => !val || val.length === 10,
      'Phone number must be 10 digits'
    ),
  primarySpecialization: z.string().optional(),
  nmcRegistrationNumber: z.string().optional(),
});

const specializations = [
  'Cardiology',
  'Pediatrics',
  'Orthopedics',
  'General Surgery',
  'Neurology',
  'Psychiatry',
  'Dermatology',
  'ENT',
  'Ophthalmology',
  'Gastroenterology',
  'Oncology',
  'Radiology',
  'Anesthesia',
  'Pathology',
  'Microbiology',
  'Pharmacology',
  'Obstetrics & Gynecology',
  'Urology',
  'Nephrology',
  'Endocrinology',
  'Rheumatology',
  'Pulmonology',
];

interface PersonalInfoTabProps {
  doctorId: string;
  initialData: PersonalInfoFormData;
  nmcRegistration?: string;
  registrationStatus?: string;
  tabStatus: TabStatus;
  setTabStatus: (status: TabStatus) => void;
  onSave?: () => void;
}

interface ExtendedPersonalInfoFormData extends PersonalInfoFormData {
  nmcRegistrationNumber?: string;
}

export const PersonalInfoTab: React.FC<PersonalInfoTabProps> = ({
  doctorId,
  initialData,
  nmcRegistration,
  registrationStatus,
  tabStatus,
  setTabStatus,
  onSave,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const extendedInitialData: ExtendedPersonalInfoFormData = {
    ...initialData,
    nmcRegistrationNumber: nmcRegistration || '',
  };
  const form = useTabFormState<ExtendedPersonalInfoFormData>(extendedInitialData);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    try {
      personalInfoSchema.parse(form.formData);
    } catch (err: any) {
      if (err instanceof z.ZodError) {
        err.errors.forEach((error) => {
          const fieldName = error.path[0] as string;
          errors[fieldName] = error.message;
        });
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validateForm()) {
      return;
    }

    try {
      form.setIsSaving(true);
      setTabStatus({ ...tabStatus, isSaving: true, error: null });

      const payload = {
        firstName: form.formData.firstName,
        lastName: form.formData.lastName || undefined,
        email: form.formData.email,
        phone: form.formData.phone || undefined,
        primarySpecialization: form.formData.primarySpecialization || undefined,
        nmcRegistrationNumber: (form.formData as ExtendedPersonalInfoFormData).nmcRegistrationNumber || undefined,
      };

      console.log('Saving personal info:', payload);
      await ApiService.updateDoctor(doctorId, payload);

      toast.success('Personal information saved successfully');
      setIsEditing(false); // Exit edit mode
      setTabStatus({
        isDirty: false,
        isSaving: false,
        error: null,
        success: true,
      });

      // Clear success state after 3 seconds
      setTimeout(() => {
        setTabStatus({
          isDirty: false,
          isSaving: false,
          error: null,
          success: false,
        });
      }, 3000);

      if (onSave) onSave();
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Failed to save personal information';
      setTabStatus({ ...tabStatus, isSaving: false, error: errorMsg });
      toast.error(errorMsg);
    } finally {
      form.setIsSaving(false);
    }
  };

  const handleCancel = () => {
    form.reset();
    setFieldErrors({});
    setIsEditing(false);
    setTabStatus({ isDirty: false, isSaving: false, error: null, success: false });
  };

  return (
    <div className="space-y-4">
      {/* Success Alert */}
      {tabStatus.success && (
        <Alert className="bg-green-50 border-green-200">
          <AlertDescription className="text-green-800">
            ✓ Personal information saved successfully!
          </AlertDescription>
        </Alert>
      )}

      {/* Error Alert */}
      {tabStatus.error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{tabStatus.error}</AlertDescription>
        </Alert>
      )}

      {/* Header with Edit Button */}
      {!isEditing && (
        <div className="flex justify-end">
          <Button
            onClick={() => setIsEditing(true)}
            className="gap-2 bg-brand-600 hover:bg-brand-700 text-white"
          >
            <Edit2 className="h-4 w-4" />
            Edit
          </Button>
        </div>
      )}

      {/* View Mode - Read-only Display */}
      {!isEditing && (
        <div className="space-y-4 bg-slate-50 p-6 rounded-lg border border-slate-200">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">First Name</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.firstName || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Last Name</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.lastName || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Email</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.email || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Phone</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.phone || '-'}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs font-medium text-slate-600 mb-1">Primary Specialization</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.primarySpecialization || '-'}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs font-medium text-slate-600 mb-1">NMC Registration Number</p>
              <p className="text-sm font-medium text-slate-900">{(form.formData as ExtendedPersonalInfoFormData).nmcRegistrationNumber || '-'}</p>
            </div>
          </div>

          {registrationStatus && (
            <div className="pt-4 border-t border-slate-300">
              <p className="text-xs font-medium text-slate-600 mb-1">Registration Status</p>
              <p className="text-sm font-medium text-slate-900 capitalize">{registrationStatus.replace(/_/g, ' ')}</p>
            </div>
          )}
        </div>
      )}

      {/* Form - Edit Mode */}
      {isEditing && (
        <div className="space-y-4 bg-slate-50 p-6 rounded-lg border border-slate-200">
        <div className="grid grid-cols-2 gap-4">
          {/* First Name */}
          <div className="space-y-2">
            <Label htmlFor="first-name">First Name *</Label>
            <Input
              id="first-name"
              value={form.formData.firstName}
              onChange={(e) => form.updateField('firstName', e.target.value)}
              placeholder="First name"
              disabled={form.isSaving}
              className={fieldErrors.firstName ? 'border-red-500' : ''}
            />
            {fieldErrors.firstName && (
              <p className="text-xs text-red-600">{fieldErrors.firstName}</p>
            )}
          </div>

          {/* Last Name */}
          <div className="space-y-2">
            <Label htmlFor="last-name">Last Name</Label>
            <Input
              id="last-name"
              value={form.formData.lastName}
              onChange={(e) => form.updateField('lastName', e.target.value)}
              placeholder="Last name"
              disabled={form.isSaving}
            />
          </div>

          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="email">Email *</Label>
            <Input
              id="email"
              type="email"
              value={form.formData.email}
              onChange={(e) => form.updateField('email', e.target.value)}
              placeholder="Email address"
              disabled={form.isSaving}
              className={fieldErrors.email ? 'border-red-500' : ''}
            />
            {fieldErrors.email && (
              <p className="text-xs text-red-600">{fieldErrors.email}</p>
            )}
          </div>

          {/* Phone */}
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              type="tel"
              value={form.formData.phone}
              onChange={(e) => form.updateField('phone', e.target.value)}
              placeholder="10-digit phone number"
              disabled={form.isSaving}
              maxLength={10}
              className={fieldErrors.phone ? 'border-red-500' : ''}
            />
            {fieldErrors.phone && (
              <p className="text-xs text-red-600">{fieldErrors.phone}</p>
            )}
          </div>

          {/* Primary Specialization */}
          <div className="col-span-2 space-y-2">
            <Label htmlFor="specialization">Primary Specialization</Label>
            <select
              id="specialization"
              value={form.formData.primarySpecialization}
              onChange={(e) => form.updateField('primarySpecialization', e.target.value)}
              disabled={form.isSaving}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 bg-white"
            >
              <option value="">Select specialization...</option>
              {specializations.map((spec) => (
                <option key={spec} value={spec}>
                  {spec}
                </option>
              ))}
            </select>
          </div>

          {/* NMC Registration Number - Now Editable */}
          <div className="col-span-2 space-y-2">
            <Label htmlFor="nmc-registration">NMC Registration Number</Label>
            <Input
              id="nmc-registration"
              value={(form.formData as ExtendedPersonalInfoFormData).nmcRegistrationNumber || ''}
              onChange={(e) => form.updateField('nmcRegistrationNumber', e.target.value)}
              placeholder="Medical Council registration number"
              disabled={form.isSaving}
            />
          </div>
        </div>

        {/* Registration Status (Read-only) */}
        {registrationStatus && (
          <div className="space-y-2 pt-4 border-t border-slate-300">
            <Label className="text-xs font-medium text-slate-600">Registration Status</Label>
            <p className="text-sm capitalize text-slate-700">{registrationStatus.replace(/_/g, ' ')}</p>
          </div>
        )}
      </div>
      )}

      {/* Action Buttons - Only in Edit Mode */}
      {isEditing && (
        <div className="flex gap-3 justify-end pt-4 border-t border-slate-200">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={form.isSaving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!form.isDirty || form.isSaving}
            className="gap-2 bg-brand-600 hover:bg-brand-700 text-white"
          >
            {form.isSaving ? (
              <>
                <Loader className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                Save Changes
              </>
            )}
          </Button>
        </div>
      )}

      {/* Dirty State Indicator */}
      {isEditing && form.isDirty && !form.isSaving && (
        <p className="text-xs text-yellow-600">You have unsaved changes</p>
      )}
    </div>
  );
};
