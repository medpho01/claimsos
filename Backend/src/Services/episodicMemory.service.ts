/**
 * Episodic Memory Service — Sprint 4, Wave 4B
 *
 * The "have we seen this kind of claim before?" layer.
 *
 * Given a current claim's dossier, retrieves the top-k most-similar prior
 * cases (by dense semantic similarity) along with their outcomes. The
 * AdjudicationEngine / ReasoningAgent (wired in Wave 4C) folds these into
 * its reasoning ("of the 5 most similar prior cases, 4 were deducted for
 * X → flag X as a risk on this one").
 *
 * Two operations, both pure DB + embedder calls (no LLM-bridge work):
 *
 *   retrieve()    — read path. Either uses the precomputed embedding for
 *                   the current claim if one exists, or embeds the query
 *                   summary inline. WHERE filters (metadata @> ...) run
 *                   first to shrink the candidate set, then cosine ORDER
 *                   BY LIMIT k+1. Self-exclusion happens in JS.
 *
 *   embedClaim()  — write path. Builds a dense ~500-1500 char summary
 *                   from the dossier, hashes it, and either skips (same
 *                   hash) or UPSERTs the new embedding. Triggered by the
 *                   caseEmbedder queue.
 *
 * Cost shape: voyage-3 at $0.06/M input tokens, ~400 tokens per summary
 * → ~₹0.002 per embed. Even with 5 lifetime re-embeds per claim that's
 * ₹0.01/claim — far below the ₹15 hard cap. Retrieval is pure SQL on the
 * pgvector index, free at scale.
 *
 * Versioning: EPISODIC_VERSION bakes into the embedding_version column.
 * Bumping it forces the backfill cron to consider all rows stale (since
 * the version stored on the row no longer matches the current writer's
 * idea of "fresh"). Used when we change the summary prompt format.
 */

import type { Pool, PoolClient } from 'pg';
import { createHash } from 'crypto';

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import claimDossierService, {
  type ClaimDossier,
} from './claimDossier.service.js';
import costAccounting from './costAccounting.service.js';
import { getEmbedder, type Embedder } from './llm/providers/voyageEmbedder.js';

export const EPISODIC_VERSION = 'v0';
export const EPISODIC_MODEL = 'voyage-3';

// retrieve()'s k bounds. Defaulted small because the model has to read
// every retrieved case as context — 5 is enough signal without bloating
// the prompt; >20 starts to overflow attention even for Sonnet.
const DEFAULT_K = 5;
const MAX_K = 20;

// Summary length envelope. We target ~500-1500 chars (≈ 100-400 tokens)
// so the embed is a meaningful semantic average without being so verbose
// it dilutes the signal.
const SUMMARY_MAX_CHARS = 1500;

type Queryable = Pool | PoolClient;

// ─── Public types ────────────────────────────────────────────────────────

export interface EpisodicRetrievalFilters {
  hospital_id?: string;
  panel_id?: string;
  insurer_id?: string;
  procedure_class?: string;
  diagnosis_class?: string;
  outcome_category?: string;
  /**
   * If set, only return cases that have reached a terminal outcome
   * (settled / rejected / withdrawn). Lets the caller restrict to
   * "cases where we know how this ended".
   */
  min_evidence?: number;
}

export interface EpisodicRetrievalInput {
  /** Current claim — excluded from results. Optional for ad-hoc retrieval. */
  claim_id?: string;
  dossier: ClaimDossier;
  k?: number;
  filters?: EpisodicRetrievalFilters;
}

export interface RetrievedCase {
  claim_id: string;
  /** Cosine similarity in [0, 1] (1 = identical). */
  similarity: number;
  /** The exact text that was embedded for that historical case. */
  summary: string;
  metadata: Record<string, unknown> | null;
  /** Outcome view: amounts + closure_outcome from the dossier projection. */
  outcome: {
    closure_outcome: string | null;
    closed_at: string | null;
    amounts: Record<string, number | null> | null;
  };
}

