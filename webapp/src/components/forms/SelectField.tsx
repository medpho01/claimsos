import React from 'react';

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SelectFieldProps {
  id: string;
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

/**
 * Reusable single-select dropdown component
 * Used for selecting one option from a list
 *
 * @example
 * <SelectField
 *   id="hospital_type"
 *   label="Hospital Type"
 *   value={selectedType}
 *   options={hospitalTypeOptions}
 *   onChange={(value) => setSelectedType(value)}
 *   placeholder="Select hospital type"
 * />
 */
export const SelectField: React.FC<SelectFieldProps> = ({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  error,
  placeholder,
  required = false,
  className = '',
}) => {
  return (
    <div className={`flex flex-col space-y-1 ${className}`}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
          {required && <span className="ml-1 text-red-500">*</span>}
        </label>
      )}

      <select
        id={id}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`
          w-full px-3 py-2 border rounded-md
          text-gray-900 dark:text-gray-100
          bg-white dark:bg-slate-900
          border-gray-300 dark:border-slate-700
          focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent
          disabled:bg-gray-100 dark:disabled:bg-slate-800
          disabled:text-gray-500 dark:disabled:text-gray-400
          disabled:cursor-not-allowed
          transition-colors duration-200
          ${error ? 'border-red-500 focus:ring-red-500' : ''}
        `}
      >
        {placeholder && <option value="">{placeholder}</option>}

        {options && options.length > 0 ? (
          options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))
        ) : (
          <option disabled>No options available</option>
        )}
      </select>

      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
    </div>
  );
};

export default SelectField;
