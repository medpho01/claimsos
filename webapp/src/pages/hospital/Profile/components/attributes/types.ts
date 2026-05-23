/**
 * Shared types for AttributesManager and its sub-components.
 * Extracted from AttributesManager.tsx during the M14 god-component split.
 *
 * The `HospitalAttribute` type below is the *normalized* (camelCase only)
 * shape returned by `normalizeAttribute()` in `attributeApi.ts`. The raw API
 * response can mix snake_case and camelCase (FE M12 — the `||` chains that
 * used to litter the JSX); consumers should ALWAYS work with the normalized
 * form and never reach for `attr.expires_at`-style fallbacks.
 */

export type VerificationStatus =
  | 'unverified'
  | 'verified'
  | 'rejected'
  | 'pending';

export interface AttributeDocument {
  id: string; // junction table ID
  documentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  isPrimary: boolean;
}

/**
 * Definition of an attribute (catalog entry). Mirrors the backend
 * `attribute_definitions` row. Mostly snake_case because that's what the
 * API still returns — the form fields are read with `def.data_type`,
 * `def.requires_document`, etc. in many spots.
 */
export interface AttributeDefinition {
  key: string;
  label: string;
  description?: string;
  data_type: string;
  category: string;
  unit?: string;
  can_verify_by_image?: boolean;
  image_guidance?: string;
  is_mandatory_basic?: boolean;
  is_mandatory_empanelment?: boolean;
  requires_document?: boolean;
  has_expiry?: boolean;
  expected_issuing_authority?: string;
}

/**
 * Normalized hospital attribute. After `normalizeAttribute()` runs there is
 * exactly ONE field per concept — no `attr.expiresAt || attr.expires_at`
 * games in the JSX.
 */
export interface HospitalAttribute {
  id: string;
  attributeKey: string;
  hospitalId?: string;
  value?: any;
  valueText?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueDate?: string;
  documentId?: string;
  documents: AttributeDocument[];
  expiresAt?: string;
  certificateNumber?: string;
  issuingAuthority?: string;
  issueDate?: string;
  verificationStatus: VerificationStatus;
  verificationMethod?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  verificationNotes?: string;
  createdAt?: string;
  updatedAt?: string;
  label?: string;
  category?: string;
  dataType?: string;
  definition?: AttributeDefinition;
}

export interface PreviewFile {
  fileName: string;
  mimeType: string;
  documentId?: string;
}

/**
 * Form-data shape used by Add/Edit attribute dialogs.
 * Each dialog owns its own instance (fixes H13 analog).
 */
export interface AttributeFormData {
  attributeKey: string;
  value: string;
  documentId: string;
  certificateNumber: string;
  issueDate: string;
  expiresAt: string;
  issuingAuthority: string;
}

export const EMPTY_ATTRIBUTE_FORM: AttributeFormData = {
  attributeKey: '',
  value: '',
  documentId: '',
  certificateNumber: '',
  issueDate: '',
  expiresAt: '',
  issuingAuthority: '',
};

export interface VerifyFormData {
  method: string;
  notes: string;
}

export const EMPTY_VERIFY_FORM: VerifyFormData = {
  method: 'manual',
  notes: '',
};