export interface EmbedClaimResult {
  embedded: boolean;     // false = skipped (hash unchanged)
  tokensUsed: number;
  costInr: number;
  reason?: 'unchanged' | 'no_dossier' | 'embedded' | 'forced';
}

// ─── Service ─────────────────────────────────────────────────────────────

interface ServiceDeps {
  pool?: Queryable;
  embedder?: Embedder;
  dossierService?: typeof claimDossierService;
}

export class EpisodicMemory {
  private readonly pool: Queryable;
  private readonly embedderRef: () => Embedder;
  private readonly dossierService: typeof claimDossierService;

  constructor(deps: ServiceDeps = {}) {
    this.pool = deps.pool ?? defaultPool;
    // Defer embedder construction until first use so tests can swap in
    // a stub via __setEmbedderForTests AFTER constructing the service.
    this.embedderRef = deps.embedder
      ? () => deps.embedder as Embedder
      : () => getEmbedder();
    this.dossierService = deps.dossierService ?? claimDossierService;
  }

  // ─── Retrieve ────────────────────────────────────────────────────────

  async retrieve(input: EpisodicRetrievalInput): Promise<RetrievedCase[]> {
    const k = Math.min(MAX_K, Math.max(1, input.k ?? DEFAULT_K));
    const filters = input.filters ?? {};

    // 1) Get a vector to search with. Cheapest source: the precomputed
    //    row for input.claim_id. Fallback: embed a summary inline.
    const queryVec = await this.resolveQueryVector(input);
    if (!queryVec) {
      // No claim_id (or no row yet) AND embedding inline failed — return
      // empty rather than throwing. Callers will degrade to rules-only.
      logger.warn(
        { claim_id: input.claim_id },
        'episodicMemory.retrieve: could not resolve query vector; returning []',
      );
      return [];
    }
    const queryVecLiteral = toPgVectorLiteral(queryVec);

    // 2) Build prefilter WHERE clause. metadata @> '{}' filtering is GIN-
    //    served and runs before the ivfflat ORDER BY <=>.
    const { whereSql, whereParams } = this.buildFilterWhere(filters, input.claim_id);

    // We fetch k+1 so we can drop the current claim and still have k.
    // Joining the dossier in the same query lets the caller render the
    // outcome card without a follow-up round trip.
    const sql = `
      SELECT
        ce.claim_id        AS claim_id,
        ce.source_summary  AS summary,
        ce.metadata        AS metadata,
        1 - (ce.embedding <=> $1::vector) AS similarity,
        cd.closure_outcome AS closure_outcome,
        cd.closed_at       AS closed_at,
        cd.amounts         AS amounts
      FROM hospital.case_embeddings ce
      LEFT JOIN hospital.claim_dossiers cd ON cd.claim_id = ce.claim_id
      ${whereSql}
      ORDER BY ce.embedding <=> $1::vector
      LIMIT ${k + 1}
    `;
    // $1 is the vector literal; subsequent params come from the filter
    // builder. (We use a string literal cast rather than parameter
    // binding for the vector since pgvector's text-cast form is the
    // best-documented path; the value is constructed by us, not from
    // user input.)
    const params: unknown[] = [queryVecLiteral, ...whereParams];

    let rows: any[] = [];
    try {
      const res = await this.pool.query(sql, params);
      rows = res.rows ?? [];
    } catch (err) {
      logger.error(
        { err, claim_id: input.claim_id, k, filters },
        'episodicMemory.retrieve: SQL failed; returning []',
      );
      return [];
    }

    // 3) Drop self + cap to k.
    const out: RetrievedCase[] = [];
    for (const row of rows) {
      if (input.claim_id && row.claim_id === input.claim_id) continue;
      out.push({
        claim_id: row.claim_id,
        similarity: Number(row.similarity),
        summary: row.summary,
        metadata: row.metadata ?? null,
        outcome: {
          closure_outcome: row.closure_outcome ?? null,
          closed_at: row.closed_at
            ? (row.closed_at instanceof Date
                ? row.closed_at.toISOString()
                : String(row.closed_at))
            : null,
          amounts: row.amounts ?? null,
        },
      });
      if (out.length >= k) break;
    }
    return out;
  }

