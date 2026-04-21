/**
 * useAttributeManager Hook
 *
 * Centralized state management for attribute forms
 * Used by both AttributesManager and PanelsManager
 *
 * Eliminates 23 separate useState calls and duplicated logic
 */

import { useState, useCallback } from 'react';
import ApiService from '@/services/api';
import {
  NormalizedAttribute,
  PanelAttributeDefinition,
  AttributeFormData,
} from '@/types/attributeTypes';
import {
  normalizeAttributeList,
  normalizeAttributeDefinitionList,
} from '@/utils/apiTransformers';

export interface UseAttributeManagerOptions {
  type: 'hospital' | 'panel';
  hospitalId: string;
  panelId?: string; // Required if type is 'panel'
}

export interface UseAttributeManagerState {
  // Data
  attributes: NormalizedAttribute[];
  definitions: PanelAttributeDefinition[];
  selectedCategory: string;

  // UI State
  dialogs: {
    add: boolean;
    edit: boolean;
    delete: boolean;
    preview: boolean;
  };

  // Form & Edit State
  formData: AttributeFormData;
  editingAttribute: NormalizedAttribute | null;
  selectedFiles: File[];
  deletedDocumentIds: string[];
  deleteAttributeId: string;
  previewFile: { fileName: string; mimeType: string; documentId?: string } | null;

  // Loading/Error State
  loading: boolean;
  uploadLoading: boolean;
  deleteLoading: boolean;
  error: string | null;
}

export interface UseAttributeManagerActions {
  // Data Management
  fetchData: () => Promise<void>;
  refreshAttributes: () => Promise<void>;

  // Category & Filtering
  setSelectedCategory: (category: string) => void;

  // Dialog Management
  openAddDialog: () => void;
  closeAddDialog: () => void;
  openEditDialog: (attribute: NormalizedAttribute) => Promise<void>;
  closeEditDialog: () => void;
  openDeleteDialog: (attributeId: string) => void;
  closeDeleteDialog: () => void;
  openPreviewModal: (file: any) => void;
  closePreviewModal: () => void;

  // Form Management
  setFormField: (field: keyof AttributeFormData, value: any) => void;
  setFormData: (data: AttributeFormData) => void;
  resetForm: () => void;

  // File Management
  addFiles: (files: File[]) => void;
  removeFile: (index: number) => void;
  clearFiles: () => void;

  // Document Management (Edit Dialog)
  removeLinkedDocument: (docId: string) => void;

  // State Getters
  getSelectedDefinition: () => PanelAttributeDefinition | undefined;
  getAvailableDefinitions: () => PanelAttributeDefinition[];
  setError: (error: string | null) => void;
}

const defaultFormData: AttributeFormData = {
  attributeKey: '',
  valueText: '',
  valueBoolean: '',
  valueDate: '',
  valueJson: '',
  documentId: '',
  certificateNumber: '',
  issuingAuthority: '',
  issueDate: '',
  expiresAt: '',
  verificationStatus: 'unverified',
  verificationNotes: '',
};

/**
 * Main hook for attribute management
 */
