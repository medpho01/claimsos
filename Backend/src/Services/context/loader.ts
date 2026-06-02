// =============================================================================
// M2 — context loader (the IO wrapper around the pure resolver).
//
// Two jobs, both shadow-only (nothing in a live decision path reads the output
// yet — that wiring is M5):
//   1. fetchClaimStage()        — the claim's CURRENT stage, for stamping
//                                 document_sections.stage at ingest.
//   2. resolveAndPersistContext() — resolve {scheme,route,insurer,stage,case_type}
//                                 and UPSERT the shadow hospital.claim_context row.
//
// The pure resolver (resolver.ts) stays IO-free; all DB access lives here.
// =============================================================================

import { pool as defaultPool } from '../../DB/db.js';
import { resolveContext, isIpdStage } from './resolver.js';
import type { IpdStage, ResolveContextInput, ResolvedContext } from './types.js';

/** Minimal shape satisfied by a pg Pool or PoolClient. */
export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[] }>;
}

/**
 * The claim's CURRENT stage: ipds.stage, falling back to the dossier's
 * projected current_stage, validated against the frozen ipd_stage vocabulary.
 * Returns null when neither is a recognised stage code.
 */
export async function fetchClaimStage(
  claimId: string,
  db: Queryable = defaultPool,
): Promise<IpdStage | null> {
  const { rows } = await db.query(
    `SELECT i.stage AS ipd_stage, d.current_stage AS dossier_stage
       FROM hospital.ipds i
       LEFT JOIN hospital.claim_dossiers d ON d.claim_id = i.id
      WHERE i.id = $1`,
    [claimId],
  );
  const row = rows[0];
  if (!row) return null;
  if (isIpdStage(row.ipd_stage)) return row.ipd_stage;
  if (isIpdStage(row.dossier_stage)) return row.dossier_stage;
  return null;
}

/** Assemble the pure resolver's input from the DB. Null if the IPD is gone. */
export async function loadResolveContextInput(
  claimId: string,
  db: Queryable = defaultPool,
): Promise<ResolveContextInput | null> {
  const { rows } = await db.query(
    `SELECT
        i.stage                     AS ipd_stage,
        i.claim_filing_route        AS claim_filing_route,
        i.panel_id                  AS panel_id,
        i.admitted_at               AS admitted_at,
        i.discharged_at             AS discharged_at,
        p.id                        AS panel_pk,
        p.code                      AS panel_code,
        p.name                      AS panel_name,
        d.current_stage             AS dossier_current_stage,
        d.current_panel_id          AS dossier_current_panel_id,
        d.doc_sections_by_category  AS doc_sections_by_category,
        e.episode                   AS episode
       FROM hospital.ipds i
       LEFT JOIN hospital.panels p ON p.id = i.panel_id
       LEFT JOIN hospital.claim_dossiers d ON d.claim_id = i.id
       LEFT JOIN hospital.claim_harmonised_episodes e ON e.claim_id = i.id
      WHERE i.id = $1`,
    [claimId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    claimId,
    ipd: {
      stage: r.ipd_stage ?? null,
      claim_filing_route: r.claim_filing_route ?? null,
      panel_id: r.panel_id ?? null,
      admitted_at: r.admitted_at ? new Date(r.admitted_at).toISOString() : null,
      discharged_at: r.discharged_at ? new Date(r.discharged_at).toISOString() : null,
    },
    panel: r.panel_pk ? { id: r.panel_pk, code: r.panel_code ?? null, name: r.panel_name ?? null } : null,
    // is_empanelled (panel_attributes EAV) is omitted in the M2 shadow loader —
    // route resolves from ipds.claim_filing_route (the record SoT) without it.
    isEmpanelled: null,
    dossier: {
      current_stage: r.dossier_current_stage ?? null,
      current_panel_id: r.dossier_current_panel_id ?? null,
      doc_sections_by_category: r.doc_sections_by_category ?? null,
    },
    episode: r.episode ?? null,
  };
}

/**
 * Resolve the claim context and UPSERT the SHADOW claim_context row (mig 067).
 * Best-effort: callers wrap this; it must never block a run. Returns the
 * resolved context, or null if the claim/IPD no longer exists.
 */
export async function resolveAndPersistContext(
  claimId: string,
  db: Queryable = defaultPool,
): Promise<ResolvedContext | null> {
  const input = await loadResolveContextInput(claimId, db);
  if (!input) return null;
  const ctx = resolveContext(input);
  await db.query(
    `INSERT INTO hospital.claim_context
        (claim_id, scheme, route, insurer_panel_id, stage, case_type,
         flags, context, resolver_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     ON CONFLICT (claim_id) DO UPDATE SET
        scheme           = EXCLUDED.scheme,
        route            = EXCLUDED.route,
        insurer_panel_id = EXCLUDED.insurer_panel_id,
        stage            = EXCLUDED.stage,
        case_type        = EXCLUDED.case_type,
        flags            = EXCLUDED.flags,
        context          = EXCLUDED.context,
        resolver_version = EXCLUDED.resolver_version,
        updated_at       = NOW()`,
    [
      claimId,
      ctx.scheme.value,
      ctx.route.value,
      ctx.insurerPanelId.value,
      ctx.stage.value,
      ctx.caseType.value,
      JSON.stringify(ctx.flags),
      JSON.stringify(ctx),
      ctx.resolverVersion,
    ],
  );
  return ctx;
}
