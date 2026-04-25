/**
 * Normalized Attribute Type Definitions
 *
 * All types use camelCase (no snake_case variants)
 * These are the canonical types used throughout the refactored components
 */

/**
 * Document attached to an attribute (from junction table)
 */
export interface AttributeDocument {
  id: string; // Junction table ID (for unlinking)
  documentId: string; // Actual document ID (for downloading)
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string; // ISO timestamp
  isPrimary: boolean;
  version?: string;
  effectiveDate?: string;
  expiryDate?: string;
}

/**
 * Normalized attribute value
 * Supports polymorphic storage with multiple value types
 */
export interface NormalizedAttribute {
  id: string;
  attributeKey: string;
  hospitalId?: string;
  panelId?: string;
  hospitalPanelId?: string;

  // Polymorphic values - only one is typically set based on dataType
  valueText?: string;
  valueBoolean?: boolean;
  valueDate?: string;
  valueInteger?: number;
  valueJson?: any;
  valueEncrypted?: string;

  // For file attributes (legacy - use documents array)
  documentId?: string;

  // Multiple documents support (new approach)
  documents?: AttributeDocument[];

  // Metadata from joined definition
  label?: string;
  category?: 'portal' | 'credential' | 'contact' | 'document' | 'operational';
  dataType?: AttributeDataType;
  description?: string;
  isRequired?: boolean;
  options?: Record<string, string>;

  // Timestamps
  createdAt?: string;
  updatedAt?: string;

  // Verification fields
  verificationStatus?: 'unverified' | 'verified' | 'rejected' | 'pending';
  verifiedAt?: string;
  verifiedBy?: string;
  verificationNotes?: string;

  // Certificate fields (if applicable)
  certificateNumber?: string;
  issuingAuthority?: string;
  issueDate?: string;
  expiresAt?: string;
}

/**
 * Supported attribute data types
 */
export type AttributeDataType =
  | 'text'
  | 'email'
  | 'phone'
  | 'url'
  | 'textarea'
  | 'encrypted_text'
  | 'date'
  | 'boolean'
  | 'integer'
  | 'file'
  | 'document'
  | 'single_select'
  | 'multi_select'
  | 'json';

/**
 * Hospital Attribute Definition - metadata about hospital attributes
 * Certification-focused attributes with document verification capabilities
 */
export interface HospitalAttributeDefinition {
  key: string; // Primary key: category.subcategory[.name] format
  label: string;
  description?: string;
  category: string; // accreditation, compliance_cert, compliance_policy, infrastructure, beds, icu, ot, equipment, in_house, lab, service, staffing, room_rent
  data_type: 'boolean' | 'integer' | 'text' | 'date' | 'document';
  unit?: string; // For integer type: count, INR/day, sqft, etc
  requires_document: boolean;
  has_expiry: boolean;
  expected_issuing_authority?: string; // e.g., "NABH", "JCI"
  can_verify_by_image: boolean;
  image_guidance?: string; // Instructions for image uploads
  is_mandatory_basic: boolean; // Required during initial hospital registration
  is_mandatory_empanelment: boolean; // Required before panel empanelment
  sort_order: number; // Display order, lower numbers first
  is_active: boolean; // Soft delete flag
  created_at: string;
  updated_at: string;
}

/**
 * Panel Attribute Definition - metadata about panel attributes
 * Generic validation-focused attributes
 */
export interface PanelAttributeDefinition {
  id: string;
  key: string; // Unique identifier: "hospital_name", "portal_email", etc
  label: string; // Display name: "Hospital Name", "Portal Email"
  description?: string;
  dataType: AttributeDataType;
  category: 'portal' | 'credential' | 'contact' | 'document' | 'operational';
  options?: Record<string, string>; // For select types: { "key": "Display Label" }
  isRequired: boolean;
  validationRegex?: string;
  minLength?: number;
  maxLength?: number;
  sortOrder?: number;
}

/**
 * Attribute definition - metadata about what attributes exist
 * Now a union type that can be either hospital or panel
 */
export type NormalizedAttributeDefinition = HospitalAttributeDefinition | PanelAttributeDefinition;

/**
 * Form data structure for attribute editing
 * Supports all attribute field types for complete attribute management
 */
export interface AttributeFormData {
  // Identifier
  attributeKey: string;

  // Value fields (polymorphic - only one set based on dataType)
  valueText?: string;
  valueBoolean?: string; // 'true' or 'false' as string
  valueDate?: string;
  valueJson?: string;
  documentId?: string;

  // Certificate-specific fields
  certificateNumber?: string;
  issuingAuthority?: string;
  issueDate?: string;
  expiresAt?: string;

  // Verification fields
  verificationStatus?: 'unverified' | 'verified' | 'rejected' | 'pending';
  verificationNotes?: string;
}

/**
 * Hospital or Panel with panel relationships
 */
export interface HospitalPanel {
  id: string; // hospital_panels.id (the relationship ID)
  hospitalId: string;
  panelId: string; // The actual panel/insurer ID
  panelName: string;
  panelCode?: string;
  whatsappGroupId?: string;
  sheetId?: string;
  sheetName?: string;
  driveFolderId?: string;
  contact?: string;
  attributes?: NormalizedAttribute[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Simple panel/insurer reference
 */
export interface Panel {
  id: string;
  name: string;
  code?: string;
  type?: string;
}

/**
 * Attribute with all details (attribute + definition joined)
 */
export interface AttributeWithDefinition extends NormalizedAttribute {
  definition?: NormalizedAttributeDefinition;
}

/**
 * Grouped definitions by category
 */
export interface AttributeDefinitionGroup {
  category: 'portal' | 'credential' | 'contact' | 'document' | 'operational';
  definitions: NormalizedAttributeDefinition[];
}

/**
 * API Error Response
 */
export interface ApiError {
  status: number;
  message: string;
  error?: any;
}

/**
 * API Success Response
 */
export interface ApiResponse<T> {
  status: number;
  data: T;
  message: string;
}

/**
 * Batch validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}
