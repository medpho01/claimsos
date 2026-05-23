/**
 * Sprint Intelligence Layer, Wave 11 — handlebars-lite template renderer.
 *
 * Replaces `{{path.to.value}}` placeholders in a string against a plain JS
 * context object. No eval, no template lib — just a dot-path lookup and a
 * single global regex pass. Designed for short insurer-query templates and
 * remediation copy that the rules editor produces (Wave 8).
 *
 * Why not a real template engine (handlebars, mustache, lodash)?
 *   - We never need conditionals or loops in these strings.
 *   - Importing handlebars would balloon the worker bundle.
 *   - Untrusted template authors (insurer-ops content) should never get a
 *     surface for code injection. Pure substitution is the smallest hammer
 *     that does the job.
 *
 * Behaviour:
 *   - Unknown placeholders are replaced with an empty string by default;
 *     pass `{ keepMissing: true }` to leave the `{{...}}` literal so the
 *     caller can detect missing context.
 *   - Arrays render as comma-joined strings (handy for {{required_docs}}).
 *   - Numbers render via Intl.NumberFormat('en-IN') when accessed through
 *     the `currency` helper hint — paths that end in `.inr` or are flagged
 *     in numericKeys get the formatted version.
 *   - Whitespace inside `{{ ... }}` is allowed and trimmed.
 */

export interface RenderOptions {
  /** Leave `{{path}}` as-is when the path doesn't resolve. Default false (empty string). */
  keepMissing?: boolean;
  /** Path keys (leaf segments) that should be rendered as INR currency. */
  currencyKeys?: string[];
  /** Override the array join separator. Default ', '. */
  arraySeparator?: string;
}

const PLACEHOLDER_RE = /\{\{\s*([\w.[\]\-]+)\s*\}\}/g;

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/**
 * Walk a dot-path against an object. Returns undefined if any segment is
 * missing. Supports `a.b.c` and `a[0].b` (bracket = numeric index).
 */
export function lookup(path: string, context: Record<string, any> | null | undefined): unknown {
  if (!context || !path) return undefined;
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: any = context;
  for (const seg of segments) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function isCurrencyPath(path: string, keys: string[]): boolean {
  if (!keys.length) return false;
  const leaf = path.split('.').pop() ?? '';
  return keys.includes(leaf) || keys.includes(path);
}

function formatValue(value: unknown, opts: { array: string; currency: boolean }): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((v) => formatValue(v, { array: opts.array, currency: false })).join(opts.array);
  }
  if (typeof value === 'number') {
    if (opts.currency) return INR.format(value);
    return String(value);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Replace `{{path}}` occurrences in `template` with values from `context`.
 * Errors (eg. invalid context shape) are swallowed at the per-placeholder
 * level — a template never crashes the surrounding workflow.
 */
export function render(
  template: string | null | undefined,
  context: Record<string, any>,
  options: RenderOptions = {},
): string {
  if (!template) return '';
  const sep = options.arraySeparator ?? ', ';
  const currencyKeys = options.currencyKeys ?? ['deduction_amount', 'estimated_deduction_amount', 'amount_inr', 'inr'];
  return template.replace(PLACEHOLDER_RE, (full, path: string) => {
    try {
      const v = lookup(path, context);
      if (v === undefined || v === null) {
        return options.keepMissing ? full : '';
      }
      return formatValue(v, { array: sep, currency: isCurrencyPath(path, currencyKeys) });
    } catch {
      return options.keepMissing ? full : '';
    }
  });
}

export default render;
