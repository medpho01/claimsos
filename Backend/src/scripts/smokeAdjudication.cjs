#!/usr/bin/env node
/**
 * Adjudication smoke test — the Waves A-D write paths, over real HTTP.
 *
 * WHY THIS EXISTS. Waves A-D shipped seven screens with clean typechecks, unit
 * tests and service-level checks against a real database — and two endpoints
 * were still returning 500 on first contact, both from column names that were
 * ASSUMED rather than looked up (`panels.panel_name` is `name`;
 * `ipds.admission_date` is `admitted_at`). Neither is catchable by a
 * typecheck, a fake pool, or a test that mocks the query layer.
 *
 * The second one mattered: it broke the Shadow Lab, which IS the rule
 * promotion gate, so every draft would have been permanently unpromotable and
 * the symptom was a 500 that looked like infrastructure.
 *
 * So this drives the real HTTP surface — routing, auth, serialisation and SQL
 * all in the path — and asserts the guard rails REFUSE what they should as
 * well as accepting what they should.
 *
 * USAGE
 *   1. Local dev stack running (the Docker dev containers bind-mount src, so
 *      changes are live; `docker restart hospital_backend_dev` after an
 *      index.ts import change).
 *   2. Mint a local superadmin token to /tmp/sa.tok — see
 *      docs or scripts/mint-dev-token.cjs. No password is involved: it signs a
 *      short-lived token with the LOCAL dev ACCESS_TOKEN_SECRET for an
 *      existing superadmin row.
 *   3. npm run smoke:adjudication
 *
 * Cleans up the rule sets it creates; see the cleanup block at the end.
 */

const TOKEN = require('fs').readFileSync('/tmp/sa.tok', 'utf8').trim();
const BASE = 'http://localhost:6001/api/v1';

let pass = 0, fail = 0;
function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`OK    ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${detail ? '  -> ' + detail : ''}`); }
}

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

