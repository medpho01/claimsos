/**
 * useAttributeFormRenderer Hook
 *
 * Centralizes the giant renderAttributeInput() function that was duplicated
 * in both AttributesManager and PanelsManager
 *
 * This eliminates ~150 lines of duplicated code
 */

import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  PanelAttributeDefinition,
  AttributeFormData,
  AttributeDataType,
} from '@/types/attributeTypes';

export function useAttributeFormRenderer() {
  /**
   * Render appropriate input component based on attribute data type
   */
  const renderAttributeInput = (
    definition: PanelAttributeDefinition,
    formData: AttributeFormData,
    setFormData: (data: AttributeFormData) => void,
    additionalProps?: {
      onFileSelect?: (files: File[]) => void;
      selectedFiles?: File[];
      removeFile?: (index: number) => void;
    }
  ): React.ReactNode => {
    if (!definition) {
      return <div>Definition not found</div>;
    }

    // Determine which formData field to use based on data_type
    let value = '';
    switch (definition.dataType) {
      case 'text':
      case 'email':
      case 'phone':
      case 'url':
      case 'textarea':
      case 'encrypted_text':
      case 'single_select':
      case 'integer':
        value = formData.valueText || '';
        break;
      case 'boolean':
        value = formData.valueBoolean || '';
        break;
      case 'date':
        value = formData.valueDate || '';
        break;
      case 'json':
      case 'multi_select':
        value = formData.valueJson || '';
        break;
      case 'file':
      case 'document':
        value = formData.documentId || '';
        break;
    }

    // Render based on data type
    switch (definition.dataType) {
      // Text inputs
      case 'text':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Input
              id="value"
              type="text"
              placeholder={definition.description}
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
            />
          </div>
        );

      // Email input
      case 'email':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Input
              id="value"
              type="email"
              placeholder={definition.description}
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
            />
          </div>
        );

      // Phone input
      case 'phone':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Input
              id="value"
              type="tel"
              placeholder={definition.description}
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
            />
          </div>
        );

      // URL input
      case 'url':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Input
              id="value"
              type="url"
              placeholder={definition.description}
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
            />
          </div>
        );

      // Textarea
      case 'textarea':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Textarea
              id="value"
              placeholder={definition.description}
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
              rows={4}
            />
          </div>
        );

      // Encrypted text (password-like)
      case 'encrypted_text':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Input
              id="value"
              type="password"
              placeholder={definition.description}
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
            />
            <p className="text-xs text-gray-500">
              This value will be encrypted and stored securely
            </p>
          </div>
        );

      // Date input
      case 'date':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Input
              id="value"
              type="date"
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueDate: e.target.value })
              }
            />
          </div>
        );

      // Integer input
      case 'integer':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Input
              id="value"
              type="number"
              placeholder={definition.description}
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
            />
          </div>
        );

      // Boolean (checkbox or toggle)
      case 'boolean':
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                id="value"
                type="checkbox"
                checked={value === 'true'}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    valueBoolean: e.target.checked ? 'true' : 'false',
                  })
                }
              />
              <Label htmlFor="value" className="cursor-pointer">
                {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
              </Label>
            </div>
          </div>
        );

      // Single select dropdown
      case 'single_select':
        let optionsObj = definition.options;
        if (typeof optionsObj === 'string') {
          try {
            optionsObj = JSON.parse(optionsObj);
          } catch (e) {
            optionsObj = {};
          }
        }

        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <select
              id="value"
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueText: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            >
              <option value="">Select {definition.label.toLowerCase()}</option>
              {optionsObj &&
                Object.entries(optionsObj).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label as string}
                  </option>
                ))}
            </select>
          </div>
        );

      // Multi-select (checkbox group)
      case 'multi_select':
        let multiOptions = definition.options;
        if (typeof multiOptions === 'string') {
          try {
            multiOptions = JSON.parse(multiOptions);
          } catch (e) {
            multiOptions = {};
          }
        }

        const selectedValues: string[] = value
          ? JSON.parse(value)
          : [];

        return (
          <div className="space-y-2">
            <Label>
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <div className="space-y-2">
              {multiOptions &&
                Object.entries(multiOptions).map(([key, label]) => (
                  <div key={key} className="flex items-center gap-2">
                    <input
                      id={key}
                      type="checkbox"
                      checked={selectedValues.includes(key)}
                      onChange={(e) => {
                        const newValues = e.target.checked
                          ? [...selectedValues, key]
                          : selectedValues.filter((v) => v !== key);
                        setFormData({
                          ...formData,
                          valueJson: JSON.stringify(newValues),
                        });
                      }}
                    />
                    <Label htmlFor={key} className="cursor-pointer">
                      {label as string}
                    </Label>
                  </div>
                ))}
            </div>
          </div>
        );

      // File upload
      case 'file':
        return (
          <div className="space-y-2">
            <Label>
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <p className="text-sm text-gray-600 mb-2">
              Drag and drop files or click to browse
            </p>

            {/* File input */}
            <input
              type="file"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (additionalProps?.onFileSelect) {
                  additionalProps.onFileSelect(files);
                }
              }}
              className="block w-full text-sm text-gray-500
                file:mr-4 file:py-2 file:px-4
                file:rounded-md file:border-0
                file:text-sm file:font-semibold
                file:bg-blue-50 file:text-blue-700
                hover:file:bg-blue-100"
            />

            {/* Show selected files */}
            {additionalProps?.selectedFiles &&
              additionalProps.selectedFiles.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    Files to upload:
                  </p>
                  <div className="space-y-2">
                    {additionalProps.selectedFiles.map((file, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200"
                      >
                        <div className="flex-1">
                          <p className="text-sm text-gray-700">{file.name}</p>
                          <p className="text-xs text-gray-500">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                        <button
                          onClick={() => additionalProps.removeFile?.(index)}
                          className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>
        );

      // Document type (similar to file but can be displayed differently)
      case 'document':
        return (
          <div className="space-y-2">
            <Label>
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <p className="text-sm text-gray-600 mb-2">
              Upload supporting documents
            </p>

            {/* File input */}
            <input
              type="file"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                if (additionalProps?.onFileSelect) {
                  additionalProps.onFileSelect(files);
                }
              }}
              className="block w-full text-sm text-gray-500
                file:mr-4 file:py-2 file:px-4
                file:rounded-md file:border-0
                file:text-sm file:font-semibold
                file:bg-blue-50 file:text-blue-700
                hover:file:bg-blue-100"
            />

            {/* Show selected files */}
            {additionalProps?.selectedFiles &&
              additionalProps.selectedFiles.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    Files to upload:
                  </p>
                  <div className="space-y-2">
                    {additionalProps.selectedFiles.map((file, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200"
                      >
                        <div className="flex-1">
                          <p className="text-sm text-gray-700">{file.name}</p>
                          <p className="text-xs text-gray-500">
                            {(file.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                        <button
                          onClick={() => additionalProps.removeFile?.(index)}
                          className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
          </div>
        );

      // JSON (for advanced use cases)
      case 'json':
        return (
          <div className="space-y-2">
            <Label htmlFor="value">
              {definition.label} {definition.isRequired && <span className="text-red-500">*</span>}
            </Label>
            <Textarea
              id="value"
              placeholder="Enter valid JSON"
              value={value}
              onChange={(e) =>
                setFormData({ ...formData, valueJson: e.target.value })
              }
              rows={6}
              className="font-mono text-sm"
            />
          </div>
        );

      default:
        return <div>Unsupported data type: {definition.dataType}</div>;
    }
  };

  return { renderAttributeInput };
}
