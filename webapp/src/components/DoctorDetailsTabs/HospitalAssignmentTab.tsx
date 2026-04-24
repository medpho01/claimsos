import React, { useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Save, Loader, Edit2 } from 'lucide-react';
import { toast } from 'sonner';
import ApiService from '@/services/api';
import { HospitalAssignmentFormData, TabStatus } from './types';
import { useTabFormState } from './hooks/useTabFormState';

// Validation schema
const hospitalAssignmentSchema = z.object({
  employmentType: z.string().min(1, 'Employment type is required'),
  department: z.string().min(1, 'Department is required'),
  designation: z.string().optional(),
  specialization: z.string().optional(),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().optional(),
  status: z.string().optional(),
  employeeId: z.string().optional(),
  hospitalPhone: z.string().optional(),
  hospitalEmail: z.string().email().optional().or(z.literal('')),
  notes: z.string().optional(),
}).refine(
  (data) => {
    if (!data.startDate || !data.endDate) return true;
    return new Date(data.endDate) > new Date(data.startDate);
  },
  {
    message: 'End date must be after start date',
    path: ['endDate'],
  }
);

const employmentTypes = ['resident', 'visiting', 'consultant', 'associate', 'empanelled', 'fulltime', 'parttime'];

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

interface HospitalAssignmentTabProps {
  doctorId: string;
  hospitalId: string;
  initialData: HospitalAssignmentFormData;
  tabStatus: TabStatus;
  setTabStatus: (status: TabStatus) => void;
  onSave?: () => void;
}

