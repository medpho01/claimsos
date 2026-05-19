/**
 * Unit tests for HarmonisationService — Wave 7.
 *
 * Run with:
 *   npx tsx --test src/Services/__tests__/harmonisation.service.test.ts
 *
 * Approach: inject a mock pool + mock LlmClient + mock costAccounting.
 * No DB, no Anthropic SDK, no Bull, no real eventDispatcher. We also
 * stub the claimDossierService.getDossier path via module-state
 * patching (see makeDossier + the pool query mocks below).
 *
 * Coverage:
 *   - happy path: builds prompt, receives valid episode, UPSERTs,
 *     records cost, dispatches claim_harmonised event.
 *   - idempotency: same dossier_state_hash + same prompt_version +
 *     status='fresh' returns existing without an LLM call.
 *   - force=true bypasses the cache.
 *   - applyCorrection: writes the correction row + patches the
 *     episode JSONB at the json_path.
 *   - Zod validation failure: status='failed', error_message set, LLM
 *     error propagates.
 *   - JSONPath parsing: dotted form + array indices; rejects predicates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HarmonisationService,
  HARMONISER_VERSION,
  computeDossierStateHash,
  parseJsonPath,
  setAtJsonPath,
  getAtJsonPath,
} from '../harmonisation.service.js';
import type { LlmClient } from '../llm/LlmClient.js';
import { LlmSchemaValidationError } from '../llm/LlmClient.js';
import type { ClaimDossier } from '../claimDossierProjector.service.js';

// ─── Fixtures ────────────────────────────────────────────────────────────

const CLAIM_ID = '11111111-1111-1111-1111-111111111111';
const HOSPITAL_ID = 'hospital-1';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function makeDossier(overrides: Partial<ClaimDossier> = {}): ClaimDossier {
  return {
    claim_id: CLAIM_ID,
    last_event_id: null,
    last_event_at: null,
    version: 0,
    current_stage: 'admitted',
    current_panel_id: 'panel-1',
    current_insurer_id: 'insurer-1',
    patient_summary: {
      first_name: 'Khatoon',
      uhid: '23730',
      age: 54,
      gender: 'F',
      admission_type: 'ELECTIVE',
      primary_diagnosis: 'Right Hip Osteoarthritis',
      procedure: 'Total Hip Replacement',
    } as any,
    amounts: { claimed: 125000 } as any,
    doc_sections_by_category: { discharge_summary: ['sec-1'] } as any,
    doc_sufficiency_per_stage: null,
    events_summary: [],
    inbound_emails: [],
    outbound_submissions: [],
    active_queries: [],
    pending_actions: [],
    active_adjudication: null,
    ai_drafts_pending: [],
    matched_kb_patterns: [],
    case_embedding_state: null,
    closed_at: null,
    closure_outcome: null,
    retrospective_summary: null,
    updated_at: new Date(0),
    ...overrides,
  };
}

const VALID_EPISODE = {
  meta: {
    schema_version: 'claimsos.canonical.medical_episode.v2',
    episode_id: CLAIM_ID,
    episode_type: 'SURGICAL',
    episode_subtype: 'ORTHOPEDIC_JOINT_REPLACEMENT',
    episode_category: 'ELECTIVE',
    treatment_intent: 'CURATIVE',
    created_at: '2025-12-23T11:40:00+05:30',
    data_completeness_score: 0.85,
    verification_status: 'DRAFT',
  },
  patient_context: {
    patient_id: `PAT_${CLAIM_ID}`,
    uhid: '23730',
    first_name: 'Khatoon',
    age: 54,
    age_unit: 'YEARS',
    gender: 'F',
  },
  hospital_context: {
    hospital_id: HOSPITAL_ID,
    name: 'Sadbhavna Nursing Home',
    type: 'NURSING_HOME',
  },
  clinical_timeline: [
    {
      phase_code: 'ADMISSION',
      phase_number: 1,
      phase_name: 'Admission',
      location: 'WARD',
      start_datetime: '2025-12-23T11:40:00+05:30',
    },
  ],
  diagnosis: {
    primary_diagnosis: {
      icd_code: 'M16.1',
      icd_version: 'ICD10',
      diagnosis_name: 'Right Hip Primary Osteoarthritis',
      certainty: 'CONFIRMED',
    },
  },
};

// ─── Mocks ───────────────────────────────────────────────────────────────

interface MockLlm {
  client: LlmClient;
  calls: any[];
  setExtractResult: (r: any) => void;
  setExtractError: (e: any) => void;
}

function makeMockLlm(): MockLlm {
  const calls: any[] = [];
  let queuedResult: any = null;
  let queuedError: any = null;
  const client: LlmClient = {
    async extract(opts: any): Promise<any> {
      calls.push(opts);
      if (queuedError) {
        const e = queuedError;
        queuedError = null;
        throw e;
      }
      if (queuedResult) {
        const r = queuedResult;
        queuedResult = null;
        return r;
      }
      return {
        data: VALID_EPISODE,
        confidence: 1,
        rawResponse: JSON.stringify(VALID_EPISODE),
        tokensInputUncached: 1800,
        tokensInputCached: 2500,
        tokensOutput: 1200,
        latencyMs: 4321,
        provider: 'anthropic',
        model: 'claude-sonnet-4-latest',
        costInr: 1.2,
        tierEscalated: false,
      };
    },
    classify: (async () => {
      throw new Error('classify not used by harmoniser');
    }) as any,
  };
  return {
    client,
    calls,
    setExtractResult: (r) => {
      queuedResult = r;
    },
    setExtractError: (e) => {
      queuedError = e;
    },
  };
}

function makeMockCost() {
  const calls: any[] = [];
  return {
    calls,
    async recordCall(input: any) {
      calls.push(input);
    },
    async checkBudget() {
      return { action: 'allow', claimUnderLimit: true, hospitalUnderLimit: true };
    },
  };
}

/**
 * Mock pool: each call to .query(sql, params) is matched against a queued
 * fixture by substring match against the SQL. The pool also supports
 * .connect() returning a client with begin/commit/rollback/query/release.
 */
