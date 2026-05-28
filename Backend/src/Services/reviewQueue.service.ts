/**
 * Review Queue Service (iter7 Stage 7) — surfaces claims whose AI run
 * produced any quality-gate flag, so a human can disposition them.
 *
 * Flag sources we monitor today (all written by the harmoniser
 * post-LLM validators added in Fixes 16-22):
 *
 *   foreign_patient_sections    — Fix 17, patient-name fuzzy mismatch
 *                                 (Vahadur / Begum Faiz case)
 *   gps_photo_clustering        — Fix 19, near-dup pairs +
 *                                 cross-hospital GPS outliers
 *                                 (Shabana ward-photo near-dup,
 *                                  Vahadur Siddh Hospital outlier)
 *   date_incoherent_sections    — Fix 22, sections dated outside the
 *                                 [admission-7d, discharge+14d] window
 *   completeness_penalties      — Fix 17/20/22, any penalty entry means
 *                                 a guardrail fired
 *   identity_warning            — Stage 1 (planned), upload-time
 *                                 patient-name mismatch on ipd_doc
 *
 * The queue is FLAT (no nesting per flag). The detail endpoint
 * groups the flag types for the UI.
 *
 * Access: superadmin only. Hospital admins won't see the queue while
 * the feature is in pilot — matches the existing intelligence-layer
 * gating pattern.
 */
import { pool } from '../DB/db.js';

export interface ReviewQueueRow {
  claim_id: string;
  patient_first_name: string | null;
  patient_last_name: string | null;
  hospital_id: string | null;
  hospital_name: string | null;
  generated_at: string;
  flag_types: string[];                 // distinct flag kinds present
  total_flags: number;                  // sum of all flagged items
  completeness_score: number | null;
  episode_status: string;
}

export interface ReviewQueueDetail extends ReviewQueueRow {
  validation_metadata: Record<string, unknown>;
  meta: Record<string, unknown>;
  flagged_sections: Array<{
    section_id: string;
    flag_type: string;
    category: string | null;
    page_start: number | null;
    page_end: number | null;
    document_id: string;
    file_name: string | null;
    s3_key: string | null;
    extracted_fields: unknown;
    detail: unknown;     // the per-flag payload (e.g. observed name)
  }>;
}

/** Page through claims with at least one validation_metadata flag. */
export async function listFlaggedClaims(opts: {
  limit?: number;
  offset?: number;
  hospital_id?: string;
} = {}): Promise<{ rows: ReviewQueueRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  // A claim qualifies if its harmonised episode has ANY of the flag
  // arrays/objects under validation_metadata. We don't filter on the
  // identity_warning (Stage 1) yet — joined in once that lands.
  const sql = `
    WITH flagged AS (
      SELECT
        e.claim_id,
        e.generated_at,
        e.episode,
        e.status                                       AS episode_status,
        (e.episode->'meta'->>'data_completeness_score')::numeric
                                                       AS completeness_score,
        e.episode->'validation_metadata'              AS vm
      FROM hospital.claim_harmonised_episodes e
      WHERE
        jsonb_array_length(
          COALESCE(e.episode->'validation_metadata'->'foreign_patient_sections', '[]'::jsonb)
        ) > 0
        OR jsonb_array_length(
          COALESCE(e.episode->'validation_metadata'->'date_incoherent_sections', '[]'::jsonb)
        ) > 0
        OR (e.episode->'validation_metadata'->'gps_photo_clustering') IS NOT NULL
        OR jsonb_array_length(
          COALESCE(e.episode->'validation_metadata'->'completeness_penalties', '[]'::jsonb)
        ) > 0
    )
    SELECT
      f.claim_id,
      f.generated_at,
      f.episode_status,
      f.completeness_score,
      f.vm,
      i.first_name      AS patient_first_name,
      i.last_name       AS patient_last_name,
      i.hospital_id,
      h.name            AS hospital_name
    FROM flagged f
    JOIN hospital.ipds i      ON i.id = f.claim_id
    LEFT JOIN hospital.hospitals h ON h.id = i.hospital_id
    ${opts.hospital_id ? 'WHERE i.hospital_id = $3' : ''}
    ORDER BY f.generated_at DESC
    LIMIT $1 OFFSET $2
  `;
  const params: unknown[] = [limit, offset];
  if (opts.hospital_id) params.push(opts.hospital_id);
  const { rows } = await pool.query<{
    claim_id: string;
    generated_at: Date;
    episode_status: string;
    completeness_score: string | null;
    vm: Record<string, unknown> | null;
    patient_first_name: string | null;
    patient_last_name: string | null;
    hospital_id: string | null;
    hospital_name: string | null;
  }>(sql, params);

  const totalSql = `
    SELECT count(*)::int AS n FROM hospital.claim_harmonised_episodes e
    ${opts.hospital_id ? `JOIN hospital.ipds i ON i.id = e.claim_id WHERE i.hospital_id = $1 AND` : 'WHERE'}
      (jsonb_array_length(COALESCE(e.episode->'validation_metadata'->'foreign_patient_sections', '[]'::jsonb)) > 0
       OR jsonb_array_length(COALESCE(e.episode->'validation_metadata'->'date_incoherent_sections', '[]'::jsonb)) > 0
       OR (e.episode->'validation_metadata'->'gps_photo_clustering') IS NOT NULL
       OR jsonb_array_length(COALESCE(e.episode->'validation_metadata'->'completeness_penalties', '[]'::jsonb)) > 0)
  `;
  const totalParams: unknown[] = opts.hospital_id ? [opts.hospital_id] : [];
  const totalRes = await pool.query<{ n: number }>(totalSql, totalParams);

  return {
    total: totalRes.rows[0]?.n ?? 0,
    rows: rows.map((r) => ({
      claim_id: r.claim_id,
      generated_at: r.generated_at.toISOString(),
      episode_status: r.episode_status,
      completeness_score: r.completeness_score == null ? null : Number(r.completeness_score),
      flag_types: extractFlagTypes(r.vm),
      total_flags: countFlags(r.vm),
      patient_first_name: r.patient_first_name,
      patient_last_name: r.patient_last_name,
      hospital_id: r.hospital_id,
      hospital_name: r.hospital_name,
    })),
  };
}