export const HospitalAssignmentTab: React.FC<HospitalAssignmentTabProps> = ({
  doctorId,
  hospitalId,
  initialData,
  tabStatus,
  setTabStatus,
  onSave,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const form = useTabFormState<HospitalAssignmentFormData>(initialData);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    try {
      hospitalAssignmentSchema.parse(form.formData);
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
        employmentType: form.formData.employmentType,
        department: form.formData.department,
        designation: form.formData.designation || undefined,
        specialization: form.formData.specialization || undefined,
        startDate: form.formData.startDate || undefined,
        endDate: form.formData.endDate || undefined,
        status: form.formData.status || undefined,
        employeeId: form.formData.employeeId || undefined,
        hospitalPhone: form.formData.hospitalPhone || undefined,
        hospitalEmail: form.formData.hospitalEmail || undefined,
        notes: form.formData.notes || undefined,
      };

      await ApiService.updateHospitalDoctor(hospitalId, doctorId, payload);

      toast.success('Hospital assignment saved successfully');
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
      const errorMsg = err.response?.data?.message || 'Failed to save hospital assignment';
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
            ✓ Hospital assignment saved successfully!
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
            className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Edit2 className="h-4 w-4" />
            Edit
          </Button>
        </div>
      )}

      {/* View Mode - Read-only Display */}
      {!isEditing && (
        <div className="space-y-4 bg-blue-50 p-6 rounded-lg border border-blue-200">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Employment Type</p>
              <p className="text-sm font-medium text-slate-900 capitalize">{form.formData.employmentType || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Department</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.department || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Designation</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.designation || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Specialization at Hospital</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.specialization || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Start Date</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.startDate || '-'}</p>
            </div>
            {form.formData.status !== 'active' && (
              <div>
                <p className="text-xs font-medium text-slate-600 mb-1">End Date</p>
                <p className="text-sm font-medium text-slate-900">{form.formData.endDate || '-'}</p>
              </div>
            )}
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Status</p>
              <p className="text-sm font-medium text-slate-900 capitalize">{form.formData.status || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Employee ID</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.employeeId || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Hospital Phone</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.hospitalPhone || '-'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1">Hospital Email</p>
              <p className="text-sm font-medium text-slate-900">{form.formData.hospitalEmail || '-'}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs font-medium text-slate-600 mb-1">Notes</p>
              <p className="text-sm font-medium text-slate-900 whitespace-pre-wrap">{form.formData.notes || '-'}</p>
            </div>
          </div>
        </div>
      )}

      {/* Form - Edit Mode */}
      {isEditing && (
        <div className="space-y-4 bg-blue-50 p-6 rounded-lg border border-blue-200">
        <div className="grid grid-cols-2 gap-4">
          {/* Employment Type */}
          <div className="space-y-2">
            <Label htmlFor="employment-type">Employment Type *</Label>
            <select
              id="employment-type"
              value={form.formData.employmentType}
              onChange={(e) => form.updateField('employmentType', e.target.value)}
              disabled={form.isSaving}
              className={`w-full px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white ${
                fieldErrors.employmentType ? 'border-red-500' : 'border-slate-300'
              }`}
            >
              <option value="">Select type...</option>
              {employmentTypes.map((type) => (
                <option key={type} value={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </select>
            {fieldErrors.employmentType && (
              <p className="text-xs text-red-600">{fieldErrors.employmentType}</p>
            )}
          </div>

          {/* Department */}
          <div className="space-y-2">
            <Label htmlFor="department">Department *</Label>
            <Input
              id="department"
              value={form.formData.department}
              onChange={(e) => form.updateField('department', e.target.value)}
              placeholder="e.g., Cardiology"
              disabled={form.isSaving}
              className={fieldErrors.department ? 'border-red-500' : ''}
            />
            {fieldErrors.department && (
              <p className="text-xs text-red-600">{fieldErrors.department}</p>
            )}
          </div>

          {/* Designation */}
          <div className="space-y-2">
            <Label htmlFor="designation">Designation</Label>
            <Input
              id="designation"
              value={form.formData.designation}
              onChange={(e) => form.updateField('designation', e.target.value)}
              placeholder="e.g., Senior Consultant"
              disabled={form.isSaving}
            />
          </div>

          {/* Specialization */}
          <div className="space-y-2">
            <Label htmlFor="specialization">Specialization at Hospital</Label>
            <select
              id="specialization"
              value={form.formData.specialization}
              onChange={(e) => form.updateField('specialization', e.target.value)}
              disabled={form.isSaving}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">Select specialization...</option>
              {specializations.map((spec) => (
                <option key={spec} value={spec}>
                  {spec}
                </option>
              ))}
            </select>
          </div>

          {/* Start Date */}
          <div className="space-y-2">
            <Label htmlFor="start-date">Start Date *</Label>
            <Input
              id="start-date"
              type="date"
              value={form.formData.startDate}
              onChange={(e) => form.updateField('startDate', e.target.value)}
              disabled={form.isSaving}
              className={fieldErrors.startDate ? 'border-red-500' : ''}
            />
            {fieldErrors.startDate && (
              <p className="text-xs text-red-600">{fieldErrors.startDate}</p>
            )}
          </div>

          {/* End Date - Only show if status is not "active" */}
          {form.formData.status !== 'active' && (
            <div className="space-y-2">
              <Label htmlFor="end-date">End Date</Label>
              <Input
                id="end-date"
                type="date"
                value={form.formData.endDate}
                onChange={(e) => form.updateField('endDate', e.target.value)}
                disabled={form.isSaving}
                className={fieldErrors.endDate ? 'border-red-500' : ''}
              />
              {fieldErrors.endDate && (
                <p className="text-xs text-red-600">{fieldErrors.endDate}</p>
              )}
            </div>
          )}

          {/* Status */}
          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <select
              id="status"
              value={form.formData.status}
              onChange={(e) => form.updateField('status', e.target.value)}
              disabled={form.isSaving}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">Select status...</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="on_leave">On Leave</option>
              <option value="terminated">Terminated</option>
            </select>
          </div>

          {/* Employee ID */}
          <div className="space-y-2">
            <Label htmlFor="employee-id">Employee ID</Label>
            <Input
              id="employee-id"
              value={form.formData.employeeId}
              onChange={(e) => form.updateField('employeeId', e.target.value)}
              placeholder="Internal employee ID"
              disabled={form.isSaving}
            />
          </div>

          {/* Hospital Phone */}
          <div className="space-y-2">
            <Label htmlFor="hospital-phone">Hospital Phone</Label>
            <Input
              id="hospital-phone"
              type="tel"
              value={form.formData.hospitalPhone}
              onChange={(e) => form.updateField('hospitalPhone', e.target.value)}
              placeholder="Extension or phone"
              disabled={form.isSaving}
            />
          </div>

          {/* Hospital Email */}
          <div className="col-span-2 space-y-2">
            <Label htmlFor="hospital-email">Hospital Email</Label>
            <Input
              id="hospital-email"
              type="email"
              value={form.formData.hospitalEmail}
              onChange={(e) => form.updateField('hospitalEmail', e.target.value)}
              placeholder="Hospital email address"
              disabled={form.isSaving}
            />
          </div>

          {/* Notes */}
          <div className="col-span-2 space-y-2">
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              value={form.formData.notes}
              onChange={(e) => form.updateField('notes', e.target.value)}
              placeholder="Additional notes or remarks"
              disabled={form.isSaving}
              rows={3}
              className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>
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
            className="gap-2 bg-blue-600 hover:bg-blue-700 text-white"
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