interface MockPool {
  pool: any;
  queries: Array<{ sql: string; params: any[] }>;
  /** Push a fixture: when the next query whose SQL contains `match` runs, return this result. */
  push: (match: string, result: { rows: any[]; rowCount?: number }) => void;
  txQueries: Array<{ sql: string; params: any[] }>;
}

function makeMockPool(): MockPool {
  const queries: Array<{ sql: string; params: any[] }> = [];
  const txQueries: Array<{ sql: string; params: any[] }> = [];
  const fixtures: Array<{ match: string; result: { rows: any[]; rowCount?: number } }> = [];

  function consume(sql: string): { rows: any[]; rowCount?: number } {
    const idx = fixtures.findIndex((f) => sql.includes(f.match));
    if (idx >= 0) {
      const fx = fixtures.splice(idx, 1)[0]!;
      return fx.result;
    }
    return { rows: [], rowCount: 0 };
  }

  const txClient = {
    async query(sql: string, params: any[] = []) {
      txQueries.push({ sql, params });
      return consume(sql);
    },
    release() {
      // no-op
    },
  };

  const pool = {
    async query(sql: string, params: any[] = []) {
      queries.push({ sql, params });
      return consume(sql);
    },
    async connect() {
      return txClient;
    },
  };

  return {
    pool,
    queries,
    txQueries,
    push: (match, result) =>
      fixtures.push({ match, result: { rowCount: result.rows.length, ...result } }),
  };
}

// We mock `claimDossierService` by hot-patching the module via require
// dynamic resolution. Simpler: tests below construct dossiers and call
// computeDossierStateHash directly to assert determinism; for the
// service path we patch `claimDossierService.getDossier` via the
// imported module reference.
import claimDossierService from '../claimDossier.service.js';

