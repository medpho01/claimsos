/**
 * useDocumentUpload Hook
 *
 * Centralized document handling logic
 * Eliminates duplicate upload, link, unlink logic from both managers
 */

import { useState, useCallback } from 'react';
import ApiService from '@/services/api';

export interface UseDocumentUploadOptions {
  hospitalId: string;
  attributeType: 'hospital' | 'panel';
  panelId?: string; // For panel attributes
}

/**
 * Hook for document operations
 */
export function useDocumentUpload(options: UseDocumentUploadOptions) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ============ File Management ============
  const addFiles = useCallback((files: File[]) => {
    console.log('📁 Adding files:', files.length);
    setSelectedFiles((prev) => [...prev, ...files]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearFiles = useCallback(() => {
    setSelectedFiles([]);
  }, []);

  // ============ Upload Operations ============
  const uploadDocument = useCallback(
    async (file: File): Promise<string> => {
      const formDataObj = new FormData();
      formDataObj.append('file', file);
      formDataObj.append('documentName', file.name);
      formDataObj.append(
        'documentCategory',
        options.attributeType === 'hospital'
          ? 'hospital_attributes'
          : 'panel_attributes'
      );
      formDataObj.append(
        'documentType',
        options.attributeType === 'hospital'
          ? 'hospital_attribute_document'
          : 'panel_attribute_document'
      );

      const response = await ApiService.uploadDocument(
        options.hospitalId,
        formDataObj
      );
      const documentId = response.data.data?.id;

      if (!documentId) {
        throw new Error('No document ID returned from upload');
      }

      return documentId;
    },
    [options]
  );

  const uploadMultipleDocuments = useCallback(
    async (files: File[]): Promise<string[]> => {
      console.log('🚀 uploadMultipleDocuments START - Uploading', files.length, 'files');
      files.forEach((f, idx) =>
        console.log(`   [${idx}] ${f.name} (${(f.size / 1024 / 1024).toFixed(2)}MB)`)
      );

      const documentIds: string[] = [];
      const failedFiles: string[] = [];

      // Upload all files, continue even if some fail
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log(`📤 [${i + 1}/${files.length}] Uploading: ${file.name}`);
        try {
          const documentId = await uploadDocument(file);
          console.log(
            `✅ [${i + 1}/${files.length}] Success: ${file.name} → ID: ${documentId}`
          );
          documentIds.push(documentId);
        } catch (err: any) {
          const errorMsg =
            err.response?.data?.message || `Failed to upload ${file.name}`;
          failedFiles.push(`${file.name}: ${errorMsg}`);
          console.error(`❌ [${i + 1}/${files.length}] Failed: ${file.name}`, err);
        }
      }

      console.log(
        `🏁 uploadMultipleDocuments END - Successful: ${documentIds.length}, Failed: ${failedFiles.length}`
      );

      // If no files were uploaded successfully, throw error
      if (documentIds.length === 0) {
        throw new Error(
          `All files failed to upload: ${failedFiles.join('; ')}`
        );
      }

      // If some files failed, log warning but continue
      if (failedFiles.length > 0) {
        const warning = `${documentIds.length} file(s) uploaded successfully, but ${failedFiles.length} failed: ${failedFiles.join('; ')}`;
        console.warn(warning);
        setUploadError(warning);
      }

      return documentIds;
    },
    [uploadDocument]
  );

  // ============ Attribute Document Operations ============
  const linkDocumentToAttribute = useCallback(
    async (attributeId: string, documentId: string): Promise<void> => {
      console.log(`🔗 Linking document ${documentId} to attribute ${attributeId}`);

      try {
        if (options.attributeType === 'hospital') {
          await ApiService.addDocumentToAttribute(
            options.hospitalId,
            attributeId,
            documentId
          );
        } else {
          await ApiService.addPanelAttributeDocument(
            options.hospitalId,
            options.panelId || '',
            attributeId,
            documentId
          );
        }
        console.log(`✅ Document linked successfully`);
      } catch (err: any) {
        console.error('❌ Failed to link document:', err);
        throw err;
      }
    },
    [options]
  );

  const unlinkDocumentFromAttribute = useCallback(
    async (attributeId: string, documentId: string): Promise<void> => {
      console.log(`🔓 Unlinking document ${documentId} from attribute ${attributeId}`);

      try {
        if (options.attributeType === 'hospital') {
          await ApiService.removeDocumentFromAttribute(
            options.hospitalId,
            attributeId,
            documentId
          );
        } else {
          await ApiService.removePanelAttributeDocument(
            options.hospitalId,
            options.panelId || '',
            attributeId,
            documentId
          );
        }
        console.log(`✅ Document unlinked successfully`);
      } catch (err: any) {
        console.error('❌ Failed to unlink document:', err);
        throw err;
      }
    },
    [options]
  );

  const setPrimaryDocument = useCallback(
    async (attributeId: string, documentId: string): Promise<void> => {
      console.log(`⭐ Setting document ${documentId} as primary`);

      try {
        if (options.attributeType === 'hospital') {
          await ApiService.setPrimaryDocument(
            options.hospitalId,
            attributeId,
            documentId
          );
        } else {
          // For panel attributes, use panel-specific endpoint if available
          // Otherwise use the same endpoint
          await ApiService.setPrimaryDocument(
            options.hospitalId,
            attributeId,
            documentId
          );
        }
        console.log(`✅ Primary document set successfully`);
      } catch (err: any) {
        console.error('❌ Failed to set primary document:', err);
        throw err;
      }
    },
    [options]
  );

  // ============ Batch Operations ============
  const uploadAndLinkMultiple = useCallback(
    async (files: File[], attributeId: string): Promise<void> => {
      console.log(`🔄 Starting batch upload and link for ${files.length} files`);

      try {
        setIsUploading(true);
        setUploadError(null);

        // Upload all files
        const documentIds = await uploadMultipleDocuments(files);

        // Link all documents to attribute
        for (let i = 0; i < documentIds.length; i++) {
          const docId = documentIds[i];
          console.log(`   [${i + 1}/${documentIds.length}] Linking document...`);
          await linkDocumentToAttribute(attributeId, docId);
        }

        console.log(`✅ All files uploaded and linked successfully`);
        clearFiles();
      } catch (err: any) {
        console.error('❌ Batch operation failed:', err);
        setUploadError(err.message || 'Failed to upload and link documents');
        throw err;
      } finally {
        setIsUploading(false);
      }
    },
    [uploadMultipleDocuments, linkDocumentToAttribute, clearFiles]
  );

  return {
    // State
    selectedFiles,
    isUploading,
    uploadError,

    // File Management
    addFiles,
    removeFile,
    clearFiles,

    // Upload Operations
    uploadDocument,
    uploadMultipleDocuments,

    // Document Operations
    linkDocumentToAttribute,
    unlinkDocumentFromAttribute,
    setPrimaryDocument,

    // Batch Operations
    uploadAndLinkMultiple,

    // Utilities
    setUploadError,
  };
}
