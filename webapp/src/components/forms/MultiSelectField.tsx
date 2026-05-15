import React, { useState, useMemo } from 'react';
import { ChevronDown, X } from 'lucide-react';

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface MultiSelectFieldProps {
  id: string;
  label?: string;
  values: string[];
  options: SelectOption[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  error?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
  loading?: boolean;
}

/**
 * Reusable multi-select dropdown component
 * Used for selecting multiple options from a list
 *
 * @example
 * <MultiSelectField
 *   id="specialities"
 *   label="Specialities"
 *   values={selectedSpecialities}
 *   options={specialityOptions}
 *   onChange={(values) => setSelectedSpecialities(values)}
 *   placeholder="Select specialities"
 * />
 */
export const MultiSelectField: React.FC<MultiSelectFieldProps> = ({
  id,
  label,
  values,
  options,
  onChange,
  disabled = false,
  error,
  placeholder,
  required = false,
  className = '',
  loading = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Filter options based on search
  const filteredOptions = useMemo(() => {
    if (!searchTerm) return options;
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
        opt.value.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [options, searchTerm]);

  // Get selected option labels
  const selectedLabels = useMemo(() => {
    return values
      .map((val) => options.find((opt) => opt.value === val)?.label)
      .filter(Boolean);
  }, [values, options]);

  const handleToggleOption = (value: string) => {
    if (values.includes(value)) {
      onChange(values.filter((v) => v !== value));
    } else {
      onChange([...values, value]);
    }
  };

  const handleRemoveTag = (value: string) => {
    onChange(values.filter((v) => v !== value));
  };

  return (
    <div className={`flex flex-col space-y-1 ${className}`}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
          {required && <span className="ml-1 text-red-500">*</span>}
        </label>
      )}

      <div className="relative">
        <div
          className={`
            w-full min-h-[40px] px-3 py-2 border rounded-md
            bg-white dark:bg-slate-900
            border-slate-300 dark:border-slate-700
            focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-600 focus-within:border-transparent
            disabled:bg-slate-100 dark:disabled:bg-slate-800
            disabled:text-slate-500 dark:disabled:text-slate-400
            disabled:cursor-not-allowed
            transition-colors duration-200
            flex flex-wrap items-center gap-2
            cursor-pointer
            ${error ? 'border-red-500 focus-within:ring-red-500' : ''}
            ${disabled ? 'opacity-50 pointer-events-none' : ''}
          `}
          onClick={() => !disabled && setIsOpen(!isOpen)}
        >
          {/* Selected tags */}
          {selectedLabels.length > 0 ? (
            selectedLabels.map((label, idx) => {
              const value = values[idx];
              return (
                <div
                  key={value}
                  className="flex items-center gap-1 bg-brand-50 dark:bg-brand-700/30 text-brand-700 dark:text-brand-50 px-2 py-1 rounded text-sm"
                >
                  <span>{label}</span>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveTag(value);
                      }}
                      className="hover:text-brand-900 dark:hover:text-brand-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })
          ) : (
            <span className="text-slate-500 dark:text-slate-400 text-sm">
              {loading ? 'Loading...' : placeholder || 'Select options...'}
            </span>
          )}

          {/* Chevron icon */}
          <div className="ml-auto flex-shrink-0">
            <ChevronDown
              className={`h-4 w-4 text-slate-400 transition-transform ${
                isOpen ? 'transform rotate-180' : ''
              }`}
            />
          </div>
        </div>

        {/* Dropdown menu */}
        {isOpen && !disabled && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md shadow-lg z-50">
            {/* Search input */}
            <div className="p-2 border-b border-slate-200 dark:border-slate-700">
              <input
                type="text"
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded text-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-brand-600"
              />
            </div>

            {/* Options list */}
            <div className="max-h-60 overflow-y-auto">
              {filteredOptions.length === 0 ? (
                <div className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400 text-center">
                  No options found
                </div>
              ) : (
                filteredOptions.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={values.includes(option.value)}
                      onChange={() => handleToggleOption(option.value)}
                      className="w-4 h-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600 cursor-pointer"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {option.label}
                      </p>
                      {option.description && (
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                          {option.description}
                        </p>
                      )}
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {loading && <p className="text-xs text-slate-500 dark:text-slate-400">Loading options...</p>}
      {error && <p className="text-sm text-red-500 dark:text-red-400">{error}</p>}
    </div>
  );
};

export default MultiSelectField;
