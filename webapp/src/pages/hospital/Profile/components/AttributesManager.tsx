import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, Plus, Check, X, Clock, Loader, Trash2, FileText, Eye, Download, Star } from 'lucide-react';
import ApiService from '@/services/api';
import FilePreviewModal from '@/components/FilePreviewModal';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AttributesManagerProps {
  hospitalId: string;
}

interface AttributeDocument {
  id: string; // junction table ID
  documentId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  isPrimary: boolean;
}

interface Attribute {
  id: string;
  attributeKey: string;
  hospital_id: string;
  value?: any; // Computed value from backend
  value_text?: string;
  value_boolean?: boolean;
  value_integer?: number;
  value_date?: string;
  documentId?: string; // UUID reference to document (deprecated, use documents array)
  document_id?: string;
  documents?: AttributeDocument[]; // Multiple documents per attribute
  expiresAt?: string; // API returns camelCase from backend
  expires_at?: string; // Fallback for snake_case
  certificateNumber?: string;
  certificate_number?: string;
  issuingAuthority?: string;
  issuing_authority?: string;
  issueDate?: string; // API returns camelCase from backend
  issued_at?: string; // Fallback for snake_case
  verificationStatus: 'unverified' | 'verified' | 'rejected' | 'pending';
  verification_method?: string;
  verified_by?: string;
  verified_at?: string;
  verificationNotes?: string;
  verification_notes?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  label?: string;
  category?: string;
  data_type?: string;
  dataType?: string; // API returns camelCase
  definition?: {
    key: string;
    label: string;
    description: string;
    data_type: string;
    category: string;
  };
}

