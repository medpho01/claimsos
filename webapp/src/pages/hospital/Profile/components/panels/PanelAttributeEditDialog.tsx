import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader } from 'lucide-react';
import ApiService from '@/services/api';
import { AttributeInputField } from './AttributeInputField';
import { PanelAttributeDocumentRow } from './PanelAttributeDocumentRow';
import {
  buildAttributePayload,
  uploadMultipleDocuments,
} from './attributeApi';
import {
  AttributeDefinition,
  AttributeFormData,
  EMPTY_ATTRIBUTE_FORM,
  Panel,
  PanelAttribute,
  PanelAttributeDocument,
  PreviewFile,
} from './types';

interface PanelAttributeEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hospitalId: string;
  panel: Panel;
  attribute: PanelAttribute | null;
  definitions: AttributeDefinition[];
  onSaved: () => Promise<void> | void;
  onError: (message: string) => void;
  onPreviewDocument: (file: PreviewFile) => void;
}

/**
 * Edit an existing panel attribute.
 *
 * Owns its OWN form state (fixes FE H13). The previous shared `formData`
 * on PanelsManager.tsx leaked partially-typed Add values into Edit.
 *
 * When the dialog opens for a given attribute we hydrate `formData` from
 * the attribute's current value (snake_case + camelCase tolerant).
 */
