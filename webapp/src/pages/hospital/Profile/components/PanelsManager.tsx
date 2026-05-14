import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AlertCircle, Plus, Trash2, Edit2, Loader, FileText, Eye, Star, X } from 'lucide-react';
import ApiService from '@/services/api';
import FilePreviewModal from '@/components/FilePreviewModal';
import PanelsFleetTable, { FleetPanel } from './PanelsFleetTable';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { LayoutGrid, Settings as SettingsIcon } from 'lucide-react';

interface PanelsManagerProps {
  hospitalId: string;
}

interface PanelAttributeDocument {
  id: string;
  documentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  isPrimary: boolean;
}

interface PanelAttribute {
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

interface Panel {
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

interface AttributeDefinition {
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

export default function PanelsManager({ hospitalId }: PanelsManagerProps) {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [definitions, setDefinitions] = useState<AttributeDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<Panel | null>(null);
  const [panelAttributes, setPanelAttributes] = useState<PanelAttribute[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [fleet, setFleet] = useState<FleetPanel[]>([]);
  const [fleetLoading, setFleetLoading] = useState(true);
  const [subTab, setSubTab] = useState<'overview' | 'configure'>('overview');
  const editorRef = useRef<HTMLDivElement | null>(null);

  // Dialog states
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Editing states
  const [editingAttribute, setEditingAttribute] = useState<PanelAttribute | null>(null);
  const [deleteAttributeId, setDeleteAttributeId] = useState<string>('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deletedDocumentIds, setDeletedDocumentIds] = useState<string[]>([]); // Track documents removed from edit dialog

  const [previewFile, setPreviewFile] = useState<{
    fileName: string;
    mimeType: string;
    documentId?: string;
  } | null>(null);

  // Form data - only store what's needed for the data type
  const [formData, setFormData] = useState({
    attributeKey: '',
    valueText: '',
    valueBoolean: '',
    valueDate: '',
    valueJson: '',
    documentId: '',
  });

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Fetch initial data
  useEffect(() => {
    fetchData();
    fetchFleet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hospitalId]);

  // Pull the fleet (all panels + their attributes) in one round-trip.
  // Powers the new PanelsFleetTable at the top of the tab.
  const fetchFleet = async () => {
    try {
      setFleetLoading(true);
      const res = await ApiService.get(`/hospitals/${hospitalId}/panels-fleet`);
      setFleet(res.data?.data || []);
    } catch (err) {
      console.error('Error fetching panel fleet:', err);
    } finally {
      setFleetLoading(false);
    }
  };

  // Called after add/edit/delete so the table reflects new values.
  const refreshAll = () => {
    fetchFleet();
  };

  // Used by the fleet table's "Configure" button — switches to the Configure
  // sub-tab with the chosen panel pre-selected.
  const handleConfigure = (panelId: string) => {
    const panel = panels.find(
      (p) => p.id === panelId || (p as any).panel_id === panelId
    );
    if (panel) {
      setSelectedPanel(panel);
      setSubTab('configure');
      setTimeout(() => {
        editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    }
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [panelsRes, defsRes] = await Promise.all([
        ApiService.getHospitalPanels(hospitalId),
        ApiService.getPanelAttributeDefinitionsByCategory(),
      ]);

      const panelsList = panelsRes.data.data || [];
      setPanels(panelsList);

      // Flatten definitions from category structure
      // API returns array of { category, definitions: [...] }
      const allDefs: AttributeDefinition[] = [];
      const defsData = defsRes.data.data || [];
      if (Array.isArray(defsData)) {
        defsData.forEach((categoryGroup: any) => {
          if (categoryGroup.definitions && Array.isArray(categoryGroup.definitions)) {
            // Ensure category field is present in each definition
            const defsWithCategory = categoryGroup.definitions.map((def: any) => ({
              ...def,
              category: categoryGroup.category || def.category, // Preserve category
            }));
            allDefs.push(...defsWithCategory);
          }
        });
      }
      setDefinitions(allDefs);
      console.log('Loaded definitions:', allDefs.length, 'Categories:', Array.from(new Set(allDefs.map(d => d.category))));

      // Auto-select first panel if available
      if (!selectedPanel && panelsList.length > 0) {
        setSelectedPanel(panelsList[0]);
      }
    } catch (err: any) {
      console.error('Error fetching data:', err);
      setError(err.response?.data?.message || 'Failed to load panels');
    } finally {
      setLoading(false);
    }
  };

  // Fetch attributes and documents when panel changes - combined to avoid race conditions
  useEffect(() => {
    const loadAllData = async () => {
      if (!selectedPanel) return;

      try {
        setError(null);
        // Step 1: Fetch attributes first
        const actualPanelId = selectedPanel.panelId || (selectedPanel as any).panel_id;
        if (!actualPanelId) {
          setError('Panel ID not found');
          return;
        }

        const res = await ApiService.getPanelAttributes(hospitalId, actualPanelId);
        const attributes = res.data.data || [];

        // Step 2: Process attributes - use documents array if available, otherwise fetch individual documents for backward compatibility
        const attributesWithDocs = await Promise.all(
          attributes.map(async (attr: any) => {
            // If backend already returned documents array (new behavior), use it directly
            if (attr.documents && Array.isArray(attr.documents)) {
              return attr;
            }

            // Fallback to old behavior: fetch individual document if document_id exists
            if (attr.data_type === 'file' && attr.document_id) {
              try {
                const docResponse = await ApiService.getDocument(hospitalId, attr.document_id);
                const docData = docResponse.data.data || docResponse.data;
                return {
                  ...attr,
                  documents: [{
                    id: attr.document_id,
                    documentId: attr.document_id,
                    fileName: docData.file_name || docData.fileName || 'Document',
                    fileSize: docData.file_size_bytes || docData.fileSize || 0,
                    mimeType: docData.mime_type || docData.mimeType || 'application/octet-stream',
                    uploadedAt: docData.created_at || docData.uploadedAt || new Date().toISOString(),
                    isPrimary: true,
                  }]
                };
              } catch (err) {
                console.error('Failed to fetch document for attribute:', attr.id, err);
                return attr;
              }
            }
            return attr;
          })
        );

        // Step 3: Set state once with complete data (attributes + documents)
        setPanelAttributes(attributesWithDocs);
      } catch (err: any) {
        console.error('Error loading panel data:', err);
        const errorMsg = err.response?.data?.error || err.response?.data?.message || 'Failed to load panel attributes';
        if (errorMsg.includes('not found')) {
          setError(`Panel relationship not found. This panel may not be properly linked to this hospital.`);
        } else {
          setError(errorMsg);
        }
      }
    };

    loadAllData();
  }, [selectedPanel?.id, hospitalId]);


  const getSelectedDefinition = (): AttributeDefinition | undefined => {
    return definitions.find(d => d.key === formData.attributeKey);
  };

  const getAvailableDefinitions = (): AttributeDefinition[] => {
    // Handle both camelCase and snake_case from API response
    const addedKeys = panelAttributes.map(a => a.attributeKey || (a as any).attribute_key);
    return definitions.filter(d => !addedKeys.includes(d.key));
  };

  // Refresh panel attributes and documents after CRUD operations
  const refreshPanelAttributes = async () => {
    if (!selectedPanel) return;

    try {
      setError(null);
      const actualPanelId = selectedPanel.panelId || (selectedPanel as any).panel_id;
      if (!actualPanelId) {
        setError('Panel ID not found');
        return;
      }

      // Fetch fresh attributes
      const res = await ApiService.getPanelAttributes(hospitalId, actualPanelId);
      const attributes = res.data.data || [];

      // Process attributes - use documents array if available, otherwise fetch individual documents for backward compatibility
      const attributesWithDocs = await Promise.all(
        attributes.map(async (attr: any) => {
          // If backend already returned documents array (new behavior), use it directly
          if (attr.documents && Array.isArray(attr.documents)) {
            return attr;
          }

          // Fallback to old behavior: fetch individual document if document_id exists
          if (attr.data_type === 'file' && attr.document_id) {
            try {
              const docResponse = await ApiService.getDocument(hospitalId, attr.document_id);
              const docData = docResponse.data.data || docResponse.data;
              return {
                ...attr,
                documents: [{
                  id: attr.document_id,
                  documentId: attr.document_id,
                  fileName: docData.file_name || docData.fileName || 'Document',
                  fileSize: docData.file_size_bytes || docData.fileSize || 0,
                  mimeType: docData.mime_type || docData.mimeType || 'application/octet-stream',
                  uploadedAt: docData.created_at || docData.uploadedAt || new Date().toISOString(),
                  isPrimary: true,
                }]
              };
            } catch (err) {
              console.error('Failed to fetch document for attribute:', attr.id, err);
              return attr;
            }
          }
          return attr;
        })
      );

      setPanelAttributes(attributesWithDocs);
    } catch (err: any) {
      console.error('Error refreshing panel attributes:', err);
      setError('Failed to refresh attributes');
    }
  };

  const uploadAttributeDocument = async (file: File): Promise<string> => {
    const definition = getSelectedDefinition();
    const formDataObj = new FormData();
    formDataObj.append('file', file);
    formDataObj.append('documentName', file.name);
    formDataObj.append('documentCategory', definition?.category || 'panel_attributes');
    formDataObj.append('documentType', 'panel_attribute_document');
    // Note: Do NOT send attributeKey for panel attributes as it's not a hospital-level attribute
    // The linking happens later through addPanelAttributeDocument()

    const response = await ApiService.uploadDocument(hospitalId, formDataObj);
    const documentId = response.data.data?.id;

    if (!documentId) {
      throw new Error('No document ID returned from upload');
    }

    return documentId;
  };

  const uploadMultipleDocuments = async (files: File[]): Promise<string[]> => {
    console.log('🚀 uploadMultipleDocuments START - Uploading', files.length, 'files');
    files.forEach((f, idx) => console.log(`   [${idx}] ${f.name} (${(f.size / 1024 / 1024).toFixed(2)}MB)`));

    const documentIds: string[] = [];
    const failedFiles: string[] = [];

    // Upload all files, continue even if some fail
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`📤 [${i + 1}/${files.length}] Uploading: ${file.name}`);
      try {
        const documentId = await uploadAttributeDocument(file);
        console.log(`✅ [${i + 1}/${files.length}] Success: ${file.name} → ID: ${documentId}`);
        documentIds.push(documentId);
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || `Failed to upload ${file.name}`;
        failedFiles.push(`${file.name}: ${errorMsg}`);
        console.error(`❌ [${i + 1}/${files.length}] Failed: ${file.name} -`, err.message);
      }
    }

    console.log(`🏁 uploadMultipleDocuments END - Successful: ${documentIds.length}, Failed: ${failedFiles.length}`);

    // If no files were uploaded successfully, throw error
    if (documentIds.length === 0) {
      throw new Error(`All files failed to upload: ${failedFiles.join('; ')}`);
    }

    // If some files failed, show warning but continue with successful ones
    if (failedFiles.length > 0) {
      const warning = `${documentIds.length} file(s) uploaded successfully, but ${failedFiles.length} failed: ${failedFiles.join('; ')}`;
      console.warn(warning);
      setError(warning);
    }

    return documentIds;
  };

  const handleAddFileToPending = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    console.log('📁 handleAddFileToPending - Files selected:', files.length);
    files.forEach(f => console.log(`   - ${f.name} (${(f.size / 1024 / 1024).toFixed(2)}MB)`));

    if (files.length > 0) {
      const updated = [...selectedFiles, ...files];
      console.log('📁 Total pending files now:', updated.length);
      setSelectedFiles(updated);
      e.target.value = '';
    }
  };

  const handleRemovePendingFile = (index: number) => {
    setSelectedFiles(selectedFiles.filter((_, i) => i !== index));
  };

  const handleRemoveLinkedDocument = (docId: string) => {
    // Remove from editing attribute's documents array
    setEditingAttribute(prev => {
      if (!prev) return null;
      return {
        ...prev,
        documents: prev.documents ? prev.documents.filter(d => d.id !== docId) : []
      };
    });

    // Track this document as deleted so we can call the API later
    setDeletedDocumentIds(prev => [...prev, docId]);
  };

  const renderAttributeInput = (definition: AttributeDefinition) => {
    // Determine which formData field to use based on data_type
    let value = '';
    if (['text', 'email', 'phone', 'url', 'textarea', 'encrypted_text', 'single_select'].includes(definition.data_type)) {
      value = formData.valueText;
    } else if (definition.data_type === 'boolean') {
      value = formData.valueBoolean;
    } else if (definition.data_type === 'date') {
      value = formData.valueDate;
    } else if (['json', 'multi_select'].includes(definition.data_type)) {
      value = formData.valueJson;
    }

    switch (definition.data_type) {
      case 'text':
      case 'textarea':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            {definition.data_type === 'textarea' ? (
              <Textarea
                id="value"
                placeholder={definition.description}
                value={value}
                onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
              />
            ) : (
              <Input
                id="value"
                type="text"
                placeholder={definition.description}
                value={value}
                onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
              />
            )}
          </div>
        );

      case 'email':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <Input
              id="value"
              type="email"
              placeholder="user@example.com"
              value={value}
              onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
            />
          </div>
        );

      case 'phone':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <Input
              id="value"
              type="tel"
              placeholder="+91-XXXX-XXXXX"
              value={value}
              onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
            />
          </div>
        );

