/**
 * Sprint 2 — Event Dispatcher
 *
 * Typed, idempotent writer for hospital.submission_events. The legacy
 * submissionEvents.service.ts (migration 027) keeps working — its callers
 * are not migrated yet — and writes the old `event_type` column. This
 * dispatcher writes the new `kind` column (migration 030) plus the new
 * claim_id / idempotency_key / correlation_id columns.
 *
 * Why this exists as a separate service:
 *
 *   1. Payload validation. Every kind has a Zod schema in eventTypes.ts.
 *      A bad payload throws InvalidEventPayloadError *before* the insert,
 *      so we never persist garbage we'd have to clean up later.
 *
 *   2. Idempotency. Callers (especially LLM-driven pipelines) often
 *      retry after a transient downstream failure. With a caller-supplied
 *      idempotency_key, a duplicate dispatch collapses to the existing row
 *      and returns `deduped: true` — the caller doesn't have to track
 *      "have I already emitted this event for this claim?".
 *
 *   3. Correlation. A stage_transitioned event that was triggered by a
 *      submission_sent event carries the same correlation_id. The FE
 *      timeline groups by correlation_id to render causal chains.
 *
 *   4. Single insert shape. Future event additions only need a new entry
 *      in EVENT_KINDS + a schema; the dispatcher and DB shape don't change.
 *
 * This service is intentionally *not wired up* anywhere in Wave 0 / Sprint 2.
 * Existing submission_events writers (submissionEvents.service.ts) keep
 * functioning as-is. A follow-up sprint migrates them to dispatch through
 * this service so we have a single ingress.
 */

import type { Pool } from 'pg';
import { z } from 'zod';

import { pool as defaultPool } from '../../DB/db.js';
import {
  EVENT_KINDS,
  EVENT_PAYLOAD_SCHEMAS,
  type EventKind,
  type EventPayload,
} from './eventTypes.js';

// ─── Typed errors ─────────────────────────────────────────────────────────
// Mirrors the style of LlmClient.ts (named classes with `cause` carry-through)
// so callers can `instanceof` differentiate from generic errors.

/**
 * Thrown when the payload supplied to dispatch() fails Zod validation against
 * the schema for `kind`. The `cause` carries the underlying ZodError; the
 * `kind` and `issues` fields are surfaced for logging convenience.
 */