/** Per-claim deep dive — used by the detail view. */
export async function getFlaggedClaim(
  claim_id: string,
): Promise<ReviewQueueDetail | null> {
  const epRes = await pool.query<{
    episode: any;
    generated_at: Date;
    status: string;
  }>(
    `SELECT episode, generated_at, status
     FROM hospital.claim_harmonised_episodes
     WHERE claim_id = $1`,
    [claim_id],
  );
  if (epRes.rowCount === 0) return null;
  const ep = epRes.rows[0]!.episode;
  const vm = (ep?.validation_metadata ?? {}) as Record<string, unknown>;
  const meta = (ep?.meta ?? {}) as Record<string, unknown>;

  // Patient + hospital context
  const ctxRes = await pool.query<{
    first_name: string | null;
    last_name: string | null;
    hospital_id: string | null;
    hospital_name: string | null;
  }>(
    `SELECT i.first_name, i.last_name, i.hospital_id, h.name AS hospital_name
     FROM hospital.ipds i
     LEFT JOIN hospital.hospitals h ON h.id = i.hospital_id
     WHERE i.id = $1`,
    [claim_id],
  );

  // Pull flagged section_ids from each flag bucket
  const flaggedSectionIds = new Set<string>();
  const sectionFlagMap = new Map<string, Array<{ flag_type: string; detail: unknown }>>();

  const push = (sid: string, flag_type: string, detail: unknown) => {
    if (!sid) return;
    flaggedSectionIds.add(sid);
    const arr = sectionFlagMap.get(sid) ?? [];
    arr.push({ flag_type, detail });
    sectionFlagMap.set(sid, arr);
  };

  for (const f of (vm.foreign_patient_sections ?? []) as any[]) {
    push(f.section_id, 'foreign_patient_section', f);
  }
  for (const f of (vm.date_incoherent_sections ?? []) as any[]) {
    push(f.section_id, 'date_incoherent', f);
  }
  const gps = vm.gps_photo_clustering as any;
  if (gps?.near_duplicate_pairs) {
    for (const p of gps.near_duplicate_pairs) {
      push(p.duplicate, 'gps_near_duplicate', p);
    }
  }
  if (gps?.cross_episode_outliers) {
    for (const sid of gps.cross_episode_outliers) {
      push(sid, 'gps_cross_episode_outlier', { section_id: sid });
    }
  }

  // Fetch the flagged sections + their docs in one go
  let flagged_sections: ReviewQueueDetail['flagged_sections'] = [];
  if (flaggedSectionIds.size > 0) {
    const secRes = await pool.query<{
      id: string;
      document_id: string;
      category: string | null;
      page_start: number | null;
      page_end: number | null;
      extracted_fields: unknown;
      file_name: string | null;
      s3_key: string | null;
    }>(
      `SELECT s.id, s.document_id, s.category, s.page_start, s.page_end,
              s.extracted_fields, d.file_name, d.s3_key
         FROM hospital.document_sections s
         LEFT JOIN hospital.ipd_doc d ON d.id = s.document_id
         WHERE s.id = ANY($1)`,
      [[...flaggedSectionIds]],
    );

    flagged_sections = [];
    for (const row of secRes.rows) {
      const flags = sectionFlagMap.get(row.id) ?? [];
      for (const f of flags) {
        flagged_sections.push({
          section_id: row.id,
          flag_type: f.flag_type,
          category: row.category,
          page_start: row.page_start,
          page_end: row.page_end,
          document_id: row.document_id,
          file_name: row.file_name,
          s3_key: row.s3_key,
          extracted_fields: row.extracted_fields,
          detail: f.detail,
        });
      }
    }
  }

  const ctx = ctxRes.rows[0];
  return {
    claim_id,
    generated_at: epRes.rows[0]!.generated_at.toISOString(),
    episode_status: epRes.rows[0]!.status,
    completeness_score: typeof meta.data_completeness_score === 'number'
      ? meta.data_completeness_score : null,
    flag_types: extractFlagTypes(vm),
    total_flags: countFlags(vm),
    patient_first_name: ctx?.first_name ?? null,
    patient_last_name: ctx?.last_name ?? null,
    hospital_id: ctx?.hospital_id ?? null,
    hospital_name: ctx?.hospital_name ?? null,
    validation_metadata: vm,
    meta,
    flagged_sections,
  };
}

