/**
 * API Response Transformers
 *
 * Converts raw API responses (which may use snake_case) to normalized types (camelCase)
 * This eliminates the need for `(attr as any).value_text || attr.valueText` patterns everywhere
 */

import {
  NormalizedAttribute,
  PanelAttributeDefinition,
  AttributeDocument,
  AttributeDataType,
  HospitalPanel,
} from '@/types/attributeTypes';

/**
 * Convert raw attribute object from API to normalized attribute
 * Handles both camelCase and snake_case from API
 */
export function normalizeAttribute(raw: any): NormalizedAttribute {
  if (!raw) return {} as NormalizedAttribute;

  // Extract documents array with proper typing
  const documents = extractDocumentsArray(raw);

  return {
    id: raw.id,
    attributeKey: raw.attribute_key || raw.attributeKey,
    hospitalId: raw.hospital_id || raw.hospitalId,
    panelId: raw.panel_id || raw.panelId,
    hospitalPanelId: raw.hospital_panel_id || raw.hospitalPanelId,

    // Polymorphic values
    valueText: raw.value_text !== undefined ? raw.value_text : raw.valueText,
    valueBoolean:
      raw.value_boolean !== undefined
        ? raw.value_boolean
        : raw.valueBoolean,
    valueInteger:
      raw.value_integer !== undefined
        ? raw.value_integer
        : raw.valueInteger,
    valueDate: raw.value_date || raw.valueDate,
    valueJson: raw.value_json || raw.valueJson,
    valueEncrypted: raw.value_encrypted || raw.valueEncrypted,

    // Legacy document reference
    documentId: raw.document_id || raw.documentId,

    // New documents array
    documents: documents && documents.length > 0 ? documents : undefined,

    // Definition fields (from joined definition)
    label: raw.label,
    category: raw.category,
    dataType: normalizeDataType(raw.data_type || raw.dataType),
    description: raw.description,
    isRequired: raw.is_required !== undefined ? raw.is_required : raw.isRequired,
    options: raw.options,

    // Timestamps
    createdAt: raw.created_at || raw.createdAt,
    updatedAt: raw.updated_at || raw.updatedAt,

    // Verification fields
    verificationStatus: raw.verification_status || raw.verificationStatus,
    verifiedAt: raw.verified_at || raw.verifiedAt,
    verifiedBy: raw.verified_by || raw.verifiedBy,
    verificationNotes: raw.verification_notes || raw.verificationNotes,

    // Certificate fields
    certificateNumber: raw.certificate_number || raw.certificateNumber,
    issuingAuthority: raw.issuing_authority || raw.issuingAuthority,
    issueDate: raw.issued_at || raw.issueDate || raw.issue_date,
    expiresAt: raw.expires_at || raw.expiresAt,
  };
}

/**
 * Convert raw attribute definition from API to normalized definition (Panel Attributes)
 */
export function normalizeAttributeDefinition(
  raw: any
): PanelAttributeDefinition {
  if (!raw) return {} as PanelAttributeDefinition;

  return {
    id: raw.id,
    key: raw.key,
    label: raw.label,
    description: raw.description,
    dataType: normalizeDataType(raw.data_type || raw.dataType),
    category: raw.category,
    options: raw.options ? parseOptions(raw.options) : undefined,
    isRequired: raw.is_required !== undefined ? raw.is_required : raw.isRequired,
    validationRegex:
      raw.validation_regex || raw.validationRegex,
    minLength: raw.min_length || raw.minLength,
    maxLength: raw.max_length || raw.maxLength,
    sortOrder: raw.sort_order || raw.sortOrder,
  };
}

/**
 * Convert list of raw attributes to normalized attributes
 */
export function normalizeAttributeList(raw: any[]): NormalizedAttribute[] {
  return Array.isArray(raw) ? raw.map(normalizeAttribute) : [];
}

/**
 * Convert list of raw definitions to normalized definitions (Panel Attributes)
 */
export function normalizeAttributeDefinitionList(
  raw: any[]
): PanelAttributeDefinition[] {
  return Array.isArray(raw)
    ? raw.map(normalizeAttributeDefinition)
    : [];
}