      case 'url':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <Input
              id="value"
              type="url"
              placeholder="https://example.com"
              value={value}
              onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
            />
          </div>
        );

      case 'date':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <Input
              id="value"
              type="date"
              value={value}
              onChange={(e) => setFormData({ ...formData, valueDate: e.target.value })}
            />
          </div>
        );

      case 'boolean':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <select
              id="value"
              value={value}
              onChange={(e) => setFormData({ ...formData, valueBoolean: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
            >
              <option value="">Select...</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
        );

      case 'single_select':
        // Handle options that might be a string or object
        let optionsObj = definition.options;
        if (typeof definition.options === 'string') {
          try {
            optionsObj = JSON.parse(definition.options);
          } catch (e) {
            optionsObj = {};
          }
        }

        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <select
              id="value"
              value={value}
              onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
            >
              <option value="">Select...</option>
              {optionsObj && Object.entries(optionsObj).map(([key, label]: [string, any]) => (
                <option key={key} value={key}>
                  {String(label)}
                </option>
              ))}
            </select>
          </div>
        );

      case 'file':
        return (
          <div className="space-y-2">
            <Label>{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                Add File
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                multiple
                onChange={handleAddFileToPending}
                accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
              />
            </div>

            {selectedFiles.length > 0 && (
              <div className="space-y-2 mt-2">
                <p className="text-sm font-medium">Pending files:</p>
                {selectedFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between p-2 bg-gray-50 rounded border">
                    <div className="flex items-center gap-2 flex-1">
                      <FileText className="h-4 w-4 text-gray-500" />
                      <span className="text-sm truncate">{file.name}</span>
                      <span className="text-xs text-gray-500">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemovePendingFile(idx)}
                      className="h-6 w-6 p-0"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );

      case 'encrypted_text':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <Input
              id="value"
              type="password"
              placeholder="Enter encrypted value"
              value={value}
              onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
            />
            <p className="text-xs text-gray-500">This value will be encrypted before storing</p>
          </div>
        );

      default:
        return (
          <div className="space-y-2">
            <Label htmlFor="value">{definition.label} {definition.is_required && <span className="text-red-500">*</span>}</Label>
            <Input
              id="value"
              type="text"
              placeholder={definition.description}
              value={value}
              onChange={(e) => setFormData({ ...formData, valueText: e.target.value })}
            />
          </div>
        );
    }
  };

  const buildAttributePayload = (definition: AttributeDefinition, hospitalPanelId: string): any => {
    const payload: any = {
      hospital_panel_id: hospitalPanelId, // Backend requires this
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
          payload.value_json = formData.valueJson ? JSON.parse(formData.valueJson) : null;
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
  };

  const handleAddAttribute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPanel) return;

    console.log('➕ handleAddAttribute - Form submitted');
    console.log(`   selectedFiles.length: ${selectedFiles.length}`);
    if (selectedFiles.length > 0) {
      selectedFiles.forEach((f, idx) => console.log(`   [${idx}] ${f.name}`));
    }

    try {
      setUploadLoading(true);

      const definition = getSelectedDefinition();
      if (!definition) {
        setError('Selected attribute definition not found');
        return;
      }

      const actualPanelId = selectedPanel.panelId || (selectedPanel as any).panel_id;
      if (!actualPanelId) {
        setError('Panel ID not found');
        return;
      }

      let documentId = formData.documentId;
      const documentIds: string[] = [];

      // Upload multiple files if selected
      if (selectedFiles.length > 0) {
        try {
          console.log(`   About to upload ${selectedFiles.length} files...`);
          const uploadedIds = await uploadMultipleDocuments(selectedFiles);
          documentIds.push(...uploadedIds);
          console.log(`   ✅ Got ${uploadedIds.length} document IDs:`, uploadedIds);
          documentId = uploadedIds[0];
        } catch (err: any) {
          console.error('   ❌ Upload failed:', err.message);
          setError(err.message || 'Failed to upload documents');
          return;
        }
      }

      const payload = buildAttributePayload(definition, selectedPanel.id);
      if (documentId) {
        payload.document_id = documentId;
      }

      const attrResponse = await ApiService.setPanelAttribute(hospitalId, actualPanelId, payload);
      const newAttributeId = attrResponse.data.data?.id || editingAttribute?.id;
      console.log(`   Attribute created: ${newAttributeId}`);

      // Link ALL uploaded documents to attribute
      if (documentIds.length > 0 && newAttributeId) {
        console.log(`   Linking ${documentIds.length} documents to attribute ${newAttributeId}...`);
        try {
          for (let i = 0; i < documentIds.length; i++) {
            const docId = documentIds[i];
            console.log(`   [${i + 1}/${documentIds.length}] Linking document ${docId}...`);
            await ApiService.addPanelAttributeDocument(
              hospitalId,
              actualPanelId,
              newAttributeId,
              docId
            );
            console.log(`   [${i + 1}/${documentIds.length}] ✅ Linked`);
          }
          console.log(`   ✅ All ${documentIds.length} documents linked successfully`);
        } catch (err: any) {
          console.error('❌ Failed to link documents:', err);
        }
      } else {
        console.log(`   No documents to link (documentIds.length=${documentIds.length}, newAttributeId=${newAttributeId})`);
      }

      setShowAddDialog(false);
      resetForm();
      console.log('   Refreshing panel attributes...');
      await refreshPanelAttributes();
      refreshAll();
      console.log('✅ handleAddAttribute COMPLETE - Dialog closed, attributes refreshed');
    } catch (err: any) {
      console.error('❌ handleAddAttribute ERROR:', err.message);
      setError(err.response?.data?.message || 'Failed to add attribute');
    } finally {
      setUploadLoading(false);
    }
  };

