import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import {
  applyEvent,
  blankDossier,
  ClaimDossier,
  SubmissionEventRow,
} from './claimDossierProjector.service.js';

/**
 * Claim Dossier Service
 *
 * I/O adapter around the pure projector in `claimDossierProjector.service.ts`.
 * Responsibilities:
 *   - Read the current projection for a claim (`getDossier`).
 *   - Apply a single event delta on top of the current projection
 *     (`upsertProjection`). Idempotent: applying the same event twice is a
 *     no-op thanks to the projector's last_event_id short-circuit plus our
 *     server-side last_event_at guard.
 *   - Full rebuild from the event log (`rebuildFromEvents`) for recovery.
 *
 * The bootstrap rule: when a dossier row does not yet exist for a claim, we
 * seed a blank shell with claim_id + a small handful of fields cribbed from
 * hospital.ipds (panel, hospital_panel, patient,
 * ipd_id). Everything else flows from events.
 *
 * Concurrency: a per-claim sequential ordering is enforced by the worker
 * (concurrency tuned low — see `Workers/claimDossierProjector.queue.ts`) and
 * by the `version` bump + `last_event_at` check in `upsertProjection`. If two
 * workers race on the same claim_id, the loser's UPDATE WHERE last_event_at
 * filter will match zero rows and that job will be re-tried by Bull (or no-op
 * if it's a stale event).
 */

// Re-export the canonical type so callers can `import { ClaimDossier } from './claimDossier.service'`.
export type { ClaimDossier } from './claimDossierProjector.service.js';

// ────────────────────────────────────────────────────────────────────────────
// Row mapping
// ────────────────────────────────────────────────────────────────────────────

interface DbRow {
  claim_id: string;
  last_event_id: string | null;
  last_event_at: Date | null;
  version: number;
  current_stage: string | null;
  current_panel_id: string | null;
  current_insurer_id: string | null;
  patient_summary: any;
  amounts: any;
  doc_sections_by_category: any;
  doc_sufficiency_per_stage: any;
  events_summary: any;
  inbound_emails: any;
  outbound_submissions: any;
  active_queries: any;
  pending_actions: any;
  active_adjudication: any;
  ai_drafts_pending: any;
  matched_kb_patterns: string[] | null;
  case_embedding_state: string | null;
  closed_at: Date | null;
  closure_outcome: string | null;
  retrospective_summary: any;
  updated_at: Date;
}

function rowToDossier(row: DbRow): ClaimDossier {
  return {
    claim_id: row.claim_id,
    last_event_id: row.last_event_id,
    last_event_at: row.last_event_at,
    version: row.version,
    current_stage: row.current_stage,
    current_panel_id: row.current_panel_id,
    current_insurer_id: row.current_insurer_id,
    patient_summary: row.patient_summary ?? null,
    amounts: row.amounts ?? null,
    doc_sections_by_category: row.doc_sections_by_category ?? null,
    doc_sufficiency_per_stage: row.doc_sufficiency_per_stage ?? null,
    events_summary: Array.isArray(row.events_summary) ? row.events_summary : [],
    inbound_emails: Array.isArray(row.inbound_emails) ? row.inbound_emails : [],
    outbound_submissions: Array.isArray(row.outbound_submissions)
      ? row.outbound_submissions
      : [],
    active_queries: Array.isArray(row.active_queries) ? row.active_queries : [],
    pending_actions: Array.isArray(row.pending_actions) ? row.pending_actions : [],
    active_adjudication: row.active_adjudication ?? null,
    ai_drafts_pending: Array.isArray(row.ai_drafts_pending)
      ? row.ai_drafts_pending
      : [],
    matched_kb_patterns: row.matched_kb_patterns ?? [],
    case_embedding_state:
      (row.case_embedding_state as ClaimDossier['case_embedding_state']) ?? null,
    closed_at: row.closed_at,
    closure_outcome: (row.closure_outcome as ClaimDossier['closure_outcome']) ?? null,
    retrospective_summary: row.retrospective_summary ?? null,
    updated_at: row.updated_at,
  };
}

