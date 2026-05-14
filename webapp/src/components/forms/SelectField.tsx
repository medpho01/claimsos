import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';

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
 * UI Revamp — custom dropdown that no longer uses a native <select>.
 *
 * Why: native <select> popups on macOS Chrome are AppKit-rendered and
 * don't reliably honour CSS `color-scheme: dark`, so the popup shows
 * up as a bright white surface against the dark app shell. Replacing
 * the popup with our own absolutely-positioned panel guarantees a
 * consistent dark/light look across platforms.
 *
 * Public API matches the original: same props, same `onChange(value)`.
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
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label || placeholder || 'Select…';

  return (
    <div className={`flex flex-col space-y-1 ${className}`} ref={wrapperRef}>
      {label && (
        <label
          htmlFor={id}
          className="block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          {label}
          {required && <span className="ml-1 text-danger-600">*</span>}
        </label>
      )}

      <div className="relative">
        <button
          id={id}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => !disabled && setOpen((v) => !v)}
          className={
            `w-full h-10 px-3 inline-flex items-center justify-between rounded-md border text-sm transition-colors ` +
            `bg-white text-slate-900 border-slate-200 hover:bg-slate-50 ` +
            `dark:bg-slate-900 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-800 ` +
            `disabled:opacity-60 disabled:cursor-not-allowed ` +
            `focus:outline-none focus:ring-2 focus:ring-brand-600/30 focus:border-brand-600 ` +
            (error ? 'border-danger-500 focus:ring-danger-500/30' : '')
          }
        >
          <span className={!selected ? 'text-slate-400 dark:text-slate-500' : ''}>
            {displayLabel}
          </span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 ml-2 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <div
            role="listbox"
            className="absolute z-50 mt-1 w-full max-h-64 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900 py-1"
          >
            {placeholder && (
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
                className="w-full px-3 py-2 text-sm text-left text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-between"
              >
                <span>{placeholder}</span>
                {!value && <Check className="h-4 w-4 text-brand-600" />}
              </button>
            )}
            {options && options.length > 0 ? (
              options.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={
                      `w-full px-3 py-2 text-sm text-left flex items-center justify-between gap-2 transition-colors ` +
                      (active
                        ? 'bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-50'
                        : 'text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800')
                    }
                  >
                    <span className="truncate">{option.label}</span>
                    {active && <Check className="h-4 w-4 text-brand-600 dark:text-brand-50 shrink-0" />}
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-2 text-sm text-slate-500">No options available</div>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
    </div>
  );
};

export default SelectField;
