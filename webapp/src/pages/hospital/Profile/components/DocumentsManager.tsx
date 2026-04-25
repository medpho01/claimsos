import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { AlertCircle, Upload, Download, Trash2, Loader, FileText, CheckCircle2 } from 'lucide-react';
import ApiService from '@/services/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface DocumentsManagerProps {
  hospitalId: string;
}

interface HospitalDocument {
  id: string;
  file_name: string;
  file_size: number;
  file_type: string;
  upload_date: string;
  uploaded_by: string;
  document_type?: string;
  status: 'pending' | 'extracted' | 'failed';
  extraction_data?: {
    raw_text?: string;
    structured_data?: any;
    extracted_at?: string;
  };
}

export default function DocumentsManager({ hospitalId }: DocumentsManagerProps) {
  const [documents, setDocuments] = useState<HospitalDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showExtractionDialog, setShowExtractionDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteDocumentId, setDeleteDocumentId] = useState<string>('');
  const [selectedDocument, setSelectedDocument] = useState<HospitalDocument | null>(null);

  const [uploadForm, setUploadForm] = useState({
    file: null as File | null,
    documentType: '',
    notes: '',
  });

  useEffect(() => {
    fetchDocuments();
  }, [hospitalId]);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const response = await ApiService.getHospitalDocuments(hospitalId);
      setDocuments(response.data.data || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadForm(prev => ({ ...prev, file }));
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadForm.file) {
      setError('Please select a file');
      return;
    }

    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('file', uploadForm.file);
      formData.append('documentType', uploadForm.documentType);
      formData.append('notes', uploadForm.notes);

      await ApiService.uploadDocument(hospitalId, formData);
      setShowUploadDialog(false);
      setUploadForm({ file: null, documentType: '', notes: '' });
      await fetchDocuments();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to upload document');
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (documentId: string, fileName: string) => {
    try {
      setLoading(true);
      const response = await ApiService.downloadDocument(hospitalId, documentId);

      // Create a blob URL and download
      const blob = new Blob([response.data], { type: 'application/octet-stream' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to download document');
    } finally {
      setLoading(false);
    }
  };

  const handleExtract = async () => {
    if (!selectedDocument) return;

    try {
      setExtracting(selectedDocument.id);
      await ApiService.submitForExtraction(hospitalId, selectedDocument.id);
      await fetchDocuments();
      setShowExtractionDialog(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to extract document');
    } finally {
      setExtracting(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteDocumentId) return;

    try {
      setLoading(true);
      await ApiService.deleteDocument(hospitalId, deleteDocumentId);
      await fetchDocuments();
      setShowDeleteDialog(false);
      setDeleteDocumentId('');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete document');
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'extracted':
        return <div className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-sm"><CheckCircle2 className="h-4 w-4" /> Extracted</div>;
      case 'failed':
        return <div className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-700 rounded text-sm">Failed</div>;
      default:
        return <div className="inline-flex items-center gap-1 px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-sm">Pending</div>;
    }
  };

  if (loading && !documents.length) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center justify-center">
          <Loader className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

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
              <CardTitle>Hospital Documents</CardTitle>
              <CardDescription>Manage hospital documents and certifications</CardDescription>
            </div>
            <Button onClick={() => setShowUploadDialog(true)} className="gap-2">
              <Upload className="h-4 w-4" />
              Upload Document
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {documents.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <FileText className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No documents uploaded yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {documents.map(doc => (
                <div key={doc.id} className="p-4 border rounded-lg space-y-2">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <FileText className="h-5 w-5 text-gray-400" />
                        <h4 className="font-semibold">{doc.file_name}</h4>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">
                        {formatFileSize(doc.file_size)} • {doc.file_type} • Uploaded {new Date(doc.upload_date).toLocaleDateString()}
                      </p>
                    </div>
                    {getStatusBadge(doc.status)}
                  </div>

                  {doc.document_type && (
                    <div className="text-sm">
                      <span className="text-gray-600">Type: </span>
                      <span className="font-medium">{doc.document_type}</span>
                    </div>
                  )}

                  {doc.extraction_data?.raw_text && (
                    <div className="bg-gray-50 p-3 rounded text-sm max-h-40 overflow-y-auto">
                      <div className="text-gray-600 font-medium mb-2">Extracted Text:</div>
                      <p className="text-gray-700 whitespace-pre-wrap">{doc.extraction_data.raw_text.substring(0, 500)}...</p>
                    </div>
                  )}

                  <div className="flex gap-2 pt-2 flex-wrap">
                    {doc.status === 'pending' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setSelectedDocument(doc);
                          handleExtract();
                        }}
                        disabled={extracting === doc.id}
                        className="gap-1"
                      >
                        {extracting === doc.id ? (
                          <>
                            <Loader className="h-4 w-4 animate-spin" />
                            Extracting...
                          </>
                        ) : (
                          <>Extract Text</>
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDownload(doc.id, doc.file_name)}
                      className="gap-1"
                    >
                      <Download className="h-4 w-4" />
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDeleteDocumentId(doc.id);
                        setShowDeleteDialog(true);
                      }}
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

      {/* Upload Document Dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>Add a new document to your hospital profile</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleUpload} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="file">File *</Label>
              <div className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-gray-50">
                <input
                  id="file"
                  type="file"
                  onChange={handleFileChange}
                  className="hidden"
                  accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                  required
                />
                <label htmlFor="file" className="cursor-pointer">
                  {uploadForm.file ? (
                    <div>
                      <FileText className="h-8 w-8 mx-auto mb-2 text-blue-500" />
                      <p className="font-medium">{uploadForm.file.name}</p>
                      <p className="text-sm text-gray-500">{formatFileSize(uploadForm.file.size)}</p>
                    </div>
                  ) : (
                    <div>
                      <Upload className="h-8 w-8 mx-auto mb-2 text-gray-400" />
                      <p className="font-medium">Click to upload</p>
                      <p className="text-sm text-gray-500">PDF, DOC, or image files</p>
                    </div>
                  )}
                </label>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="documentType">Document Type</Label>
              <select
                id="documentType"
                value={uploadForm.documentType}
                onChange={(e) => setUploadForm({ ...uploadForm, documentType: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="">Select Type</option>
                <option value="License">License</option>
                <option value="Registration">Registration Certificate</option>
                <option value="Accreditation">Accreditation</option>
                <option value="Certification">Certification</option>
                <option value="Other">Other</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                value={uploadForm.notes}
                onChange={(e) => setUploadForm({ ...uploadForm, notes: e.target.value })}
                placeholder="Add any notes about this document"
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                rows={2}
              />
            </div>

            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={uploading || !uploadForm.file} className="flex-1">
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

      {/* Extraction Result Dialog */}
      <Dialog open={showExtractionDialog} onOpenChange={setShowExtractionDialog}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Extraction Result</DialogTitle>
            <DialogDescription>Review the extracted data from your document</DialogDescription>
          </DialogHeader>

          {selectedDocument && (
            <div className="space-y-4 max-h-96 overflow-y-auto">
              <div>
                <h4 className="font-semibold mb-2">Document: {selectedDocument.file_name}</h4>
                {selectedDocument.extraction_data?.raw_text && (
                  <div className="bg-gray-50 p-3 rounded text-sm space-y-2">
                    <div className="font-medium text-gray-700">Extracted Text:</div>
                    <p className="text-gray-700 whitespace-pre-wrap font-mono text-xs">
                      {selectedDocument.extraction_data.raw_text}
                    </p>
                  </div>
                )}
                {selectedDocument.extraction_data?.structured_data && (
                  <div className="bg-blue-50 p-3 rounded text-sm space-y-2 mt-3">
                    <div className="font-medium text-blue-900">Structured Data:</div>
                    <pre className="text-xs overflow-x-auto text-blue-900">
                      {JSON.stringify(selectedDocument.extraction_data.structured_data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-4">
            <Button onClick={() => setShowExtractionDialog(false)} className="flex-1">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Document</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this document? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2 pt-4">
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={loading}
              className="flex-1"
            >
              {loading ? 'Deleting...' : 'Delete'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
