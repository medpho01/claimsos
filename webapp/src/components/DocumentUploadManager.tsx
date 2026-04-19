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
  issueDate?: string;
  expiryDate?: string;
  createdAt: string;
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
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

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

      await ApiService.downloadDocument(hospitalId, documentId);
      // Browser will automatically download the file
    } catch (err: any) {
      setError('Failed to download document');
    }
  };

  const handleDelete = async (documentId: string) => {
    if (!window.confirm('Are you sure you want to delete this document?')) {
      return;
    }

    try {
      await ApiService.deleteDocument(hospitalId, documentId);
      setDocuments(documents.filter(d => d.id !== documentId));
      setSuccess('Document deleted successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError('Failed to delete document');
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
            <div className="text-center py-8 text-gray-500">Loading documents...</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No documents uploaded yet</p>
              <p className="text-sm mt-1">Upload documents to support your attribute claims</p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map(doc => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-gray-50"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className="h-4 w-4 text-gray-400" />
                      <h4 className="font-semibold text-gray-900">{doc.documentName}</h4>
                      {isExpired(doc.expiryDate) && (
                        <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded font-medium">
                          Expired
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mt-2">
                      <div>
                        <span className="text-gray-600">Category:</span>
                        <p className="text-gray-900 capitalize">{doc.documentCategory}</p>
                      </div>
                      <div>
                        <span className="text-gray-600">Type:</span>
                        <p className="text-gray-900">{doc.documentType || '—'}</p>
                      </div>
                      <div>
                        <span className="text-gray-600">Size:</span>
                        <p className="text-gray-900">{formatFileSize(doc.fileSizeBytes)}</p>
                      </div>
                      <div>
                        <span className="text-gray-600">Uploaded:</span>
                        <p className="text-gray-900">{formatDate(doc.createdAt)}</p>
                      </div>
                      {doc.issueDate && (
                        <div>
                          <span className="text-gray-600">Issued:</span>
                          <p className="text-gray-900">{formatDate(doc.issueDate)}</p>
                        </div>
                      )}
                      {doc.expiryDate && (
                        <div>
                          <span className="text-gray-600">Expires:</span>
                          <p className={isExpired(doc.expiryDate) ? 'text-red-600 font-semibold' : 'text-gray-900'}>
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
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDelete(doc.id)}
                      className="gap-1 text-red-600 hover:text-red-700"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
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
                accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png"
                disabled={uploading}
              />
              <p className="text-xs text-gray-500">
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
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-blue-600 h-2 rounded-full transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-sm text-gray-600 text-center">Uploading... {uploadProgress}%</p>
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
