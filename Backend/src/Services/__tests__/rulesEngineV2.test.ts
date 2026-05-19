/**
 * Tests for RulesEngineV2 (Wave 8 — Sprint Intelligence Layer).
 *
 * Runner: node:test (matches the rest of Backend's test suite). Execute with:
 *   npx tsx --test src/Services/__tests__/rulesEngineV2.test.ts
 *
 * The engine takes its pool, jsonpath evaluator, expr evaluator, and custom
 * function registry through a deps bag. We pass a programmable pool stub
 * plus a hand-rolled minimal JSONPath subset — sufficient to exercise the
 * dispatch logic without dragging the real `jsonpath-plus` package into the
 * unit suite. Production code wires the real packages in `getRulesEngineV2()`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RulesEngineV2,
  type PoolLike,
  type JsonPathFn,
  type ExprEvaluator,
} from '../rulesEngineV2.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-1111-1111-111111111111';
const RULESET_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RULESET_UUID_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface PoolCall {
  sql: string;
  params: unknown[];
}

interface ProgrammablePool extends PoolLike {
  calls: PoolCall[];
}

/**
 * Pool stub that matches on substring of the SQL to keep tests readable.
 * Inserts return {rows: []}. Order of handlers matters (most-specific first).
 */
function makePool(handlers: Array<{ match: RegExp; rows: any[] | (() => any[]) }>): ProgrammablePool {
  const calls: PoolCall[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      for (const h of handlers) {
        if (h.match.test(sql)) {
          const rows = typeof h.rows === 'function' ? h.rows() : h.rows;
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

/**
 * Tiny JSONPath subset:
 *   - $.a.b.c              property walk
 *   - $.a[*].b             star wildcard
 *   - $.a[?(@.x=="y")]     equality filter on direct property
 *
 * Returns the matching values as an array (empty when no match).
 */
const jsonpath: JsonPathFn = (path, json) => {
  if (!path || !json) return [];
  const norm = path.replace(/^\$/, '').replace(/^\.?/, '');
  return walk(norm, [json]);
};

function walk(remaining: string, current: any[]): any[] {
  if (!remaining) return current;
  // Filter
  const filterMatch = /^\[\?\(@\.([\w_]+)==\"([^\"]+)\"\)\](.*)$/.exec(remaining);
  if (filterMatch) {
    const [, prop, val, rest] = filterMatch;
    const filtered: any[] = [];
    for (const c of current) {
      if (Array.isArray(c)) {
        for (const item of c) {
          if (item && String(item[prop!]) === val) filtered.push(item);
        }
      } else if (c && String(c[prop!]) === val) filtered.push(c);
    }
    return walk((rest ?? '').replace(/^\./, ''), filtered);
  }
  // Wildcard
  const wildMatch = /^\[\*\](.*)$/.exec(remaining);
  if (wildMatch) {
    const expanded: any[] = [];
    for (const c of current) {
      if (Array.isArray(c)) expanded.push(...c);
    }
    return walk((wildMatch[1] ?? '').replace(/^\./, ''), expanded);
  }
  // Property
  const propMatch = /^([\w_]+)(.*)$/.exec(remaining);
  if (propMatch) {
    const [, prop, rest] = propMatch;
    const next: any[] = [];
    for (const c of current) {
      if (c && c[prop!] !== undefined) next.push(c[prop!]);
    }
    return walk((rest ?? '').replace(/^\./, ''), next);
  }
  return current;
}

const expr: ExprEvaluator = {
  evaluate(formula, ctx) {
    // Only used in CALCULATION test; supports simple `a + b` on a context map.
    if (formula === '1+2') return 3;
    if (formula === 'x*2' && typeof ctx['x'] === 'number') return (ctx['x'] as number) * 2;
    throw new Error('formula not supported in stub: ' + formula);
  },
};

// ────────────────────────────────────────────────────────────────────────────
// SKIP path: harmonised episode absent
// ────────────────────────────────────────────────────────────────────────────

test('SKIP path: harmonised episode absent → every rule SKIPs with note', async () => {
  const pool = makePool([
    {
      match: /FROM hospital\.ipds/i,
      rows: [{ claim_id: CLAIM_ID, hospital_id: null, insurer_code: 'ACME', episode: null }],
    },
    {
      match: /FROM hospital\.insurer_rule_sets/i,
      rows: [
        {
          id: RULESET_UUID,
          rule_set_id: 'ACME_V1',
          rule_set_name: 'Acme',
          insurer_code: 'ACME',
          applicable_treatments: ['ALL'],
          applicable_specialties: [],
          status: 'live',
          created_at: '2026-01-01',
        },
      ],
    },
    {
      match: /FROM hospital\.insurance_rules/i,
      rows: [
        {
          id: 'r1',
          rule_id: 'R1',
          rule_name: 'Rule 1',
          category: 'DOCUMENT_COMPLETENESS',
          severity: 'CRITICAL',
          impact: 'QUERY',
          mandatory: true,
          validation_logic: { logic_type: 'EXISTENCE_CHECK', json_path: '$.x', operator: 'EXISTS' },
          required_documents: [],
          order_index: 1,
        },
      ],
    },
  ]);

  const engine = new RulesEngineV2({ pool, jsonpath, expr });
  const result = await engine.evaluate(CLAIM_ID);

  assert.equal(result.rule_set_id, 'ACME_V1');
  assert.equal(result.total_rules, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.evaluations[0]!.status, 'SKIP');
  assert.match(result.note ?? '', /harmonised episode/);
  // readiness stays at 100 (SKIP does not deduct).
  assert.equal(result.readiness_score, 100);
});

// ────────────────────────────────────────────────────────────────────────────
// Rule-set resolution: most-specific match wins
// ────────────────────────────────────────────────────────────────────────────

test('rule set resolution: most-specific match wins', async () => {
  const generic = {
    id: RULESET_UUID,
    rule_set_id: 'GENERIC',
    rule_set_name: 'Generic',
    insurer_code: 'ACME',
    applicable_treatments: ['ALL'],
    applicable_specialties: [],
    status: 'live',
    created_at: '2026-01-01',
  };
  const specific = {
    id: RULESET_UUID_2,
    rule_set_id: 'SPECIFIC',
    rule_set_name: 'Specific',
    insurer_code: 'ACME',
    applicable_treatments: ['SURGICAL'],
    applicable_specialties: ['ORTHOPEDICS'],
    status: 'live',
    created_at: '2026-02-01',
  };
  const pool = makePool([
    {
      match: /FROM hospital\.ipds/i,
      rows: [
        {
          claim_id: CLAIM_ID,
          hospital_id: null,
          insurer_code: 'ACME',
          episode: {
            meta: { episode_type: 'SURGICAL' },
            hospital_context: { specialty: 'ORTHOPEDICS' },
          },
        },
      ],
    },
    { match: /FROM hospital\.insurer_rule_sets/i, rows: [generic, specific] },
    { match: /FROM hospital\.insurance_rules/i, rows: [] },
  ]);

  const engine = new RulesEngineV2({ pool, jsonpath, expr });
  const r = await engine.evaluate(CLAIM_ID);
  assert.equal(r.rule_set_id, 'SPECIFIC');
});

test('rule set resolution: returns null when no candidate matches treatment', async () => {
  const onlyOrtho = {
    id: RULESET_UUID,
    rule_set_id: 'ORTHO_ONLY',
    rule_set_name: 'Ortho only',
    insurer_code: 'ACME',
    applicable_treatments: ['SURGICAL'],
    applicable_specialties: ['ORTHOPEDICS'],
    status: 'live',
    created_at: '2026-01-01',
  };
  const pool = makePool([
    {
      match: /FROM hospital\.ipds/i,
      rows: [
        {
          claim_id: CLAIM_ID,
          hospital_id: null,
          insurer_code: 'ACME',
          episode: { meta: { episode_type: 'MATERNITY' }, hospital_context: { specialty: 'OBGYN' } },
        },
      ],
    },
    { match: /FROM hospital\.insurer_rule_sets/i, rows: [onlyOrtho] },
  ]);
  const engine = new RulesEngineV2({ pool, jsonpath, expr });
  const r = await engine.evaluate(CLAIM_ID);
  assert.equal(r.rule_set_id, null);
  assert.equal(r.total_rules, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Logic-type evaluators
// ────────────────────────────────────────────────────────────────────────────

interface BuildOpts {
  rule: any;
  episode?: any;
  extraHandlers?: Array<{ match: RegExp; rows: any[] }>;
}

function buildScenario(opts: BuildOpts) {
  const episode = opts.episode ?? { meta: { episode_type: 'SURGICAL' }, hospital_context: { specialty: 'ORTHO' } };
  return makePool([
    {
      match: /FROM hospital\.ipds/i,
      rows: [{ claim_id: CLAIM_ID, hospital_id: null, insurer_code: 'ACME', episode }],
    },
    {
      match: /FROM hospital\.insurer_rule_sets/i,
      rows: [
        {
          id: RULESET_UUID,
          rule_set_id: 'ACME_V1',
          rule_set_name: 'Acme',
          insurer_code: 'ACME',
          applicable_treatments: ['ALL'],
          applicable_specialties: [],
          status: 'live',
          created_at: '2026-01-01',
        },
      ],
    },
    { match: /FROM hospital\.insurance_rules/i, rows: [opts.rule] },
    ...(opts.extraHandlers ?? []),
  ]);
}

const baseRule = (overrides: Partial<any> = {}) => ({
  id: 'r1',
  rule_id: 'R1',
  rule_name: 'Rule 1',
  category: 'CLINICAL_APPROPRIATENESS',
  severity: 'HIGH',
  impact: 'QUERY',
  mandatory: false,
  validation_logic: {},
  failure_message: 'failed',
  remediation_guidance: null,
  required_documents: [],
  estimated_deduction_amount: null,
  query_template: null,
  order_index: 1,
  ...overrides,
});

test('SIMPLE_COMPARISON: PASS and FAIL paths', async () => {
  const episode = { financial_summary: { total: 100 } };
  const passPool = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'SIMPLE_COMPARISON',
        json_path: '$.financial_summary.total',
        operator: 'LESS_THAN_OR_EQUAL',
        expected_value: 200,
      },
    }),
    episode,
  });
  const pass = await new RulesEngineV2({ pool: passPool, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(pass.evaluations[0]!.status, 'PASS');

  const failPool = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'SIMPLE_COMPARISON',
        json_path: '$.financial_summary.total',
        operator: 'LESS_THAN_OR_EQUAL',
        expected_value: 50,
      },
    }),
    episode,
  });
  const fail = await new RulesEngineV2({ pool: failPool, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(fail.evaluations[0]!.status, 'FAIL');
  // HIGH FAIL → -10
  assert.equal(fail.readiness_score, 90);
});

test('RANGE_CHECK: BETWEEN operator', async () => {
  const episode = { vitals: { hr: 80 } };
  const pool = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'RANGE_CHECK',
        json_path: '$.vitals.hr',
        operator: 'BETWEEN',
        expected_value: [60, 100],
      },
    }),
    episode,
  });
  const r = await new RulesEngineV2({ pool, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(r.evaluations[0]!.status, 'PASS');
});

