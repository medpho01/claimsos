import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle } from 'lucide-react';
import { AttributeDefinition } from '../types';

interface CredentialInputFieldProps {
  definition: AttributeDefinition;
  value: any;
  onChange: (value: any) => void;
  error?: string;
  disabled?: boolean;
}

export const CredentialInputField: React.FC<CredentialInputFieldProps> = ({
  definition,
  value,
  onChange,
  error,
  disabled = false,
}) => {
  const required = definition.is_required ? '*' : '';

  return (
    <div className="space-y-2">
      <Label htmlFor={`credential-${definition.key}`}>
        {definition.label} {required}
      </Label>

      {definition.description && (
        <p className="text-xs text-slate-500">{definition.description}</p>
      )}

      {definition.data_type === 'text' && (
        <Input
          id={`credential-${definition.key}`}
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${definition.label.toLowerCase()}`}
          disabled={disabled}
          required={definition.is_required}
          className={error ? 'border-red-500' : ''}
        />
      )}

      {definition.data_type === 'date' && (
        <Input
          id={`credential-${definition.key}`}
          type="date"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          required={definition.is_required}
          className={error ? 'border-red-500' : ''}
        />
      )}

      {definition.data_type === 'boolean' && (
        <div className="flex gap-4 mt-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`credential-${definition.key}`}
              value="true"
              checked={value === true}
              onChange={() => onChange(true)}
              disabled={disabled}
            />
            <span className="text-sm">Yes</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`credential-${definition.key}`}
              value="false"
              checked={value === false}
              onChange={() => onChange(false)}
              disabled={disabled}
            />
            <span className="text-sm">No</span>
          </label>
        </div>
      )}

      {definition.data_type === 'textarea' && (
        <textarea
          id={`credential-${definition.key}`}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Enter ${definition.label.toLowerCase()}`}
          disabled={disabled}
          required={definition.is_required}
          rows={3}
          className={`w-full px-3 py-2 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none ${
            error ? 'border-red-500' : ''
          }`}
        />
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-600 text-xs mt-1">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}
    </div>
  );
};
