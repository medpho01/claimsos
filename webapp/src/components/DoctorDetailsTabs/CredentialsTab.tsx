// Fixed JSX structure
import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Plus, Trash2, Loader, Eye, Download, File, Edit2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import FilePreviewModal from '@/components/FilePreviewModal';
import ApiService from '@/services/api';
import { useConfirm } from '@/lib/confirm';
import { TabStatus } from './types';

interface AttributeDefinition {
  id: string;
  key: string;
  label: string;
  category: string;
  data_type: 'text' | 'date' | 'boolean' | 'document' | 'textarea';
  is_required: boolean;
  has_expiry: boolean;
  requires_document: boolean;
  description?: string;
}

interface DoctorAttribute {
  id: string;
  attribute_key: string;
  value_text?: string;
  value_date?: string;
  value_boolean?: boolean;
  certificate_number?: string;
  issuing_authority?: string;
  issued_at?: string;
  expires_at?: string;
  verification_status: string;
  documents?: any[];
}

interface AttributesByCategory {
  [category: string]: DoctorAttribute[];
}

interface AddCredentialFormData {
  attributeKey: string;
  valueText: string;
  valueDate: string;
  valueBoolean: boolean;
  certificateNumber: string;
  issuingAuthority: string;
  issuedAt: string;
  expiresAt: string;
  documentFile?: File;
}

interface CredentialsTabProps {
  doctorId: string;
  tabStatus: TabStatus;
  setTabStatus: (status: TabStatus) => void;
}