/**
 * Disposition a flagged section.
 *
 *   action='accept'  — mark the section reviewed; clears the
 *                      relevant flag entry, leaves episode untouched.
 *                      The reviewer signs off that the AI was correct.
 *
 *   action='reject'  — set document_sections.status='rejected' so the
 *                      next harmonisation run drops it. Also strips
 *                      the flag entry. Caller usually wants to enqueue
 *                      a regenerate after this.
 *
 *   action='correct' — write to harmonisation_corrections at the
 *                      provided json_path, patch the episode in place.
 *                      Reuses the existing applyCorrection plumbing.
 */
export async function dispositionSection(opts: {
  claim_id: string;
  section_id: string;
  flag_type: string;
  action: 'accept' | 'reject' | 'correct';
  user_id: string;
  reason?: string;
  correction?: { json_path: string; human_value: unknown };
}): Promise<{ section_status?: string; correction_id?: string }> {
  const { claim_id, section_id, flag_type, action, user_id, reason, correction } = opts;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Always strip the flag entry from validation_metadata so the
    // claim falls out of the queue (or stays in with fewer flags).
    const stripFlagSql = `
      UPDATE hospital.claim_harmonised_episodes
      SET episode = jsonb_set(
        episode,
        '{validation_metadata}',
        ${stripFlagJsonExpr(flag_type)}
      )
      WHERE claim_id = $2
    `;
    await client.query(stripFlagSql, [section_id, claim_id]);

    let section_status: string | undefined;
    let correction_id: string | undefined;

    if (action === 'reject') {
      await client.query(
        `UPDATE hospital.document_sections
            SET status = 'rejected',
                reviewed_by = $1,
                reviewed_at = now(),
                notes = COALESCE(notes || E'\n', '') || $2
          WHERE id = $3`,
        [user_id, `Review queue: ${reason ?? 'rejected as flagged'}`, section_id],
      );
      section_status = 'rejected';
    } else if (action === 'accept') {
      await client.query(
        `UPDATE hospital.document_sections
            SET status = 'reviewed',
                reviewed_by = $1,
                reviewed_at = now(),
                notes = COALESCE(notes || E'\n', '') || $2
          WHERE id = $3`,
        [user_id, `Review queue: accepted (${flag_type})`, section_id],
      );
      section_status = 'reviewed';
    } else if (action === 'correct') {
      if (!correction) throw new Error('correction payload required when action=correct');
      const ins = await client.query<{ id: string }>(
        `INSERT INTO hospital.harmonisation_corrections
           (claim_id, json_path, human_value, corrected_by, reason)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [claim_id, correction.json_path, JSON.stringify(correction.human_value),
         user_id, reason ?? null],
      );
      correction_id = ins.rows[0]?.id;
      // applying to episode is left to the existing applyCorrection
      // controller path so behaviour stays consistent.
    }

    await client.query('COMMIT');
    return { section_status, correction_id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function extractFlagTypes(vm: any): string[] {
  if (!vm || typeof vm !== 'object') return [];
  const flags = new Set<string>();
  if (Array.isArray(vm.foreign_patient_sections) && vm.foreign_patient_sections.length > 0)
    flags.add('foreign_patient_section');
  if (Array.isArray(vm.date_incoherent_sections) && vm.date_incoherent_sections.length > 0)
    flags.add('date_incoherent');
  const gps = vm.gps_photo_clustering;
  if (gps?.near_duplicate_pairs?.length > 0)
    flags.add('gps_near_duplicate');
  if (gps?.cross_episode_outliers?.length > 0)
    flags.add('gps_cross_episode_outlier');
  if (Array.isArray(vm.completeness_penalties) && vm.completeness_penalties.length > 0)
    flags.add('completeness_penalty');
  return [...flags];
}

function countFlags(vm: any): number {
  if (!vm || typeof vm !== 'object') return 0;
  let n = 0;
  if (Array.isArray(vm.foreign_patient_sections)) n += vm.foreign_patient_sections.length;
  if (Array.isArray(vm.date_incoherent_sections)) n += vm.date_incoherent_sections.length;
  const gps = vm.gps_photo_clustering;
  if (Array.isArray(gps?.near_duplicate_pairs)) n += gps.near_duplicate_pairs.length;
  if (Array.isArray(gps?.cross_episode_outliers)) n += gps.cross_episode_outliers.length;
  return n;
}

/**
 * Build the jsonb expression that removes the matching flag entry.
 * Bound parameter $1 is the section_id we're dispositioning.
 *
 * We don't try to be clever here — most flags index by section_id and
 * we strip the matching entry. The completeness_penalties / gps
 * sub-objects are handled inline.
 */
function stripFlagJsonExpr(flag_type: string): string {
  switch (flag_type) {
    case 'foreign_patient_section':
      return `
        COALESCE(episode->'validation_metadata', '{}'::jsonb) ||
        jsonb_build_object(
          'foreign_patient_sections',
          COALESCE((
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(episode->'validation_metadata'->'foreign_patient_sections') elem
            WHERE elem->>'section_id' <> $1
          ), '[]'::jsonb)
        )
      `;
    case 'date_incoherent':
      return `
        COALESCE(episode->'validation_metadata', '{}'::jsonb) ||
        jsonb_build_object(
          'date_incoherent_sections',
          COALESCE((
            SELECT jsonb_agg(elem)
            FROM jsonb_array_elements(episode->'validation_metadata'->'date_incoherent_sections') elem
            WHERE elem->>'section_id' <> $1
          ), '[]'::jsonb)
        )
      `;
    case 'gps_near_duplicate':
      return `
        COALESCE(episode->'validation_metadata', '{}'::jsonb) ||
        jsonb_build_object(
          'gps_photo_clustering',
          COALESCE(episode->'validation_metadata'->'gps_photo_clustering', '{}'::jsonb) ||
          jsonb_build_object(
            'near_duplicate_pairs',
            COALESCE((
              SELECT jsonb_agg(elem)
              FROM jsonb_array_elements(episode->'validation_metadata'->'gps_photo_clustering'->'near_duplicate_pairs') elem
              WHERE elem->>'duplicate' <> $1
            ), '[]'::jsonb)
          )
        )
      `;
    case 'gps_cross_episode_outlier':
      return `
        COALESCE(episode->'validation_metadata', '{}'::jsonb) ||
        jsonb_build_object(
          'gps_photo_clustering',
          COALESCE(episode->'validation_metadata'->'gps_photo_clustering', '{}'::jsonb) ||
          jsonb_build_object(
            'cross_episode_outliers',
            COALESCE((
              SELECT jsonb_agg(elem)
              FROM jsonb_array_elements(episode->'validation_metadata'->'gps_photo_clustering'->'cross_episode_outliers') elem
              WHERE elem <> to_jsonb($1::text)
            ), '[]'::jsonb)
          )
        )
      `;
    case 'completeness_penalty':
      // No section_id to match — accept just clears the completeness
      // penalty list entirely on the claim.
      return `
        COALESCE(episode->'validation_metadata', '{}'::jsonb) ||
        jsonb_build_object('completeness_penalties', '[]'::jsonb)
      `;
    default:
      return `episode->'validation_metadata'`;  // no-op
  }
}
