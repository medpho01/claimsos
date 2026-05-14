import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Upload, Loader } from 'lucide-react';
import { AttributeDefinition, DoctorAttribute, CredentialFormData } from '../types';
import { CredentialInputField } from './CredentialInputField';

interface DynamicCredentialFormProps {
  definition: AttributeDefinition;
  credential?: DoctorAttribute;
  onSubmit: (data: CredentialFormData, files?: File[]) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export const DynamicCredentialForm: React.FC<DynamicCredentialFormProps> = ({
  definition,
  credential,
  onSubmit,
  onCancel,
  isSubmitting = false,
}) => {
  const [formData, setFormData] = useState<CredentialFormData>({
    attributeKey: credential?.attribute_key || definition.key,
    valueText: credential?.value_text || '',
    valueDate: credential?.value_date || '',
    valueBoolean: credential?.value_boolean || false,
    certificateNumber: credential?.certificate_number || '',
    issuingAuthority: credential?.issuing_authority || '',
    issuedAt: credential?.issued_at || '',
    expiresAt: credential?.expires_at || '',
  });

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleFieldChange = (field: keyof CredentialFormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear field error when user starts typing
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const updated = { ...prev };
        delete updated[field];
        return updated;
      });
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);

    if (files.length === 0) {
      setFileError(null);
      return;
    }

    // Validate file sizes (max 10MB per file)
    const maxSize = 10 * 1024 * 1024;
    const validFiles = files.filter((file) => {
      if (file.size > maxSize) {
        setFileError(`${file.name} is too large (max 10MB)`);
        return false;
      }
      return true;
    });

    if (validFiles.length > 0) {
      setSelectedFiles(validFiles);
      setFileError(null);
    }
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    // Validate main value based on data type
    if (definition.data_type === 'text' && definition.is_required && !formData.valueText.trim()) {
      errors.valueText = `${definition.label} is required`;
    }
    if (definition.data_type === 'date' && definition.is_required && !formData.valueDate) {
      errors.valueDate = `${definition.label} is required`;
    }
    if (definition.data_type === 'textarea' && definition.is_required && !formData.valueText.trim()) {
      errors.valueText = `${definition.label} is required`;
    }

    // Validate document requirement
    if (definition.requires_document && selectedFiles.length === 0 && !credential?.documents?.length) {
      errors.files = `Document is required for ${definition.label}`;
    }

    // Validate date ranges if both issued and expiry dates are present
    if (formData.issuedAt && formData.expiresAt) {
      if (new Date(formData.expiresAt) <= new Date(formData.issuedAt)) {
        errors.expiresAt = 'Expiry date must be after issued date';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    try {
      await onSubmit(formData, selectedFiles);
      // Reset form on success
      setFormData({
        attributeKey: definition.key,
        valueText: '',
        valueDate: '',
        valueBoolean: false,
        certificateNumber: '',
        issuingAuthority: '',
        issuedAt: '',
        expiresAt: '',
      });
      setSelectedFiles([]);
      setFileError(null);
      setFieldErrors({});
    } catch (err) {
      // Error is handled by parent component
      console.error('Error submitting credential:', err);
    }
  };

  const isCertificateCategory = ['Licenses', 'Qualifications', 'Registrations'].includes(definition.category);

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Main Value Input - Dynamic based on data_type */}
      {definition.data_type !== 'document' && (
        <CredentialInputField
          definition={definition}
          value={
            definition.data_type === 'boolean'
              ? formData.valueBoolean
              : definition.data_type === 'date'
              ? formData.valueDate
              : formData.valueText
          }
          onChange={(value) => {
            if (definition.data_type === 'boolean') {
              handleFieldChange('valueBoolean', value);
            } else if (definition.data_type === 'date') {
              handleFieldChange('valueDate', value);
            } else {
              handleFieldChange('valueText', value);
            }
          }}
          error={
            fieldErrors.valueText ||
            fieldErrors.valueDate ||
            fieldErrors.valueBoolean
          }
          disabled={isSubmitting}
        />
      )}

      {/* Certificate-related fields (for Licenses, Qualifications, Registrations) */}
      {isCertificateCategory && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="certificate-number">Certificate Number</Label>
              <Input
                id="certificate-number"
                type="text"
                value={formData.certificateNumber}
                onChange={(e) => handleFieldChange('certificateNumber', e.target.value)}
                placeholder="e.g., NMC123456"
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="issuing-authority">Issuing Authority</Label>
              <Input
                id="issuing-authority"
                type="text"
                value={formData.issuingAuthority}
                onChange={(e) => handleFieldChange('issuingAuthority', e.target.value)}
                placeholder="e.g., NMC India"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="issued-date">Issued Date</Label>
              <Input
                id="issued-date"
                type="date"
                value={formData.issuedAt}
                onChange={(e) => handleFieldChange('issuedAt', e.target.value)}
                disabled={isSubmitting}
              />
            </div>
            {definition.has_expiry && (
              <div className="space-y-2">
                <Label htmlFor="expiry-date">Expiry Date</Label>
                <Input
                  id="expiry-date"
                  type="date"
                  value={formData.expiresAt}
                  onChange={(e) => handleFieldChange('expiresAt', e.target.value)}
                  disabled={isSubmitting}
                  className={fieldErrors.expiresAt ? 'border-red-500' : ''}
                />
                {fieldErrors.expiresAt && (
                  <p className="text-xs text-red-600">{fieldErrors.expiresAt}</p>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Standalone expiry date (if not a certificate category) */}
      {!isCertificateCategory && definition.has_expiry && (
        <div className="space-y-2">
          <Label htmlFor="expiry-date">Expiry Date</Label>
          <Input
            id="expiry-date"
            type="date"
            value={formData.expiresAt}
            onChange={(e) => handleFieldChange('expiresAt', e.target.value)}
            disabled={isSubmitting}
            className={fieldErrors.expiresAt ? 'border-red-500' : ''}
          />
          {fieldErrors.expiresAt && (
            <p className="text-xs text-red-600">{fieldErrors.expiresAt}</p>
          )}
        </div>
      )}

      {/* Document Upload Section */}
      {(definition.requires_document || definition.data_type === 'document') && (
        <div className="space-y-3 p-3 bg-brand-50 rounded-lg border border-brand-50">
          <Label htmlFor="document-upload" className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            📎 Upload Supporting Documents
            {definition.requires_document && <span className="text-red-600">*</span>}
          </Label>

          <input
            id="document-upload"
            type="file"
            multiple
            accept="application/pdf,image/*,.doc,.docx"
            onChange={handleFileSelect}
            disabled={isSubmitting}
            className="block w-full text-sm text-slate-500
              file:mr-4 file:py-2 file:px-4
              file:rounded-md file:border-0
              file:text-sm file:font-semibold
              file:bg-brand-50 file:text-brand-700
              hover:file:bg-brand-50"
          />

          {selectedFiles.length > 0 && (
            <div className="space-y-1 mt-2">
              <p className="text-xs font-medium text-slate-600">Selected files:</p>
              <div className="space-y-1">
                {selectedFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between text-xs p-2 bg-white rounded border border-slate-200">
                    <span className="text-slate-700 truncate">📄 {file.name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedFiles(selectedFiles.filter((_, i) => i !== idx))}
                      className="text-red-600 hover:text-red-700 font-medium"
                      disabled={isSubmitting}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {fileError && (
            <div className="flex items-center gap-2 text-red-600 text-xs">
              <AlertCircle className="h-4 w-4" />
              {fileError}
            </div>
          )}

          {definition.requires_document && !selectedFiles.length && (
            <p className="text-xs text-brand-600">Document upload is required for this credential</p>
          )}
        </div>
      )}

      {/* Error Summary */}
      {Object.keys(fieldErrors).length > 0 && (
        <Alert variant="destructive" className="bg-red-50 border-red-200">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="text-red-700">
            Please fix the errors above before submitting
          </AlertDescription>
        </Alert>
      )}

      {/* Form Actions */}
      <div className="flex gap-2 justify-end pt-3 border-t border-slate-200">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="bg-brand-600 hover:bg-brand-700 text-white gap-2"
        >
          {isSubmitting ? (
            <>
              <Loader className="h-4 w-4 animate-spin" />
              {credential ? 'Updating...' : 'Adding...'}
            </>
          ) : (
            credential ? 'Update Credential' : 'Add Credential'
          )}
        </Button>
      </div>
    </form>
  );
};