export default function AttributesManager({ hospitalId }: AttributesManagerProps) {
  const [attributes, setAttributes] = useState<Attribute[]>([]);
  const [definitions, setDefinitions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showVerifyDialog, setShowVerifyDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewFile, setPreviewFile] = useState<{
    fileName: string;
    mimeType: string;
    documentId?: string;
  } | null>(null);
  const [deleteAttributeKey, setDeleteAttributeKey] = useState<string>('');
  const [editingAttribute, setEditingAttribute] = useState<Attribute | null>(null);
  const [selectedAttribute, setSelectedAttribute] = useState<Attribute | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [editDialogDocuments, setEditDialogDocuments] = useState<AttributeDocument[]>([]);
  const [isDeletingDocument, setIsDeletingDocument] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState({
    attributeKey: '',
    value: '',
    documentId: '',
    certificateNumber: '',
    issueDate: '',
    expiresAt: '',
    issuingAuthority: '',
  });

  const [verifyData, setVerifyData] = useState({
    method: 'manual',
    notes: '',
  });

  useEffect(() => {
    fetchData();
  }, [hospitalId]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [attrRes, defRes] = await Promise.all([
        ApiService.getHospitalAttributes(hospitalId),
        ApiService.getAttributeDefinitions(),
      ]);
      setAttributes(attrRes.data.data || []);
      setDefinitions(defRes.data.data || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load attributes');
    } finally {
      setLoading(false);
    }
  };

  const getSelectedDefinition = () => {
    return definitions.find(d => d.key === formData.attributeKey);
  };

  // Get only attributes that haven't been added yet
  const getAvailableDefinitions = () => {
    const addedKeys = attributes.map(a => a.attributeKey);
    return definitions.filter(d => !addedKeys.includes(d.key));
  };

  // Check if certificate details section should be shown (only if there's data to display)
  const hasCertificateData = (attr: Attribute) => {
    return !!(
      attr.certificateNumber ||
      attr.issuingAuthority ||
      attr.issueDate ||
      attr.expiresAt ||
      attr.issued_at ||
      attr.expires_at
    );
  };

  const uploadAttributeDocument = async (file: File): Promise<string> => {
    const definition = getSelectedDefinition();

    const formDataObj = new FormData();
    formDataObj.append('file', file);
    formDataObj.append('documentName', file.name);
    formDataObj.append('documentCategory', definition?.category || 'attributes');
    formDataObj.append('documentType', 'attribute_document');
    formDataObj.append('attributeKey', formData.attributeKey);

    const response = await ApiService.uploadDocument(hospitalId, formDataObj);
    const documentId = response.data.data?.id;

    if (!documentId) {
      throw new Error('No document ID returned from upload');
    }

    return documentId;
  };

  const uploadMultipleDocuments = async (files: File[]): Promise<string[]> => {
    const documentIds: string[] = [];

    for (const file of files) {
      try {
        const documentId = await uploadAttributeDocument(file);
        documentIds.push(documentId);
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || `Failed to upload ${file.name}`;
        setError(errorMsg);
        throw new Error(errorMsg);
      }
    }

    return documentIds;
  };

  const handleAddFileToPending = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      // Add new files to the pending list
      setSelectedFiles([...selectedFiles, ...files]);
      // Reset the input so the same file can be selected again
      e.target.value = '';
    }
  };

  const handleRemovePendingFile = (index: number) => {
    setSelectedFiles(selectedFiles.filter((_, i) => i !== index));
  };

  const handleAddAttribute = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setUploadLoading(true);

      const definition = getSelectedDefinition();
      if (!definition) {
        setError('Selected attribute definition not found');
        return;
      }

      let documentId = formData.documentId;
      const documentIds: string[] = [];

      // Upload multiple files if selected
      if (selectedFiles.length > 0) {
        try {
          const uploadedIds = await uploadMultipleDocuments(selectedFiles);
          documentIds.push(...uploadedIds);
          // Use the first uploaded document as the primary
          documentId = uploadedIds[0];
          console.log('Documents uploaded, IDs:', uploadedIds);
        } catch (err: any) {
          setError(err.message || 'Failed to upload documents');
          return;
        }
      }

      // Prepare the payload with correct field name based on data type
      const payload: any = {
        documentId: documentId || undefined,
        certificateNumber: formData.certificateNumber || undefined,
        issueDate: formData.issueDate || undefined,
        expiresAt: formData.expiresAt || undefined,
        issuingAuthority: formData.issuingAuthority || undefined,
      };

      // Set value in the correct field based on data type
      switch (definition.data_type) {
        case 'boolean':
          payload.valueBoolean = formData.value === 'true' ? true : formData.value === 'false' ? false : null;
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
          // For document type, value is stored in document, not in value fields
          payload.valueText = formData.value || null;
          break;
        default:
          payload.valueText = formData.value || null;
      }

      console.log('Sending setAttribute payload:', payload);
      await ApiService.setAttribute(hospitalId, formData.attributeKey, payload);

      // Link additional documents to the attribute (if multiple)
      if (documentIds.length > 1) {
        try {
          for (let i = 1; i < documentIds.length; i++) {
            await ApiService.addDocumentToAttribute(hospitalId, formData.attributeKey, documentIds[i]);
          }
        } catch (err: any) {
          console.error('Failed to link additional documents:', err);
          // Continue anyway - primary document is linked
        }
      }

      setShowAddDialog(false);
      setFormData({
        attributeKey: '',
        value: '',
        documentId: '',
        certificateNumber: '',
        issueDate: '',
        expiresAt: '',
        issuingAuthority: '',
      });
      setSelectedFiles([]);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to add attribute');
    } finally {
      setLoading(false);
      setUploadLoading(false);
    }
  };

  const handleUpdateAttribute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAttribute) return;

    try {
      setLoading(true);
      setUploadLoading(true);

      const definition = getSelectedDefinition();
      if (!definition) {
        setError('Selected attribute definition not found');
        return;
      }

      let documentId = formData.documentId;
      const documentIds: string[] = [];

      // Upload multiple files if selected
      if (selectedFiles.length > 0) {
        try {
          const uploadedIds = await uploadMultipleDocuments(selectedFiles);
          documentIds.push(...uploadedIds);
          console.log('Documents uploaded, IDs:', uploadedIds);
        } catch (err: any) {
          setError(err.message || 'Failed to upload documents');
          return;
        }
      }

      // Prepare the payload
      const payload: any = {
        documentId: documentId || undefined,
        certificateNumber: formData.certificateNumber || undefined,
        issueDate: formData.issueDate || undefined,
        expiresAt: formData.expiresAt || undefined,
        issuingAuthority: formData.issuingAuthority || undefined,
      };

      // Set value based on data type
      switch (definition.data_type) {
        case 'boolean':
          payload.valueBoolean = formData.value === 'true' ? true : formData.value === 'false' ? false : null;
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

      await ApiService.updateAttribute(hospitalId, editingAttribute.attributeKey, payload);

      // Link additional documents to the attribute (if multiple)
      if (documentIds.length > 0) {
        try {
          for (const docId of documentIds) {
            await ApiService.addDocumentToAttribute(hospitalId, editingAttribute.attributeKey, docId);
          }
        } catch (err: any) {
          console.error('Failed to link additional documents:', err);
          // Continue anyway - attribute is updated
        }
      }

      setShowEditDialog(false);
      setEditingAttribute(null);
      setFormData({
        attributeKey: '',
        value: '',
        documentId: '',
        certificateNumber: '',
        issueDate: '',
        expiresAt: '',
        issuingAuthority: '',
      });
      setSelectedFiles([]);
      setEditDialogDocuments([]);
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update attribute');
    } finally {
      setLoading(false);
      setUploadLoading(false);
    }
  };

  const handleDeleteDocumentFromAttribute = async (doc: AttributeDocument) => {
    if (!editingAttribute || !window.confirm('Are you sure you want to remove this document from the attribute?')) {
      return;
    }

    try {
      setIsDeletingDocument(true);
      await ApiService.removeDocumentFromAttribute(
        hospitalId,
        editingAttribute.attributeKey,
        doc.documentId
      );
      setEditDialogDocuments(editDialogDocuments.filter(d => d.id !== doc.id));
    } catch (err: any) {
      console.error('Delete error:', err);
      setError('Failed to remove document from attribute');
    } finally {
      setIsDeletingDocument(false);
    }
  };

  const handleVerifyAttribute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAttribute) return;

    try {
      setLoading(true);
      await ApiService.verifyAttribute(
        hospitalId,
        selectedAttribute.attributeKey,
        verifyData.method,
        verifyData.notes
      );
      setShowVerifyDialog(false);
      setSelectedAttribute(null);
      setVerifyData({ method: 'manual', notes: '' });
      await fetchData();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to verify attribute');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAttribute = async () => {
    if (!deleteAttributeKey) {
      console.warn('No deleteAttributeKey set');
      return;
    }

    console.log('Delete triggered for:', deleteAttributeKey);

    try {
      setDeleteLoading(true);
      setError(null);
      console.log('Calling deleteAttribute API...');
      const response = await ApiService.deleteAttribute(hospitalId, deleteAttributeKey);
      console.log('Delete response:', response);
      await fetchData();
      setShowDeleteDialog(false);
      setDeleteAttributeKey('');
    } catch (err: any) {
      const errorMessage = err.response?.data?.message || err.message || 'Failed to delete attribute';
      console.error('Delete error:', err);
      setError(errorMessage);
      setShowDeleteDialog(false);
    } finally {
      setDeleteLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'verified':
        return <div className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-sm"><Check className="h-4 w-4" /> Verified</div>;
      case 'rejected':
        return <div className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 rounded text-sm"><X className="h-4 w-4" /> Rejected</div>;
      default:
        return <div className="inline-flex items-center gap-1 px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-sm"><Clock className="h-4 w-4" /> Pending</div>;
    }
  };

  const getAttributeDefinition = (attributeKey: string) => {
    return definitions.find(d => d.key === attributeKey);
  };

  const toTitleCase = (str: string) => {
    if (str === 'all') return 'All';
    return str
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  // Helper function to render formatted attribute value
  const renderAttributeValue = (attr: Attribute) => {
    // For document-type attributes with certificate number, show the certificate number as value
    if (attr.dataType === 'document' && (attr.certificateNumber || attr.certificate_number)) {
      return <span className="font-mono text-sm">{attr.certificateNumber || attr.certificate_number}</span>;
    }

    if (attr.value === null || attr.value === undefined) {
      return <span className="text-gray-400">Not Set</span>;
    }

    switch (attr.dataType) {
      case 'boolean':
        if (attr.value === true) {
          return (
            <span className="inline-flex items-center gap-1 text-green-600">
              <Check className="h-4 w-4" />
              Yes
            </span>
          );
        } else if (attr.value === false) {
          return (
            <span className="inline-flex items-center gap-1 text-red-600">
              <X className="h-4 w-4" />
              No
            </span>
          );
        }
        return <span className="text-gray-400">Not Set</span>;
      case 'integer':
        return <span>{attr.value}</span>;
      case 'date':
        return <span>{new Date(attr.value).toLocaleDateString()}</span>;
      case 'document':
        return <span>{attr.value ? attr.value.toString() : 'Stored'}</span>;
      default:
        return <span>{attr.value.toString()}</span>;
    }
  };

  // Helper functions to determine what fields to show
  const shouldShowCertificateFields = (attr: Attribute) => {
    const attrDef = getAttributeDefinition(attr.attributeKey);
    // Only show certificate section for document types AND if there's actual certificate data
    return (attrDef?.data_type === 'document' || attrDef?.requires_document) && hasCertificateData(attr);
  };

  const shouldShowExpiryDate = (attr: Attribute) => {
    const attrDef = getAttributeDefinition(attr.attributeKey);
    return (attrDef?.has_expiry || attrDef?.data_type === 'document') && (attr.expiresAt || attr.expires_at);
  };

  const shouldShowDocumentSection = (attr: Attribute) => {
    const attrDef = getAttributeDefinition(attr.attributeKey);
    return attrDef?.data_type === 'document' || attrDef?.requires_document;
  };

  const getFilteredAttributes = () => {
    if (selectedCategory === 'all') return attributes;
    return attributes.filter(
      attr => attr.category === selectedCategory
    );
  };

  const categories = ['all', ...Array.from(new Set(definitions.map(d => d.category)))];

  if (loading && !attributes.length) {
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
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              {error}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Hospital Attributes</CardTitle>
              <CardDescription>Manage hospital certifications and attributes</CardDescription>
            </div>
            <Button onClick={() => setShowAddDialog(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Add Attribute
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Category Filter */}
          <div className="flex gap-2 flex-wrap">
            {categories.map(cat => (
              <Button
                key={cat}
                variant={selectedCategory === cat ? 'default' : 'outline'}
                onClick={() => setSelectedCategory(cat)}
                size="sm"
              >
                {toTitleCase(cat)}
              </Button>
            ))}
          </div>

          {/* Attributes List */}
          {filteredAttributes.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No attributes found in this category
            </div>
          ) : (
            <div className="space-y-3">
              {filteredAttributes.map(attr => {
                const attrDef = getAttributeDefinition(attr.attributeKey);
                return (
                <div key={attr.id} className="p-4 border rounded-lg space-y-2">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="font-semibold">{attr.label || attrDef?.label || attr.attributeKey}</h4>
                        {attr.documents && attr.documents.length > 0 && (
                          <span className="inline-block bg-blue-100 text-blue-800 text-xs font-medium px-2 py-0.5 rounded">
                            {attr.documents.length} {attr.documents.length === 1 ? 'doc' : 'docs'}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-600">{attrDef?.description}</p>
                    </div>
                    {getStatusBadge(attr.verificationStatus)}
                  </div>

                  {/* Basic Information */}
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-gray-600">Value: </span>
                        <span className="font-medium">{renderAttributeValue(attr)}</span>
                      </div>
                    </div>

                    {/* Certificate Information - for document-type attributes */}
                    {shouldShowCertificateFields(attr) && (
                      <div className="pt-2 border-t">
                        <p className="text-xs font-semibold text-gray-700 mb-2">Certificate Details</p>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          {attr.certificate_number && (
                            <div>
                              <span className="text-gray-600">Certificate #: </span>
                              <span className="font-medium">{attr.certificate_number}</span>
                            </div>
                          )}
                          {attr.issuing_authority && (
                            <div>
                              <span className="text-gray-600">Authority: </span>
                              <span className="font-medium">{attr.issuing_authority}</span>
                            </div>
                          )}
                          {(attr.issueDate || attr.issued_at) && (
                            <div>
                              <span className="text-gray-600">Issued: </span>
                              <span className="font-medium">{new Date(attr.issueDate || attr.issued_at!).toLocaleDateString()}</span>
                            </div>
                          )}
                          {shouldShowExpiryDate(attr) && (
                            <div>
                              <span className="text-gray-600">Expires: </span>
                              <span className={`font-medium ${
                                (attr.expiresAt || attr.expires_at) && new Date(attr.expiresAt || attr.expires_at!) < new Date()
                                  ? 'text-red-600'
                                  : 'text-gray-900'
                              }`}>
                                {(attr.expiresAt || attr.expires_at) ? new Date(attr.expiresAt || attr.expires_at!).toLocaleDateString() : 'N/A'}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Document Section - for document type attributes */}
                    {shouldShowDocumentSection(attr) && (
                      <div className="pt-2 border-t">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-gray-700">
                            Documents
                            {attr.documents && attr.documents.length > 0 && (
                              <span className="ml-2 inline-block bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded">
                                {attr.documents.length}
                              </span>
                            )}
                          </p>
                        </div>

                        {attr.documents && attr.documents.length > 0 ? (
                          <div className="space-y-3">
                            {attr.documents.map((doc) => (
                              <div key={doc.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded border border-gray-200">
                                {doc.isPrimary && (
                                  <span title="Primary document" className="text-yellow-500">
                                    <svg className="h-4 w-4 fill-current" viewBox="0 0 20 20">
                                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                    </svg>
                                  </span>
                                )}
                                <FileText className="h-4 w-4 text-gray-400" />
                                <span className="flex-1 text-sm text-gray-700 truncate">{doc.fileName}</span>
                                <div className="flex gap-1">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={async () => {
                                      try {
                                        setPreviewFile({
                                          fileName: doc.fileName,
                                          mimeType: doc.mimeType,
                                          documentId: doc.documentId,
                                        });
                                        setShowPreviewModal(true);
                                      } catch (err) {
                                        console.error('Failed to preview document:', err);
                                        alert('Failed to load preview');
                                      }
                                    }}
                                    className="gap-1"
                                    title="Preview document"
                                  >
                                    <Eye className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
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
                                        link.parentNode?.removeChild(link);
                                        window.URL.revokeObjectURL(url);
                                      } catch (err) {
                                        console.error('Failed to download document:', err);
                                        alert('Failed to download document');
                                      }
                                    }}
                                    className="gap-1"
                                    title="Download document"
                                  >
                                    <Download className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-500">No documents uploaded</p>
                        )}
                      </div>
                    )}

                    {/* Verification Information */}
                    {attr.verified_at && (
                      <div className="pt-2 border-t">
                        <p className="text-xs font-semibold text-gray-700 mb-2">Verification</p>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <span className="text-gray-600">Verified: </span>
                            <span className="font-medium">{new Date(attr.verified_at).toLocaleDateString()}</span>
                          </div>
                          {attr.verification_method && (
                            <div>
                              <span className="text-gray-600">Method: </span>
                              <span className="font-medium capitalize">{attr.verification_method}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex gap-2 pt-2">
                    {attr.verificationStatus === 'pending' && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSelectedAttribute(attr);
                            setShowVerifyDialog(true);
                          }}
                          className="gap-1"
                        >
                          <Check className="h-4 w-4" />
                          Verify
                        </Button>
                      </>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setEditingAttribute(attr);
                          setEditDialogDocuments(attr.documents || []);
                          // Get issue date - handle both ISO and other formats
                          let issueDateStr = '';
                          const issueDate = attr.issueDate || attr.issued_at;
                          if (issueDate) {
                            try {
                              issueDateStr = new Date(issueDate).toISOString().split('T')[0];
                            } catch (e) {
                              issueDateStr = issueDate;
                            }
                          }

                          // Get expiry date - handle both ISO and other formats
                          let expiryDateStr = '';
                          const expiryDate = attr.expiresAt || attr.expires_at;
                          if (expiryDate) {
                            try {
                              expiryDateStr = new Date(expiryDate).toISOString().split('T')[0];
                            } catch (e) {
                              expiryDateStr = expiryDate;
                            }
                          }

                          setFormData({
                            attributeKey: attr.attributeKey,
                            value: attr.value ? attr.value.toString() : '',
                            documentId: attr.documentId || attr.document_id || '',
                            certificateNumber: attr.certificateNumber || attr.certificate_number || '',
                            issueDate: issueDateStr,
                            expiresAt: expiryDateStr,
                            issuingAuthority: (attr.issuingAuthority || attr.issuing_authority || '').trim(),
                          });
                          setShowEditDialog(true);
                        }}
                        className="gap-1"
                      >
                        ✎ Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          console.log('Full attribute object:', attr);
                          console.log('Delete button clicked for attribute:', attr.attributeKey);
                          setDeleteAttributeKey(attr.attributeKey);
                          setShowDeleteDialog(true);
                          console.log('Dialog and key set');
                        }}
                        className="gap-1 text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Attribute Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Attribute</DialogTitle>
            <DialogDescription>Add a new attribute to your hospital profile</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleAddAttribute} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="attributeKey">Attribute *</Label>
              <select
                id="attributeKey"
                value={formData.attributeKey}
                onChange={(e) => setFormData({ ...formData, attributeKey: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
                required
              >
                <option value="">Select Attribute</option>
                {getAvailableDefinitions().map(def => (
                  <option key={def.key} value={def.key}>
                    {def.label}
                  </option>
                ))}
              </select>
            </div>

            {formData.attributeKey && getSelectedDefinition() && (
              <>
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-md text-sm text-blue-700 dark:text-blue-300">
                  <p className="font-medium">{getSelectedDefinition()?.label}</p>
                  <p className="text-xs opacity-75">{getSelectedDefinition()?.description}</p>
                </div>

                {getSelectedDefinition()?.data_type === 'boolean' && !getSelectedDefinition()?.requires_document ? (
                  <div className="space-y-2">
                    <Label htmlFor="value">Status *</Label>
                    <select
                      id="value"
                      value={formData.value}
                      onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
                      required
                    >
                      <option value="">Select</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </div>
                ) : getSelectedDefinition()?.data_type === 'integer' ? (
                  <div className="space-y-2">
                    <Label htmlFor="value">
                      {getSelectedDefinition()?.label} *
                    </Label>
                    <Input
                      id="value"
                      type="number"
                      value={formData.value}
                      onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                      placeholder={`Enter ${getSelectedDefinition()?.label?.toLowerCase()}`}
                      required
                    />
                  </div>
                ) : getSelectedDefinition()?.data_type === 'date' ? (
                  <div className="space-y-2">
                    <Label htmlFor="value">
                      {getSelectedDefinition()?.label} *
                    </Label>
                    <Input
                      id="value"
                      type="date"
                      value={formData.value}
                      onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                      required
                    />
                  </div>
                ) : getSelectedDefinition()?.data_type === 'boolean' && getSelectedDefinition()?.requires_document ? (
                  <div className="space-y-2">
                    <Label htmlFor="value">Status *</Label>
                    <select
                      id="value"
                      value={formData.value}
                      onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
                      required
                    >
                      <option value="">Select</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </div>
                ) : null}

                {(getSelectedDefinition()?.data_type === 'document' || getSelectedDefinition()?.requires_document) && (
                  <div className="space-y-2">
                    <Label htmlFor="documentFile">Upload Documents/Images</Label>
                    <Input
                      id="documentFile"
                      type="file"
                      ref={fileInputRef}
                      onChange={handleAddFileToPending}
                      accept="image/*,.pdf,.doc,.docx"
                    />
                    <p className="text-xs text-gray-500">Accepted: Images (JPG, PNG), PDF, DOC, DOCX - Select multiple files</p>

                    {/* Pending Files List */}
                    {selectedFiles.length > 0 && (
                      <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-md space-y-2 max-h-40 overflow-y-auto">
                        <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                          Pending Uploads ({selectedFiles.length})
                        </p>
                        {selectedFiles.map((file, index) => (
                          <div key={`${file.name}-${index}`} className="flex items-start justify-between p-1.5 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium break-words text-gray-900 dark:text-white">{file.name}</p>
                              <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(0)} KB</p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => handleRemovePendingFile(index)}
                              className="text-red-600 hover:text-red-700 flex-shrink-0 mt-0.5"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {getSelectedDefinition()?.data_type === 'document' && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="certificateNumber">Certificate Number</Label>
                      <Input
                        id="certificateNumber"
                        value={formData.certificateNumber}
                        onChange={(e) => setFormData({ ...formData, certificateNumber: e.target.value })}
                        placeholder="e.g., CERT-2024-001"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="issueDate">Issue Date</Label>
                      <Input
                        id="issueDate"
                        type="date"
                        value={formData.issueDate}
                        onChange={(e) => setFormData({ ...formData, issueDate: e.target.value })}
                      />
                    </div>

                    {getSelectedDefinition()?.has_expiry && (
                      <div className="space-y-2">
                        <Label htmlFor="expiresAt">Expiration Date</Label>
                        <Input
                          id="expiresAt"
                          type="date"
                          value={formData.expiresAt}
                          onChange={(e) => setFormData({ ...formData, expiresAt: e.target.value })}
                        />
                      </div>
                    )}

                    {getSelectedDefinition()?.expected_issuing_authority && (
                      <div className="space-y-2">
                        <Label htmlFor="issuingAuthority">Issuing Authority</Label>
                        <Input
                          id="issuingAuthority"
                          value={formData.issuingAuthority}
                          onChange={(e) => setFormData({ ...formData, issuingAuthority: e.target.value })}
                          placeholder={getSelectedDefinition()?.expected_issuing_authority}
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={loading || uploadLoading} className="flex-1">
                {uploadLoading ? 'Uploading...' : loading ? 'Adding...' : 'Add Attribute'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowAddDialog(false);
                  setSelectedFiles([]);
                }}
                disabled={loading || uploadLoading}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Attribute Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Attribute</DialogTitle>
            <DialogDescription>Update attribute value and details</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleUpdateAttribute} className="space-y-4">
            {editingAttribute && (
              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-md text-sm text-blue-700 dark:text-blue-300">
                <p className="font-medium">{editingAttribute.label}</p>
                <p className="text-xs opacity-75">Updating {editingAttribute.label}</p>
              </div>
            )}

            {getSelectedDefinition()?.data_type === 'boolean' && !getSelectedDefinition()?.requires_document ? (
              <div className="space-y-2">
                <Label htmlFor="edit-value">Status *</Label>
                <select
                  id="edit-value"
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
                  required
                >
                  <option value="">Select</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            ) : getSelectedDefinition()?.data_type === 'integer' ? (
              <div className="space-y-2">
                <Label htmlFor="edit-value">{getSelectedDefinition()?.label} *</Label>
                <Input
                  id="edit-value"
                  type="number"
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  required
                />
              </div>
            ) : getSelectedDefinition()?.data_type === 'date' ? (
              <div className="space-y-2">
                <Label htmlFor="edit-value">{getSelectedDefinition()?.label} *</Label>
                <Input
                  id="edit-value"
                  type="date"
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  required
                />
              </div>
            ) : getSelectedDefinition()?.data_type === 'boolean' && getSelectedDefinition()?.requires_document ? (
              <div className="space-y-2">
                <Label htmlFor="edit-value">Status *</Label>
                <select
                  id="edit-value"
                  value={formData.value}
                  onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
                  required
                >
                  <option value="">Select</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            ) : null}

            {(getSelectedDefinition()?.data_type === 'document' || getSelectedDefinition()?.requires_document) && (
              <>
                {/* Existing Documents Section */}
                {editDialogDocuments.length > 0 && (
                  <div className="space-y-2 p-3 border rounded-md bg-gray-50 dark:bg-gray-900/20">
                    <div className="flex items-center justify-between mb-2">
                      <Label className="text-sm font-semibold">Linked Documents ({editDialogDocuments.length})</Label>
                    </div>
                    <div className="space-y-2">
                      {editDialogDocuments.map((doc) => (
                        <div key={doc.id} className="flex items-center justify-between p-2 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            {doc.isPrimary && (
                              <span title="Primary document">
                                <Star className="h-4 w-4 fill-yellow-400 text-yellow-400 flex-shrink-0" />
                              </span>
                            )}
                            <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate text-gray-900 dark:text-white">{doc.fileName}</p>
                              <p className="text-xs text-gray-500">{(doc.fileSize / 1024).toFixed(0)} KB</p>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDeleteDocumentFromAttribute(doc)}
                            disabled={isDeletingDocument || uploadLoading}
                            className="text-red-600 hover:text-red-700 flex-shrink-0"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Add New Document Section */}
                <div className="space-y-2">
                  <Label htmlFor="edit-document">Add Documents/Images</Label>
                  <Input
                    id="edit-document"
                    type="file"
                    onChange={handleAddFileToPending}
                    disabled={uploadLoading}
                  />
                  <p className="text-xs text-gray-500">
                    Upload new documents to add to this attribute - Select multiple files
                  </p>

                  {/* Pending Files List */}
                  {selectedFiles.length > 0 && (
                    <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-md space-y-2 max-h-40 overflow-y-auto">
                      <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                        Pending Uploads ({selectedFiles.length})
                      </p>
                      {selectedFiles.map((file, index) => (
                        <div key={`${file.name}-${index}`} className="flex items-start justify-between p-1.5 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium break-words text-gray-900 dark:text-white">{file.name}</p>
                            <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(0)} KB</p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => handleRemovePendingFile(index)}
                            disabled={uploadLoading}
                            className="text-red-600 hover:text-red-700 flex-shrink-0 mt-0.5"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {getSelectedDefinition()?.data_type === 'document' && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="edit-certificate-number">Certificate Number</Label>
                      <Input
                        id="edit-certificate-number"
                        value={formData.certificateNumber}
                        onChange={(e) => setFormData({ ...formData, certificateNumber: e.target.value })}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-issue-date">Issue Date</Label>
                        <Input
                          id="edit-issue-date"
                          type="date"
                          value={formData.issueDate}
                          onChange={(e) => setFormData({ ...formData, issueDate: e.target.value })}
                        />
                      </div>

                      {getSelectedDefinition()?.has_expiry && (
                        <div className="space-y-2">
                          <Label htmlFor="edit-expiry-date">Expiry Date</Label>
                          <Input
                            id="edit-expiry-date"
                            type="date"
                            value={formData.expiresAt}
                            onChange={(e) => setFormData({ ...formData, expiresAt: e.target.value })}
                          />
                        </div>
                      )}
                    </div>

                    {getSelectedDefinition()?.expected_issuing_authority && (
                      <div className="space-y-2">
                        <Label htmlFor="edit-issuing-authority">Issuing Authority</Label>
                        <Input
                          id="edit-issuing-authority"
                          value={formData.issuingAuthority}
                          onChange={(e) => setFormData({ ...formData, issuingAuthority: e.target.value })}
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={loading || uploadLoading} className="flex-1">
                {uploadLoading ? 'Uploading...' : loading ? 'Updating...' : 'Update Attribute'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowEditDialog(false);
                  setEditingAttribute(null);
                  setSelectedFiles([]);
                }}
                disabled={loading || uploadLoading}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Verify Attribute Dialog */}
      <Dialog open={showVerifyDialog} onOpenChange={setShowVerifyDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Verify Attribute</DialogTitle>
            <DialogDescription>Mark this attribute as verified</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleVerifyAttribute} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="method">Verification Method *</Label>
              <select
                id="method"
                value={verifyData.method}
                onChange={(e) => setVerifyData({ ...verifyData, method: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
                required
              >
                <option value="manual">Manual Review</option>
                <option value="document">Document Verification</option>
                <option value="image">Image Verification</option>
                <option value="automated">Automated Verification</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                value={verifyData.notes}
                onChange={(e) => setVerifyData({ ...verifyData, notes: e.target.value })}
                placeholder="Add verification notes..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                rows={3}
              />
            </div>

            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={loading} className="flex-1">
                {loading ? 'Verifying...' : 'Verify'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowVerifyDialog(false)}
                disabled={loading}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Attribute</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this attribute? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2 pt-4">
            <Button
              variant="destructive"
              onClick={handleDeleteAttribute}
              disabled={deleteLoading}
              className="flex-1"
            >
              {deleteLoading ? 'Deleting...' : 'Delete'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={deleteLoading}
              className="flex-1"
            >
              Cancel
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
          documentId={previewFile.documentId}
          hospitalId={hospitalId}
          onDownload={async () => {
            try {
              if (!previewFile.documentId) return;

              const docMetadata = await ApiService.getDocument(hospitalId, previewFile.documentId);
              const fileName = docMetadata.data?.fileName || docMetadata.data?.file_name || previewFile.fileName;

              const response = await ApiService.downloadDocument(hospitalId, previewFile.documentId);
              const mimeType = docMetadata.data?.mimeType || docMetadata.data?.mime_type || previewFile.mimeType;
              const blob = new Blob([response.data], { type: mimeType });
              const url = window.URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.setAttribute('download', fileName);
              document.body.appendChild(link);
              link.click();
              link.parentNode?.removeChild(link);
              window.URL.revokeObjectURL(url);
            } catch (err) {
              console.error('Download failed:', err);
              alert('Failed to download file');
            }
          }}
        />
      )}
    </div>
  );
}