test('EXISTENCE_CHECK: EXISTS positive and NOT_EXISTS path', async () => {
  const episode = { docs: [{ kind: 'X-RAY' }] };
  const poolPass = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'EXISTENCE_CHECK',
        json_path: '$.docs[?(@.kind=="X-RAY")]',
        operator: 'EXISTS',
      },
    }),
    episode,
  });
  const pass = await new RulesEngineV2({ pool: poolPass, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(pass.evaluations[0]!.status, 'PASS');

  const poolFail = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'EXISTENCE_CHECK',
        json_path: '$.docs[?(@.kind=="MRI")]',
        operator: 'EXISTS',
      },
    }),
    episode,
  });
  const fail = await new RulesEngineV2({ pool: poolFail, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(fail.evaluations[0]!.status, 'FAIL');
});

test('CALCULATION: uses expr evaluator and compares', async () => {
  const pool = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'CALCULATION',
        calculation_formula: '1+2',
        operator: 'EQUALS',
        expected_value: 3,
      },
    }),
  });
  const r = await new RulesEngineV2({ pool, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(r.evaluations[0]!.status, 'PASS');
});

test('CALCULATION: ERROR when expr evaluator missing', async () => {
  const pool = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'CALCULATION',
        calculation_formula: '1+2',
        operator: 'EQUALS',
        expected_value: 3,
      },
    }),
  });
  const r = await new RulesEngineV2({ pool, jsonpath /* no expr */ }).evaluate(CLAIM_ID);
  assert.equal(r.evaluations[0]!.status, 'ERROR');
});

