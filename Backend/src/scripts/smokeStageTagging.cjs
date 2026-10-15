#!/usr/bin/env node
/**
 * End-to-end smoke for the stage-tagging path, against the REAL local database.
 *
 * WHY A SEPARATE SCRIPT FROM THE UNIT TESTS
 * The unit tests run stampSectionStages over a fake pool, so they prove the
 * precedence and the grouping but NOT that the SQL is valid, that the columns
 * exist, or that ipd_doc.declared_stage actually joins through to a section.
 * Every defect this path has had so far was of that kind — a column that did
 * not exist, a join that named the wrong table. Those only show up against a
 * real schema.
 *
 * Creates its own throwaway IPD + document + sections, asserts, and removes
 * them in a finally block. Safe to run repeatedly; refuses to run against a
 * non-local database.
 *
 *   node src/scripts/smokeStageTagging.cjs
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Client } = require('pg');

const LOCAL = ['localhost', '127.0.0.1', 'host.docker.internal'];

// Read the REAL variable. This said `POSTGRES_HOST_OVERRIDE || 'localhost'`,
// a name nothing else in the codebase sets — so on production the guard below
// compared the literal 'localhost' against the local list, decided it was
// local, and let the script proceed to connect to a database that is not
// there. It then died with an empty `FATAL` (see the error handler at the
// bottom for why the message was blank).
//
// It failed SAFE only by accident: the connection never succeeded, so no
// fixture rows were written to production. The guard still has to work.
const HOST = process.env.POSTGRES_HOST || 'localhost';
const IS_LOCAL = LOCAL.includes(HOST);

// The [stamp] section CREATES an IPD, a document and sections, then deletes
// them. That is fine on a dev database and unacceptable on a live one. Pass
// --read-only to run just the schema and cutover assertions, which are pure
// SELECTs — that is the mode production should use.
const READ_ONLY = process.argv.includes('--read-only');

let passed = 0;
let failed = 0;

function ok(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

async function main() {
  if (!IS_LOCAL && !READ_ONLY) {
    console.error(
      `[smoke:stage] refusing to write fixtures to non-local host "${HOST}".\n`
      + '[smoke:stage] re-run with --read-only to verify schema and cutover without writing:\n'
      + '[smoke:stage]     npm run smoke:stage -- --read-only',
    );
    process.exit(1);
  }
  console.log(`[smoke:stage] host=${HOST}  mode=${READ_ONLY ? 'read-only' : 'full (writes fixtures)'}`);

  const db = new Client({
    host: HOST,
    port: process.env.POSTGRES_PORT || 5432,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  await db.connect();

  let ipdId = null;
  let docId = null;

  try {
    // ── schema shape ──────────────────────────────────────────────────────
    const cols = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='hospital'
          AND ((table_name='document_sections' AND column_name IN ('stage','stage_source'))
            OR (table_name='ipd_doc' AND column_name='declared_stage'))`,
    );
    const have = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
    console.log('\n[schema]');
    ok('document_sections.stage exists', have.has('document_sections.stage'));
    ok('document_sections.stage_source exists', have.has('document_sections.stage_source'));
    ok('ipd_doc.declared_stage exists', have.has('ipd_doc.declared_stage'));

    // ── cutover left nothing behind ───────────────────────────────────────
    console.log('\n[cutover]');
    const stray = await db.query(
      `SELECT src, val FROM (
         SELECT 'ipds.stage' src, stage val FROM hospital.ipds WHERE stage IS NOT NULL
         UNION ALL SELECT 'claim_context.stage', stage FROM hospital.claim_context WHERE stage IS NOT NULL
         UNION ALL SELECT 'document_sections.stage', stage FROM hospital.document_sections WHERE stage IS NOT NULL
         UNION ALL SELECT 'insurer_document_requirements.stage', stage
           FROM hospital.insurer_document_requirements WHERE stage IS NOT NULL AND stage <> 'ALL'
         UNION ALL SELECT 'insurer_rule_sets.applicable_stages', unnest(applicable_stages)
           FROM hospital.insurer_rule_sets
       ) x WHERE val NOT IN (SELECT code FROM hospital.claim_stages)`,
    );
    ok(
      'no unmapped stage values anywhere',
      stray.rowCount === 0,
      stray.rows.map((r) => `${r.src}=${r.val}`).join(', '),
    );

    const statuses = await db.query(
      `SELECT count(*)::int n FROM hospital.insurer_rule_sets
        WHERE applicable_stages && ARRAY['preauth_approved','discharge_approved','discharged']`,
    );
    ok('status values dropped from rule packs', statuses.rows[0].n === 0);

    // Every live pack must still be scoped to SOMETHING — the drop must not
    // have emptied a pack, which would silently stop it firing.
    const emptied = await db.query(
      `SELECT count(*)::int n FROM hospital.insurer_rule_sets s
        WHERE s.status = 'live'
          AND COALESCE(array_length(s.applicable_stages, 1), 0) = 0
          AND EXISTS (SELECT 1 FROM hospital.insurance_rules r
                       WHERE r.rule_set_id = s.id AND r.kind IS NOT NULL)`,
    );
    console.log(`  note packs with kinded rules and no stage scope: ${emptied.rows[0].n}`);

    // ── the real path ─────────────────────────────────────────────────────
    console.log(
      READ_ONLY
        ? '\n[stamp] skipped — --read-only (this section writes fixture rows)'
        : '\n[stamp]',
    );
    if (!READ_ONLY) {
    const hospital = await db.query('SELECT id FROM hospital.hospitals LIMIT 1');
    if (!hospital.rowCount) throw new Error('no hospitals in local DB to attach a fixture to');

    const ipd = await db.query(
      `INSERT INTO hospital.ipds (first_name, last_name, hospital_id, stage)
       VALUES ('Smoke', 'StageTag', $1, 'PREAUTH') RETURNING id`,
      [hospital.rows[0].id],
    );
    ipdId = ipd.rows[0].id;

    const doc = await db.query(
      `INSERT INTO hospital.ipd_doc (ipd_id, file_name, type, declared_stage)
       VALUES ($1, 'smoke-stage.pdf', 'admission', 'FINAL_AUTH') RETURNING id`,
      [ipdId],
    );
    docId = doc.rows[0].id;

    // An evergreen category and a plain one, so both branches are exercised.
    const evergreen = await db.query(
      `SELECT doc_category FROM hospital.document_stage_affinity
        WHERE is_evergreen IS TRUE LIMIT 1`,
    );
    const evergreenCat = evergreen.rows[0]?.doc_category ?? null;

    await db.query(
      `INSERT INTO hospital.document_sections
         (document_id, claim_id, page_start, page_end, category, status, segmenter_version)
       VALUES ($1, $2, 1, 1, 'final_bill', 'auto', 'smoke'),
              ($1, $2, 2, 2, $3, 'auto', 'smoke'),
              ($1, $2, 3, 3, NULL, 'auto', 'smoke')`,
      [docId, ipdId, evergreenCat],
    );

    const { stampSectionStages } = await import(
      '../Services/harmoniser/stampSectionStages.js'
    );
    const result = await stampSectionStages(db, docId, ipdId);
    ok('stamp touched all three sections', result.stamped === 3, `stamped=${result.stamped}`);

    const after = await db.query(
      `SELECT category, stage, stage_source FROM hospital.document_sections
        WHERE document_id = $1 ORDER BY page_start`,
      [docId],
    );
    const byPage = after.rows;

    ok(
      'declared stage beats the claim stage',
      byPage[0].stage === 'FINAL_AUTH' && byPage[0].stage_source === 'declared',
      `got ${byPage[0].stage}/${byPage[0].stage_source}`,
    );

    if (evergreenCat) {
      ok(
        'evergreen category resolves to NULL stage with a recorded source',
        byPage[1].stage === null && byPage[1].stage_source === 'none',
        `got ${byPage[1].stage}/${byPage[1].stage_source}`,
      );
    } else {
      console.log('  skip evergreen assertion — no evergreen category seeded');
    }

    ok(
      'category-less section still gets the declared stage',
      byPage[2].stage === 'FINAL_AUTH' && byPage[2].stage_source === 'declared',
      `got ${byPage[2].stage}/${byPage[2].stage_source}`,
    );

    // A reviewer-corrected row must survive a re-stamp.
    await db.query(
      `UPDATE hospital.document_sections SET status='reviewed', stage='PREAUTH',
              stage_source='reviewer'
        WHERE document_id=$1 AND page_start=1`,
      [docId],
    );
    await stampSectionStages(db, docId, ipdId);
    const reviewed = await db.query(
      `SELECT stage, stage_source FROM hospital.document_sections
        WHERE document_id=$1 AND page_start=1`,
      [docId],
    );
    ok(
      're-stamp does not overwrite a reviewed section',
      reviewed.rows[0].stage === 'PREAUTH' && reviewed.rows[0].stage_source === 'reviewer',
      `got ${reviewed.rows[0].stage}/${reviewed.rows[0].stage_source}`,
    );
    }
  } finally {
    if (docId) {
      await db.query('DELETE FROM hospital.document_sections WHERE document_id=$1', [docId]);
      await db.query('DELETE FROM hospital.ipd_doc WHERE id=$1', [docId]);
    }
    if (ipdId) await db.query('DELETE FROM hospital.ipds WHERE id=$1', [ipdId]);
    await db.end();
  }

  console.log(`\n[smoke:stage] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  // Print the WHOLE error, not just `.message`. A failed connection to
  // "localhost" throws an AggregateError — one failure per resolved address,
  // ::1 and 127.0.0.1 — and AggregateError.message is EMPTY. Printing only
  // the message produced a bare `[smoke:stage] FATAL` with nothing after it,
  // which is worse than no output: it says something broke and refuses to say
  // what.
  console.error('[smoke:stage] FATAL:', e?.message || e?.code || '(no message)');
  if (Array.isArray(e?.errors)) {
    for (const sub of e.errors) console.error('  -', sub?.message ?? String(sub));
  }
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
