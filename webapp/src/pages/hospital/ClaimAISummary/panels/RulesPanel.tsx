import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  MinusCircle,
  AlertTriangle,
  RefreshCw,
  Copy,
  ShieldOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  ReadinessGauge,
  CategoryPill,
} from '@/components/intelligence/primitives';
import {
  useRulesV2,
  type RuleEvaluation,
  type RulesV2Result,
} from '@/hooks/intelligence/useRulesV2';
import { useMasterOptions } from '@/hooks/intelligence';
import { OverrideRuleDialog } from '../components/OverrideRuleDialog';

/**
 * Wave 9 — RulesPanel.
 *
 * Groups rule evaluations by category, expands each into a full evidence
 * card, and offers per-rule override + global re-evaluate.
 */
export interface RulesPanelProps {
  claimId: string;
  /** Override the result — used by the dev demo. */
  resultOverride?: RulesV2Result | null;
  /** Disable network calls — used by the dev demo. */
  offline?: boolean;
}

const CATEGORY_ORDER: string[] = [
  'POLICY_ELIGIBILITY',
  'DOCUMENT_COMPLETENESS',
  'CLINICAL_APPROPRIATENESS',
  'FINANCIAL_LIMITS',
  'PROCEDURAL_COMPLIANCE',
  'TEMPORAL_VALIDITY',
];

const CATEGORY_LABEL: Record<string, string> = {
  POLICY_ELIGIBILITY: 'Policy eligibility',
  DOCUMENT_COMPLETENESS: 'Document completeness',
  CLINICAL_APPROPRIATENESS: 'Clinical appropriateness',
  FINANCIAL_LIMITS: 'Financial limits',
  PROCEDURAL_COMPLIANCE: 'Procedural compliance',
  TEMPORAL_VALIDITY: 'Temporal validity',
};

const STATUS_TONE: Record<string, string> = {
  PASS: 'text-emerald-700 dark:text-emerald-300',
  FAIL: 'text-red-700 dark:text-red-300',
  SKIP: 'text-slate-500 dark:text-slate-400',
  WARN: 'text-amber-700 dark:text-amber-300',
  OVERRIDDEN: 'text-amber-700 dark:text-amber-300',
};

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: 'text-red-700 dark:text-red-300',
  HIGH: 'text-red-700 dark:text-red-300',
  MEDIUM: 'text-amber-700 dark:text-amber-300',
  LOW: 'text-slate-600 dark:text-slate-300',
  INFO: 'text-slate-500 dark:text-slate-400',
};