export const CredentialsTab: React.FC<CredentialsTabProps> = ({
  doctorId,
  tabStatus,
  setTabStatus,
}) => {
  const confirm = useConfirm();
  const [credentials, setCredentials] = useState<DoctorAttribute[]>([]);
  const [definitions, setDefinitions] = useState<AttributeDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedDefinition, setSelectedDefinition] = useState<AttributeDefinition | null>(null);
  const [editingCredential, setEditingCredential] = useState<DoctorAttribute | null>(null);
  const [formData, setFormData] = useState<AddCredentialFormData>({
    attributeKey: '',
    valueText: '',
    valueDate: '',
    valueBoolean: false,
    certificateNumber: '',
    issuingAuthority: '',
    issuedAt: '',
    expiresAt: '',
  });
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [originalDocuments, setOriginalDocuments] = useState<any[]>([]); // Track original documents before edit

  // Preview modal state
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewFile, setPreviewFile] = useState<{
    fileName: string;
    mimeType: string;
    fileData?: Blob;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Load credentials and definitions on mount
  useEffect(() => {
    loadData();
  }, [doctorId]);

  // Normalize API response from camelCase to snake_case
  const normalizeDefinition = (def: any): AttributeDefinition => ({
    id: def.id,
    key: def.key,
    label: def.label,
    category: def.category,
    data_type: def.dataType || def.data_type,
    is_required: def.isRequired || def.is_required,
    has_expiry: def.hasExpiry || def.has_expiry,
    requires_document: def.requiresDocument || def.requires_document,
    description: def.description,
  });

  // Open file preview modal
  const handleViewDocument = async (doc: any) => {
    if (!doc.documentId) {
      toast.error('Document ID not available');
      return;
    }

    try {
      setPreviewLoading(true);

      // Use API endpoint to download document (bypasses CORS issues)
      const response = await ApiService.downloadDoctorDoc(doctorId, doc.documentId);
      const blob = response.data;

      setPreviewFile({
        fileName: doc.fileName || 'Document',
        mimeType: blob.type || doc.mimeType || 'application/octet-stream',
        fileData: blob,
      });
      setShowPreviewModal(true);
    } catch (err) {
      toast.error('Failed to load document');
      console.error('Error opening preview:', err);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Handle download from FilePreviewModal
  const handleDownloadFile = async () => {
    if (!previewFile?.fileData) {
      toast.error('File data not available');
      return;
    }

    try {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(previewFile.fileData);
      link.download = previewFile.fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast.success('File downloaded successfully');
    } catch (err) {
      toast.error('Failed to download file');
      console.error('Error downloading:', err);
    }
  };

  // Handle direct download from document card (without opening modal)
  const handleDownloadDocumentDirect = async (doc: any) => {
    if (!doc.documentId) {
      toast.error('Document ID not available');
      return;
    }

    try {
      // Fetch the document via API
      const response = await ApiService.downloadDoctorDoc(doctorId, doc.documentId);
      const blob = response.data;

      // Trigger download directly
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = doc.fileName || 'document';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);

      toast.success('File downloaded successfully');
    } catch (err) {
      toast.error('Failed to download file');
      console.error('Error downloading:', err);
    }
  };

  const normalizeCredential = (cred: any): DoctorAttribute => ({
    id: cred.id,
    attribute_key: cred.attributeKey || cred.attribute_key,
    value_text: cred.valueText || cred.value_text,
    value_date: cred.valueDate || cred.value_date,
    value_boolean: cred.valueBoolean !== undefined ? cred.valueBoolean : cred.value_boolean,
    certificate_number: cred.certificateNumber || cred.certificate_number,
    issuing_authority: cred.issuingAuthority || cred.issuing_authority,
    issued_at: cred.issuedAt || cred.issued_at,
    expires_at: cred.expiresAt || cred.expires_at,
    verification_status: cred.verificationStatus || cred.verification_status,
    documents: cred.documents || [],
  });

  const loadData = async () => {
    try {
      setLoading(true);
      const [credRes, defRes] = await Promise.all([
        ApiService.getDoctorAttributes(doctorId),
        ApiService.getDoctorAttributeDefinitionsGrouped(),
      ]);

      let credsData: DoctorAttribute[] = [];
      if (credRes.data?.data) {
        const rawData = credRes.data.data;
        if (Array.isArray(rawData)) {
          credsData = rawData.map(normalizeCredential);
        } else if (rawData.attributes && Array.isArray(rawData.attributes)) {
          credsData = rawData.attributes.map(normalizeCredential);
        }
      }
      console.log('Loaded credentials:', credsData);
      setCredentials(credsData);

      const flatDefs: AttributeDefinition[] = [];
      if (defRes.data?.data) {
        Object.values(defRes.data.data).forEach((categoryDefs: any) => {
          if (Array.isArray(categoryDefs)) {
            flatDefs.push(...categoryDefs.map(normalizeDefinition));
          }
        });
      }
      console.log('Loaded definitions:', flatDefs);
      setDefinitions(flatDefs);
    } catch (err: any) {
      toast.error('Failed to load credentials');
      console.error('Error loading credentials:', err);
      setCredentials([]);
      setDefinitions([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectDefinition = (def: AttributeDefinition) => {
    console.log('Selected definition:', def);
    setSelectedDefinition(def);
    setFormData({
      attributeKey: def.key,
      valueText: '',
      valueDate: '',
      valueBoolean: false,
      certificateNumber: '',
      issuingAuthority: '',
      issuedAt: '',
      expiresAt: '',
    });
  };

  const handleEditCredential = (cred: DoctorAttribute) => {
    const def = definitions.find((d) => d.key === cred.attribute_key);
    if (!def) return;

    // Store original documents before edit starts
    setOriginalDocuments(cred.documents || []);

    setEditingCredential(cred);
    setSelectedDefinition(def);
    setFormData({
      attributeKey: cred.attribute_key,
      valueText: cred.value_text || '',
      valueDate: cred.value_date || '',
      valueBoolean: cred.value_boolean ?? false,
      certificateNumber: cred.certificate_number || '',
      issuingAuthority: cred.issuing_authority || '',
      issuedAt: cred.issued_at || '',
      expiresAt: cred.expires_at || '',
    });
    setShowAddDialog(true);
  };

  const closeDialog = () => {
    setShowAddDialog(false);
    setSelectedDefinition(null);
    setEditingCredential(null);
    setOriginalDocuments([]);
    setFormData({
      attributeKey: '',
      valueText: '',
      valueDate: '',
      valueBoolean: false,
      certificateNumber: '',
      issuingAuthority: '',
      issuedAt: '',
      expiresAt: '',
    });
    setSelectedFiles([]);
  };

  const handleInputChange = (field: keyof AddCredentialFormData, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      setSelectedFiles(Array.from(files));
    }
  };

  const handleRemovePendingFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveCredential = async () => {
    if (!selectedDefinition) return;

    try {
      setIsSaving(true);
      setTabStatus({ ...tabStatus, isSaving: true, error: null });

      const payload: any = {};

      switch (selectedDefinition.data_type) {
        case 'text':
        case 'textarea':
          payload.value_text = formData.valueText;
          break;
        case 'date':
          payload.value_date = formData.valueDate;
          break;
        case 'boolean':
          payload.value_boolean = formData.valueBoolean;
          break;
        case 'document':
          payload.value_text = formData.valueText || 'Document';
          break;
      }

      if (selectedDefinition.category === 'licenses' || selectedDefinition.category === 'qualifications') {
        if (formData.certificateNumber) payload.certificate_number = formData.certificateNumber;
        if (formData.issuingAuthority) payload.issuing_authority = formData.issuingAuthority;
        if (formData.issuedAt) payload.issued_at = formData.issuedAt;
      }

      if (selectedDefinition.has_expiry && formData.expiresAt) {
        payload.expires_at = formData.expiresAt;
      }

      console.log('=== CREDENTIAL SAVE START ===');
      console.log('doctorId:', doctorId);
      console.log('attributeKey:', selectedDefinition.key);
      console.log('Full payload:', JSON.stringify(payload, null, 2));

      const attrRes = await ApiService.setDoctorAttribute(doctorId, selectedDefinition.key, payload);
      console.log('Full setDoctorAttribute response:', JSON.stringify(attrRes, null, 2));

      const attributeId = attrRes.data?.data?.id;
      console.log('Extracted attributeId:', attributeId);

      if (!attributeId) {
        console.error('ERROR: No attributeId returned from setDoctorAttribute!');
        console.error('attrRes.data:', attrRes.data);
        throw new Error('Failed to get attribute ID from response');
      }

      // Handle document deletions in edit mode
      if (editingCredential && originalDocuments.length > 0) {
        console.log('=== DOCUMENT DELETION START (EDIT MODE) ===');
        const currentDocIds = editingCredential.documents?.map((d) => d.documentId || d.id) || [];
        const originalDocIds = originalDocuments.map((d) => d.documentId || d.id);
        const deletedDocIds = originalDocIds.filter((id) => !currentDocIds.includes(id));

        console.log('Current docs:', currentDocIds);
        console.log('Original docs:', originalDocIds);
        console.log('Deleted docs:', deletedDocIds);

        for (const docId of deletedDocIds) {
          try {
            console.log(`Removing document ${docId} from attribute ${attributeId}`);
            await ApiService.removeDoctorAttributeDocument(doctorId, attributeId, docId);
            console.log(`Document ${docId} removed successfully`);
          } catch (delErr: any) {
            console.error(`Error removing document ${docId}:`, delErr?.response?.data || delErr.message);
          }
        }
        console.log('=== DOCUMENT DELETION END ===');
      }

      if (selectedFiles.length > 0 && attributeId) {
        console.log('=== DOCUMENT UPLOAD START ===');
        console.log('Files to upload:', selectedFiles.length);
        for (const file of selectedFiles) {
          try {
            console.log(`Uploading file: ${file.name}`);
            const uploadRes = await ApiService.uploadDoctorDoc(doctorId, file, {
              documentName: file.name,
              documentCategory: selectedDefinition.category || 'general',
              documentType: 'credential',
              attributeKey: selectedDefinition.key,
            });
            console.log('Upload response:', uploadRes.data);
            const documentId = uploadRes.data?.data?.id;
            if (documentId) {
              console.log(`Linking document ${documentId} to attribute ${attributeId}`);
              await ApiService.addDoctorAttributeDocument(doctorId, attributeId, documentId);
              console.log('Document linked successfully');
            } else {
              console.warn('No documentId in upload response for', file.name);
            }
          } catch (docErr: any) {
            console.error(`Error uploading/linking file ${file.name}:`, docErr?.response?.data || docErr.message);
          }
        }
        console.log('=== DOCUMENT UPLOAD END ===');
      } else {
        console.log('No files to upload or no attributeId:', { filesCount: selectedFiles.length, attributeId });
      }

      console.log('=== CREDENTIAL SAVE SUCCESS ===');
      console.log('Saved credential:', {
        attributeId,
        key: selectedDefinition.key,
        files: selectedFiles.length
      });

      toast.success(editingCredential ? 'Credential updated successfully' : 'Credential added successfully');
      closeDialog();

      console.log('Reloading data...');
      await loadData();
      console.log('Data reloaded');

      setTabStatus({
        isDirty: false,
        isSaving: false,
        error: null,
        success: true,
      });

      setTimeout(() => {
        setTabStatus({
          isDirty: false,
          isSaving: false,
          error: null,
          success: false,
        });
      }, 3000);
    } catch (err: any) {
      console.error('=== CREDENTIAL SAVE ERROR ===');
      console.error('Full error object:', err);
      console.error('Error response:', err.response);
      console.error('Error message:', err.message);

      const errorMsg = err.response?.data?.message || err.message || 'Failed to save credential';
      setTabStatus({ ...tabStatus, isSaving: false, error: errorMsg });
      toast.error(errorMsg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteCredential = async (credentialId: string) => {
    if (!(await confirm({
      title: 'Delete credential?',
      message: 'This action cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    }))) return;

    try {
      await ApiService.deleteDoctorAttribute(doctorId, credentialId);
      toast.success('Credential deleted successfully');
      await loadData();
    } catch (err: any) {
      toast.error('Failed to delete credential');
      console.error('Error deleting credential:', err);
    }
  };

  // Get unique categories and group credentials
  const categoriesSet = new Set<string>();
  const groupedCredentials = Array.isArray(credentials)
    ? credentials.reduce((acc, cred) => {
        const def = definitions.find((d) => d.key === cred.attribute_key);
        const category = def?.category || 'Other';
        categoriesSet.add(category);
        if (!acc[category]) acc[category] = [];
        acc[category].push(cred);
        return acc;
      }, {} as AttributesByCategory)
    : {};

  const allCategories = ['All', ...Array.from(categoriesSet).sort()];
  const filteredCredentials =
    selectedCategory && selectedCategory !== 'All'
      ? Object.fromEntries(
          Object.entries(groupedCredentials).filter(([cat]) => cat === selectedCategory)
        )
      : groupedCredentials;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader className="h-6 w-6 animate-spin text-slate-400 mr-3" />
        <p className="text-slate-600">Loading credentials...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Doctor Credentials Header */}
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">Doctor Credentials</h2>
            <p className="text-slate-600 text-sm mt-1">Manage qualifications and certifications</p>
          </div>
          <Button
            onClick={() => setShowAddDialog(true)}
            className="gap-2 bg-slate-900 hover:bg-slate-800 text-white"
          >
            <Plus className="h-4 w-4" />
            Add Credential
          </Button>
        </div>

        {/* Success Alert */}
        {tabStatus.success && (
          <Alert className="bg-green-50 border-green-200">
            <AlertDescription className="text-green-800">
              ✓ Credential saved successfully!
            </AlertDescription>
          </Alert>
        )}

        {/* Error Alert */}
        {tabStatus.error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{tabStatus.error}</AlertDescription>
          </Alert>
        )}

        {/* Category Filter Tabs */}
        {Object.keys(groupedCredentials).length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-2">
            {allCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat === 'All' ? null : cat)}
                className={`px-4 py-2 rounded-full font-medium text-sm whitespace-nowrap transition-colors ${
                  (cat === 'All' && !selectedCategory) || (cat === selectedCategory)
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

      {/* Scrollable Credentials List */}
        {Object.keys(filteredCredentials).length === 0 ? (
          <p className="text-slate-600 text-center py-8">
            No credentials added yet. Click "Add Credential" to get started.
          </p>
        ) : (
          Object.entries(filteredCredentials).map(([category, creds]) => (
            <div key={category} className="space-y-4">
              {creds.map((cred) => {
                const def = definitions.find((d) => d.key === cred.attribute_key);
                return (
                  <div
                    key={cred.id}
                    className="border border-slate-200 rounded-lg bg-white p-6 space-y-4"
                  >
                    {/* Header with title and status */}
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <h3 className="font-semibold text-slate-900">{def?.label}</h3>
                        {cred.value_text && def?.data_type === 'text' && (
                          <p className="text-sm text-slate-600 mt-1">
                            Value: <span className="font-medium">{cred.value_text}</span>
                          </p>
                        )}
                        {cred.value_date && (
                          <p className="text-sm text-slate-600 mt-1">
                            Date: <span className="font-medium">{new Date(cred.value_date).toLocaleDateString()}</span>
                          </p>
                        )}
                        {cred.value_boolean !== null && cred.value_boolean !== undefined && (
                          <p className="text-sm text-slate-600 mt-1">
                            Status: <span className="font-medium">{cred.value_boolean ? 'Yes' : 'No'}</span>
                          </p>
                        )}
                      </div>
                      <span className={`inline-block px-3 py-1 rounded-full text-xs font-medium text-white whitespace-nowrap ${
                        cred.verification_status === 'verified' || cred.verification_status === 'verified_by_doc'
                          ? 'bg-green-500'
                          : cred.verification_status === 'unverified'
                          ? 'bg-brand-500'
                          : 'bg-yellow-500'
                      }`}>
                        {cred.verification_status === 'verified_by_doc' ? 'Verified' : cred.verification_status.charAt(0).toUpperCase() + cred.verification_status.slice(1)}
                      </span>
                    </div>

                    {/* Certificate Details */}
                    {(cred.certificate_number || cred.issuing_authority || cred.issued_at || cred.expires_at) && (
                      <div className="border-t pt-4">
                        <p className="text-sm font-semibold text-slate-700 mb-3">Certificate Details</p>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          {cred.certificate_number && (
                            <div>
                              <p className="text-slate-600">Certificate Number</p>
                              <p className="font-medium text-slate-900 mt-1">{cred.certificate_number}</p>
                            </div>
                          )}
                          {cred.issuing_authority && (
                            <div>
                              <p className="text-slate-600">Issuing Authority</p>
                              <p className="font-medium text-slate-900 mt-1">{cred.issuing_authority}</p>
                            </div>
                          )}
                          {cred.issued_at && (
                            <div>
                              <p className="text-slate-600">Issued</p>
                              <p className="font-medium text-slate-900 mt-1">
                                {new Date(cred.issued_at).toLocaleDateString()}
                              </p>
                            </div>
                          )}
                          {cred.expires_at && (
                            <div>
                              <p className="text-slate-600">Expires</p>
                              <p className="font-medium text-slate-900 mt-1">
                                {new Date(cred.expires_at).toLocaleDateString()}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Documents Section */}
                    {cred.documents && cred.documents.length > 0 && (
                      <div className="border-t pt-4">
                        <div className="flex items-center gap-2 mb-4">
                          <p className="text-sm font-semibold text-slate-700">Documents</p>
                          <span className="bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full text-xs font-medium">
                            {cred.documents.length}
                          </span>
                        </div>
                        <div className="space-y-3">
                          {cred.documents.map((doc, idx) => (
                            <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                {doc.isPrimary && <span className="text-yellow-500 text-lg">★</span>}
                                <File className="h-4 w-4 text-slate-500 flex-shrink-0" />
                                <span className="text-slate-700 font-medium truncate">{doc.fileName || 'Document'}</span>
                              </div>
                              <div className="flex items-center gap-2 ml-3">
                                <button
                                  onClick={() => handleViewDocument(doc)}
                                  className="p-2 hover:bg-slate-200 rounded transition"
                                  title="View document"
                                >
                                  <Eye className="h-4 w-4 text-slate-600" />
                                </button>
                                <button
                                  onClick={() => handleDownloadDocumentDirect(doc)}
                                  className="p-2 hover:bg-slate-200 rounded transition"
                                  title="Download document"
                                >
                                  <Download className="h-4 w-4 text-slate-600" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="border-t pt-4 flex gap-2 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditCredential(cred)}
                        className="text-brand-600 border-brand-50 hover:bg-brand-50"
                      >
                        <Edit2 className="h-4 w-4 mr-2" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteCredential(cred.id)}
                        className="text-red-600 border-red-200 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}

    {/* Dialog and Preview Modal */}
    <Dialog open={showAddDialog} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className={editingCredential ? "max-w-2xl max-h-[90vh] overflow-y-auto" : "max-w-md"}>
          <DialogHeader>
            <DialogTitle>{editingCredential ? 'Edit Credential' : 'Add Doctor Credential'}</DialogTitle>
            {editingCredential && selectedDefinition && (
              <p className="text-sm text-slate-600 mt-1">Update attribute value and details</p>
            )}
          </DialogHeader>

          <div className={editingCredential ? "space-y-6" : "space-y-4"}>
            {/* Edit Mode: Show Status and Existing Documents */}
            {editingCredential && selectedDefinition && (
              <div className="bg-brand-50 p-4 rounded-lg border border-brand-50 space-y-4">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="font-semibold text-slate-900">{selectedDefinition.label}</p>
                    <p className="text-sm text-slate-600">Updating {selectedDefinition.label}</p>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-medium text-white ${
                    editingCredential.verification_status === 'verified' || editingCredential.verification_status === 'verified_by_doc'
                      ? 'bg-green-500'
                      : editingCredential.verification_status === 'unverified'
                      ? 'bg-brand-500'
                      : 'bg-yellow-500'
                  }`}>
                    {editingCredential.verification_status === 'verified_by_doc' ? 'Verified' : editingCredential.verification_status.charAt(0).toUpperCase() + editingCredential.verification_status.slice(1)}
                  </span>
                </div>

                {/* Existing Documents Section */}
                {editingCredential.documents && editingCredential.documents.length > 0 && (
                  <div className="border-t border-brand-50 pt-4">
                    <p className="text-sm font-semibold text-slate-700 mb-3">Linked Documents ({editingCredential.documents.length})</p>
                    <div className="space-y-2">
                      {editingCredential.documents.map((doc, idx) => (
                        <div key={idx} className="flex items-center justify-between p-2 bg-white rounded border border-brand-50">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            {doc.isPrimary && <span className="text-yellow-500">★</span>}
                            <File className="h-4 w-4 text-slate-500 flex-shrink-0" />
                            <span className="text-sm text-slate-700 truncate">{doc.fileName || 'Document'}</span>
                          </div>
                          <button
                            onClick={() => {
                              const updatedDocs = (editingCredential.documents || []).filter((_, i) => i !== idx);
                              setEditingCredential({ ...editingCredential, documents: updatedDocs });
                              toast.success('Document removed');
                            }}
                            className="p-1 hover:bg-red-100 rounded transition"
                            title="Remove document"
                          >
                            <Trash2 className="h-4 w-4 text-red-600" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {!selectedDefinition ? (
              <div className="space-y-2">
                <Label htmlFor="credential-type">Select Credential Type *</Label>
                <select
                  id="credential-type"
                  className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 bg-white"
                  onChange={(e) => {
                    const def = definitions.find((d) => d.key === e.target.value);
                    if (def) handleSelectDefinition(def);
                  }}
                  defaultValue=""
                >
                  <option value="">Select a credential...</option>
                  {definitions.map((def) => (
                    <option key={def.key} value={def.key}>
                      {def.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <>
                <div>
                  <Label className="text-sm text-slate-600">Selected Credential</Label>
                  <p className="font-medium text-slate-900">{selectedDefinition.label}</p>
                  {selectedDefinition.description && (
                    <p className="text-xs text-slate-600 mt-1">
                      {selectedDefinition.description}
                    </p>
                  )}
                </div>

                {console.log('Data type for', selectedDefinition.label, ':', selectedDefinition.data_type)}

                {selectedDefinition.data_type === 'text' && (
                  <div className="space-y-2">
                    <Label htmlFor="value-text">{selectedDefinition.label} *</Label>
                    <Input
                      id="value-text"
                      type="text"
                      value={formData.valueText}
                      onChange={(e) => handleInputChange('valueText', e.target.value)}
                      placeholder={selectedDefinition.description || 'Enter value'}
                      disabled={isSaving}
                    />
                  </div>
                )}

                {selectedDefinition.data_type === 'date' && (
                  <div className="space-y-2">
                    <Label htmlFor="value-date">{selectedDefinition.label} *</Label>
                    <Input
                      id="value-date"
                      type="date"
                      value={formData.valueDate}
                      onChange={(e) => handleInputChange('valueDate', e.target.value)}
                      disabled={isSaving}
                    />
                  </div>
                )}

                {selectedDefinition.data_type === 'boolean' && (
                  <div className="space-y-3">
                    <Label>{selectedDefinition.label} *</Label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="value-boolean"
                          checked={formData.valueBoolean === true}
                          onChange={() => handleInputChange('valueBoolean', true)}
                          disabled={isSaving}
                        />
                        Yes
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="value-boolean"
                          checked={formData.valueBoolean === false}
                          onChange={() => handleInputChange('valueBoolean', false)}
                          disabled={isSaving}
                        />
                        No
                      </label>
                    </div>
                  </div>
                )}

                {selectedDefinition.data_type === 'textarea' && (
                  <div className="space-y-2">
                    <Label htmlFor="value-textarea">{selectedDefinition.label} *</Label>
                    <textarea
                      id="value-textarea"
                      value={formData.valueText}
                      onChange={(e) => handleInputChange('valueText', e.target.value)}
                      placeholder={selectedDefinition.description || 'Enter details'}
                      disabled={isSaving}
                      rows={4}
                      className="w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-brand-600 resize-none"
                    />
                  </div>
                )}

                {(selectedDefinition.data_type === 'document' || selectedDefinition.requires_document) && (
                  <div className="space-y-2">
                    <Label htmlFor="document-file">
                      {editingCredential ? 'Add Documents/Images' : `Upload ${selectedDefinition.label}`}
                    </Label>
                    <Input
                      id="document-file"
                      type="file"
                      onChange={handleFileChange}
                      disabled={isSaving}
                      accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                      multiple
                    />
                    <p className="text-xs text-slate-600">
                      {editingCredential ? 'Upload new documents to add to this attribute - Select multiple files' : 'You can select multiple files'}
                    </p>

                    {selectedFiles.length > 0 && (
                      <div className="p-2 bg-brand-50 rounded-md space-y-2 max-h-40 overflow-y-auto">
                        <p className="text-xs font-semibold text-slate-700">
                          Selected Files ({selectedFiles.length})
                        </p>
                        {selectedFiles.map((file, index) => (
                          <div
                            key={`${file.name}-${index}`}
                            className="flex items-center justify-between p-1.5 bg-white rounded border border-slate-200 gap-2"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium break-words text-slate-900">
                                {file.name}
                              </p>
                              <p className="text-xs text-slate-500">
                                {(file.size / 1024).toFixed(0)} KB
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemovePendingFile(index)}
                              className="text-red-600 hover:bg-red-50 h-6 px-2"
                            >
                              ✕
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {(selectedDefinition.category === 'licenses' ||
                  selectedDefinition.category === 'qualifications') && (
                  <div className="border-t pt-4">
                    <h4 className="text-sm font-medium text-slate-700 mb-3">
                      Certificate Details
                    </h4>

                    <div className="space-y-2">
                      <Label htmlFor="cert-number">Certificate Number</Label>
                      <Input
                        id="cert-number"
                        value={formData.certificateNumber}
                        onChange={(e) =>
                          handleInputChange('certificateNumber', e.target.value)
                        }
                        placeholder="Certificate/License number"
                        disabled={isSaving}
                      />
                    </div>

                    <div className="space-y-2 mt-3">
                      <Label htmlFor="issuing-auth">Issuing Authority</Label>
                      <Input
                        id="issuing-auth"
                        value={formData.issuingAuthority}
                        onChange={(e) =>
                          handleInputChange('issuingAuthority', e.target.value)
                        }
                        placeholder="e.g., Medical Council"
                        disabled={isSaving}
                      />
                    </div>

                    <div className="space-y-2 mt-3">
                      <Label htmlFor="issued-at">Issued Date</Label>
                      <Input
                        id="issued-at"
                        type="date"
                        value={formData.issuedAt}
                        onChange={(e) => handleInputChange('issuedAt', e.target.value)}
                        disabled={isSaving}
                      />
                    </div>
                  </div>
                )}

                {selectedDefinition.has_expiry && (
                  <div className="space-y-2">
                    <Label htmlFor="expires-at">Expiry Date</Label>
                    <Input
                      id="expires-at"
                      type="date"
                      value={formData.expiresAt}
                      onChange={(e) => handleInputChange('expiresAt', e.target.value)}
                      disabled={isSaving}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex gap-3 justify-end pt-4 border-t">
            <Button
              variant="outline"
              onClick={closeDialog}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveCredential}
              disabled={!selectedDefinition || isSaving}
              className="gap-2 bg-brand-600 hover:bg-brand-700 text-white"
            >
              {isSaving ? (
                <>
                  <Loader className="h-4 w-4 animate-spin" />
                  {editingCredential ? 'Updating...' : 'Saving...'}
                </>
              ) : (
                editingCredential ? 'Update Credential' : 'Add Credential'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* File Preview Modal */}
      {previewFile && (
        <FilePreviewModal
          open={showPreviewModal}
          onOpenChange={setShowPreviewModal}
          fileName={previewFile.fileName}
          mimeType={previewFile.mimeType}
          fileData={previewFile.fileData}
          onDownload={handleDownloadFile}
        />
      )}
    </div>
  );
};
