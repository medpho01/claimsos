/**
 * Unit tests for EpisodicMemory — Sprint 4, Wave 4B.
 *
 * Runner: node:test (matches the convention in adjudicationEngine.test.ts,
 * actionEngine.test.ts). Run with:
 *
 *   npx tsx --test src/Services/__tests__/episodicMemory.test.ts
 *
 * Everything is mocked: pool, embedder, claimDossier. No DB, no Bull,
 * no Voyage API.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EpisodicMemory,
  buildClaimSummary,
  buildClaimMetadata,
  toPgVectorLiteral,
  parsePgVectorLiteral,
} from '../episodicMemory.service.js';
import type { ClaimDossier } from '../claimDossierProjector.service.js';
import type { Embedder } from '../llm/providers/voyageEmbedder.js';

const CLAIM_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeDossier(overrides: Partial<ClaimDossier> = {}): ClaimDossier {
  return {
    claim_id: CLAIM_ID,
    last_event_id: null,
    last_event_at: null,
    version: 0,
    current_stage: 'admitted',
    current_panel_id: 'panel-1',
    current_insurer_id: 'insurer-1',
    patient_summary: { primary_diagnosis: 'pneumonia', procedure: 'icu_admission' },
    amounts: { claimed: 75000 },
    doc_sections_by_category: { admission: ['s1'], lab: ['s2', 's3'] },
    doc_sufficiency_per_stage: null,
    events_summary: [
      { event_id: 'e1', kind: 'claim_created', at: '2026-05-01T10:00:00Z', actor: null, salient: null },
      { event_id: 'e2', kind: 'doc_uploaded', at: '2026-05-01T11:00:00Z', actor: null, salient: null },
    ],
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

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface PoolStub {
  pool: { query: (sql: string, params?: unknown[]) => Promise<any> };
  calls: QueryCall[];
  setHandler: (
    h: (sql: string, params: unknown[]) => { rowCount: number; rows: any[] } | null,
  ) => void;
}

function makePoolStub(): PoolStub {
  const calls: QueryCall[] = [];
  let handler: (sql: string, params: unknown[]) => { rowCount: number; rows: any[] } | null = () => null;
  return {
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        const r = handler(sql, params);
        return r ?? { rowCount: 0, rows: [] };
      },
    },
    calls,
    setHandler: (h) => {
      handler = h;
    },
  };
}

function makeEmbedderStub(opts?: {
  dim?: number;
  failOnce?: boolean;
}): Embedder & { callCount: number } {
  const dim = opts?.dim ?? 1024;
  let calls = 0;
  let failsLeft = opts?.failOnce ? 1 : 0;
  return {
    get callCount() {
      return calls;
    },
    async embed(texts: string[]) {
      calls += 1;
      if (failsLeft > 0) {
        failsLeft -= 1;
        throw new Error('stub voyage error');
      }
      // Deterministic 'embedding' so test asserts are stable.
      const embeddings = texts.map((t, i) =>
        new Array(dim).fill(0).map((_, j) => (i + 1) * 0.001 + j * 1e-6),
      );
      return {
        embeddings,
        tokensUsed: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
        costInr: 0.002,
      };
    },
  } as any;
}

function makeDossierStub(d: ClaimDossier | null) {
  let calls = 0;
  return {
    get callCount() {
      return calls;
    },
    async getDossier(_id: string) {
      calls += 1;
      return d;
    },
  } as any;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe('buildClaimSummary', () => {
  it('produces a dense structured summary', () => {
    const s = buildClaimSummary(makeDossier());
    assert.ok(s.includes('STAGE: admitted'));
    assert.ok(s.includes('PANEL: panel-1'));
    assert.ok(s.includes('INSURER: insurer-1'));
    assert.ok(s.includes('dx=pneumonia'));
    assert.ok(s.includes('proc=icu_admission'));
    assert.ok(s.includes('claimed=75000'));
    assert.ok(s.includes('admission=1'));
    assert.ok(s.includes('lab=2'));
    assert.ok(s.includes('EVENTS:'));
  });

  it('omits PII (name, uhid) from the summary', () => {
    const s = buildClaimSummary(
      makeDossier({
        patient_summary: {
          name: 'Ravi Kumar',
          uhid: 'UH-9001',
          primary_diagnosis: 'sepsis',
        },
      }),
    );
    assert.ok(!s.includes('Ravi'));
    assert.ok(!s.includes('UH-9001'));
    assert.ok(s.includes('dx=sepsis'));
  });
});

describe('buildClaimMetadata', () => {
  it('bucketizes amounts into coarse INR ranges', () => {
    const m1 = buildClaimMetadata(makeDossier({ amounts: { claimed: 10_000 } }));
    assert.equal(m1.claim_amount_range, '<25k');
    const m2 = buildClaimMetadata(makeDossier({ amounts: { claimed: 2_50_000 } }));
    assert.equal(m2.claim_amount_range, '1L-3L');
    const m3 = buildClaimMetadata(makeDossier({ amounts: { claimed: 15_00_000 } }));
    assert.equal(m3.claim_amount_range, '>10L');
  });

  it('captures panel/insurer/procedure/diagnosis facets', () => {
    const m = buildClaimMetadata(makeDossier());
    assert.equal(m.panel_id, 'panel-1');
    assert.equal(m.insurer_id, 'insurer-1');
    assert.equal(m.procedure_class, 'icu_admission');
    assert.equal(m.diagnosis_class, 'pneumonia');
  });
});

describe('pgvector text-literal helpers', () => {
  it('round-trips a vector', () => {
    const v = [0.1, -0.2, 0.3];
    const lit = toPgVectorLiteral(v);
    assert.equal(lit, '[0.1,-0.2,0.3]');
    const parsed = parsePgVectorLiteral(lit);
    assert.deepEqual(parsed, v);
  });

  it('sanitises NaN/Infinity to 0', () => {
    const v = [Number.NaN, 1, Number.POSITIVE_INFINITY];
    const lit = toPgVectorLiteral(v);
    assert.equal(lit, '[0,1,0]');
  });
});

// ─── embedClaim ──────────────────────────────────────────────────────────

describe('EpisodicMemory.embedClaim', () => {
  it('returns no_dossier when dossier missing', async () => {
    const pool = makePoolStub();
    const embedder = makeEmbedderStub();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(null),
    });
    const r = await svc.embedClaim(CLAIM_ID);
    assert.equal(r.embedded, false);
    assert.equal(r.reason, 'no_dossier');
    assert.equal(embedder.callCount, 0);
  });

  it('skips embed when source_state_hash matches an existing fresh row', async () => {
    const pool = makePoolStub();
    const dossier = makeDossier();
    const embedder = makeEmbedderStub();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(dossier),
    });

    // Predict the hash the service will compute and return a matching row
    // on the SELECT probe.
    const { createHash } = await import('crypto');
    const summary = buildClaimSummary(dossier);
    const hash = createHash('sha256').update(summary).digest('hex');

    pool.setHandler((sql, _params) => {
      if (/SELECT source_state_hash/.test(sql)) {
        return {
          rowCount: 1,
          rows: [
            {
              source_state_hash: hash,
              embedding_version: 'v0',
              status: 'fresh',
            },
          ],
        };
      }
      return null;
    });

    const r = await svc.embedClaim(CLAIM_ID);
    assert.equal(r.embedded, false);
    assert.equal(r.reason, 'unchanged');
    assert.equal(embedder.callCount, 0);
    // No INSERT issued.
    assert.equal(
      pool.calls.some((c) => /INSERT INTO hospital\.case_embeddings/.test(c.sql)),
      false,
    );
  });

  it('embeds and UPSERTs when no existing row', async () => {
    const pool = makePoolStub();
    const dossier = makeDossier();
    const embedder = makeEmbedderStub();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(dossier),
    });
    // SELECT probe finds nothing → embed runs.
    pool.setHandler((_sql, _params) => null);

    const r = await svc.embedClaim(CLAIM_ID);
    assert.equal(r.embedded, true);
    assert.equal(r.reason, 'embedded');
    assert.equal(embedder.callCount, 1);
    const insert = pool.calls.find((c) =>
      /INSERT INTO hospital\.case_embeddings/.test(c.sql),
    );
    assert.ok(insert, 'expected UPSERT issued');
    // params: [claim_id, vectorLiteral, model, version, summary, hash, metadata]
    assert.equal(insert!.params[0], CLAIM_ID);
    assert.equal(typeof insert!.params[1], 'string');
    assert.ok((insert!.params[1] as string).startsWith('['));
    assert.equal(insert!.params[2], 'voyage-3');
    assert.equal(insert!.params[3], 'v0');
  });

  it('force=true bypasses the unchanged-hash short-circuit', async () => {
    const pool = makePoolStub();
    const dossier = makeDossier();
    const embedder = makeEmbedderStub();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(dossier),
    });

    const { createHash } = await import('crypto');
    const summary = buildClaimSummary(dossier);
    const hash = createHash('sha256').update(summary).digest('hex');
    pool.setHandler((sql, _params) => {
      if (/SELECT source_state_hash/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ source_state_hash: hash, embedding_version: 'v0', status: 'fresh' }],
        };
      }
      return null;
    });

    const r = await svc.embedClaim(CLAIM_ID, { force: true });
    assert.equal(r.embedded, true);
    assert.equal(r.reason, 'forced');
    assert.equal(embedder.callCount, 1);
  });

  it('flips status to failed when embedder throws', async () => {
    const pool = makePoolStub();
    const dossier = makeDossier();
    const embedder = makeEmbedderStub({ failOnce: true });
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(dossier),
    });
    pool.setHandler((_sql, _params) => null);

    await assert.rejects(svc.embedClaim(CLAIM_ID));
    const statusUpdates = pool.calls.filter(
      (c) => /SET status = 'failed'/.test(c.sql),
    );
    assert.equal(statusUpdates.length, 1);
  });
});

// ─── retrieve ────────────────────────────────────────────────────────────

describe('EpisodicMemory.retrieve', () => {
  it('builds a WHERE clause with metadata @> for facets and excludes self', async () => {
    const pool = makePoolStub();
    const dossier = makeDossier();
    const embedder = makeEmbedderStub();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(dossier),
    });

    pool.setHandler((sql, _params) => {
      if (/SELECT embedding::text/.test(sql)) {
        // Vector lookup returns the precomputed embedding.
        return {
          rowCount: 1,
          rows: [{ embedding: '[0.1,0.2,0.3]' }],
        };
      }
      if (/FROM hospital\.case_embeddings ce/.test(sql) && /ORDER BY/.test(sql)) {
        // Retrieval returns 3 candidates including self.
        return {
          rowCount: 3,
          rows: [
            // Self first — should be filtered out.
            { claim_id: CLAIM_ID, summary: 'self', metadata: {}, similarity: 0.99, closure_outcome: null, closed_at: null, amounts: null },
            { claim_id: OTHER_ID, summary: 'other', metadata: { panel_id: 'panel-1' }, similarity: 0.81, closure_outcome: 'settled', closed_at: new Date('2026-04-10'), amounts: { claimed: 50000 } },
            { claim_id: '33333333-3333-3333-3333-333333333333', summary: 'third', metadata: {}, similarity: 0.72, closure_outcome: null, closed_at: null, amounts: null },
          ],
        };
      }
      return null;
    });

    const results = await svc.retrieve({
      claim_id: CLAIM_ID,
      dossier,
      k: 5,
      filters: {
        panel_id: 'panel-1',
        insurer_id: 'insurer-1',
        outcome_category: 'settled',
      },
    });

    // Self filtered out.
    assert.equal(results.length, 2);
    assert.equal(results[0]!.claim_id, OTHER_ID);
    assert.equal(results[0]!.outcome.closure_outcome, 'settled');

    // WHERE clause used metadata @> and bound the filter object.
    const retrievalCall = pool.calls.find((c) => /ORDER BY ce\.embedding/.test(c.sql));
    assert.ok(retrievalCall, 'retrieval SQL issued');
    assert.ok(/metadata @> /.test(retrievalCall!.sql));
    // First param is the vector literal, second is the filter jsonb.
    assert.equal(typeof retrievalCall!.params[0], 'string');
    const filterObj = retrievalCall!.params[1] as Record<string, unknown>;
    assert.equal(filterObj.panel_id, 'panel-1');
    assert.equal(filterObj.insurer_id, 'insurer-1');
    assert.equal(filterObj.outcome_category, 'settled');
  });

  it('caps k to MAX_K and uses k+1 in the LIMIT', async () => {
    const pool = makePoolStub();
    const embedder = makeEmbedderStub();
    const dossier = makeDossier();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(dossier),
    });

    pool.setHandler((sql, _params) => {
      if (/SELECT embedding::text/.test(sql)) {
        return { rowCount: 1, rows: [{ embedding: '[0.1,0.2]' }] };
      }
      return null;
    });

    // Way over MAX_K — service should clamp to 20 → LIMIT 21.
    await svc.retrieve({ claim_id: CLAIM_ID, dossier, k: 999 });
    const retrievalCall = pool.calls.find((c) => /ORDER BY ce\.embedding/.test(c.sql));
    assert.ok(retrievalCall);
    assert.ok(/LIMIT 21/.test(retrievalCall!.sql));
  });

  it('falls back to inline embedding when no precomputed row exists', async () => {
    const pool = makePoolStub();
    const embedder = makeEmbedderStub();
    const dossier = makeDossier();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder,
      dossierService: makeDossierStub(dossier),
    });
    // Precomputed lookup returns empty, retrieval returns empty.
    pool.setHandler((_sql, _params) => null);

    const out = await svc.retrieve({ claim_id: CLAIM_ID, dossier, k: 5 });
    // Embedder was called inline for the query.
    assert.equal(embedder.callCount, 1);
    assert.equal(out.length, 0);
  });
});

// ─── markStale ───────────────────────────────────────────────────────────

describe('EpisodicMemory.markStale', () => {
  it('issues an UPDATE setting status=stale', async () => {
    const pool = makePoolStub();
    const svc = new EpisodicMemory({
      pool: pool.pool as any,
      embedder: makeEmbedderStub(),
      dossierService: makeDossierStub(null),
    });

    await svc.markStale(CLAIM_ID);
    const upd = pool.calls.find((c) =>
      /UPDATE hospital\.case_embeddings/.test(c.sql) && /SET status = 'stale'/.test(c.sql),
    );
    assert.ok(upd, 'markStale issued the UPDATE');
    assert.equal(upd!.params[0], CLAIM_ID);
  });

  it('swallows DB errors (non-fatal)', async () => {
    const failingPool = {
      query: async () => {
        throw new Error('boom');
      },
    };
    const svc = new EpisodicMemory({
      pool: failingPool as any,
      embedder: makeEmbedderStub(),
      dossierService: makeDossierStub(null),
    });
    await assert.doesNotReject(svc.markStale(CLAIM_ID));
  });
});
