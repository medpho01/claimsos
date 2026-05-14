import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader } from 'lucide-react';
import ApiService from '@/services/api';
import type { Panel } from './types';

interface PanelAttributeDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hospitalId: string;
  panel: Panel;
  attributeId: string;
  onDeleted: () => Promise<void> | void;
  onError: (message: string) => void;
}

/**
 * Confirm + delete a single panel attribute.
 * Extracted from PanelsManager.tsx during the M14 split.
 */
export function PanelAttributeDeleteDialog({
  open,
  onOpenChange,
  hospitalId,
  panel,
  attributeId,
  onDeleted,
  onError,
}: PanelAttributeDeleteDialogProps) {
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    if (!attributeId) return;
    const actualPanelId = panel.panelId || (panel as any).panel_id;
    if (!actualPanelId) {
      onError('Panel ID not found');
      return;
    }
    try {
      setLoading(true);
      await ApiService.deletePanelAttribute(hospitalId, actualPanelId, attributeId);
      onOpenChange(false);
      await onDeleted();
    } catch (err: any) {
      onError(err?.response?.data?.message || 'Failed to delete attribute');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Attribute?</DialogTitle>
          <DialogDescription>
            This action cannot be undone. The attribute will be permanently removed.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={loading}
          >
            {loading ? (
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
  );
}