const SELECT_ALL_COLS = `
  claim_id, last_event_id, last_event_at, version,
  current_stage, current_panel_id, current_insurer_id,
  patient_summary, amounts,
  doc_sections_by_category, doc_sufficiency_per_stage,
  events_summary, inbound_emails, outbound_submissions,
  active_queries, pending_actions,
  active_adjudication, ai_drafts_pending,
  matched_kb_patterns, case_embedding_state,
  closed_at, closure_outcome, retrospective_summary,
  updated_at
`;

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap helper
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read the parent IPD row and use it to seed a blank dossier shell.
 * Returns null if the claim (IPD) does not exist. The shell is *not* persisted
 * here — the caller (`upsertProjection` / `rebuildFromEvents`) is responsible
 * for writing the row after folding events on top.
 *
 * The dossier is keyed by IPD id (one dossier per patient admission, accumulating
 * state across all submissions/filings within that IPD). Matches the FK target
 * in migration 031 and aligns with Lane A (030) which FK's submission_events
 * and stage_transitions to hospital.ipds(id) as well.
 */
async function bootstrapShell(claim_id: string): Promise<ClaimDossier | null> {
  const res = await pool.query<{
    id: string;
    first_name: string;
    last_name: string | null;
    panel_id: string | null;
    hospital_panel_id: string | null;
    admission_type: string | null;
  }>(
    `SELECT i.id,
            i.first_name,
            i.last_name,
            i.panel_id,
            i.hospital_panel_id,
            i.admission_type
       FROM hospital.ipds i
      WHERE i.id = $1`,
    [claim_id]
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const row = res.rows[0]!;
  const shell = blankDossier(claim_id);
  shell.current_panel_id = row.panel_id ?? null;
  // current_insurer_id is left null — once a richer panel→insurer mapping
  // exists (Wave 2) we can populate here.
  // patient_summary is seeded with minimal IPD facts; richer details
  // (uhid, room, diagnosis) flow in via claim_created / doc extractions.
  shell.patient_summary = {
    first_name: row.first_name,
    last_name: row.last_name ?? null,
    admission_type: row.admission_type ?? null,
  };
  return shell;
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export class ClaimDossierService {
  /**
   * Load the projection for a single claim. Returns null if no row exists
   * (i.e. no projection has ever been built — first event hasn't been
   * processed yet).
   */
  async getDossier(claim_id: string): Promise<ClaimDossier | null> {
    const res = await pool.query<DbRow>(
      `SELECT ${SELECT_ALL_COLS}
         FROM hospital.claim_dossiers
        WHERE claim_id = $1`,
      [claim_id]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return rowToDossier(res.rows[0]!);
  }

  /**
   * Apply a single event to the projection and persist.
   *
   * Concurrency control: we UPDATE … WHERE last_event_at < $evtAt OR
   * last_event_at IS NULL. If another worker has already advanced past this
   * event, our UPDATE matches zero rows and we re-read whatever the winner
   * wrote — no harm done. The projector itself also no-ops on duplicate
   * event.id.
   */
  async upsertProjection(
    claim_id: string,
    event: SubmissionEventRow
  ): Promise<ClaimDossier> {
    // Read-modify-write. We could do this in a transaction with SELECT FOR
    // UPDATE, but the optimistic guard below covers the race adequately and
    // keeps lock duration short.
    let current = await this.getDossier(claim_id);
    if (!current) {
      const shell = await bootstrapShell(claim_id);
      if (!shell) {
        throw new Error(
          `claim_dossier.upsert: insurance_submission ${claim_id} not found`
        );
      }
      current = shell;
    }

    const next = applyEvent(current, event);
    // applyEvent is a no-op when event.id is already folded — detect & skip.
    if (next.last_event_id === current.last_event_id && next.version === current.version) {
      return current;
    }

    return this.writeProjection(next);
  }

  /**
   * Replay the entire submission_events stream for a claim and rewrite the
   * projection. Use for recovery, schema migrations, or when a new event
   * vocabulary lands and we need to re-fold history.
   */
  async rebuildFromEvents(claim_id: string): Promise<ClaimDossier> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const exists = await client.query(
        `SELECT 1 FROM hospital.ipds WHERE id = $1`,
        [claim_id]
      );
      if ((exists.rowCount ?? 0) === 0) {
        throw new Error(
          `claim_dossier.rebuild: ipd ${claim_id} not found`
        );
      }

      const shell = (await bootstrapShell(claim_id))!;

      const eventsRes = await client.query<{
        id: string;
        event_type: string;
        payload: any;
        actor: string | null;
        created_at: Date;
      }>(
        `SELECT id, event_type, payload, actor, created_at
           FROM hospital.submission_events
          WHERE insurance_submission_id = $1
          ORDER BY created_at ASC, id ASC`,
        [claim_id]
      );

      let folded: ClaimDossier = shell;
      for (const e of eventsRes.rows) {
        folded = applyEvent(folded, {
          id: e.id,
          kind: e.event_type,
          payload: e.payload ?? {},
          actor: e.actor,
          created_at: e.created_at,
        });
      }

      // Replace the row outright — rebuild is authoritative.
      await client.query(
        `DELETE FROM hospital.claim_dossiers WHERE claim_id = $1`,
        [claim_id]
      );
      await this.insertRow(client, folded);

      await client.query('COMMIT');
      logger.info(
        {
          claim_id,
          event_count: eventsRes.rowCount,
          version: folded.version,
        },
        'claim_dossier: rebuilt from events'
      );
      return folded;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Writers
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Persist a fully-projected ClaimDossier. Uses an UPSERT and only commits
   * when the row in the DB has not advanced past `dossier.last_event_at` —
   * stale writes are dropped quietly.
   */
  private async writeProjection(dossier: ClaimDossier): Promise<ClaimDossier> {
    const client = await pool.connect();
    try {
      const res = await client.query<DbRow>(
        `INSERT INTO hospital.claim_dossiers (
            claim_id, last_event_id, last_event_at, version,
            current_stage, current_panel_id, current_insurer_id,
            patient_summary, amounts,
            doc_sections_by_category, doc_sufficiency_per_stage,
            events_summary, inbound_emails, outbound_submissions,
            active_queries, pending_actions,
            active_adjudication, ai_drafts_pending,
            matched_kb_patterns, case_embedding_state,
            closed_at, closure_outcome, retrospective_summary,
            updated_at
         ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8::jsonb, $9::jsonb,
            $10::jsonb, $11::jsonb,
            $12::jsonb, $13::jsonb, $14::jsonb,
            $15::jsonb, $16::jsonb,
            $17::jsonb, $18::jsonb,
            $19::uuid[], $20,
            $21, $22, $23::jsonb,
            NOW()
         )
         ON CONFLICT (claim_id) DO UPDATE
           SET last_event_id            = EXCLUDED.last_event_id,
               last_event_at            = EXCLUDED.last_event_at,
               version                  = EXCLUDED.version,
               current_stage            = EXCLUDED.current_stage,
               current_panel_id         = EXCLUDED.current_panel_id,
               current_insurer_id       = EXCLUDED.current_insurer_id,
               patient_summary          = EXCLUDED.patient_summary,
               amounts                  = EXCLUDED.amounts,
               doc_sections_by_category = EXCLUDED.doc_sections_by_category,
               doc_sufficiency_per_stage= EXCLUDED.doc_sufficiency_per_stage,
               events_summary           = EXCLUDED.events_summary,
               inbound_emails           = EXCLUDED.inbound_emails,
               outbound_submissions     = EXCLUDED.outbound_submissions,
               active_queries           = EXCLUDED.active_queries,
               pending_actions          = EXCLUDED.pending_actions,
               active_adjudication      = EXCLUDED.active_adjudication,
               ai_drafts_pending        = EXCLUDED.ai_drafts_pending,
               matched_kb_patterns      = EXCLUDED.matched_kb_patterns,
               case_embedding_state     = EXCLUDED.case_embedding_state,
               closed_at                = EXCLUDED.closed_at,
               closure_outcome          = EXCLUDED.closure_outcome,
               retrospective_summary    = EXCLUDED.retrospective_summary,
               updated_at               = NOW()
           WHERE hospital.claim_dossiers.last_event_at IS NULL
              OR hospital.claim_dossiers.last_event_at < EXCLUDED.last_event_at
         RETURNING ${SELECT_ALL_COLS}`,
        [
          dossier.claim_id,
          dossier.last_event_id,
          dossier.last_event_at,
          dossier.version,
          dossier.current_stage,
          dossier.current_panel_id,
          dossier.current_insurer_id,
          JSON.stringify(dossier.patient_summary),
          JSON.stringify(dossier.amounts),
          JSON.stringify(dossier.doc_sections_by_category),
          JSON.stringify(dossier.doc_sufficiency_per_stage),
          JSON.stringify(dossier.events_summary),
          JSON.stringify(dossier.inbound_emails),
          JSON.stringify(dossier.outbound_submissions),
          JSON.stringify(dossier.active_queries),
          JSON.stringify(dossier.pending_actions),
          JSON.stringify(dossier.active_adjudication),
          JSON.stringify(dossier.ai_drafts_pending),
          dossier.matched_kb_patterns,
          dossier.case_embedding_state,
          dossier.closed_at,
          dossier.closure_outcome,
          JSON.stringify(dossier.retrospective_summary),
        ]
      );

      if ((res.rowCount ?? 0) === 0) {
        // Stale write — a concurrent worker already advanced the projection.
        // Read back and return whatever's there.
        const current = await this.getDossier(dossier.claim_id);
        if (!current) {
          // Extremely rare — projection vanished between the UPSERT and the
          // SELECT (DELETE during rebuild?). Surface as an error.
          throw new Error(
            `claim_dossier.write: projection for ${dossier.claim_id} disappeared mid-write`
          );
        }
        logger.info(
          {
            claim_id: dossier.claim_id,
            attempted_event: dossier.last_event_id,
            current_event: current.last_event_id,
          },
          'claim_dossier: stale write skipped, returning current projection'
        );
        return current;
      }

      return rowToDossier(res.rows[0]!);
    } finally {
      client.release();
    }
  }

  /**
   * Insert a row inside a transaction client (used by rebuildFromEvents).
   */
  private async insertRow(
    client: import('pg').PoolClient,
    dossier: ClaimDossier
  ): Promise<void> {
    await client.query(
      `INSERT INTO hospital.claim_dossiers (
          claim_id, last_event_id, last_event_at, version,
          current_stage, current_panel_id, current_insurer_id,
          patient_summary, amounts,
          doc_sections_by_category, doc_sufficiency_per_stage,
          events_summary, inbound_emails, outbound_submissions,
          active_queries, pending_actions,
          active_adjudication, ai_drafts_pending,
          matched_kb_patterns, case_embedding_state,
          closed_at, closure_outcome, retrospective_summary,
          updated_at
       ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8::jsonb, $9::jsonb,
          $10::jsonb, $11::jsonb,
          $12::jsonb, $13::jsonb, $14::jsonb,
          $15::jsonb, $16::jsonb,
          $17::jsonb, $18::jsonb,
          $19::uuid[], $20,
          $21, $22, $23::jsonb,
          NOW()
       )`,
      [
        dossier.claim_id,
        dossier.last_event_id,
        dossier.last_event_at,
        dossier.version,
        dossier.current_stage,
        dossier.current_panel_id,
        dossier.current_insurer_id,
        JSON.stringify(dossier.patient_summary),
        JSON.stringify(dossier.amounts),
        JSON.stringify(dossier.doc_sections_by_category),
        JSON.stringify(dossier.doc_sufficiency_per_stage),
        JSON.stringify(dossier.events_summary),
        JSON.stringify(dossier.inbound_emails),
        JSON.stringify(dossier.outbound_submissions),
        JSON.stringify(dossier.active_queries),
        JSON.stringify(dossier.pending_actions),
        JSON.stringify(dossier.active_adjudication),
        JSON.stringify(dossier.ai_drafts_pending),
        dossier.matched_kb_patterns,
        dossier.case_embedding_state,
        dossier.closed_at,
        dossier.closure_outcome,
        JSON.stringify(dossier.retrospective_summary),
      ]
    );
  }
}

export default new ClaimDossierService();
