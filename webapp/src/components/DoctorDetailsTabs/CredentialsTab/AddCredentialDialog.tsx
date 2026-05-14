import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { AttributeDefinition, AttributeDefinitionsGrouped, DoctorAttribute, CredentialFormData } from '../types';
import { DynamicCredentialForm } from './DynamicCredentialForm';

interface AddCredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attributeDefinitionsGrouped: AttributeDefinitionsGrouped;
  credential?: DoctorAttribute;
  onSubmit: (data: CredentialFormData, files?: File[]) => Promise<void>;
  isSubmitting?: boolean;
}

export const AddCredentialDialog: React.FC<AddCredentialDialogProps> = ({
  open,
  onOpenChange,
  attributeDefinitionsGrouped,
  credential,
  onSubmit,
  isSubmitting = false,
}) => {
  const [selectedKey, setSelectedKey] = useState(credential?.attribute_key || '');
  const [formError, setFormError] = useState<string | null>(null);

  // Get all definitions in a flat list with category info
  const allDefinitions: (AttributeDefinition & { category: string })[] = [];
  Object.entries(attributeDefinitionsGrouped).forEach(([category, defs]) => {
    defs.forEach((def) => {
      allDefinitions.push({ ...def, category });
    });
  });

  const selectedDefinition = allDefinitions.find((d) => d.key === selectedKey);

  const handleSubmit = async (data: CredentialFormData, files?: File[]) => {
    try {
      setFormError(null);
      await onSubmit(data, files);
      // Close dialog on success
      onOpenChange(false);
      setSelectedKey('');
    } catch (err: any) {
      setFormError(err.message || 'Failed to save credential');
    }
  };

  const handleClose = () => {
    setSelectedKey('');
    setFormError(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {credential ? 'Update Credential' : 'Add Doctor Credential'}
          </DialogTitle>
          <DialogDescription>
            {credential
              ? 'Update the credential details'
              : 'Add a new credential or qualification for the doctor'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Credential Type Selection */}
          {!credential && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-900">
                Select Credential Type *
              </label>
              <select
                value={selectedKey}
                onChange={(e) => {
                  setSelectedKey(e.target.value);
                  setFormError(null);
                }}
                disabled={isSubmitting}
                className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 bg-white"
              >
                <option value="">Choose a credential type...</option>
                {Object.entries(attributeDefinitionsGrouped).map(([category, defs]) => (
                  <optgroup key={category} label={category}>
                    {defs.map((def) => (
                      <option key={def.key} value={def.key}>
                        {def.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {!selectedKey && !credential && (
                <p className="text-xs text-slate-500">Required to proceed</p>
              )}
            </div>
          )}

          {/* Error Alert */}
          {formError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          {/* Dynamic Form - Only show if credential is selected or we're editing */}
          {(selectedDefinition || credential) && (
            <DynamicCredentialForm
              definition={selectedDefinition || allDefinitions.find((d) => d.key === credential?.attribute_key)!}
              credential={credential}
              onSubmit={handleSubmit}
              onCancel={handleClose}
              isSubmitting={isSubmitting}
            />
          )}

          {/* Helper Text */}
          {!selectedKey && !credential && (
            <div className="p-3 bg-brand-50 border border-brand-50 rounded-md text-xs text-brand-700">
              <p className="font-medium mb-1">💡 Tip:</p>
              <p>Select a credential type from the dropdown above to begin adding credentials for this doctor.</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
