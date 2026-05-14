/**
 * Shared types for PanelsManager and its sub-components.
 * Extracted from PanelsManager.tsx during the M14 god-component split.
 */

export interface PanelAttributeDocument {
  id: string;
  documentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  isPrimary: boolean;
}

export interface PanelAttribute {
  id: string;
  hospitalPanelId: string;
  panelAttributeDefinitionId: string;
  attributeKey: string;
  valueText?: string;
  valueBoolean?: boolean;
  valueDate?: string;
  valueJson?: any;
  valueEncrypted?: string;
  documentId?: string;
  documents?: PanelAttributeDocument[];
  createdAt?: string;
  updatedAt?: string;
  // From definition (joined)
  label?: string;
  category?: string;
  dataType?: string;
  data_type?: string;
  options?: Record<string, string>;
  isRequired?: boolean;
  is_required?: boolean;
}

export interface Panel {
  id: string; // hospital_panels.id (relationship ID)
  hospitalId?: string;
  panelId: string; // The actual panel ID
  panelName?: string;
  panel_name?: string; // From backend response
  panelCode?: string;
  whatsappGroupId?: string;
  whatsapp_group_id?: string;
  sheetId?: string;
  sheet_id?: string;
  sheetName?: string;
  sheet_name?: string;
  driveFolderId?: string;
  drive_folder_id?: string;
  contact?: string;
  totalCount?: number;
  total_count?: number;
  attributes?: PanelAttribute[];
}

export interface AttributeDefinition {
  id: string;
  key: string;
  label: string;
  description?: string;
  category: string;
  data_type: string;
  options?: Record<string, string>;
  isRequired?: boolean;
  is_required?: boolean;
  validationRegex?: string;
  minLength?: number;
  maxLength?: number;
}

export interface PreviewFile {
  fileName: string;
  mimeType: string;
  documentId?: string;
}

/**
 * Form-data shape used by Add/Edit attribute dialogs.
 * Each dialog owns its own instance (fixes H13).
 */
export interface AttributeFormData {
  attributeKey: string;
  valueText: string;
  valueBoolean: string;
  valueDate: string;
  valueJson: string;
  documentId: string;
}

export const EMPTY_ATTRIBUTE_FORM: AttributeFormData = {
  attributeKey: '',
  valueText: '',
  valueBoolean: '',
  valueDate: '',
  valueJson: '',
  documentId: '',
};
