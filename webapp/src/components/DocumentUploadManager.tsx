import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertCircle, Upload, Trash2, Download, FileText, CheckCircle, X } from 'lucide-react';
import ApiService from '@/services/api';
import { useConfirm } from '@/lib/confirm';

interface DocumentUploadManagerProps {
  hospitalId: string;
  attributeKey?: string;
  onDocumentUploaded?: (document: any) => void;
}

interface Document {
  id: string;
  documentName: string;
  documentCategory: string;
  documentType: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  issueDate?: string;
  expiryDate?: string;
  createdAt: string;
  isPrimary?: boolean;
}

const DOCUMENT_CATEGORIES = [
  { value: 'certifications', label: 'Certifications' },
  { value: 'licenses', label: 'Licenses' },
  { value: 'registrations', label: 'Registrations' },
  { value: 'accreditations', label: 'Accreditations' },
  { value: 'insurance', label: 'Insurance Documents' },
  { value: 'compliance', label: 'Compliance Documents' },
  { value: 'other', label: 'Other' },
];

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export default function DocumentUploadManager({
  hospitalId,
  attributeKey,
  onDocumentUploaded
}: DocumentUploadManagerProps) {
  const confirm = useConfirm();
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isLinkingDocument, setIsLinkingDocument] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    documentName: '',
    documentCategory: 'certifications',
    documentType: '',
    issueDate: '',
    expiryDate: '',
    file: null as File | null,
  });

  // Fetch documents on mount
  React.useEffect(() => {
    fetchDocuments();
  }, [hospitalId, attributeKey]);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const response = await ApiService.getHospitalDocuments(
        hospitalId,
        formData.documentCategory,
        undefined,
        attributeKey
      );
      setDocuments(response.data.data || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      setError(`File size exceeds 100MB limit. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB`);
      return;
    }

    setFormData({ ...formData, file });
    setError(null);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.file) {
      setError('Please select a file');
      return;
    }

    if (!formData.documentName) {
      setError('Please enter a document name');
      return;
    }

    try {
      setUploading(true);
      setUploadProgress(0);

      const formDataToSend = new FormData();
      formDataToSend.append('file', formData.file);
      formDataToSend.append('documentName', formData.documentName);
      formDataToSend.append('documentCategory', formData.documentCategory);
      formDataToSend.append('documentType', formData.documentType);
      if (attributeKey) {
        formDataToSend.append('attributeKey', attributeKey);
      }
      if (formData.issueDate) {
        formDataToSend.append('issueDate', formData.issueDate);
      }
      if (formData.expiryDate) {
        formDataToSend.append('expiryDate', formData.expiryDate);
      }

      // Simulate progress (actual progress would come from axios interceptors)
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => Math.min(prev + 10, 90));
      }, 200);

      const response = await ApiService.uploadDocument(hospitalId, formDataToSend);

      clearInterval(progressInterval);
      setUploadProgress(100);

      // Add document to list
      setDocuments([response.data.data, ...documents]);
      setSuccess('Document uploaded successfully');

      // Reset form
      setFormData({
        documentName: '',
        documentCategory: 'certifications',
        documentType: '',
        issueDate: '',
        expiryDate: '',
        file: null,
      });
      setShowUploadDialog(false);

      if (onDocumentUploaded) {
        onDocumentUploaded(response.data.data);
      }

      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to upload document');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleDownload = async (documentId: string) => {
    try {
      const doc = documents.find(d => d.id === documentId);
      if (!doc) return;

      console.log('Downloading document:', doc);

      const response = await ApiService.downloadDocument(hospitalId, documentId);

      // Create blob with proper MIME type - axios with responseType: 'blob' returns a Blob
      // but we ensure the MIME type is correct by creating a new Blob with the stored MIME type
      const mimeType = doc.mimeType || 'application/octet-stream';
      const blob = new Blob([response.data], { type: mimeType });

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // Use original filename, fallback to document name with default extension
      const fileName = doc.fileName || `${doc.documentName}.pdf`;
      console.log('Using fileName:', fileName, 'with MIME type:', mimeType);
      link.setAttribute('download', fileName);
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
      window.URL.revokeObjectURL(url);

      setSuccess(`Downloaded: ${doc.documentName}`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      console.error('Download error:', err);
      setError('Failed to download document');
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!(await confirm({
      title: 'Delete document?',
      message: 'This action cannot be undone.',
      confirmText: 'Delete',
      destructive: true,
    }))) return;

    try {
      // If this is linked to an attribute, remove from attribute instead of deleting
      if (attributeKey) {
        await ApiService.removeDocumentFromAttribute(hospitalId, attributeKey, documentId);
        // Refetch documents to update the list
        await fetchDocuments();
        setSuccess('Document removed from attribute');
      } else {
        // Otherwise delete the document entirely
        await ApiService.deleteDocument(hospitalId, documentId);
        setDocuments(documents.filter(d => d.id !== documentId));
        setSuccess('Document deleted successfully');
      }
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      console.error('Delete error:', err);
      setError('Failed to delete document');
    }
  };

  const handleSetPrimary = async (documentId: string) => {
    if (!attributeKey) {
      setError('Cannot set primary: attribute key is required');
      return;
    }

    try {
      setIsLinkingDocument(true);
      await ApiService.setPrimaryDocument(hospitalId, attributeKey, documentId);
      // Refetch documents to update primary status
      await fetchDocuments();
      setSuccess('Document set as primary');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      console.error('Set primary error:', err);
      setError('Failed to set document as primary');
    } finally {
      setIsLinkingDocument(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '—';
    return new Date(dateString).toLocaleDateString();
  };

  const isExpired = (expiryDate?: string) => {
    if (!expiryDate) return false;
    return new Date(expiryDate) < new Date();
  };

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

      {success && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="h-5 w-5" />
              {success}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Documents & Certifications</CardTitle>
              <CardDescription>Upload and manage hospital documents</CardDescription>
            </div>
            <Button onClick={() => setShowUploadDialog(true)} className="gap-2">
              <Upload className="h-4 w-4" />
              Upload Document
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-slate-500">Loading documents...</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No documents uploaded yet</p>
              <p className="text-sm mt-1">Upload documents to support your attribute claims</p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map(doc => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-slate-50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {/* Primary document indicator */}
                      {doc.isPrimary && (
                        <span title="Primary document" className="text-yellow-500">
                          <svg className="h-5 w-5 fill-current" viewBox="0 0 20 20">
                            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                          </svg>
                        </span>
                      )}
                      <FileText className="h-4 w-4 text-slate-400" />
                      <h4 className="font-semibold text-slate-900 dark:text-slate-50">{doc.documentName}</h4>
                      {isExpired(doc.expiryDate) && (
                        <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded font-medium">
                          Expired
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-2">
                      <div>
                        <span className="text-slate-600">Category:</span>
                        <p className="text-slate-900 dark:text-slate-50 capitalize">{doc.documentCategory}</p>
                      </div>
                      <div>
                        <span className="text-slate-600">Type:</span>
                        <p className="text-slate-900 dark:text-slate-50">{doc.documentType || '—'}</p>
                      </div>
                      <div>
                        <span className="text-slate-600">Size:</span>
                        <p className="text-slate-900 dark:text-slate-50">{formatFileSize(doc.fileSizeBytes)}</p>
                      </div>
                      <div>
                        <span className="text-slate-600">Uploaded:</span>
                        <p className="text-slate-900 dark:text-slate-50">{formatDate(doc.createdAt)}</p>
                      </div>
                      {doc.issueDate && (
                        <div>
                          <span className="text-slate-600">Issued:</span>
                          <p className="text-slate-900 dark:text-slate-50">{formatDate(doc.issueDate)}</p>
                        </div>
                      )}
                      {doc.expiryDate && (
                        <div>
                          <span className="text-slate-600">Expires:</span>
                          <p className={isExpired(doc.expiryDate) ? 'text-red-600 font-semibold' : 'text-slate-900 dark:text-slate-50'}>
                            {formatDate(doc.expiryDate)}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2 ml-4">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDownload(doc.id)}
                      className="gap-1"
                    >
                      <Download className="h-4 w-4" />
                      Download
                    </Button>
                    {attributeKey && !doc.isPrimary && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSetPrimary(doc.id)}
                        disabled={isLinkingDocument}
                        className="gap-1"
                        title="Set as primary document for this attribute"
                      >
                        Set Primary
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(doc.id)}
                      disabled={isLinkingDocument}
                      className="gap-1 text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                      {attributeKey ? 'Remove' : 'Delete'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upload Dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>
              Upload a document to support your hospital attributes
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleUpload} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="file">Select File</Label>
              <Input
                id="file"
                type="file"
                onChange={handleFileSelect}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg,image/jpg,image/png"
                disabled={uploading}
              />
              <p className="text-xs text-slate-500">
                Max size: 100MB. Supported: PDF, Word, Excel, Images
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="documentName">Document Name *</Label>
              <Input
                id="documentName"
                value={formData.documentName}
                onChange={(e) => setFormData({ ...formData, documentName: e.target.value })}
                placeholder="e.g., NABH Certification"
                disabled={uploading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="documentCategory">Category *</Label>
              <select
                id="documentCategory"
                value={formData.documentCategory}
                onChange={(e) => setFormData({ ...formData, documentCategory: e.target.value })}
                disabled={uploading}
                className="w-full px-3 py-2 border rounded-md"
              >
                {DOCUMENT_CATEGORIES.map(cat => (
                  <option key={cat.value} value={cat.value}>{cat.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="documentType">Document Type</Label>
              <Input
                id="documentType"
                value={formData.documentType}
                onChange={(e) => setFormData({ ...formData, documentType: e.target.value })}
                placeholder="e.g., NABH, ISO 9001"
                disabled={uploading}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="issueDate">Issue Date</Label>
                <Input
                  id="issueDate"
                  type="date"
                  value={formData.issueDate}
                  onChange={(e) => setFormData({ ...formData, issueDate: e.target.value })}
                  disabled={uploading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="expiryDate">Expiry Date</Label>
                <Input
                  id="expiryDate"
                  type="date"
                  value={formData.expiryDate}
                  onChange={(e) => setFormData({ ...formData, expiryDate: e.target.value })}
                  disabled={uploading}
                />
              </div>
            </div>

            {uploading && (
              <div className="space-y-2">
                <div className="w-full bg-slate-200 rounded-full h-2">
                  <div
                    className="bg-brand-600 h-2 rounded-full transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-sm text-slate-600 text-center">Uploading... {uploadProgress}%</p>
              </div>
            )}

            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={uploading} className="flex-1">
                {uploading ? 'Uploading...' : 'Upload'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowUploadDialog(false)}
                disabled={uploading}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
