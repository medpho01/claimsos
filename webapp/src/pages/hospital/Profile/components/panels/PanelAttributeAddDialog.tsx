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
} from './types';

interface PanelAttributeAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hospitalId: string;
  panel: Panel;
  /** All definitions for this hospital (so we can compute "available" = not yet configured). */
  definitions: AttributeDefinition[];
  /** Currently configured attributes — used to filter out ones already added. */
  existingAttributes: PanelAttribute[];
  onSaved: () => Promise<void> | void;
  onError: (message: string) => void;
}

/**
 * Add a new attribute to a panel.
 *
 * Owns its OWN form state (fixes FE H13): previously PanelsManager kept a
 * single shared `formData` that both Add and Edit dialogs read/wrote. Opening
 * Add, typing a value, closing without saving, then opening Edit on a
 * different attribute caused Add's data to leak into Edit. Now the state is
 * scoped to this component and resets every time the dialog opens.
 */
export function PanelAttributeAddDialog({
  open,
  onOpenChange,
  hospitalId,
  panel,
  definitions,
  existingAttributes,
  onSaved,
  onError,
}: PanelAttributeAddDialogProps) {
  const [formData, setFormData] = useState<AttributeFormData>(EMPTY_ATTRIBUTE_FORM);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);

  // Reset every time the dialog opens — fully isolates Add state from Edit.
  useEffect(() => {
    if (open) {
      setFormData(EMPTY_ATTRIBUTE_FORM);
      setSelectedFiles([]);
    }
  }, [open]);

  const selectedDefinition = definitions.find((d) => d.key === formData.attributeKey);

  const availableDefinitions = (() => {
    const addedKeys = existingAttributes.map(
      (a) => a.attributeKey || (a as any).attribute_key,
    );
    return definitions.filter((d) => !addedKeys.includes(d.key));
  })();

  const handleAddFiles = (files: File[]) => {
    setSelectedFiles((prev) => [...prev, ...files]);
  };

  const handleRemovePendingFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDefinition) {
      onError('Selected attribute definition not found');
      return;
    }

    const actualPanelId = panel.panelId || (panel as any).panel_id;
    if (!actualPanelId) {
      onError('Panel ID not found');
      return;
    }

    try {
      setLoading(true);

      let documentId = formData.documentId;
      let documentIds: string[] = [];

      if (selectedFiles.length > 0) {
        try {
          const { documentIds: uploadedIds, failed } =
            await uploadMultipleDocuments(hospitalId, selectedDefinition, selectedFiles);
          documentIds = uploadedIds;
          if (failed.length > 0) {
            onError(
              `${uploadedIds.length} file(s) uploaded, ${failed.length} failed: ${failed.join('; ')}`,
            );
          }
          documentId = uploadedIds[0];
        } catch (err: any) {
          onError(err.message || 'Failed to upload documents');
          return;
        }
      }

      const payload = buildAttributePayload(selectedDefinition, panel.id, formData);
      if (documentId) {
        payload.document_id = documentId;
      }

      const attrResponse = await ApiService.setPanelAttribute(
        hospitalId,
        actualPanelId,
        payload,
      );
      const newAttributeId = attrResponse.data.data?.id;

      if (documentIds.length > 0 && newAttributeId) {
        for (const docId of documentIds) {
          try {
            await ApiService.addPanelAttributeDocument(
              hospitalId,
              actualPanelId,
              newAttributeId,
              docId,
            );
          } catch (err) {
            console.error('Failed to link document:', err);
          }
        }
      }

      onOpenChange(false);
      await onSaved();
    } catch (err: any) {
      onError(err?.response?.data?.message || 'Failed to add attribute');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Panel Attribute</DialogTitle>
          <DialogDescription>
            Select an attribute and enter its value
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="attr-select">Attribute</Label>
            <select
              id="attr-select"
              value={formData.attributeKey}
              onChange={(e) =>
                setFormData({
                  ...EMPTY_ATTRIBUTE_FORM,
                  attributeKey: e.target.value,
                })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-black dark:bg-gray-800 dark:text-white dark:border-gray-600"
            >
              <option value="">Select unconfigured attribute...</option>
              {availableDefinitions.map((def) => (
                <option key={def.id} value={def.key}>
                  {def.label}
                </option>
              ))}
            </select>
          </div>

          {formData.attributeKey && selectedDefinition && (
            <AttributeInputField
              definition={selectedDefinition}
              formData={formData}
              onChange={setFormData}
              selectedFiles={selectedFiles}
              onAddFiles={handleAddFiles}
              onRemovePendingFile={handleRemovePendingFile}
            />
          )}

          <div className="flex gap-2 pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!formData.attributeKey || loading}>
              {loading ? (
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
  );
}
