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
import { AlertCircle, Loader } from 'lucide-react';
import ApiService from '@/services/api';

interface CreateOptionModalProps {
  category: string;
  onSuccess: () => void;
  onClose: () => void;
}

export default function CreateOptionModal({ category, onSuccess, onClose }: CreateOptionModalProps) {
  const [formData, setFormData] = useState({
    code: '',
    label: '',
    description: '',
    sort_order: '999',
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);

      // Validate required fields
      if (!formData.code.trim() || !formData.label.trim()) {
        setError('Code and Label are required');
        return;
      }

      await ApiService.post('/master-options', {
        category,
        code: formData.code.trim(),
        label: formData.label.trim(),
        description: formData.description.trim() || null,
        sort_order: parseInt(formData.sort_order) || 999,
      });

      onSuccess();
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || 'Failed to create option';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create New Option</DialogTitle>
          <DialogDescription>
            Add a new option to the <span className="font-medium">{category.replace(/_/g, ' ').split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}</span> category
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
            <Label htmlFor="code">Code *</Label>
            <Input
              id="code"
              name="code"
              placeholder="e.g., cardiology, single_specialty"
              value={formData.code}
              onChange={handleChange}
              disabled={loading}
              required
              pattern="^[a-z0-9_]+$"
              title="Only lowercase letters, numbers, and underscores allowed"
            />
            <p className="text-xs text-muted-foreground">Unique identifier within category (lowercase, underscore, no spaces)</p>
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
            <p className="text-xs text-muted-foreground">Display text shown in dropdowns</p>
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
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading} className="gap-2">
            {loading && <Loader className="h-4 w-4 animate-spin" />}
            Create Option
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