export function PanelAttributeEditDialog({
  open,
  onOpenChange,
  hospitalId,
  panel,
  attribute,
  definitions,
  onSaved,
  onError,
  onPreviewDocument,
}: PanelAttributeEditDialogProps) {
  const [formData, setFormData] = useState<AttributeFormData>(EMPTY_ATTRIBUTE_FORM);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [editingDocuments, setEditingDocuments] = useState<PanelAttributeDocument[]>([]);
  const [deletedDocumentIds, setDeletedDocumentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const attributeKey = attribute
    ? attribute.attributeKey || (attribute as any).attribute_key
    : '';
  const definition = definitions.find((d) => d.key === attributeKey);

  // Hydrate state when the dialog opens for a new attribute.
  useEffect(() => {
    if (!open || !attribute || !definition) return;

    const attrAny = attribute as any;
    const valueText = attrAny.value_text || attribute.valueText || '';
    const valueBoolean =
      attrAny.value_boolean !== undefined
        ? attrAny.value_boolean
        : attribute.valueBoolean;
    const valueDate = attrAny.value_date || attribute.valueDate || '';
    const valueJson = attrAny.value_json || attribute.valueJson;
    const valueEncrypted = attrAny.value_encrypted || attribute.valueEncrypted || '';
    const documentId = attrAny.document_id || attribute.documentId || '';

    const nextForm: AttributeFormData = { ...EMPTY_ATTRIBUTE_FORM, attributeKey };

    switch (definition.data_type) {
      case 'text':
      case 'email':
      case 'phone':
      case 'url':
      case 'textarea':
      case 'single_select':
        nextForm.valueText = valueText;
        break;
      case 'boolean':
        nextForm.valueBoolean = valueBoolean ? 'true' : 'false';
        break;
      case 'date':
        nextForm.valueDate = valueDate;
        break;
      case 'file':
        nextForm.documentId = documentId;
        break;
      case 'json':
      case 'multi_select':
        nextForm.valueJson = valueJson
          ? typeof valueJson === 'string'
            ? valueJson
            : JSON.stringify(valueJson)
          : '';
        break;
      case 'encrypted_text':
        nextForm.valueText = valueEncrypted;
        break;
      default:
        nextForm.valueText = valueText;
    }

    setFormData(nextForm);
    setSelectedFiles([]);
    setEditingDocuments(attribute.documents || []);
    setDeletedDocumentIds([]);

    // Backward-compat: if there's a legacy single document_id but no
    // documents[], fetch it so the user can see/remove it in the dialog.
    if (
      definition.data_type === 'file' &&
      (!attribute.documents || attribute.documents.length === 0) &&
      documentId
    ) {
      (async () => {
        try {
          const docResponse = await ApiService.getDocument(hospitalId, documentId);
          const docData = docResponse.data.data || docResponse.data;
          setEditingDocuments([
            {
              id: documentId,
              documentId,
              fileName: docData.file_name || docData.fileName || 'Document',
              fileSize: docData.file_size_bytes || docData.fileSize || 0,
              mimeType:
                docData.mime_type || docData.mimeType || 'application/octet-stream',
              uploadedAt:
                docData.created_at ||
                docData.uploadedAt ||
                new Date().toISOString(),
              isPrimary: true,
            },
          ]);
        } catch (err) {
          console.error('Failed to fetch document details:', err);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attribute?.id]);

  const handleAddFiles = (files: File[]) => {
    setSelectedFiles((prev) => [...prev, ...files]);
  };

  const handleRemovePendingFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRemoveLinkedDocument = (docId: string) => {
    setEditingDocuments((prev) => prev.filter((d) => d.id !== docId));
    setDeletedDocumentIds((prev) => [...prev, docId]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!attribute || !definition) return;

    const actualPanelId = panel.panelId || (panel as any).panel_id;
    if (!actualPanelId) {
      onError('Panel ID not found');
      return;
    }

    try {
      setLoading(true);

      let documentIds: string[] = [];

      if (selectedFiles.length > 0) {
        try {
          const { documentIds: uploadedIds, failed } =
            await uploadMultipleDocuments(hospitalId, definition, selectedFiles);
          documentIds = uploadedIds;
          if (failed.length > 0) {
            onError(
              `${uploadedIds.length} file(s) uploaded, ${failed.length} failed: ${failed.join('; ')}`,
            );
          }
        } catch (err: any) {
          onError(err.message || 'Failed to upload documents');
          return;
        }
      }

      const payload = buildAttributePayload(definition, panel.id, formData);
      if (formData.documentId || documentIds.length > 0) {
        payload.document_id = formData.documentId || documentIds[0];
      }

      await ApiService.updatePanelAttribute(
        hospitalId,
        actualPanelId,
        attribute.id,
        payload,
      );

      // Link newly uploaded documents
      for (const docId of documentIds) {
        try {
          await ApiService.addPanelAttributeDocument(
            hospitalId,
            actualPanelId,
            attribute.id,
            docId,
          );
        } catch (err) {
          console.error('Failed to link document:', err);
        }
      }

      // Remove deleted documents
      for (const docId of deletedDocumentIds) {
        try {
          await ApiService.removePanelAttributeDocument(
            hospitalId,
            actualPanelId,
            attribute.id,
            docId,
          );
        } catch (err) {
          console.error('Failed to remove document:', err);
        }
      }

      onOpenChange(false);
      await onSaved();
    } catch (err: any) {
      onError(err?.response?.data?.message || 'Failed to update attribute');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Panel Attribute</DialogTitle>
          <DialogDescription>Update the attribute value</DialogDescription>
        </DialogHeader>

        {attribute && definition ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-gray-700">
                {definition.label}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {definition.description}
              </p>
            </div>

            <AttributeInputField
              definition={definition}
              formData={formData}
              onChange={setFormData}
              selectedFiles={selectedFiles}
              onAddFiles={handleAddFiles}
              onRemovePendingFile={handleRemovePendingFile}
            />

            {definition.data_type === 'file' && editingDocuments.length > 0 && (
              <div className="space-y-2 p-3 border rounded-md bg-gray-50 dark:bg-gray-900/20">
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-semibold">
                    Linked Documents ({editingDocuments.length})
                  </Label>
                </div>
                <div className="space-y-2">
                  {editingDocuments.map((doc) => (
                    <PanelAttributeDocumentRow
                      key={doc.id}
                      doc={doc}
                      hospitalId={hospitalId}
                      onPreview={(d) =>
                        onPreviewDocument({
                          fileName: d.fileName,
                          mimeType: d.mimeType,
                          documentId: d.documentId,
                        })
                      }
                      onRemove={handleRemoveLinkedDocument}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? (
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
  );
}
