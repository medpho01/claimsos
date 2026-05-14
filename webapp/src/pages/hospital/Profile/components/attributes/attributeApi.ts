import ApiService from '@/services/api';
import type {
  AttributeDefinition,
  AttributeFormData,
  HospitalAttribute,
  VerificationStatus,
} from './types';

/**
 * Helpers shared between Add/Edit dialogs and the read-only card view.
 * Extracted from AttributesManager.tsx during the M14 split.
 *
 * Most importantly: `normalizeAttribute()` collapses the snake_case +
 * camelCase mess the backend returns into a single camelCase shape so the
 * JSX never has to write `attr.expiresAt || attr.expires_at` again (FE M12).
 */

/**
 * Map any raw API attribute object — which may mix snake_case + camelCase —
 * into the canonical `HospitalAttribute` shape.
 *
 * Once data passes through this, downstream code uses a single accessor
 * per field. No more `||`-chains.
 */
export function normalizeAttribute(raw: any): HospitalAttribute {
  if (!raw) return raw;

  const status: VerificationStatus =
    raw.verificationStatus || raw.verification_status || 'unverified';

  return {
    id: raw.id,
    attributeKey: raw.attributeKey || raw.attribute_key,
    hospitalId: raw.hospitalId || raw.hospital_id,
    value: raw.value,
    valueText: raw.valueText ?? raw.value_text,
    valueBoolean:
      raw.valueBoolean !== undefined ? raw.valueBoolean : raw.value_boolean,
    valueInteger:
      raw.valueInteger !== undefined ? raw.valueInteger : raw.value_integer,
    valueDate: raw.valueDate ?? raw.value_date,
    documentId: raw.documentId || raw.document_id,
    documents: Array.isArray(raw.documents) ? raw.documents : [],
    expiresAt: raw.expiresAt || raw.expires_at,
    certificateNumber: raw.certificateNumber || raw.certificate_number,
    issuingAuthority: raw.issuingAuthority || raw.issuing_authority,
    issueDate: raw.issueDate || raw.issued_at,
    verificationStatus: status,
    verificationMethod: raw.verificationMethod || raw.verification_method,
    verifiedBy: raw.verifiedBy || raw.verified_by,
    verifiedAt: raw.verifiedAt || raw.verified_at,
    verificationNotes: raw.verificationNotes || raw.verification_notes,
    createdAt: raw.createdAt || raw.created_at,
    updatedAt: raw.updatedAt || raw.updated_at,
    label: raw.label,
    category: raw.category,
    dataType: raw.dataType || raw.data_type,
    definition: raw.definition,
  };
}

export function normalizeAttributes(rawList: any[]): HospitalAttribute[] {
  return (rawList || []).map(normalizeAttribute);
}

/**
 * Does this attribute have any certificate / authority metadata worth showing?
 * Used to gate the "Certificate Details" sub-card.
 */
export function hasCertificateData(attr: HospitalAttribute): boolean {
  return !!(
    attr.certificateNumber ||
    attr.issuingAuthority ||
    attr.issueDate ||
    attr.expiresAt
  );
}

export async function uploadAttributeDocument(
  hospitalId: string,
  attributeKey: string,
  definition: AttributeDefinition | undefined,
  file: File,
): Promise<string> {
  const formDataObj = new FormData();
  formDataObj.append('file', file);
  formDataObj.append('documentName', file.name);
  formDataObj.append(
    'documentCategory',
    definition?.category || 'attributes',
  );
  formDataObj.append('documentType', 'attribute_document');
  formDataObj.append('attributeKey', attributeKey);

  const response = await ApiService.uploadDocument(hospitalId, formDataObj);
  const documentId = response.data.data?.id;
  if (!documentId) {
    throw new Error('No document ID returned from upload');
  }
  return documentId;
}

export async function uploadMultipleDocuments(
  hospitalId: string,
  attributeKey: string,
  definition: AttributeDefinition | undefined,
  files: File[],
): Promise<string[]> {
  const documentIds: string[] = [];
  for (const file of files) {
    const documentId = await uploadAttributeDocument(
      hospitalId,
      attributeKey,
      definition,
      file,
    );
    documentIds.push(documentId);
  }
  return documentIds;
}

/**
 * Build the POST/PUT payload for setAttribute/updateAttribute.
 * Decides which `valueX` field to populate based on the definition's data_type.
 */
export function buildAttributePayload(
  definition: AttributeDefinition,
  formData: AttributeFormData,
  documentId?: string,
): any {
  const payload: any = {
    documentId: documentId || formData.documentId || undefined,
    certificateNumber: formData.certificateNumber || undefined,
    issueDate: formData.issueDate || undefined,
    expiresAt: formData.expiresAt || undefined,
    issuingAuthority: formData.issuingAuthority || undefined,
  };

  switch (definition.data_type) {
    case 'boolean':
      payload.valueBoolean =
        formData.value === 'true'
          ? true
          : formData.value === 'false'
            ? false
            : null;
      break;
    case 'integer':
      payload.valueInteger = formData.value ? parseInt(formData.value) : null;
      break;
    case 'text':
      payload.valueText = formData.value || null;
      break;
    case 'date':
      payload.valueDate = formData.value || null;
      break;
    case 'document':
      payload.valueText = formData.value || null;
      break;
    default:
      payload.valueText = formData.value || null;
  }

  return payload;
}

/**
 * Hydrate AttributeFormData from a normalized HospitalAttribute. Used when
 * opening the Edit dialog. Converts ISO timestamps to `yyyy-MM-dd` so
 * `<input type="date">` accepts them.
 */
export function attributeToFormData(
  attr: HospitalAttribute,
): AttributeFormData {
  let issueDateStr = '';
  if (attr.issueDate) {
    try {
      issueDateStr = new Date(attr.issueDate).toISOString().split('T')[0];
    } catch {
      issueDateStr = attr.issueDate;
    }
  }

  let expiryDateStr = '';
  if (attr.expiresAt) {
    try {
      expiryDateStr = new Date(attr.expiresAt).toISOString().split('T')[0];
    } catch {
      expiryDateStr = attr.expiresAt;
    }
  }

  return {
    attributeKey: attr.attributeKey,
    value: attr.value !== null && attr.value !== undefined ? attr.value.toString() : '',
    documentId: attr.documentId || '',
    certificateNumber: attr.certificateNumber || '',
    issueDate: issueDateStr,
    expiresAt: expiryDateStr,
    issuingAuthority: (attr.issuingAuthority || '').trim(),
  };
}

/**
 * Download a single document blob to the browser as a file.
 * Shared by the read-only card row and the preview modal's download button.
 */
export async function downloadAttributeDocument(
  hospitalId: string,
  documentId: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const response = await ApiService.downloadDocument(hospitalId, documentId);
  const blob = new Blob([response.data], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', fileName);
  document.body.appendChild(link);
  link.click();
  link.parentNode?.removeChild(link);
  window.URL.revokeObjectURL(url);
}
