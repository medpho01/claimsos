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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertCircle, Loader } from 'lucide-react';
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

interface EditOptionModalProps {
  option: MasterOption;
  onSuccess: () => void;
  onClose: () => void;
}

export default function EditOptionModal({ option, onSuccess, onClose }: EditOptionModalProps) {
  const [formData, setFormData] = useState({
    label: option.label,
    description: option.description || '',
    sort_order: option.sort_order.toString(),
    is_active: option.is_active,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleCheckboxChange = (checked: boolean) => {
    setFormData((prev) => ({
      ...prev,
      is_active: checked,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);

      // Validate required fields
      if (!formData.label.trim()) {
        setError('Label is required');
        return;
      }

      await ApiService.put(`/master-options/${option.id}`, {
        label: formData.label.trim(),
        description: formData.description.trim() || null,
        sort_order: parseInt(formData.sort_order) || 999,
        is_active: formData.is_active,
      });

      onSuccess();
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || 'Failed to update option';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Option</DialogTitle>
          <DialogDescription>
            Update the option "<span className="font-medium">{option.label}</span>"
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

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Code (Read-only)</Label>
            <Input value={option.code} disabled className="bg-slate-100 dark:bg-slate-900" />
            <p className="text-xs text-muted-foreground">Code cannot be changed after creation</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="label">Label *</Label>
            <Input
              id="label"
              name="label"
              placeholder="e.g., Cardiology, Single Specialty Hospital"
              value={formData.label}
              onChange={handleChange}
              disabled={loading}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              name="description"
              placeholder="Optional description for admin reference"
              value={formData.description}
              onChange={handleChange}
              disabled={loading}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sort_order">Sort Order</Label>
            <Input
              id="sort_order"
              name="sort_order"
              type="number"
              placeholder="999"
              value={formData.sort_order}
              onChange={handleChange}
              disabled={loading}
              min="0"
              max="9999"
            />
            <p className="text-xs text-muted-foreground">Display order in dropdowns (lower numbers appear first)</p>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="is_active"
              checked={formData.is_active}
              onCheckedChange={handleCheckboxChange}
              disabled={loading}
            />
            <Label htmlFor="is_active" className="font-normal cursor-pointer">
              Active (visible in dropdowns)
            </Label>
          </div>

          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Created:</span> {new Date(option.created_at).toLocaleDateString()}
            </p>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Updated:</span> {new Date(option.updated_at).toLocaleDateString()}
            </p>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading} className="gap-2">
            {loading && <Loader className="h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
