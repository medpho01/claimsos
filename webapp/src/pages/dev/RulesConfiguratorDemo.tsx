import React, { useState } from 'react';
import RuleEditor, { RuleFormValue } from '@/pages/superadmin/RulesConfigurator/RuleEditor';
import RuleVersionHistory, {
  RuleVersion,
} from '@/pages/superadmin/RulesConfigurator/RuleVersionHistory';
import { CategoryPill } from '@/components/intelligence/primitives';

/**
 * Wave 5C — RulesConfigurator DEMO
 *
 * NOT routed. Renders sub-components against mock data covering:
 *   - empty rules table
 *   - populated rules table (mixed scopes + severities)
 *   - rule editor closed / open with prefilled values
 *   - rule editor mid-edit + error
 *   - version history drawer empty / populated
 *   - success / error toast
 */

const mockRules = [
  {
    id: 'r1',
    rule_key: 'discharge.docs.discharge_summary',
    stage_key: 'discharge',
    required_doc_category: 'discharge_summary',
    severity: 'blocker' as const,
    scope: {},
    version: 3,
    is_active: true,
  },
  {
    id: 'r2',
    rule_key: 'admission.docs.indoor_case_paper',
    stage_key: 'admission',
    required_doc_category: 'indoor_case_paper',
    severity: 'warning' as const,
    scope: { panel_id: 'panel-12' },
    version: 1,
    is_active: true,
  },
  {
    id: 'r3',
    rule_key: 'preauth.fields.diagnosis',
    stage_key: 'pre_auth',
    required_doc_category: 'pre_auth_form',
    severity: 'info' as const,
    scope: { insurer_id: 'insurer-9', procedure_code: 'C0091' },
    version: 2,
    is_active: false,
  },
];

const mockHistory: RuleVersion[] = [
  {
    id: 'h1',
    rule_key: 'discharge.docs.discharge_summary',
    target_stage: 'discharge',
    required_doc_category: 'discharge_summary',
    severity: 'blocker',
    version: 3,
    is_active: true,
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updated_by: 'admin@finclarity.co',
  },
  {
    id: 'h2',
    rule_key: 'discharge.docs.discharge_summary',
    target_stage: 'discharge',
    required_doc_category: 'discharge_summary',
    severity: 'warning',
    version: 2,
    is_active: false,
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    updated_by: 'admin@finclarity.co',
  },
  {
    id: 'h3',
    rule_key: 'discharge.docs.discharge_summary',
    target_stage: 'discharge',
    required_doc_category: 'discharge_summary',
    severity: 'warning',
    version: 1,
    is_active: false,
    updated_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60).toISOString(),
  },
];

function severityOntology(sev: string) {
  if (sev === 'blocker') return 'deficiency_type' as const;
  if (sev === 'warning') return 'deduction_reason' as const;
  return undefined;
}

function summarizeScope(scope: any): string {
  const parts: string[] = [];
  if (scope?.panel_id) parts.push(`panel:${scope.panel_id}`);
  if (scope?.insurer_id) parts.push(`insurer:${scope.insurer_id}`);
  if (scope?.procedure_code) parts.push(`proc:${scope.procedure_code}`);
  return parts.length === 0 ? 'global' : parts.join(' · ');
}

const RulesConfiguratorDemo: React.FC = () => {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<any>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [emptyHistory, setEmptyHistory] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const flash = (kind: 'ok' | 'err', msg: string) => {
    setToast({ kind, msg });
    setTimeout(() => setToast(null), 2000);
  };

  const handleSubmit = async (v: RuleFormValue) => {
    if (v.rule_key.includes('fail')) {
      throw new Error('Demo error: rule_key contains "fail"');
    }
    flash('ok', `Rule "${v.rule_key}" saved`);
    setEditorOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <header>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
            RulesConfigurator — demo states
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Not routed. Mock data. Use rule_key "fail" to trigger an error.
          </p>
        </header>

        {toast && (
          <div
            className={
              'rounded-md border px-3 py-2 text-sm ' +
              (toast.kind === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300')
            }
          >
            {toast.msg}
          </div>
        )}

        <Section title="Rules table — populated">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/60">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Rule key</th>
                  <th className="text-left font-medium px-3 py-2">Stage</th>
                  <th className="text-left font-medium px-3 py-2">Doc</th>
                  <th className="text-left font-medium px-3 py-2">Severity</th>
                  <th className="text-left font-medium px-3 py-2">Scope</th>
                  <th className="text-left font-medium px-3 py-2">v</th>
                  <th className="text-left font-medium px-3 py-2">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60">
                {mockRules.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs">{r.rule_key}</td>
                    <td className="px-3 py-2">
                      <CategoryPill category={r.stage_key} ontologyCategory="stage" size="xs" />
                    </td>
                    <td className="px-3 py-2">
                      <CategoryPill
                        category={r.required_doc_category}
                        ontologyCategory="doc_category"
                        size="xs"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <CategoryPill
                        category={r.severity}
                        ontologyCategory={severityOntology(r.severity)}
                        size="xs"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600 dark:text-slate-300">
                      {summarizeScope(r.scope)}
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums">{r.version}</td>
                    <td className="px-3 py-2 text-xs">
                      <span
                        className={
                          r.is_active
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-slate-400 dark:text-slate-500'
                        }
                      >
                        {r.is_active ? 'active' : 'inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Rules table — empty">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-6">
            <div className="text-xs text-slate-500 dark:text-slate-400 italic">
              No rules match the current filter.
            </div>
          </div>
        </Section>

        <Section title="RuleEditor — open dialogs">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setEditorInitial(null);
                setEditorOpen(true);
              }}
              className="text-xs px-3 py-1.5 rounded bg-slate-900 text-white dark:bg-white dark:text-slate-900"
            >
              Open empty (create)
            </button>
            <button
              type="button"
              onClick={() => {
                setEditorInitial(mockRules[0]);
                setEditorOpen(true);
              }}
              className="text-xs px-3 py-1.5 rounded bg-slate-900 text-white dark:bg-white dark:text-slate-900"
            >
              Open prefilled (edit)
            </button>
            <button
              type="button"
              onClick={() => {
                setEditorInitial(mockRules[2]);
                setEditorOpen(true);
              }}
              className="text-xs px-3 py-1.5 rounded bg-slate-900 text-white dark:bg-white dark:text-slate-900"
            >
              Open scoped rule
            </button>
          </div>
        </Section>

        <Section title="RuleVersionHistory drawer">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setEmptyHistory(false);
                setHistoryOpen(true);
              }}
              className="text-xs px-3 py-1.5 rounded bg-slate-900 text-white dark:bg-white dark:text-slate-900"
            >
              Open populated
            </button>
            <button
              type="button"
              onClick={() => {
                setEmptyHistory(true);
                setHistoryOpen(true);
              }}
              className="text-xs px-3 py-1.5 rounded bg-slate-900 text-white dark:bg-white dark:text-slate-900"
            >
              Open empty
            </button>
          </div>
        </Section>

        <RuleEditor
          open={editorOpen}
          initial={editorInitial}
          onClose={() => setEditorOpen(false)}
          onSubmit={handleSubmit}
        />

        <RuleVersionHistory
          open={historyOpen}
          ruleKey="discharge.docs.discharge_summary"
          versions={emptyHistory ? [] : mockHistory}
          onClose={() => setHistoryOpen(false)}
        />
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2">
    <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{title}</h2>
    <div>{children}</div>
  </section>
);

export default RulesConfiguratorDemo;