  const handleUpdateAttribute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPanel || !editingAttribute) return;

    console.log('✏️ handleUpdateAttribute - Form submitted');
    console.log(`   Editing attribute: ${editingAttribute.id}`);
    console.log(`   selectedFiles.length: ${selectedFiles.length}`);
    if (selectedFiles.length > 0) {
      selectedFiles.forEach((f, idx) => console.log(`   [${idx}] ${f.name}`));
    }

    try {
      setUploadLoading(true);

      const definition = getSelectedDefinition();
      if (!definition) {
        setError('Selected attribute definition not found');
        return;
      }

      const actualPanelId = selectedPanel.panelId || (selectedPanel as any).panel_id;
      if (!actualPanelId) {
        setError('Panel ID not found');
        return;
      }

      let documentId = formData.documentId;
      const documentIds: string[] = [];

      // Upload multiple files if selected
      if (selectedFiles.length > 0) {
        try {
          console.log(`   About to upload ${selectedFiles.length} files...`);
          const uploadedIds = await uploadMultipleDocuments(selectedFiles);
          documentIds.push(...uploadedIds);
          console.log(`   ✅ Got ${uploadedIds.length} document IDs:`, uploadedIds);
        } catch (err: any) {
          console.error('   ❌ Upload failed:', err.message);
          setError(err.message || 'Failed to upload documents');
          return;
        }
      }

      const payload = buildAttributePayload(definition, selectedPanel.id);
      if (documentId || documentIds.length > 0) {
        payload.document_id = documentId || documentIds[0];
      }

      await ApiService.updatePanelAttribute(
        hospitalId,
        actualPanelId,
        editingAttribute.id,
        payload
      );

      // Link ALL newly uploaded documents to attribute
      if (documentIds.length > 0) {
        console.log(`   Linking ${documentIds.length} documents to attribute ${editingAttribute.id}...`);
        try {
          for (let i = 0; i < documentIds.length; i++) {
            const docId = documentIds[i];
            console.log(`   [${i + 1}/${documentIds.length}] Linking document ${docId}...`);
            await ApiService.addPanelAttributeDocument(
              hospitalId,
              actualPanelId,
              editingAttribute.id,
              docId
            );
            console.log(`   [${i + 1}/${documentIds.length}] ✅ Linked`);
          }
          console.log(`   ✅ All ${documentIds.length} documents linked successfully`);
        } catch (err: any) {
          console.error('❌ Failed to link documents:', err);
          // Continue anyway - attribute is updated
        }
      } else {
        console.log(`   No documents to link (documentIds.length=0)`);
      }

      // Remove deleted documents from attribute
      if (deletedDocumentIds.length > 0) {
        console.log(`   Removing ${deletedDocumentIds.length} documents from attribute ${editingAttribute.id}...`);
        try {
          for (let i = 0; i < deletedDocumentIds.length; i++) {
            const docId = deletedDocumentIds[i];
            console.log(`   [${i + 1}/${deletedDocumentIds.length}] Removing document ${docId}...`);
            await ApiService.removePanelAttributeDocument(
              hospitalId,
              actualPanelId,
              editingAttribute.id,
              docId
            );
            console.log(`   [${i + 1}/${deletedDocumentIds.length}] ✅ Removed`);
          }
          console.log(`   ✅ All ${deletedDocumentIds.length} documents removed successfully`);
        } catch (err: any) {
          console.error('❌ Failed to remove documents:', err);
          // Continue anyway - attribute is updated
        }
      } else {
        console.log(`   No documents to remove (deletedDocumentIds.length=0)`);
      }

      setShowEditDialog(false);
      resetForm();
      console.log('   Refreshing panel attributes...');
      await refreshPanelAttributes();
      refreshAll();
      console.log('✅ handleUpdateAttribute COMPLETE - Dialog closed, attributes refreshed');
    } catch (err: any) {
      console.error('❌ handleUpdateAttribute ERROR:', err.message);
      setError(err.response?.data?.message || 'Failed to update attribute');
    } finally {
      setUploadLoading(false);
    }
  };

  const handleDeleteAttribute = async () => {
    if (!selectedPanel || !deleteAttributeId) return;

    try {
      setDeleteLoading(true);
      const actualPanelId = selectedPanel.panelId || (selectedPanel as any).panel_id;
      if (!actualPanelId) {
        setError('Panel ID not found');
        return;
      }
      await ApiService.deletePanelAttribute(hospitalId, actualPanelId, deleteAttributeId);
      setShowDeleteDialog(false);
      setDeleteAttributeId('');
      await refreshPanelAttributes();
      refreshAll();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete attribute');
    } finally {
      setDeleteLoading(false);
    }
  };

  const resetForm = () => {
    setFormData({
      attributeKey: '',
      valueText: '',
      valueBoolean: '',
      valueDate: '',
      valueJson: '',
      documentId: '',
    });
    setSelectedFiles([]);
    setEditingAttribute(null);
    setDeletedDocumentIds([]);
  };

  const openEditDialog = async (attr: PanelAttribute) => {
    setEditingAttribute(attr);

    // Handle both camelCase and snake_case for attribute key
    const attributeKey = attr.attributeKey || (attr as any).attribute_key;

    if (!attributeKey) {
      setError('Attribute key not found');
      return;
    }

    const definition = definitions.find(d => d.key === attributeKey);

    if (definition) {
      // Handle both camelCase and snake_case from API response
      const valueText = (attr as any).value_text || attr.valueText || '';
      const valueBoolean = (attr as any).value_boolean !== undefined ? (attr as any).value_boolean : attr.valueBoolean;
      const valueDate = (attr as any).value_date || attr.valueDate || '';
      const valueJson = (attr as any).value_json || attr.valueJson;
      const valueEncrypted = (attr as any).value_encrypted || attr.valueEncrypted || '';
      const documentId = (attr as any).document_id || attr.documentId || '';

      // For file-type attributes, use documents array if available (new behavior)
      // Or fetch document details if only document_id exists (old behavior for backward compatibility)
      if (definition.data_type === 'file') {
        // If the attribute already has a documents array from the API, use it directly
        if (attr.documents && Array.isArray(attr.documents) && attr.documents.length > 0) {
          // Documents array is already populated from the API response, nothing to do
          // setEditingAttribute is already called above with the full documents array
        } else if (documentId) {
          // Fallback: fetch single document if only document_id exists (backward compatibility)
          try {
            const docResponse = await ApiService.getDocument(hospitalId, documentId);
            const docData = docResponse.data.data || docResponse.data;

            // Create documents array from the fetched document
            const documentWithDetails = {
              id: documentId, // Use document_id as the ID for linking
              documentId: documentId,
              fileName: docData.file_name || docData.fileName || 'Document',
              fileSize: docData.file_size_bytes || docData.fileSize || 0,
              mimeType: docData.mime_type || docData.mimeType || 'application/octet-stream',
              uploadedAt: docData.created_at || docData.uploadedAt || new Date().toISOString(),
              isPrimary: true, // The linked document is always primary
            };

            // Update editingAttribute with documents array
            setEditingAttribute(prev => prev ? {
              ...prev,
              documents: [documentWithDetails]
            } : null);
          } catch (err) {
            console.error('Failed to fetch document details:', err);
            // Continue without document details - form will still work
          }
        }
      }

      switch (definition.data_type) {
        case 'text':
        case 'email':
        case 'phone':
        case 'url':
        case 'textarea':
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            valueText: valueText,
          }));
          break;

        case 'boolean':
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            valueBoolean: valueBoolean ? 'true' : 'false',
          }));
          break;

        case 'date':
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            valueDate: valueDate,
          }));
          break;

        case 'file':
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            documentId: documentId,
          }));
          break;

        case 'json':
        case 'multi_select':
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            valueJson: valueJson ? (typeof valueJson === 'string' ? valueJson : JSON.stringify(valueJson)) : '',
          }));
          break;

        case 'single_select':
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            valueText: valueText,
          }));
          break;

        case 'encrypted_text':
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            valueText: valueEncrypted,
          }));
          break;

        default:
          setFormData(prev => ({
            ...prev,
            attributeKey: attributeKey,
            valueText: valueText,
          }));
      }
    }

    setShowEditDialog(true);
  };

  const renderAttributeValue = (attr: PanelAttribute): string => {
    // Use data_type to determine which value field to read
    const dataType = attr.data_type || attr.dataType || 'text';

    // Check both camelCase and snake_case for API response compatibility
    const valueText = (attr as any).value_text || attr.valueText;
    const valueBoolean = (attr as any).value_boolean !== undefined ? (attr as any).value_boolean : attr.valueBoolean;
    const valueDate = (attr as any).value_date || attr.valueDate;
    const valueJson = (attr as any).value_json || attr.valueJson;
    const valueEncrypted = (attr as any).value_encrypted || attr.valueEncrypted;
    const documentId = (attr as any).document_id || attr.documentId;

    switch (dataType) {
      case 'text':
      case 'email':
      case 'phone':
      case 'url':
      case 'textarea':
        return valueText || 'N/A';

      case 'boolean':
        return valueBoolean !== undefined && valueBoolean !== null
          ? (valueBoolean ? 'Yes' : 'No')
          : 'N/A';

      case 'date':
        return valueDate
          ? new Date(valueDate).toLocaleDateString()
          : 'N/A';

      case 'json':
      case 'multi_select':
        return valueJson
          ? (typeof valueJson === 'string' ? valueJson : JSON.stringify(valueJson))
          : 'N/A';

      case 'single_select':
        if (valueText && attr.options) {
          // Handle options that might be a string or object
          let optionsObj = attr.options;
          if (typeof attr.options === 'string') {
            try {
              optionsObj = JSON.parse(attr.options);
            } catch (e) {
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
  };

  const getFilteredAttributes = () => {
    if (selectedCategory === 'all') {
      return panelAttributes;
    }
    return panelAttributes.filter(attr => {
      // Handle both camelCase and snake_case
      const attrKey = attr.attributeKey || (attr as any).attribute_key;
      const def = definitions.find(d => d.key === attrKey);
      return def?.category === selectedCategory;
    });
  };

  // Get unique categories from definitions, filtering out undefined
  const categories = [
    'all',
    ...Array.from(new Set(
      definitions
        .map(d => d.category)
        .filter(cat => cat !== undefined && cat !== null && cat !== '')
    )),
  ];

  if (loading && !selectedPanel) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center justify-center">
          <Loader className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  const filteredAttributes = getFilteredAttributes();

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-red-600">
                <AlertCircle className="h-5 w-5" />
                {error}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setError(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as 'overview' | 'configure')}>
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="overview" className="gap-2">
            <LayoutGrid className="h-4 w-4" />
            Overview
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 h-5 text-[10px]">
              {fleet.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="configure" className="gap-2">
            <SettingsIcon className="h-4 w-4" />
            Configure
            {selectedPanel && subTab === 'configure' && (
              <span className="ml-1 text-xs text-muted-foreground truncate max-w-[120px]">
                · {(selectedPanel as any).panel_name || selectedPanel.panelName}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Overview — fleet table */}
        <TabsContent value="overview" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Panel Fleet</CardTitle>
              <CardDescription>
                All panels linked to this hospital with their portal access details. Click a row to see every configured attribute; click <span className="font-medium">Configure</span> to jump to the editor.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PanelsFleetTable
                fleet={fleet}
                loading={fleetLoading}
                onConfigure={handleConfigure}
                onRefresh={fetchFleet}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Configure — per-panel editor */}
        <TabsContent value="configure" className="mt-4">
          <Card ref={editorRef}>
        <CardHeader>
          <CardTitle>Configure Panel</CardTitle>
          <CardDescription>
            {selectedPanel
              ? 'Add, edit, or remove attributes for the selected panel.'
              : 'Pick a panel below to start editing its attributes, or go back to Overview and click Configure on any row.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Panel Selection */}
          <div className="space-y-2">
            <Label htmlFor="panel-select">Select Panel</Label>
            {panels.length === 0 ? (
              <div className="p-3 border border-gray-300 rounded-md bg-gray-50 text-gray-500">
                No panels available. Please link panels in Hospital Management first.
              </div>
            ) : (
              <select
                id="panel-select"
                value={selectedPanel?.id || ''}
                onChange={(e) => {
                  const panel = panels.find(p => p.id === e.target.value);
                  setSelectedPanel(panel || null);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-brand-600"
              >
                <option value="">-- Select a panel --</option>
                {panels.map(panel => (
                  <option key={panel.id} value={panel.id}>
                    {(panel as any).panel_name || panel.panelName || 'Unnamed Panel'}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Only show attributes if panel is selected */}
          {selectedPanel && (
            <>
              {/* Header with Add Button */}
              <div className="flex items-center justify-between pt-4 border-t">
                <div>
                  <h3 className="font-semibold">Attributes</h3>
                  <p className="text-sm text-gray-600">
                    {filteredAttributes.length} configured {selectedCategory !== 'all' ? `in ${selectedCategory}` : ''}
                  </p>
                </div>
                <Button onClick={() => setShowAddDialog(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add Attribute
                </Button>
              </div>

              {/* UI Revamp: wireframe-style chip filter with brand active state, visible in dark mode */}
              {categories.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {categories.map(cat => {
                    const isActive = selectedCategory === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setSelectedCategory(cat)}
                        className={
                          `px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ` +
                          (isActive
                            ? 'bg-brand-600 text-white border-brand-600 hover:bg-brand-700'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 hover:border-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-800')
                        }
                      >
                        {cat && (cat.charAt(0).toUpperCase() + cat.slice(1))}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Attributes List */}
              {filteredAttributes.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No attributes found in this category
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredAttributes.map(attr => {
                    // Handle both camelCase and snake_case
                    const attrKey = attr.attributeKey || (attr as any).attribute_key;
                    const attrDef = definitions.find(d => d.key === attrKey);
                    return (
                      <div key={attr.id} className="p-4 border rounded-lg space-y-3">
                        {/* Header */}
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold">{attr.label || attrDef?.label || attrKey}</h4>
                              {attr.documents && attr.documents.length > 0 && (
                                <span className="inline-block bg-brand-50 text-brand-700 text-xs font-medium px-2 py-0.5 rounded">
                                  {attr.documents.length} {attr.documents.length === 1 ? 'doc' : 'docs'}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-gray-600">{attrDef?.description}</p>
                          </div>
                        </div>

                        {/* Value */}
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <span className="text-gray-600">Value: </span>
                            <span className="font-medium">{renderAttributeValue(attr)}</span>
                          </div>
                        </div>

                        {/* Documents */}
                        {attr.documents && attr.documents.length > 0 && (
                          <div className="space-y-2 p-3 border rounded-md bg-gray-50 dark:bg-gray-900/20 mt-3">
                            <div className="flex items-center justify-between mb-2">
                              <Label className="text-sm font-semibold">Documents ({attr.documents.length})</Label>
                            </div>
                            <div className="space-y-2">
                              {attr.documents.map(doc => (
                                <div key={doc.id} className="flex items-center justify-between p-2 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                                  <div className="flex items-center gap-2 flex-1 min-w-0">
                                    {doc.isPrimary && (
                                      <span title="Primary document">
                                        <Star className="h-4 w-4 fill-yellow-400 text-yellow-400 flex-shrink-0" />
                                      </span>
                                    )}
                                    <FileText className="h-4 w-4 text-gray-500 flex-shrink-0" />
                                    <div className="flex-1 min-w-0">
                                      <p className="text-sm font-medium truncate">{doc.fileName}</p>
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0"
                                    onClick={() => {
                                      setPreviewFile({
                                        fileName: doc.fileName,
                                        mimeType: doc.mimeType,
                                        documentId: doc.documentId,
                                      });
                                      setShowPreviewModal(true);
                                    }}
                                    title="Preview document"
                                  >
                                    <Eye className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0"
                                    onClick={async () => {
                                      try {
                                        const response = await ApiService.downloadDocument(hospitalId, doc.documentId);
                                        const blob = new Blob([response.data], { type: doc.mimeType });
                                        const url = window.URL.createObjectURL(blob);
                                        const link = document.createElement('a');
                                        link.href = url;
                                        link.setAttribute('download', doc.fileName);
                                        document.body.appendChild(link);
                                        link.click();
                                        window.URL.revokeObjectURL(url);
                                        link.remove();
                                      } catch (err) {
                                        console.error('Failed to download document:', err);
                                        setError('Failed to download document');
                                      }
                                    }}
                                    title="Download document"
                                  >
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                    </svg>
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex gap-2 pt-2 border-t">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEditDialog(attr)}
                            className="gap-2"
                          >
                            <Edit2 className="h-4 w-4" />
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDeleteAttributeId(attr.id);
                              setShowDeleteDialog(true);
                            }}
                            className="gap-2 text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Add Attribute Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Panel Attribute</DialogTitle>
            <DialogDescription>
              Select an attribute and enter its value
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleAddAttribute} className="space-y-4">
            {/* Attribute Select */}
            <div className="space-y-2">
              <Label htmlFor="attr-select">Attribute</Label>
              <select
                id="attr-select"
                value={formData.attributeKey}
                onChange={(e) => setFormData({
                  attributeKey: e.target.value,
                  valueText: '',
                  valueBoolean: '',
                  valueDate: '',
                  valueJson: '',
                  documentId: '',
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
              >
                <option value="">Select unconfigured attribute...</option>
                {getAvailableDefinitions().map(def => (
                  <option key={def.id} value={def.key}>
                    {def.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Render appropriate input */}
            {formData.attributeKey && getSelectedDefinition() && (
              renderAttributeInput(getSelectedDefinition()!)
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowAddDialog(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!formData.attributeKey || uploadLoading}>
                {uploadLoading ? (
                  <>
                    <Loader className="h-4 w-4 animate-spin mr-2" />
                    Saving...
                  </>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Attribute Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Panel Attribute</DialogTitle>
            <DialogDescription>
              Update the attribute value
            </DialogDescription>
          </DialogHeader>

          {editingAttribute && getSelectedDefinition() ? (
            <form onSubmit={handleUpdateAttribute} className="space-y-4">
              {/* Show attribute label and current info */}
              <div>
                <p className="text-sm font-semibold text-gray-700">
                  {getSelectedDefinition()?.label}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {getSelectedDefinition()?.description}
                </p>
              </div>

              {/* Render form input */}
              {renderAttributeInput(getSelectedDefinition()!)}

              {/* Linked Documents Section - for file type attributes */}
              {getSelectedDefinition()?.data_type === 'file' && (
                <>
                  {/* Existing Documents */}
                  {editingAttribute.documents && editingAttribute.documents.length > 0 && (
                    <div className="space-y-2 p-3 border rounded-md bg-gray-50 dark:bg-gray-900/20">
                      <div className="flex items-center justify-between mb-2">
                        <Label className="text-sm font-semibold">Linked Documents ({editingAttribute.documents.length})</Label>
                      </div>
                      <div className="space-y-2">
                        {editingAttribute.documents.map((doc) => (
                          <div key={doc.id} className="flex items-center justify-between p-2 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              {doc.isPrimary && (
                                <span title="Primary document">
                                  <Star className="h-4 w-4 fill-yellow-400 text-yellow-400 flex-shrink-0" />
                                </span>
                              )}
                              <FileText className="h-4 w-4 text-gray-500 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">{doc.fileName}</p>
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => {
                                setPreviewFile({
                                  fileName: doc.fileName,
                                  mimeType: doc.mimeType,
                                  documentId: doc.documentId,
                                });
                                setShowPreviewModal(true);
                              }}
                              title="Preview document"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0"
                              onClick={() => {
                                handleRemoveLinkedDocument(doc.id);
                              }}
                              title="Remove document from this attribute"
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowEditDialog(false);
                    resetForm();
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={uploadLoading}>
                  {uploadLoading ? (
                    <>
                      <Loader className="h-4 w-4 animate-spin mr-2" />
                      Saving...
                    </>
                  ) : (
                    'Update'
                  )}
                </Button>
              </div>
            </form>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <p>Loading attribute details...</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Attribute?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. The attribute will be permanently removed.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteAttribute}
              disabled={deleteLoading}
            >
              {deleteLoading ? (
                <>
                  <Loader className="h-4 w-4 animate-spin mr-2" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* File Preview Modal */}
      {previewFile && (
        <FilePreviewModal
          open={showPreviewModal}
          onOpenChange={(open) => {
            setShowPreviewModal(open);
            if (!open) {
              setPreviewFile(null);
            }
          }}
          fileName={previewFile.fileName}
          mimeType={previewFile.mimeType}
          documentId={previewFile.documentId}
          hospitalId={hospitalId}
        />
      )}
    </div>
  );
}
