import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';

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
  /**
   * When true, renders a search input at the top of the popup and filters
   * options client-side by their label (case-insensitive substring match).
   * Defaults to false to keep behaviour for existing call sites unchanged;
   * enable explicitly when the option list is long (8+ items) e.g. the
   * Fix Category modal where doc_category has ~30 entries.
   */
  searchable?: boolean;
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
  searchable = false,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Reset the search query whenever the popup closes so the next open
  // starts fresh. Auto-focus the input when the popup opens so the user
  // can start typing immediately without an extra click.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (searchable) {
      // Defer focus to after the popup is in the DOM.
      const t = window.setTimeout(() => searchInputRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open, searchable]);

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label || placeholder || 'Select…';

  // Filter options by the typed query. Substring match against label
  // AND value so a user typing "aadhaar" hits both "Aadhaar Front" (label)
  // and a hypothetical bare code if labels are ever blank.
  const filteredOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const needle = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        o.value.toLowerCase().includes(needle),
    );
  }, [options, query, searchable]);

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
            `bg-white text-slate-900 dark:text-slate-50 border-slate-200 hover:bg-slate-50 ` +
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
            className="absolute z-50 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            {searchable && (
              // Sticky header so the search box stays visible while the
              // options list scrolls underneath it for long lists. `stopPropagation`
              // on key events prevents Enter/Space from triggering the
              // listbox's own keyboard handlers.
              <div className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search categories…"
                    className={
                      `w-full h-8 pl-7 pr-2 text-sm rounded border ` +
                      `bg-white text-slate-900 border-slate-200 placeholder:text-slate-400 ` +
                      `dark:bg-slate-950 dark:text-slate-100 dark:border-slate-700 dark:placeholder:text-slate-500 ` +
                      `focus:outline-none focus:ring-1 focus:ring-brand-600/40 focus:border-brand-600`
                    }
                    onKeyDown={(e) => {
                      // Esc closes the popup; Enter selects the first
                      // filtered option if any (quick-pick when search
                      // narrows to one obvious result).
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setOpen(false);
                      } else if (e.key === 'Enter' && filteredOptions.length > 0) {
                        e.preventDefault();
                        const first = filteredOptions[0]!;
                        onChange(first.value);
                        setOpen(false);
                      }
                    }}
                  />
                </div>
              </div>
            )}
            <div className="max-h-56 overflow-auto py-1">
              {placeholder && !query && (
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
              {filteredOptions && filteredOptions.length > 0 ? (
                filteredOptions.map((option) => {
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
                <div className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400 text-center">
                  {searchable && query
                    ? `No matches for "${query}"`
                    : 'No options available'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-danger-600">{error}</p>}
    </div>
  );
};

export default SelectField;
