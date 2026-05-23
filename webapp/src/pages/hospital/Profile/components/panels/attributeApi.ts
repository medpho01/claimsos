import ApiService from '@/services/api';
import type { AttributeDefinition, AttributeFormData } from './types';

/**
 * Helpers shared between Add and Edit attribute dialogs.
 * Extracted from PanelsManager.tsx during the M14 split.
 */

export async function uploadAttributeDocument(
  hospitalId: string,
  definition: AttributeDefinition,
  file: File,
): Promise<string> {
  const formDataObj = new FormData();
  formDataObj.append('file', file);
  formDataObj.append('documentName', file.name);
  formDataObj.append(
    'documentCategory',
    definition?.category || 'panel_attributes',
  );
  formDataObj.append('documentType', 'panel_attribute_document');
  // Note: Do NOT send attributeKey for panel attributes (not a hospital-level
  // attribute). Linking happens via addPanelAttributeDocument().

  const response = await ApiService.uploadDocument(hospitalId, formDataObj);
  const documentId = response.data.data?.id;
  if (!documentId) {
    throw new Error('No document ID returned from upload');
  }
  return documentId;
}

export interface UploadResult {
  documentIds: string[];
  failed: string[];
}

export async function uploadMultipleDocuments(
  hospitalId: string,
  definition: AttributeDefinition,
  files: File[],
): Promise<UploadResult> {
  const documentIds: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const documentId = await uploadAttributeDocument(hospitalId, definition, file);
      documentIds.push(documentId);
    } catch (err: any) {
      const errorMsg =
        err?.response?.data?.message || `Failed to upload ${file.name}`;
      failed.push(`${file.name}: ${errorMsg}`);
      console.error(`Failed to upload ${file.name}:`, err);
    }
  }

  if (documentIds.length === 0 && failed.length > 0) {
    throw new Error(`All files failed to upload: ${failed.join('; ')}`);
  }
  return { documentIds, failed };
}

export function buildAttributePayload(
  definition: AttributeDefinition,
  hospitalPanelId: string,
  formData: AttributeFormData,
): any {
  const payload: any = {
    hospital_panel_id: hospitalPanelId,
    panel_attribute_definition_id: definition.id,
    attribute_key: formData.attributeKey,
  };

  switch (definition.data_type) {
    case 'boolean':
      payload.value_boolean = formData.valueBoolean === 'true';
      break;
    case 'date':
      payload.value_date = formData.valueDate || null;
      break;
    case 'file':
      payload.document_id = formData.documentId || null;
      break;
    case 'json':
      try {
        payload.value_json = formData.valueJson
          ? JSON.parse(formData.valueJson)
          : null;
      } catch {
        payload.value_json = null;
      }
      break;
    case 'encrypted_text':
      payload.value_encrypted = formData.valueText || null;
      break;
    default:
      payload.value_text = formData.valueText || null;
  }

  return payload;
}

export function renderAttributeValue(attr: any): string {
  // Use data_type to determine which value field to read
  const dataType = attr.data_type || attr.dataType || 'text';

  const valueText = attr.value_text ?? attr.valueText;
  const valueBoolean =
    attr.value_boolean !== undefined ? attr.value_boolean : attr.valueBoolean;
  const valueDate = attr.value_date ?? attr.valueDate;
  const valueJson = attr.value_json ?? attr.valueJson;
  const valueEncrypted = attr.value_encrypted ?? attr.valueEncrypted;
  const documentId = attr.document_id ?? attr.documentId;

  switch (dataType) {
    case 'text':
    case 'email':
    case 'phone':
    case 'url':
    case 'textarea':
      return valueText || 'N/A';

    case 'boolean':
      return valueBoolean !== undefined && valueBoolean !== null
        ? valueBoolean
          ? 'Yes'
          : 'No'
        : 'N/A';

    case 'date':
      return valueDate ? new Date(valueDate).toLocaleDateString() : 'N/A';

    case 'json':
    case 'multi_select':
      return valueJson
        ? typeof valueJson === 'string'
          ? valueJson
          : JSON.stringify(valueJson)
        : 'N/A';

    case 'single_select':
      if (valueText && attr.options) {
        let optionsObj: any = attr.options;
        if (typeof attr.options === 'string') {
          try {
            optionsObj = JSON.parse(attr.options);
          } catch {
            optionsObj = attr.options;
          }
        }
        return optionsObj[valueText] || valueText || 'N/A';
      }
      return valueText || 'N/A';

    case 'encrypted_text':
      return valueEncrypted ? '***encrypted***' : 'N/A';

    case 'file':
      return documentId ? '📄 Document attached' : 'N/A';

    default:
      return valueText || 'N/A';
  }
}
