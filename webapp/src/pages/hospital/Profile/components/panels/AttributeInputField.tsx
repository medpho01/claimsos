import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Plus, FileText, X } from 'lucide-react';
import type { AttributeDefinition, AttributeFormData } from './types';

interface AttributeInputFieldProps {
  definition: AttributeDefinition;
  formData: AttributeFormData;
  onChange: (next: AttributeFormData) => void;
  selectedFiles: File[];
  onAddFiles: (files: File[]) => void;
  onRemovePendingFile: (index: number) => void;
}

/**
 * Renders the per-data-type form field for a panel attribute.
 *
 * Extracted from PanelsManager.tsx so Add and Edit dialogs can share it
 * without sharing form state (H13).
 *
 * `onChange` always receives a fresh form-data object; the caller decides
 * which slice of state to assign it to (addFormData vs editFormData).
 */
export function AttributeInputField({
  definition,
  formData,
  onChange,
  selectedFiles,
  onAddFiles,
  onRemovePendingFile,
}: AttributeInputFieldProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Determine which formData field to read based on data_type
  let value = '';
  if (
    ['text', 'email', 'phone', 'url', 'textarea', 'encrypted_text', 'single_select'].includes(
      definition.data_type,
    )
  ) {
    value = formData.valueText;
  } else if (definition.data_type === 'boolean') {
    value = formData.valueBoolean;
  } else if (definition.data_type === 'date') {
    value = formData.valueDate;
  } else if (['json', 'multi_select'].includes(definition.data_type)) {
    value = formData.valueJson;
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onAddFiles(files);
      e.target.value = '';
    }
  };

  switch (definition.data_type) {
    case 'text':
    case 'textarea':
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          {definition.data_type === 'textarea' ? (
            <Textarea
              id="value"
              placeholder={definition.description}
              value={value}
              onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
            />
          ) : (
            <Input
              id="value"
              type="text"
              placeholder={definition.description}
              value={value}
              onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
            />
          )}
        </div>
      );

    case 'email':
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="value"
            type="email"
            placeholder="user@example.com"
            value={value}
            onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
          />
        </div>
      );

    case 'phone':
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="value"
            type="tel"
            placeholder="+91-XXXX-XXXXX"
            value={value}
            onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
          />
        </div>
      );

    case 'url':
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="value"
            type="url"
            placeholder="https://example.com"
            value={value}
            onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
          />
        </div>
      );

    case 'date':
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="value"
            type="date"
            value={value}
            onChange={(e) => onChange({ ...formData, valueDate: e.target.value })}
          />
        </div>
      );

    case 'boolean':
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <select
            id="value"
            value={value}
            onChange={(e) => onChange({ ...formData, valueBoolean: e.target.value })}
            className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white text-black dark:bg-slate-800 dark:text-white dark:border-slate-600"
          >
            <option value="">Select...</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
      );

    case 'single_select': {
      let optionsObj: any = definition.options;
      if (typeof definition.options === 'string') {
        try {
          optionsObj = JSON.parse(definition.options);
        } catch {
          optionsObj = {};
        }
      }
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <select
            id="value"
            value={value}
            onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
            className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white text-black dark:bg-slate-800 dark:text-white dark:border-slate-600"
          >
            <option value="">Select...</option>
            {optionsObj &&
              Object.entries(optionsObj).map(([key, label]: [string, any]) => (
                <option key={key} value={key}>
                  {String(label)}
                </option>
              ))}
          </select>
        </div>
      );
    }

    case 'file':
      return (
        <div className="space-y-2">
          <Label>
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              Add File
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              onChange={handleFileChange}
              accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
            />
          </div>

          {selectedFiles.length > 0 && (
            <div className="space-y-2 mt-2">
              <p className="text-sm font-medium">Pending files:</p>
              {selectedFiles.map((file, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-800 rounded border"
                >
                  <div className="flex items-center gap-2 flex-1">
                    <FileText className="h-4 w-4 text-slate-500" />
                    <span className="text-sm truncate">{file.name}</span>
                    <span className="text-xs text-slate-500">
                      ({(file.size / 1024 / 1024).toFixed(2)} MB)
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemovePendingFile(idx)}
                    className="h-6 w-6 p-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      );

    case 'encrypted_text':
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="value"
            type="password"
            placeholder="Enter encrypted value"
            value={value}
            onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
          />
          <p className="text-xs text-slate-500">This value will be encrypted before storing</p>
        </div>
      );

    default:
      return (
        <div className="space-y-2">
          <Label htmlFor="value">
            {definition.label}{' '}
            {definition.is_required && <span className="text-red-500">*</span>}
          </Label>
          <Input
            id="value"
            type="text"
            placeholder={definition.description}
            value={value}
            onChange={(e) => onChange({ ...formData, valueText: e.target.value })}
          />
        </div>
      );
  }
}
