/**
 * Attribute Validation Utilities
 *
 * Validates form data and files without changing existing behavior
 * Returns validation errors so components can choose how to display them
 */

import {
  PanelAttributeDefinition,
  AttributeFormData,
  ValidationResult,
} from '@/types/attributeTypes';

/**
 * Validate attribute form data against definition rules
 * Returns empty array if valid, array of error messages if invalid
 */
export function validateAttributeForm(
  formData: AttributeFormData,
  definition: PanelAttributeDefinition
): string[] {
  if (!definition) {
    return ['No attribute definition provided'];
  }

  const errors: string[] = [];

  // Check required fields
  if (definition.isRequired) {
    const value = getFormValue(formData, definition.dataType);
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      errors.push(`${definition.label} is required`);
    }
  }

  // Type-specific validation
  switch (definition.dataType) {
    case 'email':
      if (formData.valueText && !isValidEmail(formData.valueText)) {
        errors.push(`${definition.label} must be a valid email address`);
      }
      break;

    case 'phone':
      if (formData.valueText && !isValidPhone(formData.valueText)) {
        errors.push(
          `${definition.label} must be a valid phone number`
        );
      }
      break;

    case 'url':
      if (formData.valueText && !isValidUrl(formData.valueText)) {
        errors.push(`${definition.label} must be a valid URL`);
      }
      break;

    case 'date':
      if (formData.valueDate && !isValidDate(formData.valueDate)) {
        errors.push(`${definition.label} must be a valid date`);
      }
      break;

    case 'file':
      if (definition.isRequired && !formData.documentId) {
        errors.push(`${definition.label} requires a document`);
      }
      break;

    case 'single_select':
      if (
        definition.isRequired &&
        !formData.valueText &&
        definition.options
      ) {
        errors.push(
          `Please select a ${definition.label.toLowerCase()}`
        );
      }
      if (
        formData.valueText &&
        definition.options &&
        !Object.keys(definition.options).includes(formData.valueText)
      ) {
        errors.push(`Invalid selection for ${definition.label}`);
      }
      break;

    case 'text':
    case 'textarea':
    case 'encrypted_text':
      if (formData.valueText) {
        if (definition.minLength && formData.valueText.length < definition.minLength) {
          errors.push(
            `${definition.label} must be at least ${definition.minLength} characters`
          );
        }
        if (definition.maxLength && formData.valueText.length > definition.maxLength) {
          errors.push(
            `${definition.label} must be no more than ${definition.maxLength} characters`
          );
        }
        if (definition.validationRegex) {
          const regex = new RegExp(definition.validationRegex);
          if (!regex.test(formData.valueText)) {
            errors.push(`${definition.label} format is invalid`);
          }
        }
      }
      break;
  }

  return errors;
}

/**
 * Validate single file upload
 */
export function validateFileUpload(file: File): string | null {
  if (!file) {
    return 'No file selected';
  }

  // Check file size (limit to 50MB)
  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) {
    return `File is too large. Maximum size is 50MB. Your file is ${formatFileSize(file.size)}`;
  }

  // Check file type (allow common document types)
  const allowedMimeTypes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'text/plain',
    'text/csv',
    'application/json',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];

  if (file.type && !allowedMimeTypes.includes(file.type)) {
    return `File type ${file.type} is not supported. Please upload: PDF, images, documents, or spreadsheets`;
  }

  return null; // Valid
}

/**
 * Validate multiple files
 */
export function validateFileUploads(files: File[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!files || files.length === 0) {
    return { isValid: false, errors: ['No files selected'] };
  }

  files.forEach((file, index) => {
    const error = validateFileUpload(file);
    if (error) {
      errors.push(`File ${index + 1} (${file.name}): ${error}`);
    }
  });

  // Warn if many files
  if (files.length > 10) {
    warnings.push(
      `You're uploading ${files.length} files. This may take a while.`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate entire attribute (form + files)
 */
export function validateCompleteAttribute(
  formData: AttributeFormData,
  definition: PanelAttributeDefinition,
  files?: File[]
): ValidationResult {
  const formErrors = validateAttributeForm(formData, definition);

  if (files && files.length > 0) {
    const fileErrors = validateFileUploads(files);
    if (!fileErrors.isValid) {
      return {
        isValid: false,
        errors: [...formErrors, ...fileErrors.errors],
        warnings: fileErrors.warnings,
      };
    }
  }

  return {
    isValid: formErrors.length === 0,
    errors: formErrors,
  };
}

// ============= Helper Validation Functions =============

function getFormValue(
  formData: AttributeFormData,
  dataType: string
): any {
  switch (dataType) {
    case 'boolean':
      return formData.valueBoolean;
    case 'date':
      return formData.valueDate;
    case 'json':
    case 'multi_select':
      return formData.valueJson;
    case 'file':
      return formData.documentId;
    default:
      return formData.valueText;
  }
}

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidPhone(phone: string): boolean {
  // Accept various phone formats
  // Remove common formatting characters and check length
  const digitsOnly = phone.replace(/\D/g, '');
  return digitsOnly.length >= 10; // At least 10 digits
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function isValidDate(dateString: string): boolean {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Check if attribute value is "empty"
 * Useful for determining if an attribute is actually set
 */
export function isAttributeEmpty(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/**
 * Compare two attribute values for equality
 * Useful for detecting unsaved changes
 */
export function attributeValuesEqual(a: any, b: any): boolean {
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * Check if form has unsaved changes compared to original attribute
 */
export function hasUnsavedChanges(
  formData: AttributeFormData,
  originalAttribute: any
): boolean {
  if (!originalAttribute) return false;

  return (
    formData.valueText !== (originalAttribute.valueText || '') ||
    formData.valueBoolean !== String(originalAttribute.valueBoolean || '') ||
    formData.valueDate !== (originalAttribute.valueDate || '') ||
    formData.valueJson !== (originalAttribute.valueJson || '') ||
    formData.documentId !== (originalAttribute.documentId || '')
  );
}