export class InvalidEventPayloadError extends Error {
  readonly kind: EventKind | string;
  readonly issues: ReadonlyArray<z.ZodIssue>;
  constructor(
    kind: EventKind | string,
    issues: ReadonlyArray<z.ZodIssue>,
    cause?: unknown,
  ) {
    super(
      `invalid payload for event kind '${kind}': ${issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'InvalidEventPayloadError';
    this.kind = kind;
    this.issues = issues;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

/**
 * Thrown when dispatch() is called with a `kind` that isn't in EVENT_KINDS.
 * Distinct from InvalidEventPayloadError so callers can tell "unknown kind"
 * from "kind is valid but payload is wrong".
 */
export class UnknownEventKindError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`unknown event kind: '${kind}'`);
    this.name = 'UnknownEventKindError';
    this.kind = kind;
  }
}

// ─── Dispatcher input ─────────────────────────────────────────────────────

export interface DispatchInput<K extends EventKind> {
  kind: K;
  /** Claim (IPD) the event belongs to. Required — every event has a claim. */
  claimId: string;
  /**
   * Hospital that owns the claim. Optional at the dispatcher API level
   * (some background workers don't have it handy), but populated in the
   * insert when supplied so the firehose row is queryable by tenant.
   */
  hospitalId?: string;
  /**
   * User who triggered the event. NULL for system-emitted events
   * (timeouts, AI auto-runs).
   */
  actorUserId?: string;
  /** Event-specific payload. Validated against EVENT_PAYLOAD_SCHEMAS[kind]. */
  payload: EventPayload<K>;
  /**
   * Caller-supplied idempotency key. When set, a second dispatch with the
   * same (claimId, idempotencyKey) returns the existing row with
   * deduped=true rather than inserting a duplicate.
   */
  idempotencyKey?: string;
  /**
   * Correlation id for chaining causally-related events. The FE timeline
   * groups rows by correlation_id to render "this stage_transitioned was
   * caused by that submission_sent".
   */
  correlationId?: string;
}

export interface DispatchResult {
  /** The submission_events.id of the inserted (or existing) row. */
  id: string;
  /**
   * True when the row already existed under the same (claimId, idempotencyKey)
   * — i.e. this was a retry. False on first insert.
   */
  deduped: boolean;
}

// ─── Service ──────────────────────────────────────────────────────────────

/**
 * Pool-injectable so the test suite can pass a stub. In production code
 * the no-arg constructor (or the exported `eventDispatcher` singleton) is
 * what callers use; the default pool is imported from DB/db.ts.
 */
export class EventDispatcher {
  // We accept the minimum surface we touch — a `query` method — rather than
  // the full Pool type so tests don't have to construct a real pg.Pool.
  private readonly pool: Pick<Pool, 'query'>;

  constructor(pool: Pick<Pool, 'query'> = defaultPool) {
    this.pool = pool;
  }

  async dispatch<K extends EventKind>(
    input: DispatchInput<K>,
  ): Promise<DispatchResult> {
    // 1. Kind must be in EVENT_KINDS. Runtime check matters: a bad caller
    //    might bypass the type system (untyped JS, dynamic kind from a
    //    config table, etc.) and the dispatcher is the last line of defence.
    if (!isKnownEventKind(input.kind)) {
      throw new UnknownEventKindError(input.kind as string);
    }

    // 2. Payload validation. parseAsync would also work but every schema
    //    here is synchronous so `safeParse` is cheaper and gives us the
    //    ZodIssue array without a try/catch.
    const schema = EVENT_PAYLOAD_SCHEMAS[input.kind];
    const parsed = schema.safeParse(input.payload);
    if (!parsed.success) {
      throw new InvalidEventPayloadError(
        input.kind,
        parsed.error.issues,
        parsed.error,
      );
    }

    // 3. Idempotency-aware insert.
    //
    // The (claim_id, idempotency_key) partial UNIQUE index from migration
    // 030 lets us use `ON CONFLICT DO NOTHING` to swallow the duplicate
    // cheaply. The RETURNING clause only fires on a fresh insert; on
    // dedup we fall through to a SELECT to fetch the existing id. This
    // ordering is safe because the UNIQUE index commits the dedup before
    // our SELECT runs in the same connection.
    //
    // For inserts WITHOUT an idempotency key we always insert (every call
    // produces a new row), which matches the firehose semantics.
    const validatedPayload = parsed.data;
    const payloadJson = JSON.stringify(validatedPayload);

    // legacy event_type column (migration 027) is NOT NULL — write the new
    // `kind` value into it as well so the row satisfies the old schema
    // until that column is dropped. Callers reading via the legacy column
    // see the new typed kind string; readers via `kind` see the same.
    const legacyEventType = input.kind;

    if (input.idempotencyKey !== undefined) {
      // insurance_submission_id is left NULL for dispatcher-emitted events
      // (migration 034 dropped its FK + NOT NULL). claim_id (an IPD id) is
      // the canonical join target going forward.
      const insertSql = `
        INSERT INTO hospital.submission_events
          (claim_id, hospital_id, kind, event_type, payload, actor,
           idempotency_key, correlation_id,
           insurance_submission_id)
        VALUES
          ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, NULL)
        ON CONFLICT (claim_id, idempotency_key)
          WHERE claim_id IS NOT NULL AND idempotency_key IS NOT NULL
          DO NOTHING
        RETURNING id
      `;
      const insertParams = [
        input.claimId,
        input.hospitalId ?? null,
        input.kind,
        legacyEventType,
        payloadJson,
        input.actorUserId ?? null,
        input.idempotencyKey,
        input.correlationId ?? null,
      ];
      const inserted = await this.pool.query<{ id: string }>(
        insertSql,
        insertParams,
      );
      if (inserted.rows.length > 0) {
        const row = inserted.rows[0]!;
        return { id: row.id, deduped: false };
      }

      // Conflict path — fetch the prior row.
      const existing = await this.pool.query<{ id: string }>(
        `SELECT id
           FROM hospital.submission_events
          WHERE claim_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [input.claimId, input.idempotencyKey],
      );
      if (existing.rows.length === 0) {
        // Vanishingly rare race: ON CONFLICT swallowed the insert, but the
        // existing row got deleted between then and our SELECT. Surface as
        // a generic Error rather than pretending to dedup successfully.
        throw new Error(
          `dispatcher: conflict swallowed but prior row missing for ` +
            `(${input.claimId}, ${input.idempotencyKey})`,
        );
      }
      const row = existing.rows[0]!;
      return { id: row.id, deduped: true };
    }

    // No idempotency key — straight insert.
    // insurance_submission_id left NULL (see comment above).
    const insertSql = `
      INSERT INTO hospital.submission_events
        (claim_id, hospital_id, kind, event_type, payload, actor,
         correlation_id, insurance_submission_id)
      VALUES
        ($1, $2, $3, $4, $5::jsonb, $6, $7, NULL)
      RETURNING id
    `;
    const insertParams = [
      input.claimId,
      input.hospitalId ?? null,
      input.kind,
      legacyEventType,
      payloadJson,
      input.actorUserId ?? null,
      input.correlationId ?? null,
    ];
    const inserted = await this.pool.query<{ id: string }>(
      insertSql,
      insertParams,
    );
    const row = inserted.rows[0];
    if (!row) {
      // Defensive: a RETURNING clause without rows is a postgres
      // misconfiguration we'd rather surface loudly than silently.
      throw new Error('dispatcher: INSERT ... RETURNING id returned no row');
    }
    return { id: row.id, deduped: false };
  }
}

/**
 * Narrowing guard — `EVENT_KINDS.includes` returns boolean but doesn't narrow
 * the input type because `includes` is widened to `string`. Wrapping it lets
 * us write `if (isKnownEventKind(x))` and have `x` typed as EventKind inside.
 */
function isKnownEventKind(k: string): k is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(k);
}

/**
 * Singleton wired to the default pg pool. Service modules import this
 * directly:
 *   import { eventDispatcher } from '.../events/eventDispatcher.service';
 *   await eventDispatcher.dispatch({ kind: 'ai_draft_created', ... });
 */
export const eventDispatcher = new EventDispatcher();