export function useAttributeManager(
  options: UseAttributeManagerOptions
): UseAttributeManagerState & UseAttributeManagerActions {
  // ============ State ============
  const [attributes, setAttributes] = useState<NormalizedAttribute[]>([]);
  const [definitions, setDefinitions] = useState<PanelAttributeDefinition[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Dialog states
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Form and edit states
  const [formData, setFormData] = useState<AttributeFormData>(defaultFormData);
  const [editingAttribute, setEditingAttribute] =
    useState<NormalizedAttribute | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [deletedDocumentIds, setDeletedDocumentIds] = useState<string[]>([]);
  const [deleteAttributeId, setDeleteAttributeId] = useState<string>('');
  const [previewFile, setPreviewFile] = useState<{
    fileName: string;
    mimeType: string;
    documentId?: string;
  } | null>(null);

  // Loading and error states
  const [loading, setLoading] = useState(true);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ============ Data Fetching ============
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      if (options.type === 'hospital') {
        // Fetch hospital attributes and definitions
        const [attrRes, defRes] = await Promise.all([
          ApiService.getHospitalAttributes(options.hospitalId),
          ApiService.getAttributeDefinitions(),
        ]);

        setAttributes(
          normalizeAttributeList(attrRes.data.data || [])
        );
        setDefinitions(
          normalizeAttributeDefinitionList(defRes.data.data || [])
        );
      } else if (options.type === 'panel' && options.panelId) {
        // Fetch panel attributes and definitions
        const [attrRes, defRes] = await Promise.all([
          ApiService.getPanelAttributes(options.hospitalId, options.panelId),
          ApiService.getPanelAttributeDefinitionsByCategory(),
        ]);

        setAttributes(
          normalizeAttributeList(attrRes.data.data || [])
        );

        // Flatten definitions from category structure
        const allDefs: PanelAttributeDefinition[] = [];
        const defsData = defRes.data.data || [];
        if (Array.isArray(defsData)) {
          defsData.forEach((categoryGroup: any) => {
            if (categoryGroup.definitions && Array.isArray(categoryGroup.definitions)) {
              allDefs.push(...normalizeAttributeDefinitionList(categoryGroup.definitions));
            }
          });
        }
        setDefinitions(allDefs);
      }
    } catch (err: any) {
      console.error('Error fetching data:', err);
      setError(err.response?.data?.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [options]);

  const refreshAttributes = useCallback(async () => {
    try {
      setError(null);

      if (options.type === 'hospital') {
        const res = await ApiService.getHospitalAttributes(options.hospitalId);
        setAttributes(normalizeAttributeList(res.data.data || []));
      } else if (options.type === 'panel' && options.panelId) {
        const res = await ApiService.getPanelAttributes(
          options.hospitalId,
          options.panelId
        );
        setAttributes(normalizeAttributeList(res.data.data || []));
      }
    } catch (err: any) {
      console.error('Error refreshing attributes:', err);
      setError('Failed to refresh attributes');
    }
  }, [options]);

  // ============ Dialog Management ============
  const openAddDialog = useCallback(() => {
    resetForm();
    setShowAddDialog(true);
  }, []);

  const closeAddDialog = useCallback(() => {
    setShowAddDialog(false);
  }, []);

  const openEditDialog = useCallback(
    async (attr: NormalizedAttribute) => {
      setEditingAttribute(attr);

      const attributeKey = attr.attributeKey;
      if (!attributeKey) {
        setError('Attribute key not found');
        return;
      }

      const definition = definitions.find((d) => d.key === attributeKey);

      if (definition) {
        // Set form data based on data type - load ALL fields
        const newFormData: AttributeFormData = {
          attributeKey,
          // Value fields
          valueText: attr.valueText || '',
          valueBoolean: attr.valueBoolean ? 'true' : 'false',
          valueDate: attr.valueDate || '',
          valueJson: attr.valueJson || '',
          documentId: attr.documentId || '',
          // Certificate fields
          certificateNumber: attr.certificateNumber || '',
          issuingAuthority: attr.issuingAuthority || '',
          issueDate: attr.issueDate || '',
          expiresAt: attr.expiresAt || '',
          // Verification fields
          verificationStatus: attr.verificationStatus || 'unverified',
          verificationNotes: attr.verificationNotes || '',
        };
        setFormData(newFormData);
      }

      setShowEditDialog(true);
    },
    [definitions]
  );

  const closeEditDialog = useCallback(() => {
    setShowEditDialog(false);
  }, []);

  const openDeleteDialog = useCallback((attributeId: string) => {
    setDeleteAttributeId(attributeId);
    setShowDeleteDialog(true);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setShowDeleteDialog(false);
    setDeleteAttributeId('');
  }, []);

  const openPreviewModal = useCallback((file: any) => {
    setPreviewFile(file);
    setShowPreviewModal(true);
  }, []);

  const closePreviewModal = useCallback(() => {
    setShowPreviewModal(false);
    setPreviewFile(null);
  }, []);

  // ============ Form Management ============
  const setFormFieldCallback = useCallback(
    (field: keyof AttributeFormData, value: any) => {
      setFormData((prev) => ({
        ...prev,
        [field]: value,
      }));
    },
    []
  );

  const resetForm = useCallback(() => {
    setFormData(defaultFormData);
    setSelectedFiles([]);
    setEditingAttribute(null);
    setDeletedDocumentIds([]);
  }, []);

  // ============ File Management ============
  const addFiles = useCallback((files: File[]) => {
    setSelectedFiles((prev) => [...prev, ...files]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearFiles = useCallback(() => {
    setSelectedFiles([]);
  }, []);

  // ============ Document Management ============
  const removeLinkedDocument = useCallback((docId: string) => {
    setEditingAttribute((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        documents: prev.documents
          ? prev.documents.filter((d) => d.id !== docId)
          : [],
      };
    });
    setDeletedDocumentIds((prev) => [...prev, docId]);
  }, []);

  // ============ Getters ============
  const getSelectedDefinition = useCallback(
    (): PanelAttributeDefinition | undefined => {
      return definitions.find((d) => d.key === formData.attributeKey);
    },
    [definitions, formData.attributeKey]
  );

  const getAvailableDefinitions = useCallback((): PanelAttributeDefinition[] => {
    const addedKeys = attributes.map((a) => a.attributeKey);
    return definitions.filter((d) => !addedKeys.includes(d.key));
  }, [definitions, attributes]);

  // ============ State Object ============
  return {
    // State
    attributes,
    definitions,
    selectedCategory,
    dialogs: {
      add: showAddDialog,
      edit: showEditDialog,
      delete: showDeleteDialog,
      preview: showPreviewModal,
    },
    formData,
    editingAttribute,
    selectedFiles,
    deletedDocumentIds,
    deleteAttributeId,
    previewFile,
    loading,
    uploadLoading,
    deleteLoading,
    error,

    // Actions
    fetchData,
    refreshAttributes,
    setSelectedCategory,
    openAddDialog,
    closeAddDialog,
    openEditDialog,
    closeEditDialog,
    openDeleteDialog,
    closeDeleteDialog,
    openPreviewModal,
    closePreviewModal,
    setFormField: setFormFieldCallback,
    setFormData,
    resetForm,
    addFiles,
    removeFile,
    clearFiles,
    removeLinkedDocument,
    getSelectedDefinition,
    getAvailableDefinitions,
    setError,
  };
}
