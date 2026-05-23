/**
 * Tests for RulesEngine (Wave 3A — Sprint 3).
 *
 * Runner: node:test (matches the rest of Backend's test suite). Execute with:
 *   npx tsx --test src/Services/__tests__/rulesEngine.test.ts
 *
 * The service takes its pool via a deps-bag constructor, so we pass a
 * programmable pool stub and assert on the returned RuleEvaluationResult.
 * We deliberately avoid a generic spy library — the matchers are inline and
 * the assertions are explicit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RulesEngine,
  RuleEvaluationInput,
  PoolLike,
} from '../rulesEngine.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-1111-1111-111111111111';
const PANEL_A  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PANEL_B  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface FakeRule {
  id: string;
  rule_key: string;
  target_stage: string;
  required_doc_category?: string | null;
  required_fields?: any | null;
  severity: 'blocking' | 'warning' | 'info';
  scope_global?: boolean;
  scope_panel_id?: string | null;
  scope_insurer_id?: string | null;
  scope_procedure_code?: string | null;
  scope_diagnosis_class?: string | null;
  version?: number;
}

function mkRule(r: FakeRule) {
  return {
    id: r.id,
    rule_key: r.rule_key,
    target_stage: r.target_stage,
    required_doc_category: r.required_doc_category ?? null,
    required_fields: r.required_fields ?? null,
    severity: r.severity,
    scope_global: r.scope_global ?? false,
    scope_panel_id: r.scope_panel_id ?? null,
    scope_insurer_id: r.scope_insurer_id ?? null,
    scope_procedure_code: r.scope_procedure_code ?? null,
    scope_diagnosis_class: r.scope_diagnosis_class ?? null,
    version: r.version ?? 1,
  };
}

interface SectionRow {
  category: string;
  extracted_fields: Record<string, unknown> | null;
}

function makePool(rules: any[], sections: SectionRow[] = []): PoolLike & { calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool: any = {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/FROM hospital\.stage_requirements/i.test(sql)) {
        return { rows: rules, rowCount: rules.length };
      }
      if (/FROM hospital\.document_sections/i.test(sql)) {
        return { rows: sections, rowCount: sections.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function baseInput(overrides: Partial<RuleEvaluationInput> = {}): RuleEvaluationInput {
  return {
    claim_id: CLAIM_ID,
    target_stage: 'preauth_submitted',
    dossier_snapshot: {
      current_panel_id: null,
      current_insurer_id: null,
      doc_sections_by_category: {},
    },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

test('global rule passes when required doc is present', async () => {
  const pool = makePool([
    mkRule({
      id: 'rule-1',
      rule_key: 'pre_auth.requires.diagnosis_summary',
      target_stage: 'preauth_submitted',
      required_doc_category: 'diagnosis_summary',
      severity: 'blocking',
      scope_global: true,
    }),
  ]);
  const engine = new RulesEngine({ pool });

  const result = await engine.evaluate(
    baseInput({
      dossier_snapshot: {
        current_panel_id: null,
        current_insurer_id: null,
        doc_sections_by_category: { diagnosis_summary: ['sec-1'] },
      },
    })
  );

  assert.equal(result.ready, true);
  assert.equal(result.readiness_score, 100);
  assert.equal(result.blocking_gaps.length, 0);
  assert.equal(result.evaluated_rules.length, 1);
  assert.equal(result.evaluated_rules[0]!.passed, true);
  assert.equal(result.scope_resolution.global_rules_applied, 1);
});

test('global blocking rule fails when required doc is absent', async () => {
  const pool = makePool([
    mkRule({
      id: 'rule-2',
      rule_key: 'pre_auth.requires.consent',
      target_stage: 'preauth_submitted',
      required_doc_category: 'consent',
      severity: 'blocking',
      scope_global: true,
    }),
  ]);
  const engine = new RulesEngine({ pool });

  const result = await engine.evaluate(baseInput());

  assert.equal(result.ready, false);
  assert.equal(result.blocking_gaps.length, 1);
  assert.equal(result.blocking_gaps[0]!.rule_key, 'pre_auth.requires.consent');
  assert.equal(result.blocking_gaps[0]!.severity, 'blocking');
  // 100 - 25 = 75
  assert.equal(result.readiness_score, 75);
});

test('panel-specific rule only fires when panel matches', async () => {
  const panelRule = mkRule({
    id: 'rule-panel',
    rule_key: 'panel.specific.consent',
    target_stage: 'preauth_submitted',
    required_doc_category: 'consent',
    severity: 'blocking',
    scope_panel_id: PANEL_A,
  });
  const engine = new RulesEngine({ pool: makePool([panelRule]) });

  // Claim's panel is PANEL_B — rule should be skipped entirely.
  const resB = await engine.evaluate(
    baseInput({
      dossier_snapshot: {
        current_panel_id: PANEL_B,
        current_insurer_id: null,
        doc_sections_by_category: {},
      },
    })
  );
  assert.equal(resB.evaluated_rules.length, 0, 'rule should not apply when panel mismatches');
  assert.equal(resB.ready, true);
  assert.equal(resB.readiness_score, 100);
  assert.equal(resB.scope_resolution.panel_rules_applied, 0);

  // Claim's panel is PANEL_A — rule applies and (since consent missing) fails.
  const engine2 = new RulesEngine({ pool: makePool([panelRule]) });
  const resA = await engine2.evaluate(
    baseInput({
      dossier_snapshot: {
        current_panel_id: PANEL_A,
        current_insurer_id: null,
        doc_sections_by_category: {},
      },
    })
  );
  assert.equal(resA.evaluated_rules.length, 1);
  assert.equal(resA.blocking_gaps.length, 1);
  assert.equal(resA.scope_resolution.panel_rules_applied, 1);
});

test('warning rule does not affect ready but lowers readiness_score', async () => {
  const pool = makePool([
    mkRule({
      id: 'rule-warn',
      rule_key: 'pre_auth.warns.oncologist_consent_if_oncology',
      target_stage: 'preauth_submitted',
      required_doc_category: 'oncologist_consent',
      severity: 'warning',
      scope_diagnosis_class: 'oncology',
    }),
    mkRule({
      id: 'rule-block',
      rule_key: 'pre_auth.requires.consent',
      target_stage: 'preauth_submitted',
      required_doc_category: 'consent',
      severity: 'blocking',
      scope_global: true,
    }),
  ]);

  const engine = new RulesEngine({ pool });
  const result = await engine.evaluate(
    baseInput({
      diagnosis_class: 'oncology',
      dossier_snapshot: {
        current_panel_id: null,
        current_insurer_id: null,
        doc_sections_by_category: { consent: ['sec-c'] }, // blocking passes
      },
    })
  );
  // Warning fires (oncology + oncologist_consent missing) -- ready=true (only warning failed)
  assert.equal(result.ready, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.blocking_gaps.length, 0);
  // 100 - 0*25 - 1*5 = 95
  assert.equal(result.readiness_score, 95);
});

test('readiness_score clamps to 0 with many blocking gaps', async () => {
  const rules = Array.from({ length: 6 }, (_, i) =>
    mkRule({
      id: `rule-${i}`,
      rule_key: `rule.key.${i}`,
      target_stage: 'preauth_submitted',
      required_doc_category: `cat_${i}`,
      severity: 'blocking',
      scope_global: true,
    })
  );
  const pool = makePool(rules);
  const engine = new RulesEngine({ pool });
  const result = await engine.evaluate(baseInput());

  assert.equal(result.blocking_gaps.length, 6);
  // 100 - 6*25 = -50 → clamped to 0
  assert.equal(result.readiness_score, 0);
  assert.equal(result.ready, false);
});

test('diagnosis_class scope is respected when input matches', async () => {
  const oncologyRule = mkRule({
    id: 'rule-onc',
    rule_key: 'pre_auth.warns.oncologist_consent_if_oncology',
    target_stage: 'preauth_submitted',
    required_doc_category: 'oncologist_consent',
    severity: 'warning',
    scope_diagnosis_class: 'oncology',
  });

  // No diagnosis_class on input — rule skipped.
  const engine = new RulesEngine({ pool: makePool([oncologyRule]) });
  const noMatch = await engine.evaluate(baseInput());
  assert.equal(noMatch.evaluated_rules.length, 0);
  assert.equal(noMatch.scope_resolution.diagnosis_rules_applied, 0);

  // diagnosis_class matches — rule applies.
  const engine2 = new RulesEngine({ pool: makePool([oncologyRule]) });
  const match = await engine2.evaluate(baseInput({ diagnosis_class: 'oncology' }));
  assert.equal(match.evaluated_rules.length, 1);
  assert.equal(match.scope_resolution.diagnosis_rules_applied, 1);
  assert.equal(match.warnings.length, 1);
});

test('required_fields check uses document_sections.extracted_fields', async () => {
  const rule = mkRule({
    id: 'rule-fields',
    rule_key: 'pre_auth.requires.diagnosis_field',
    target_stage: 'preauth_submitted',
    required_fields: [
      { field_key: 'primary_diagnosis', allowed_categories: ['diagnosis_summary'] },
    ],
    severity: 'blocking',
    scope_global: true,
  });

  // Section exists but field missing → fail.
  const engineMissing = new RulesEngine({
    pool: makePool(
      [rule],
      [{ category: 'diagnosis_summary', extracted_fields: { unrelated: 'x' } }]
    ),
  });
  const missing = await engineMissing.evaluate(
    baseInput({
      dossier_snapshot: {
        current_panel_id: null,
        current_insurer_id: null,
        doc_sections_by_category: { diagnosis_summary: ['sec-1'] },
      },
    })
  );
  assert.equal(missing.blocking_gaps.length, 1);

  // Field present in an allowed category → pass.
  const enginePresent = new RulesEngine({
    pool: makePool(
      [rule],
      [{ category: 'diagnosis_summary', extracted_fields: { primary_diagnosis: 'Sepsis' } }]
    ),
  });
  const present = await enginePresent.evaluate(
    baseInput({
      dossier_snapshot: {
        current_panel_id: null,
        current_insurer_id: null,
        doc_sections_by_category: { diagnosis_summary: ['sec-1'] },
      },
    })
  );
  assert.equal(present.blocking_gaps.length, 0);
  assert.equal(present.ready, true);
});

test('info rules surface in info bucket and do not affect score', async () => {
  const pool = makePool([
    mkRule({
      id: 'rule-info',
      rule_key: 'pre_auth.info.note',
      target_stage: 'preauth_submitted',
      required_doc_category: 'consent',
      severity: 'info',
      scope_global: true,
    }),
  ]);
  const engine = new RulesEngine({ pool });
  const result = await engine.evaluate(baseInput());
  assert.equal(result.info.length, 1);
  assert.equal(result.blocking_gaps.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.readiness_score, 100);
  assert.equal(result.ready, true);
});

test('mixed blocking + warning gives expected math', async () => {
  const pool = makePool([
    mkRule({
      id: 'b1',
      rule_key: 'b.one',
      target_stage: 'preauth_submitted',
      required_doc_category: 'a',
      severity: 'blocking',
      scope_global: true,
    }),
    mkRule({
      id: 'b2',
      rule_key: 'b.two',
      target_stage: 'preauth_submitted',
      required_doc_category: 'b',
      severity: 'blocking',
      scope_global: true,
    }),
    mkRule({
      id: 'w1',
      rule_key: 'w.one',
      target_stage: 'preauth_submitted',
      required_doc_category: 'c',
      severity: 'warning',
      scope_global: true,
    }),
  ]);
  const engine = new RulesEngine({ pool });
  const result = await engine.evaluate(baseInput());
  assert.equal(result.blocking_gaps.length, 2);
  assert.equal(result.warnings.length, 1);
  // 100 - 2*25 - 1*5 = 45
  assert.equal(result.readiness_score, 45);
  assert.equal(result.ready, false);
});

test('does not query document_sections when no rule needs fields', async () => {
  const pool = makePool([
    mkRule({
      id: 'r1',
      rule_key: 'r.k',
      target_stage: 'preauth_submitted',
      required_doc_category: 'consent',
      severity: 'blocking',
      scope_global: true,
    }),
  ]);
  const engine = new RulesEngine({ pool });
  await engine.evaluate(baseInput());
  const sectionCalls = (pool as any).calls.filter((c: any) =>
    /FROM hospital\.document_sections/i.test(c.sql)
  );
  assert.equal(sectionCalls.length, 0);
});