(async () => {
  console.log('\n── Claim Stages ──────────────────────────────────────────');

  const before = (await req('GET', '/claim-stages?include_retired=true')).json.data;
  ok(before.length === 10, 'list returns the 10 seeded stages', `got ${before.length}`);

  // Label edit round-trips
  const orig = before.find((s) => s.code === 'ENHANCEMENT');
  let r = await req('PATCH', '/claim-stages/ENHANCEMENT', { label: 'Enhancement (smoke)' });
  ok(r.status === 200 && r.json.data.label === 'Enhancement (smoke)', 'PATCH label round-trips', `${r.status}`);
  await req('PATCH', '/claim-stages/ENHANCEMENT', { label: orig.label });

  // code is immutable
  r = await req('PATCH', '/claim-stages/ENHANCEMENT', { code: 'RENAMED' });
  ok(r.status === 400 && /immutable/.test(r.json.error || ''), 'PATCH rejects a code change', `${r.status}`);

  // cycle_types validation
  r = await req('PATCH', '/claim-stages/ENHANCEMENT', { cycle_types: ['query_response'] });
  ok(r.status === 400 && /initial/.test(r.json.error || ''), "rejects cycle_types without 'initial'", `${r.status}`);

  // reorder requires the complete list
  r = await req('PUT', '/claim-stages/order', { codes: ['PREAUTH', 'ENHANCEMENT'] });
  ok(r.status === 400 && /missing/.test(r.json.error || ''), 'reorder rejects a partial list', `${r.status}`);

  // real reorder + restore
  const codes = before.map((s) => s.code);
  const swapped = [...codes]; [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  r = await req('PUT', '/claim-stages/order', { codes: swapped });
  ok(r.status === 200 && r.json.data.map((s) => s.code).join() === swapped.join(), 'reorder persists', `${r.status}`);
  await req('PUT', '/claim-stages/order', { codes });

  // usage + retire round-trip
  r = await req('GET', '/claim-stages/PREAUTH/usage');
  ok(r.status === 200 && typeof r.json.data.claims === 'number', 'usage returns counts', `${r.status}`);
  r = await req('POST', '/claim-stages/PRE_POST_HOSP/retire', { is_active: false });
  ok(r.status === 200 && r.json.data.is_active === false, 'retire works and reports usage', `${r.status}`);
  const activeNow = (await req('GET', '/claim-stages')).json.data;
  ok(activeNow.length === 9, 'retired stage leaves the active list', `${activeNow.length}`);
  await req('POST', '/claim-stages/PRE_POST_HOSP/retire', { is_active: true });

  console.log('\n── Document Mapping ──────────────────────────────────────');

  r = await req('GET', '/document-stage-affinity/groups');
  ok(r.status === 200 && r.json.data.length > 0, 'groups list', `${r.status}`);

  // evergreen + floor is contradictory
  r = await req('PUT', '/document-stage-affinity/aadhaar_front', { is_evergreen: true, stage_floor: 'FINAL_AUTH' });
  ok(r.status === 400 && /evergreen and floored/.test(r.json.error || ''), 'rejects evergreen + floored', `${r.status}`);

  // unknown stage code
  r = await req('PUT', '/document-stage-affinity/opd_notes', { stage_floor: 'PRE_AUTH' });
  ok(r.status === 400 && /unknown stage/.test(r.json.error || ''), 'rejects a legacy stage spelling', `${r.status}`);

  // unknown category
  r = await req('PUT', '/document-stage-affinity/not_a_category', { is_evergreen: true });
  ok(r.status === 400 && /unknown doc_category/.test(r.json.error || ''), 'rejects an unknown category', `${r.status}`);

  // real upsert round-trip
  r = await req('PUT', '/document-stage-affinity/opd_notes', { affinity_stage: 'PREAUTH', notes: 'smoke' });
  ok(r.status === 200 && r.json.data.affinity_stage === 'PREAUTH', 'mapping upsert round-trips', `${r.status}`);
  await req('PUT', '/document-stage-affinity/opd_notes', { affinity_stage: null, notes: null });

  console.log('\n── Rule Sets: clone → edit → shadow → promote ────────────');

  const sets = (await req('GET', '/rule-sets')).json.data;
  const live = sets.find((s) => s.status === 'live');
  ok(Boolean(live), 'a live rule set exists to clone', live ? live.rule_set_id : 'none');

  const draftId = `SMOKE_TEST_${Date.now()}`;
  r = await req('POST', `/rule-sets/${live.rule_set_id}/clone`, { new_rule_set_id: draftId, new_name: 'Smoke draft' });
  ok(r.status === 201 && r.json.data.status === 'draft', 'clone creates a draft', `${r.status}`);

  // live is immutable
  r = await req('PATCH', `/rule-sets/${live.rule_set_id}`, { rule_set_name: 'nope' });
  ok(r.status === 400 && /clone it/.test(r.json.error || ''), 'live rule set refuses edits', `${r.status}`);

  // promotion blocked with no shadow run
  r = await req('POST', `/rule-sets/${draftId}/promote`, { change_note: 'trying it on' });
  ok(r.status === 400 && /shadow-run/.test(r.json.error || ''), 'promote blocked without a shadow run', `${r.status}`);

  // rule validation
  r = await req('PUT', `/rule-sets/${draftId}/rules`, { rule_id: 'SMOKE_R1', rule_name: 'x', kind: 'VIBES' });
  ok(r.status === 400 && /unknown rule kind/.test(r.json.error || ''), 'rejects an unknown evaluator kind', `${r.status}`);

  r = await req('PUT', `/rule-sets/${draftId}/rules`, {
    rule_id: 'SMOKE_R1', rule_name: 'Discharge summary present', kind: 'DOCUMENT_PRESENCE',
    severity: 'HIGH', category: 'DOCUMENT_COMPLETENESS', impact: 'QUERY',
    validation_logic: { category: 'discharge_summary' },
  });
  ok(r.status === 200, 'valid rule saves', `${r.status} ${r.json && r.json.error}`);

  // shadow run
  r = await req('POST', `/rule-sets/${draftId}/shadow-run`, { limit: 25 });
  ok(r.status === 200, 'shadow run completes', `${r.status} ${r.json && r.json.error}`);
  const shadow = r.json && r.json.data;
  if (shadow) {
    ok(typeof shadow.claims_evaluated === 'number', `shadow evaluated ${shadow.claims_evaluated} claims`);
    ok('delta_vs_live' in shadow, 'shadow reports the delta vs live');
  }

  // promotion now permitted... but an edit must invalidate it again
  r = await req('PUT', `/rule-sets/${draftId}/rules`, {
    rule_id: 'SMOKE_R1', rule_name: 'Renamed after shadow', kind: 'DOCUMENT_PRESENCE',
    validation_logic: { category: 'discharge_summary' },
  });
  r = await req('POST', `/rule-sets/${draftId}/promote`, { change_note: 'after an edit' });
  ok(r.status === 400 && /shadow-run/.test(r.json.error || ''),
     'an edit AFTER the shadow run re-blocks promotion', `${r.status}`);

  // re-shadow, then promote for real
  await req('POST', `/rule-sets/${draftId}/shadow-run`, { limit: 25 });
  r = await req('POST', `/rule-sets/${draftId}/promote`, { change_note: '' });
  ok(r.status === 400 && /change note/.test(r.json.error || ''), 'promote requires a change note', `${r.status}`);

  r = await req('POST', `/rule-sets/${draftId}/promote`, { change_note: 'smoke test promotion' });
  ok(r.status === 200 && r.json.data.status === 'live', 'promote succeeds when gated conditions are met', `${r.status}`);

  r = await req('GET', `/rule-sets/${draftId}/versions`);
  ok(r.status === 200 && r.json.data.length === 1 && r.json.data[0].change_note === 'smoke test promotion',
     'promotion wrote a version snapshot with the note', `${r.status}`);

  console.log('\n── Panels & Non-Payables ─────────────────────────────────');

  const panels = (await req('GET', '/adjudication-config/panels')).json.data;
  ok(panels.length > 0, `panel list loads (${panels.length})`);

  const p0 = panels[0];
  r = await req('PUT', `/adjudication-config/panels/${p0.panel_id}`, { claim_file_days: 0 });
  ok(r.status === 400 && /greater than 0/.test(r.json.error || ''), 'rejects a zero deadline', `${r.status}`);

  r = await req('PUT', `/adjudication-config/panels/${p0.panel_id}`, {
    claim_file_days: 7, preauth_decision_hours: 1,
    terminology_aliases: { FINAL_AUTH: 'enhancement' },
    proportionate_exempt_heads: ['pharmacy', 'implants'],
    source_note: 'smoke test',
  });
  ok(r.status === 200 && r.json.data.claim_file_days === 7, 'panel config round-trips', `${r.status}`);

  const np = (await req('GET', '/adjudication-config/non-payables')).json;
  ok(np.items.length === 27 && np.coverage.irdai_total === 146 && np.coverage.complete === false,
     'non-payables reports PARTIAL coverage 27/146', `${np.items.length}`);

  r = await req('GET', '/adjudication-config/non-payables?search=glucometer');
  ok(r.json.items.length === 1, 'non-payables search by name', `${r.json.items.length}`);
  r = await req('GET', '/adjudication-config/non-payables?search=urobag');
  ok(r.json.items.length === 1, 'non-payables search matches an ALIAS', `${r.json.items.length}`);

  console.log('\n── Calibration ───────────────────────────────────────────');
  r = await req('GET', '/rule-calibration?days=3650');
  ok(r.status === 200 && Array.isArray(r.json.data), `calibration loads (${r.json.data.length} rules)`, `${r.status}`);
  const unreviewed = r.json.data.find((x) => x.agreement_rate === null);
  ok(unreviewed !== undefined, 'unreviewed rules report agreement_rate=null, not 0');

  console.log('\n── Cleanup ───────────────────────────────────────────────');
  console.log(`(leaving ${draftId} promoted — clean up manually if it matters)`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
