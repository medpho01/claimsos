import { useState } from 'react';

export interface TabFormState<T> {
  formData: T;
  isDirty: boolean;
  isSaving: boolean;
  error: string | null;
  saveSuccess: boolean;
  updateField: (field: keyof T, value: any) => void;
  updateMultipleFields: (updates: Partial<T>) => void;
  reset: () => void;
  setIsSaving: (value: boolean) => void;
  setError: (error: string | null) => void;
  setSaveSuccess: (success: boolean) => void;
}

export function useTabFormState<T extends Record<string, any>>(
  initialData: T
): TabFormState<T> {
  const [formData, setFormData] = useState<T>(initialData);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const updateField = (field: keyof T, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
    setIsDirty(true);
    setError(null);
  };

  const updateMultipleFields = (updates: Partial<T>) => {
    setFormData((prev) => ({
      ...prev,
      ...updates,
    }));
    setIsDirty(true);
    setError(null);
  };

  const reset = () => {
    setFormData(initialData);
    setIsDirty(false);
    setError(null);
    setSaveSuccess(false);
  };

  return {
    formData,
    isDirty,
    isSaving,
    error,
    saveSuccess,
    updateField,
    updateMultipleFields,
    reset,
    setIsSaving,
    setError,
    setSaveSuccess,
  };
}