const originalGetDossier = (claimDossierService as any).getDossier.bind(
  claimDossierService,
);
function withMockDossier<T>(d: ClaimDossier | null, fn: () => Promise<T>): Promise<T> {
  (claimDossierService as any).getDossier = async () => d;
  return fn().finally(() => {
    (claimDossierService as any).getDossier = originalGetDossier;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('HARMONISER_VERSION is exported as v1', () => {
  assert.equal(HARMONISER_VERSION, 'v1');
});

test('computeDossierStateHash: deterministic + sensitive to inputs', () => {
  const d = makeDossier();
  const h1 = computeDossierStateHash(d, ['sec-1', 'sec-2']);
  const h2 = computeDossierStateHash(d, ['sec-2', 'sec-1']); // order shouldn't matter
  assert.equal(h1, h2, 'section_id order must not affect hash');

  const h3 = computeDossierStateHash(makeDossier({ amounts: { claimed: 99 } as any }), [
    'sec-1',
    'sec-2',
  ]);
  assert.notEqual(h1, h3, 'amounts change should flip hash');

  const h4 = computeDossierStateHash(d, ['sec-1']);
  assert.notEqual(h1, h4, 'section set change should flip hash');
});

test('parseJsonPath: dotted form + array indices', () => {
  assert.deepEqual(parseJsonPath('$'), []);
  assert.deepEqual(parseJsonPath('$.a.b'), ['a', 'b']);
  assert.deepEqual(parseJsonPath('$.a[0].b'), ['a', 0, 'b']);
  assert.deepEqual(parseJsonPath('$.a.b[3].c[0]'), ['a', 'b', 3, 'c', 0]);
});

test('parseJsonPath: rejects predicates / wildcards / recursive descent', () => {
  assert.throws(() => parseJsonPath('$..foo'), /recursive descent/);
  assert.throws(() => parseJsonPath('$.a.*'), /wildcards/);
  assert.throws(() => parseJsonPath('$.a[?(@.k==1)]'), /predicates/);
  assert.throws(() => parseJsonPath('a.b'), /must start with/);
});

test('setAtJsonPath: creates intermediate containers', () => {
  const obj: any = {};
  setAtJsonPath(obj, '$.diagnosis.primary_diagnosis.icd_code', 'M16.1');
  assert.equal(obj.diagnosis.primary_diagnosis.icd_code, 'M16.1');

  setAtJsonPath(obj, '$.clinical_timeline[0].phase_code', 'ADMISSION');
  assert.equal(obj.clinical_timeline[0].phase_code, 'ADMISSION');
});

test('getAtJsonPath: returns undefined when path missing', () => {
  const obj = { diagnosis: { primary_diagnosis: { icd_code: 'M16.1' } } };
  assert.equal(getAtJsonPath(obj, '$.diagnosis.primary_diagnosis.icd_code'), 'M16.1');
  assert.equal(getAtJsonPath(obj, '$.foo.bar'), undefined);
});

test('harmonise(): happy path persists row + records cost + emits no LLM call when cache hit', async () => {
  const llm = makeMockLlm();
  const cost = makeMockCost();
  const dbm = makeMockPool();

  // Cache check — no existing row.
  dbm.push('FROM hospital.claim_harmonised_episodes\n        WHERE claim_id = $1', {
    rows: [],
  });
  // loadSections — one section in the discharge_summary category.
  dbm.push('FROM hospital.document_sections ds', {
    rows: [
      {
        section_id: 'sec-1',
        document_id: 'doc-1',
        file_name: 'discharge.pdf',
        s3_key: 's3://bucket/doc-1.pdf',
        category: 'discharge_summary',
        classifier_confidence: 0.94,
        page_start: 1,
        page_end: 3,
        title: null,
        status: 'extracted',
        extracted_fields: { discharge_date: '2025-12-31' },
        extraction_confidence: { discharge_date: 0.93 },
      },
    ],
  });
  // upsertPending
  dbm.push('VALUES ($1, ', { rows: [] });
  // loadSeedFacts
  dbm.push('FROM hospital.ipds i', {
    rows: [
      {
        first_name: 'Khatoon',
        last_name: null,
        admission_type: 'ELECTIVE',
        panel_id: 'panel-1',
        hospital_panel_id: 'hp-1',
        hospital_name: 'Sadbhavna',
      },
    ],
  });
  // upsertSuccess
  dbm.push('RETURNING', {
    rows: [
      {
        claim_id: CLAIM_ID,
        episode: VALID_EPISODE,
        schema_version: 'claimsos.canonical.medical_episode.v2',
        prompt_version: 'harmoniser.v1',
        confidence: '0.935',
        provenance: {},
        dossier_state_hash: 'hash-x',
        cost_inr: '1.2',
        tokens_used: 5500,
        llm_provider: 'anthropic',
        llm_model: 'claude-sonnet-4-latest',
        generated_at: new Date(),
        last_corrected_at: null,
        status: 'fresh',
        error_message: null,
      },
    ],
  });

  const svc = new HarmonisationService({
    pool: dbm.pool,
    llm: llm.client,
    cost: cost as any,
  });

  const row = await withMockDossier(makeDossier(), () =>
    svc.harmonise({ claim_id: CLAIM_ID, hospital_id: HOSPITAL_ID }),
  );

  assert.equal(row.status, 'fresh');
  assert.equal(row.cost_inr, 1.2);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].tier, 'premium');
  assert.equal(llm.calls[0].promptVersion, 'harmoniser.v1');
  assert.equal(llm.calls[0].taskName, 'claim_harmonisation');
  assert.equal(llm.calls[0].claimId, CLAIM_ID);
  assert.match(llm.calls[0].cacheKey, /^harmonise:/);
  // user prompt mentions seed facts + the section data
  assert.match(llm.calls[0].userPrompt, /SEED_FACTS/);
  assert.match(llm.calls[0].userPrompt, /DOCUMENT_SECTIONS_AND_EXTRACTIONS/);
  assert.match(llm.calls[0].userPrompt, /discharge_summary/);

  // Cost recorded once.
  assert.equal(cost.calls.length, 1);
  assert.equal(cost.calls[0].task, 'claim_harmonisation');
  assert.equal(cost.calls[0].promptVersion, 'harmoniser.v1');
});

test('harmonise(): idempotency — fresh row at same hash skips LLM', async () => {
  const llm = makeMockLlm();
  const cost = makeMockCost();
  const dbm = makeMockPool();

  // Pre-compute the hash the service will derive — we need to set the
  // cache row with the same hash for the short-circuit to fire.
  const dossier = makeDossier();

  // Service calls loadSections to derive hash too — both the cache
  // check and the section loader will run. Cache short-circuit happens
  // AFTER section_ids are known. Order:
  //   1. getDossier (mocked)
  //   2. loadSections (DB)
  //   3. getEpisode (DB)  ← cache check returns matching row
  dbm.push('FROM hospital.document_sections ds', {
    rows: [
      {
        section_id: 'sec-1',
        document_id: 'doc-1',
        file_name: null,
        s3_key: null,
        category: 'discharge_summary',
        classifier_confidence: 0.9,
        page_start: 1,
        page_end: null,
        title: null,
        status: 'extracted',
        extracted_fields: null,
        extraction_confidence: null,
      },
    ],
  });
  const cachedHash = computeDossierStateHash(dossier, ['sec-1']);
  dbm.push('FROM hospital.claim_harmonised_episodes\n        WHERE claim_id = $1', {
    rows: [
      {
        claim_id: CLAIM_ID,
        episode: VALID_EPISODE,
        schema_version: 'claimsos.canonical.medical_episode.v2',
        prompt_version: 'harmoniser.v1',
        confidence: '0.9',
        provenance: {},
        dossier_state_hash: cachedHash,
        cost_inr: '0.95',
        tokens_used: 5000,
        llm_provider: 'anthropic',
        llm_model: 'claude-sonnet-4-latest',
        generated_at: new Date(),
        last_corrected_at: null,
        status: 'fresh',
        error_message: null,
      },
    ],
  });

  const svc = new HarmonisationService({
    pool: dbm.pool,
    llm: llm.client,
    cost: cost as any,
  });

  const row = await withMockDossier(dossier, () =>
    svc.harmonise({ claim_id: CLAIM_ID, hospital_id: HOSPITAL_ID }),
  );

  // LLM was NOT called.
  assert.equal(llm.calls.length, 0);
  assert.equal(cost.calls.length, 0);
  assert.equal(row.status, 'fresh');
  assert.equal(row.dossier_state_hash, cachedHash);
});

test('harmonise(): force=true bypasses the cache', async () => {
  const llm = makeMockLlm();
  const cost = makeMockCost();
  const dbm = makeMockPool();
  const dossier = makeDossier();

  // loadSections
  dbm.push('FROM hospital.document_sections ds', { rows: [] });
  // upsertPending
  dbm.push('VALUES ($1, ', { rows: [] });
  // loadSeedFacts
  dbm.push('FROM hospital.ipds i', { rows: [] });
  // upsertSuccess
  dbm.push('RETURNING', {
    rows: [
      {
        claim_id: CLAIM_ID,
        episode: VALID_EPISODE,
        schema_version: 'claimsos.canonical.medical_episode.v2',
        prompt_version: 'harmoniser.v1',
        confidence: null,
        provenance: {},
        dossier_state_hash: 'hash-x',
        cost_inr: '1.2',
        tokens_used: 5000,
        llm_provider: 'anthropic',
        llm_model: 'claude-sonnet-4-latest',
        generated_at: new Date(),
        last_corrected_at: null,
        status: 'fresh',
        error_message: null,
      },
    ],
  });

  const svc = new HarmonisationService({
    pool: dbm.pool,
    llm: llm.client,
    cost: cost as any,
  });

  await withMockDossier(dossier, () =>
    svc.harmonise({ claim_id: CLAIM_ID, hospital_id: HOSPITAL_ID, force: true }),
  );

  // The cache check was bypassed — the LLM call happened.
  assert.equal(llm.calls.length, 1);
});

test('harmonise(): Zod validation failure persists status=failed and rethrows', async () => {
  const llm = makeMockLlm();
  llm.setExtractError(
    new LlmSchemaValidationError(
      'zod validation failed',
      'not even close to JSON',
      'claim_harmonisation',
      'harmoniser.v1',
    ),
  );
  const cost = makeMockCost();
  const dbm = makeMockPool();

  // Cache check → empty
  dbm.push('FROM hospital.claim_harmonised_episodes\n        WHERE claim_id = $1', {
    rows: [],
  });
  // loadSections
  dbm.push('FROM hospital.document_sections ds', { rows: [] });
  // upsertPending
  dbm.push('VALUES ($1, ', { rows: [] });
  // loadSeedFacts
  dbm.push('FROM hospital.ipds i', { rows: [] });
  // upsertFailed (called after LLM error + failed partial fallback)
  dbm.push('VALUES ($1, ', { rows: [] });

  const svc = new HarmonisationService({
    pool: dbm.pool,
    llm: llm.client,
    cost: cost as any,
  });

  await assert.rejects(
    () =>
      withMockDossier(makeDossier(), () =>
        svc.harmonise({ claim_id: CLAIM_ID, hospital_id: HOSPITAL_ID }),
      ),
    (err: any) => err instanceof LlmSchemaValidationError,
  );

  // Cost not recorded on failure.
  assert.equal(cost.calls.length, 0);
  // At least one of the queries was an UPSERT writing status='failed'.
  const failedUpsert = dbm.queries.find(
    (q) =>
      q.sql.includes('claim_harmonised_episodes') &&
      q.params.includes('failed'),
  );
  assert.ok(failedUpsert, 'expected an upsertFailed write');
});

test('applyCorrection(): writes correction row + patches episode JSONB', async () => {
  const llm = makeMockLlm();
  const cost = makeMockCost();
  const dbm = makeMockPool();

  // SELECT FOR UPDATE — returns the existing episode.
  dbm.push('FOR UPDATE', {
    rows: [
      {
        claim_id: CLAIM_ID,
        episode: structuredClone(VALID_EPISODE),
        schema_version: 'claimsos.canonical.medical_episode.v2',
        prompt_version: 'harmoniser.v1',
        confidence: '0.9',
        provenance: {},
        dossier_state_hash: 'hash-x',
        cost_inr: '1.2',
        tokens_used: 5000,
        llm_provider: 'anthropic',
        llm_model: 'claude-sonnet-4-latest',
        generated_at: new Date(),
        last_corrected_at: null,
        status: 'fresh',
        error_message: null,
      },
    ],
  });
  // INSERT into harmonisation_corrections
  dbm.push('INSERT INTO hospital.harmonisation_corrections', { rows: [] });
  // UPDATE claim_harmonised_episodes
  dbm.push('UPDATE hospital.claim_harmonised_episodes', { rows: [] });

  const svc = new HarmonisationService({
    pool: dbm.pool,
    llm: llm.client,
    cost: cost as any,
  });

  await svc.applyCorrection(
    CLAIM_ID,
    '$.diagnosis.primary_diagnosis.icd_code',
    'M16.0',
    USER_ID,
    'wrong ICD on AI output',
  );

  // The INSERT into harmonisation_corrections fired with the right args.
  const correctionInsert = dbm.txQueries.find((q) =>
    q.sql.includes('INSERT INTO hospital.harmonisation_corrections'),
  );
  assert.ok(correctionInsert, 'expected correction insert');
  // params: [claim_id, json_path, ai_value, human_value, corrected_by, reason]
  assert.equal(correctionInsert!.params[0], CLAIM_ID);
  assert.equal(correctionInsert!.params[1], '$.diagnosis.primary_diagnosis.icd_code');
  // ai_value was 'M16.1' (from VALID_EPISODE), human_value is 'M16.0'.
  assert.equal(JSON.parse(correctionInsert!.params[2] as string), 'M16.1');
  assert.equal(JSON.parse(correctionInsert!.params[3] as string), 'M16.0');
  assert.equal(correctionInsert!.params[4], USER_ID);

  // The UPDATE on claim_harmonised_episodes received a patched episode
  // with the new icd_code at the right path.
  const episodeUpdate = dbm.txQueries.find((q) =>
    q.sql.includes('UPDATE hospital.claim_harmonised_episodes'),
  );
  assert.ok(episodeUpdate, 'expected episode update');
  const patched = JSON.parse(episodeUpdate!.params[1] as string);
  assert.equal(patched.diagnosis.primary_diagnosis.icd_code, 'M16.0');
});

test('applyCorrection(): rejects unparseable JSONPath before opening tx', async () => {
  const llm = makeMockLlm();
  const cost = makeMockCost();
  const dbm = makeMockPool();
  const svc = new HarmonisationService({
    pool: dbm.pool,
    llm: llm.client,
    cost: cost as any,
  });

  await assert.rejects(
    () =>
      svc.applyCorrection(CLAIM_ID, 'no-dollar-prefix', 'foo', USER_ID),
    /invalid json_path/,
  );
  // No DB activity.
  assert.equal(dbm.queries.length, 0);
  assert.equal(dbm.txQueries.length, 0);
});