  // ─── Embed ───────────────────────────────────────────────────────────

  async embedClaim(
    claim_id: string,
    opts?: { force?: boolean },
  ): Promise<EmbedClaimResult> {
    const force = opts?.force === true;
    const dossier = await this.dossierService.getDossier(claim_id);
    if (!dossier) {
      return { embedded: false, tokensUsed: 0, costInr: 0, reason: 'no_dossier' };
    }

    const summary = buildClaimSummary(dossier);
    const source_state_hash = createHash('sha256').update(summary).digest('hex');

    if (!force) {
      // Skip when an existing row matches: same summary hash AND same
      // embedding version. Either condition mismatching forces re-embed
      // (e.g. version bumped means the summary semantics changed even
      // if the text hash didn't).
      try {
        const existing = await this.pool.query<{
          source_state_hash: string;
          embedding_version: string;
          status: string;
        }>(
          `SELECT source_state_hash, embedding_version, status
             FROM hospital.case_embeddings
            WHERE claim_id = $1`,
          [claim_id],
        );
        const row = existing.rows[0];
        if (
          row &&
          row.source_state_hash === source_state_hash &&
          row.embedding_version === EPISODIC_VERSION &&
          row.status === 'fresh'
        ) {
          return {
            embedded: false,
            tokensUsed: 0,
            costInr: 0,
            reason: 'unchanged',
          };
        }
      } catch (err) {
        // Read-side error shouldn't block embedding; fall through and
        // let the UPSERT run.
        logger.warn(
          { err, claim_id },
          'episodicMemory.embedClaim: hash probe failed, embedding anyway',
        );
      }
    }

    // Mark pending before the network call so concurrent retrieve()s
    // know the row is being rebuilt. Safe to no-op on first insert.
    try {
      await this.pool.query(
        `UPDATE hospital.case_embeddings
            SET status = 'pending'
          WHERE claim_id = $1`,
        [claim_id],
      );
    } catch {
      // Best-effort.
    }

    let embedding: number[];
    let tokensUsed = 0;
    let costInr = 0;
    const startedAt = Date.now();
    try {
      const embedder = this.embedderRef();
      const result = await embedder.embed([summary]);
      if (!result.embeddings[0]) {
        throw new Error('embedder returned zero vectors');
      }
      embedding = result.embeddings[0];
      tokensUsed = result.tokensUsed;
      costInr = result.costInr;
    } catch (err) {
      logger.error(
        { err, claim_id },
        'episodicMemory.embedClaim: embedder failed',
      );
      // Flip to failed so the backfill cron can pick it up again later.
      try {
        await this.pool.query(
          `UPDATE hospital.case_embeddings
              SET status = 'failed'
            WHERE claim_id = $1`,
          [claim_id],
        );
      } catch {
        /* swallow */
      }
      throw err;
    }
    const latencyMs = Date.now() - startedAt;

    const metadata = buildClaimMetadata(dossier);

    try {
      await this.pool.query(
        `INSERT INTO hospital.case_embeddings
           (claim_id, embedding, embedding_model, embedding_version,
            source_summary, source_state_hash, metadata, embedded_at, status)
         VALUES ($1, $2::vector, $3, $4, $5, $6, $7, NOW(), 'fresh')
         ON CONFLICT (claim_id) DO UPDATE
           SET embedding         = EXCLUDED.embedding,
               embedding_model   = EXCLUDED.embedding_model,
               embedding_version = EXCLUDED.embedding_version,
               source_summary    = EXCLUDED.source_summary,
               source_state_hash = EXCLUDED.source_state_hash,
               metadata          = EXCLUDED.metadata,
               embedded_at       = NOW(),
               status            = 'fresh'`,
        [
          claim_id,
          toPgVectorLiteral(embedding),
          EPISODIC_MODEL,
          EPISODIC_VERSION,
          summary,
          source_state_hash,
          metadata,
        ],
      );
    } catch (err) {
      logger.error(
        { err, claim_id },
        'episodicMemory.embedClaim: UPSERT failed',
      );
      throw err;
    }

    // Cost log. Provider/model match the embedder; task tag lets the
    // dashboards bucket episodic-embedding spend separately from
    // adjudication / classification spend.
    await costAccounting
      .recordCall({
        claimId: claim_id,
        hospitalId: (metadata?.hospital_id as string | undefined) ?? null,
        task: 'episodic_embedding',
        provider: 'voyage',
        model: EPISODIC_MODEL,
        promptVersion: EPISODIC_VERSION,
        tokensInputUncached: tokensUsed,
        tokensInputCached: 0,
        tokensOutput: 0,
        latencyMs,
        costInr,
        succeeded: true,
      })
      .catch(() => {
        /* recordCall already logs; never block embed on cost-log write */
      });

    return {
      embedded: true,
      tokensUsed,
      costInr,
      reason: force ? 'forced' : 'embedded',
    };
  }