test('LOOKUP_TABLE: master_options ref PASS path', async () => {
  const pool = buildScenario({
    rule: baseRule({
      validation_logic: {
        logic_type: 'LOOKUP_TABLE',
        json_path: '$.code',
        lookup_table_ref: 'master_options:ipd_stage',
      },
    }),
    episode: { code: 'admitted', meta: { episode_type: 'SURGICAL' } },
    extraHandlers: [
      { match: /FROM hospital\.master_options/i, rows: [{ code: 'admitted' }] },
    ],
  });
  const r = await new RulesEngineV2({ pool, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(r.evaluations[0]!.status, 'PASS');
});

test('COMPLEX_CONDITION: custom function PASS', async () => {
  const pool = buildScenario({
    rule: baseRule({
      validation_logic: { logic_type: 'COMPLEX_CONDITION', custom_function: 'always_pass' },
    }),
  });
  const engine = new RulesEngineV2({
    pool,
    jsonpath,
    expr,
    customFunctions: {
      always_pass: async () => ({ status: 'PASS', evidence: { ok: true }, message: null }),
    },
  });
  const r = await engine.evaluate(CLAIM_ID);
  assert.equal(r.evaluations[0]!.status, 'PASS');
  assert.deepEqual(r.evaluations[0]!.evidence, { ok: true });
});

test('COMPLEX_CONDITION: ERROR when custom function not registered', async () => {
  const pool = buildScenario({
    rule: baseRule({
      validation_logic: { logic_type: 'COMPLEX_CONDITION', custom_function: 'does_not_exist_xyz' },
    }),
  });
  const r = await new RulesEngineV2({ pool, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(r.evaluations[0]!.status, 'ERROR');
  assert.match(String(r.evaluations[0]!.evidence?.reason ?? ''), /not registered/);
});

// ────────────────────────────────────────────────────────────────────────────
// Readiness score math
// ────────────────────────────────────────────────────────────────────────────

test('readiness_score: -25 critical, -10 high, -5 medium, -2 low, warning does not deduct', async () => {
  const rules = [
    baseRule({ id: 'r1', rule_id: 'R1', severity: 'CRITICAL', impact: 'QUERY' }),
    baseRule({ id: 'r2', rule_id: 'R2', severity: 'HIGH', impact: 'QUERY' }),
    baseRule({ id: 'r3', rule_id: 'R3', severity: 'MEDIUM', impact: 'QUERY' }),
    baseRule({ id: 'r4', rule_id: 'R4', severity: 'LOW', impact: 'QUERY' }),
    baseRule({ id: 'r5', rule_id: 'R5', severity: 'CRITICAL', impact: 'WARNING' }),
  ].map((r) => ({
    ...r,
    validation_logic: { logic_type: 'EXISTENCE_CHECK', json_path: '$.missing', operator: 'EXISTS' },
  }));
  const pool = makePool([
    {
      match: /FROM hospital\.ipds/i,
      rows: [
        {
          claim_id: CLAIM_ID,
          hospital_id: null,
          insurer_code: 'ACME',
          episode: { meta: { episode_type: 'SURGICAL' } },
        },
      ],
    },
    {
      match: /FROM hospital\.insurer_rule_sets/i,
      rows: [
        {
          id: RULESET_UUID,
          rule_set_id: 'ACME_V1',
          rule_set_name: 'Acme',
          insurer_code: 'ACME',
          applicable_treatments: ['ALL'],
          applicable_specialties: [],
          status: 'live',
          created_at: '2026-01-01',
        },
      ],
    },
    { match: /FROM hospital\.insurance_rules/i, rows: rules },
  ]);
  const r = await new RulesEngineV2({ pool, jsonpath, expr }).evaluate(CLAIM_ID);
  // 100 - 25(critical) - 10(high) - 5(medium) - 2(low) - 0(warning) = 58
  assert.equal(r.readiness_score, 58);
  assert.equal(r.failed, 5);
  assert.equal(r.critical_failures, 1);
});

test('readiness_score: clamped to 0 when many criticals fail', async () => {
  const rules = Array.from({ length: 6 }, (_, i) =>
    ({
      ...baseRule({ id: `r${i}`, rule_id: `R${i}`, severity: 'CRITICAL', impact: 'QUERY' }),
      validation_logic: { logic_type: 'EXISTENCE_CHECK', json_path: '$.missing', operator: 'EXISTS' },
    })
  );
  const pool = makePool([
    {
      match: /FROM hospital\.ipds/i,
      rows: [
        {
          claim_id: CLAIM_ID,
          hospital_id: null,
          insurer_code: 'ACME',
          episode: { meta: { episode_type: 'SURGICAL' } },
        },
      ],
    },
    {
      match: /FROM hospital\.insurer_rule_sets/i,
      rows: [
        {
          id: RULESET_UUID,
          rule_set_id: 'ACME_V1',
          rule_set_name: 'Acme',
          insurer_code: 'ACME',
          applicable_treatments: ['ALL'],
          applicable_specialties: [],
          status: 'live',
          created_at: '2026-01-01',
        },
      ],
    },
    { match: /FROM hospital\.insurance_rules/i, rows: rules },
  ]);
  const r = await new RulesEngineV2({ pool, jsonpath, expr }).evaluate(CLAIM_ID);
  assert.equal(r.readiness_score, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

test('persists one UPSERT per rule into claim_rule_evaluations', async () => {
  const rule = baseRule({
    validation_logic: { logic_type: 'EXISTENCE_CHECK', json_path: '$.x', operator: 'EXISTS' },
  });
  const pool = buildScenario({ rule, episode: { x: 1, meta: { episode_type: 'SURGICAL' } } });
  await new RulesEngineV2({ pool, jsonpath, expr }).evaluate(CLAIM_ID);
  const upserts = pool.calls.filter((c) => /INSERT INTO hospital\.claim_rule_evaluations/i.test(c.sql));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0]!.params[0], CLAIM_ID);
  assert.equal(upserts[0]!.params[2], 'R1'); // rule_id
});
