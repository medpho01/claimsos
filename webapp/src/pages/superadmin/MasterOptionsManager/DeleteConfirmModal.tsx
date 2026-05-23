import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, Loader, Trash2 } from 'lucide-react';
import ApiService from '@/services/api';

interface MasterOption {
  id: string;
  category: string;
  code: string;
  label: string;
  description?: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface DeleteConfirmModalProps {
  option: MasterOption;
  onSuccess: () => void;
  onClose: () => void;
}

export default function DeleteConfirmModal({ option, onSuccess, onClose }: DeleteConfirmModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    try {
      setLoading(true);
      setError(null);

      await ApiService.delete(`/master-options/${option.id}`);
      onSuccess();
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || 'Failed to delete option';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
            <Trash2 className="h-5 w-5" />
            Delete Option Permanently
          </DialogTitle>
          <DialogDescription>
            This will permanently delete this option from the system. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
            <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm">{error}</span>
            </div>
          </div>
        )}

        <div className="rounded-lg bg-slate-50 p-4 dark:bg-slate-900">
          <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Option Details:</p>
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-medium">Label:</span> {option.label}
            </p>
            <p>
              <span className="font-medium">Code:</span> <code className="rounded bg-slate-200 px-2 py-1 dark:bg-slate-800">{option.code}</code>
            </p>
            <p>
              <span className="font-medium">Category:</span> {option.category}
            </p>
            {option.description && (
              <p>
                <span className="font-medium">Description:</span> {option.description}
              </p>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-950">
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            <span className="font-medium">Warning:</span> After deletion, you can create a new option with the same code if needed.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={loading}
            className="gap-2"
          >
            {loading && <Loader className="h-4 w-4 animate-spin" />}
            Delete Option
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