export const RulesPanel: React.FC<RulesPanelProps> = ({
  claimId,
  resultOverride,
  offline = false,
}) => {
  const rules = useRulesV2(offline ? null : claimId);
  const docCategories = useMasterOptions(offline ? null : 'doc_category');

  const result = resultOverride !== undefined ? resultOverride : rules.data;

  const summary = useMemo(() => {
    const evals = result?.evaluations ?? [];
    return {
      total: evals.length,
      passed: evals.filter((e) => e.status === 'PASS').length,
      failed: evals.filter((e) => e.status === 'FAIL').length,
      skipped: evals.filter((e) => e.status === 'SKIP').length,
      warn: evals.filter((e) => e.status === 'WARN').length,
      overridden: evals.filter((e) => e.status === 'OVERRIDDEN').length,
    };
  }, [result]);

  const grouped = useMemo(() => {
    const map: Record<string, RuleEvaluation[]> = {};
    (result?.evaluations ?? []).forEach((e) => {
      const cat = e.category ?? 'OTHER';
      if (!map[cat]) map[cat] = [];
      map[cat].push(e);
    });
    return map;
  }, [result]);

  const orderedCats = useMemo(() => {
    const present = Object.keys(grouped);
    return [
      ...CATEGORY_ORDER.filter((c) => present.includes(c)),
      ...present.filter((c) => !CATEGORY_ORDER.includes(c)),
    ];
  }, [grouped]);

  const [openCats, setOpenCats] = useState<Set<string>>(
    new Set([CATEGORY_ORDER[0], CATEGORY_ORDER[1]]),
  );
  const toggleCat = (c: string) =>
    setOpenCats((cur) => {
      const next = new Set(cur);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRule = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [overrideTarget, setOverrideTarget] = useState<RuleEvaluation | null>(null);

  const categoryLabel = (code: string): string =>
    docCategories.data.find((o) => o.code === code)?.label ?? code;

  const onReeval = () => {
    if (offline) return;
    void rules.evaluate();
  };

  const onOverrideConfirm = async (reason: string) => {
    if (!overrideTarget || offline) return;
    await rules.overrideRule({ rule_id: overrideTarget.rule_id, reason });
  };

  if (!offline && rules.loading) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading rule evaluations…
      </div>
    );
  }

  if (!result || result.no_match) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
          <div className="mx-auto size-10 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center">
            <AlertTriangle className="size-5 text-amber-600 dark:text-amber-300" />
          </div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {result?.no_match
              ? 'No insurer rule set configured for this claim'
              : 'Rules not yet evaluated'}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            {result?.no_match
              ? 'Using generic stage_requirements only. Configure an insurer-specific rule set in /admin/rules-v2 to get richer scoring.'
              : 'Trigger the rules engine to evaluate document completeness, clinical appropriateness, and financial limits.'}
          </p>
          <Button onClick={onReeval} disabled={rules.isEvaluating || offline} className="gap-2">
            <RefreshCw
              className={cn('size-3.5', rules.isEvaluating && 'animate-spin')}
            />
            Evaluate rules
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center gap-5">
        <ReadinessGauge
          score={result.readiness_score ?? 0}
          size={72}
          subtitle={result.rule_set_name ?? 'Default rule set'}
        />
        <div className="flex-1 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <Stat label="Rules" value={summary.total} />
          <Stat label="Passed" value={summary.passed} tone="ok" />
          <Stat label="Failed" value={summary.failed} tone="bad" />
          <Stat label="Skipped" value={summary.skipped} />
          <Stat label="Overridden" value={summary.overridden} tone="warn" />
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onReeval}
          disabled={rules.isEvaluating || offline}
          className="gap-1.5"
        >
          <RefreshCw className={cn('size-3.5', rules.isEvaluating && 'animate-spin')} />
          Re-evaluate
        </Button>
      </div>

      {/* Grouped rules */}
      <div className="space-y-2">
        {orderedCats.map((cat) => {
          const list = grouped[cat] ?? [];
          const open = openCats.has(cat);
          const failed = list.filter((r) => r.status === 'FAIL').length;
          return (
            <section
              key={cat}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
            >
              <button
                type="button"
                onClick={() => toggleCat(cat)}
                className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40"
              >
                {open ? (
                  <ChevronDown className="size-4 text-slate-400" />
                ) : (
                  <ChevronRight className="size-4 text-slate-400" />
                )}
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {CATEGORY_LABEL[cat] ?? cat}
                </span>
                <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                  {list.length} rules
                </span>
                {failed > 0 && (
                  <span className="ml-1 text-xs font-medium text-red-700 dark:text-red-300">
                    · {failed} failing
                  </span>
                )}
              </button>
              {open && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {list.map((r) => (
                    <RuleRow
                      key={r.rule_id}
                      rule={r}
                      open={expanded.has(r.rule_id)}
                      onToggle={() => toggleRule(r.rule_id)}
                      onOverride={() => setOverrideTarget(r)}
                      categoryLabel={categoryLabel}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <OverrideRuleDialog
        open={!!overrideTarget}
        ruleName={overrideTarget?.rule_name ?? overrideTarget?.rule_code ?? ''}
        ruleId={overrideTarget?.rule_id ?? ''}
        onClose={() => setOverrideTarget(null)}
        onConfirm={onOverrideConfirm}
        saving={rules.isOverriding}
      />
    </div>
  );
};

// ─── helpers ───────────────────────────────────────────────────────────────

const Stat: React.FC<{
  label: string;
  value: number;
  tone?: 'ok' | 'bad' | 'warn' | 'default';
}> = ({ label, value, tone = 'default' }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div
      className={cn(
        'text-base font-semibold tabular-nums',
        tone === 'ok' && 'text-emerald-700 dark:text-emerald-300',
        tone === 'bad' && 'text-red-700 dark:text-red-300',
        tone === 'warn' && 'text-amber-700 dark:text-amber-300',
        tone === 'default' && 'text-slate-900 dark:text-slate-100',
      )}
    >
      {value}
    </div>
  </div>
);

interface RuleRowProps {
  rule: RuleEvaluation;
  open: boolean;
  onToggle: () => void;
  onOverride: () => void;
  categoryLabel: (c: string) => string;
}

const RuleRow: React.FC<RuleRowProps> = ({
  rule,
  open,
  onToggle,
  onOverride,
  categoryLabel,
}) => {
  const StatusIcon =
    rule.status === 'PASS'
      ? CheckCircle2
      : rule.status === 'FAIL'
        ? XCircle
        : rule.status === 'OVERRIDDEN'
          ? ShieldOff
          : rule.status === 'WARN'
            ? AlertTriangle
            : MinusCircle;

  const copyQuery = () => {
    if (rule.query_template) {
      navigator.clipboard?.writeText(rule.query_template).catch(() => undefined);
    }
  };

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/30"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-slate-400 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 text-slate-400 shrink-0" />
        )}
        <StatusIcon
          className={cn('size-4 shrink-0', STATUS_TONE[rule.status] ?? '')}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
            {rule.rule_name ?? rule.rule_code ?? rule.rule_id}
          </div>
          {rule.message && (
            <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
              {rule.message}
            </div>
          )}
        </div>
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide font-medium ml-auto shrink-0',
            SEVERITY_TONE[rule.severity] ?? 'text-slate-500',
          )}
        >
          {rule.severity}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pl-11 space-y-3 text-xs">
          {rule.rule_description && (
            <div>
              <SubHeading>Description</SubHeading>
              <p className="text-slate-700 dark:text-slate-200">
                {rule.rule_description}
              </p>
            </div>
          )}
          {rule.evidence && (
            <div>
              <SubHeading>Evidence</SubHeading>
              <pre className="rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2 text-[11px] font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap max-h-48 overflow-auto">
                {JSON.stringify(rule.evidence, null, 2)}
              </pre>
            </div>
          )}
          {rule.remediation_guidance && (
            <div>
              <SubHeading>Remediation</SubHeading>
              <p className="text-slate-700 dark:text-slate-200">
                {rule.remediation_guidance}
              </p>
            </div>
          )}
          {!!rule.required_documents?.length && (
            <div>
              <SubHeading>Required documents</SubHeading>
              <div className="flex flex-wrap gap-1.5">
                {rule.required_documents.map((d) => (
                  <CategoryPill
                    key={d}
                    category={categoryLabel(d)}
                    ontologyCategory="doc_category"
                    size="xs"
                  />
                ))}
              </div>
            </div>
          )}
          {rule.query_template && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <SubHeading>Query template</SubHeading>
                <button
                  type="button"
                  onClick={copyQuery}
                  className="text-[10px] text-indigo-600 dark:text-indigo-300 hover:underline inline-flex items-center gap-0.5"
                >
                  <Copy className="size-2.5" />
                  Copy
                </button>
              </div>
              <pre className="rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2 text-[11px] font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap">
                {rule.query_template}
              </pre>
            </div>
          )}
          {rule.estimated_deduction_amount != null && (
            <div className="text-[11px] text-amber-700 dark:text-amber-300">
              Est. deduction: ₹{' '}
              {Number(rule.estimated_deduction_amount).toLocaleString('en-IN')}
            </div>
          )}
          {rule.override && (
            <div className="text-[11px] text-slate-600 dark:text-slate-300 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-2">
              <div className="font-medium mb-0.5">Overridden</div>
              {rule.override.reason}
              {rule.override.overridden_by &&
                ` — ${rule.override.overridden_by}`}
              {rule.override.overridden_at &&
                ` · ${new Date(rule.override.overridden_at).toLocaleString()}`}
            </div>
          )}
          {rule.status === 'FAIL' && !rule.override && (
            <div className="pt-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={onOverride}
                className="gap-1.5 text-xs h-7"
              >
                <ShieldOff className="size-3.5" />
                Override rule
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
};

const SubHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h5 className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
    {children}
  </h5>
);

export default RulesPanel;