/**
 * Convert raw hospital panel to normalized format
 */
export function normalizeHospitalPanel(raw: any): HospitalPanel {
  if (!raw) return {} as HospitalPanel;

  return {
    id: raw.id,
    hospitalId: raw.hospital_id || raw.hospitalId,
    panelId: raw.panel_id || raw.panelId,
    panelName: raw.panel_name || raw.panelName,
    panelCode: raw.panel_code || raw.panelCode,
    whatsappGroupId: raw.whatsapp_group_id || raw.whatsappGroupId,
    sheetId: raw.sheet_id || raw.sheetId,
    sheetName: raw.sheet_name || raw.sheetName,
    driveFolderId: raw.drive_folder_id || raw.driveFolderId,
    contact: raw.contact,
    attributes: raw.attributes
      ? raw.attributes.map((attr: any) => normalizeAttribute(attr))
      : undefined,
    createdAt: raw.created_at || raw.createdAt,
    updatedAt: raw.updated_at || raw.updatedAt,
  };
}

/**
 * Convert list of hospital panels
 */
export function normalizeHospitalPanelList(raw: any[]): HospitalPanel[] {
  return Array.isArray(raw)
    ? raw.map(normalizeHospitalPanel)
    : [];
}

/**
 * Extract and normalize documents array from raw attribute
 */
function extractDocumentsArray(raw: any): AttributeDocument[] | undefined {
  const documents = raw.documents;

  if (!Array.isArray(documents)) {
    return undefined;
  }

  return documents.map((doc: any) => ({
    id: doc.id,
    documentId: doc.document_id || doc.documentId,
    fileName: doc.file_name || doc.fileName,
    fileSize: doc.file_size_bytes || doc.fileSize || 0,
    mimeType: doc.mime_type || doc.mimeType || 'application/octet-stream',
    uploadedAt: doc.uploaded_at || doc.uploadedAt || doc.added_at,
    isPrimary: doc.is_primary !== undefined ? doc.is_primary : doc.isPrimary,
    version: doc.version,
    effectiveDate: doc.effective_date || doc.effectiveDate,
    expiryDate: doc.expiry_date || doc.expiryDate,
  }));
}

/**
 * Parse options from string or object format
 */
function parseOptions(
  options: string | Record<string, string>
): Record<string, string> {
  if (typeof options === 'string') {
    try {
      return JSON.parse(options);
    } catch (e) {
      console.warn('Failed to parse options:', options);
      return {};
    }
  }
  return options || {};
}

/**
 * Normalize data type string to enum value
 */
function normalizeDataType(dataType: string): AttributeDataType {
  const normalized = (dataType || '').toLowerCase().replace(/[_-]/g, '_');

  const validTypes: AttributeDataType[] = [
    'text',
    'email',
    'phone',
    'url',
    'textarea',
    'encrypted_text',
    'date',
    'boolean',
    'file',
    'single_select',
    'multi_select',
    'json',
  ];

  return (validTypes.includes(normalized as AttributeDataType)
    ? normalized
    : 'text') as AttributeDataType;
}

/**
 * Reverse transformer: Convert normalized attribute to API format
 * Used when sending data to backend
 */
export function denormalizeAttribute(
  attr: NormalizedAttribute
): Record<string, any> {
  return {
    attribute_key: attr.attributeKey,
    hospital_id: attr.hospitalId,
    panel_id: attr.panelId,
    hospital_panel_id: attr.hospitalPanelId,
    value_text: attr.valueText,
    value_boolean: attr.valueBoolean,
    value_date: attr.valueDate,
    value_json: attr.valueJson,
    value_encrypted: attr.valueEncrypted,
    document_id: attr.documentId,
    label: attr.label,
    category: attr.category,
    data_type: attr.dataType,
  };
}

/**
 * Batch normalize API response with pagination/structure
 */
export function normalizeBatchResponse(response: any): {
  attributes: NormalizedAttribute[];
  pagination?: any;
} {
  const data = response.data || response;
  const items = Array.isArray(data) ? data : data.data || data.attributes || [];

  return {
    attributes: normalizeAttributeList(items),
    pagination: response.pagination,
  };
}