  // ─── Mark stale ──────────────────────────────────────────────────────

  async markStale(claim_id: string): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE hospital.case_embeddings
            SET status = 'stale'
          WHERE claim_id = $1`,
        [claim_id],
      );
    } catch (err) {
      logger.warn(
        { err, claim_id },
        'episodicMemory.markStale: update failed (non-fatal)',
      );
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────

  /**
   * Get the vector to search with. Cheapest path: the precomputed row
   * for input.claim_id (no Voyage call, no charge). Fallback for claims
   * that haven't been embedded yet: embed the freshly built summary
   * inline. The fallback path uses the same summary builder so the
   * inline-embed and precomputed-embed paths use identical text.
   */
  private async resolveQueryVector(
    input: EpisodicRetrievalInput,
  ): Promise<number[] | null> {
    if (input.claim_id) {
      try {
        const res = await this.pool.query<{ embedding: string }>(
          `SELECT embedding::text AS embedding
             FROM hospital.case_embeddings
            WHERE claim_id = $1 AND status IN ('fresh', 'stale')`,
          [input.claim_id],
        );
        const row = res.rows[0];
        if (row?.embedding) return parsePgVectorLiteral(row.embedding);
      } catch (err) {
        logger.warn(
          { err, claim_id: input.claim_id },
          'episodicMemory.resolveQueryVector: existing-row lookup failed',
        );
      }
    }

    // Inline embed path.
    try {
      const summary = buildClaimSummary(input.dossier);
      const embedder = this.embedderRef();
      const result = await embedder.embed([summary]);
      const v = result.embeddings[0];
      return v ?? null;
    } catch (err) {
      logger.error(
        { err, claim_id: input.claim_id },
        'episodicMemory.resolveQueryVector: inline embed failed',
      );
      return null;
    }
  }

  /**
   * Build the prefilter WHERE clause. We use metadata @> jsonb_build_object(...)
   * for the equality facets (GIN-served), plus a status filter so we never
   * return rows that errored. Self-exclusion happens in JS rather than SQL —
   * pushing it down via WHERE claim_id <> $X would require another param
   * slot and the post-filter list of k results is tiny anyway.
   */
  private buildFilterWhere(
    filters: EpisodicRetrievalFilters,
    _self_id: string | undefined,
  ): { whereSql: string; whereParams: unknown[] } {
    const clauses: string[] = [`ce.status IN ('fresh', 'stale')`];
    const params: unknown[] = [];

    const facets: Record<string, unknown> = {};
    if (filters.hospital_id) facets.hospital_id = filters.hospital_id;
    if (filters.panel_id) facets.panel_id = filters.panel_id;
    if (filters.insurer_id) facets.insurer_id = filters.insurer_id;
    if (filters.procedure_class) facets.procedure_class = filters.procedure_class;
    if (filters.diagnosis_class) facets.diagnosis_class = filters.diagnosis_class;
    if (filters.outcome_category) facets.outcome_category = filters.outcome_category;
    if (Object.keys(facets).length > 0) {
      // $2 onward come after the vector literal in $1.
      params.push(facets);
      clauses.push(`ce.metadata @> $${params.length + 1}::jsonb`);
    }

    if (filters.min_evidence && filters.min_evidence > 0) {
      // Terminal outcome required — closed_at IS NOT NULL on the dossier.
      clauses.push(`cd.closed_at IS NOT NULL`);
    }

    return {
      whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
      whereParams: params,
    };
  }
}

// ─── Summary / metadata builders ─────────────────────────────────────────

/**
 * Build a dense ~500-1500 char text summary of a claim for embedding.
 * Every token is intentional — we're packing structure (key/value lines)
 * because dense embedders work better on structured text than on prose.
 *
 * Intentionally excludes raw PII (name, UHID values) — we keep the
 * procedure/diagnosis/amount/event-pattern signals that drive retrieval
 * without leaking patient identifiers into the embedding store. The
 * embedded text is also persisted as source_summary, so anything written
 * here is visible to anyone with case_embeddings read access.
 */
export function buildClaimSummary(dossier: ClaimDossier): string {
  const lines: string[] = [];

  // Stage + routing.
  lines.push(`STAGE: ${dossier.current_stage ?? 'unknown'}`);
  if (dossier.current_panel_id) lines.push(`PANEL: ${dossier.current_panel_id}`);
  if (dossier.current_insurer_id) lines.push(`INSURER: ${dossier.current_insurer_id}`);

  // Patient — demographics only, no name/UHID.
  const p = dossier.patient_summary ?? {};
  const demo: string[] = [];
  if (p.primary_diagnosis) demo.push(`dx=${p.primary_diagnosis}`);
  if (p.procedure) demo.push(`proc=${p.procedure}`);
  if (p.room) demo.push(`room=${p.room}`);
  if (demo.length) lines.push(`PATIENT: ${demo.join(' ')}`);

  // Amounts.
  const a = dossier.amounts ?? {};
  const amts: string[] = [];
  if (a.claimed != null) amts.push(`claimed=${a.claimed}`);
  if (a.pre_auth_approved != null) amts.push(`preauth=${a.pre_auth_approved}`);
  if (a.enhancement_approved != null) amts.push(`enhancement=${a.enhancement_approved}`);
  if (a.final_approved != null) amts.push(`final=${a.final_approved}`);
  if (a.deducted != null) amts.push(`deducted=${a.deducted}`);
  if (amts.length) lines.push(`AMOUNTS: ${amts.join(' ')}`);

  // Doc sections by category — collapse to category counts to keep dense.
  const byCat = dossier.doc_sections_by_category ?? {};
  const catEntries = Object.entries(byCat).map(
    ([cat, items]) => `${cat}=${Array.isArray(items) ? items.length : 0}`,
  );
  if (catEntries.length) lines.push(`DOCS: ${catEntries.join(' ')}`);

  // Stage sufficiency snapshot.
  const suff = dossier.doc_sufficiency_per_stage ?? {};
  for (const [stage, st] of Object.entries(suff)) {
    if (!st) continue;
    lines.push(
      `SUFFICIENCY[${stage}]: have=${(st.present ?? []).length} miss=${(st.missing ?? []).length}`,
    );
  }

  // Query history — type + count, not free text, so the embedding sees
  // the SHAPE of the deficiencies even when wording varies.
  const queries = dossier.active_queries ?? [];
  if (queries.length) {
    const types = queries
      .map((q) => q.deficiency_type)
      .filter(Boolean) as string[];
    lines.push(`QUERIES: count=${queries.length} types=${types.join(',') || 'unspecified'}`);
  }

  // Event kinds histogram — captures the "story" without dumping payloads.
  const eventKinds: Record<string, number> = {};
  for (const e of dossier.events_summary ?? []) {
    eventKinds[e.kind] = (eventKinds[e.kind] ?? 0) + 1;
  }
  const ekParts = Object.entries(eventKinds)
    .sort(([, ac], [, bc]) => bc - ac)
    .slice(0, 12)
    .map(([k, c]) => `${k}=${c}`);
  if (ekParts.length) lines.push(`EVENTS: ${ekParts.join(' ')}`);

  // Closure.
  if (dossier.closure_outcome) {
    lines.push(`OUTCOME: ${dossier.closure_outcome}`);
  }

  const joined = lines.join('\n');
  if (joined.length <= SUMMARY_MAX_CHARS) return joined;
  // If somehow oversize (huge event histogram), truncate from the tail.
  return joined.slice(0, SUMMARY_MAX_CHARS);
}

/**
 * Filter facets for retrieval prefiltering. We bucket the continuous
 * fields (claim_amount, diagnosis text) into coarse classes so the
 * metadata @> equality filter has reasonable selectivity.
 *
 * The bucketing is intentionally crude in v0 — sharper classifiers
 * (diagnosis → ICD chapter, procedure → CPT class) land in Wave 5
 * when the ontology service exposes them.
 */
export function buildClaimMetadata(
  dossier: ClaimDossier,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (dossier.current_panel_id) meta.panel_id = dossier.current_panel_id;
  if (dossier.current_insurer_id) meta.insurer_id = dossier.current_insurer_id;

  const p = dossier.patient_summary ?? {};
  if (p.procedure) meta.procedure_class = coarseClass(p.procedure);
  if (p.primary_diagnosis) meta.diagnosis_class = coarseClass(p.primary_diagnosis);

  const claimed = dossier.amounts?.claimed ?? null;
  if (typeof claimed === 'number') {
    meta.claim_amount_range = amountBucket(claimed);
  }

  if (dossier.closure_outcome) {
    meta.outcome_category = dossier.closure_outcome;
  }

  return meta;
}

/** Lowercase + collapse whitespace + cap length — crude bucketization. */
function coarseClass(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '_').slice(0, 48);
}

/** Coarse INR buckets — match the dashboard's bucketing for consistency. */
function amountBucket(amount: number): string {
  if (amount < 25_000) return '<25k';
  if (amount < 50_000) return '25k-50k';
  if (amount < 1_00_000) return '50k-1L';
  if (amount < 3_00_000) return '1L-3L';
  if (amount < 5_00_000) return '3L-5L';
  if (amount < 10_00_000) return '5L-10L';
  return '>10L';
}

// ─── pgvector text-literal helpers ───────────────────────────────────────

/**
 * pgvector accepts text-literal vectors of the form '[1.0, 2.0, 3.0]'.
 * We build the literal ourselves rather than relying on the driver's
 * JSONB serialization because pg-node has no built-in vector type.
 */
export function toPgVectorLiteral(vec: number[]): string {
  // Defensive: filter NaN / Infinity → 0 (an embedder bug should fail
  // loudly, but a single bad coord shouldn't poison the cast).
  const safe = vec.map((v) => (Number.isFinite(v) ? v : 0));
  return '[' + safe.join(',') + ']';
}

export function parsePgVectorLiteral(s: string): number[] {
  // '[1,2,3]' → [1,2,3]
  const inner = s.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner) return [];
  return inner.split(',').map((x) => Number(x));
}

// ─── Default export (singleton) ──────────────────────────────────────────

export default new EpisodicMemory();
