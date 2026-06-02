// =============================================================================
// Full review cycle: trigger adjudication → show the complete output → submit
// sample feedback. This is the manual "trigger AI, review output, correct" loop.
//
// Usage:
//   POSTGRES_HOST=localhost npx tsx src/scripts/reviewClaim.ts [claimId]
//   POSTGRES_HOST=localhost npx tsx src/scripts/reviewClaim.ts [claimId] --run
//
// --run  re-runs the adjudicator first (force-fetches fresh output).
//        Omit to just show whatever is already persisted.
// =============================================================================

import { pool } from '../DB/db.js';
import { adjudicateClaim, getClaimReview } from '../Services/adjudication/stageAwareAdjudicator.service.js';
import { recordFeedback } from '../Services/adjudication/feedback.service.js';

const CLAIM_ID = process.argv[2] ?? '4b48967b-e559-41c2-9268-4334642dba47';
const SHOULD_RUN = process.argv.includes('--run');

function section(title: string): void {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

async function main(): Promise<void> {
  // ── Step 1: (Re-)run the adjudicator if requested ─────────────────────────
  if (SHOULD_RUN) {
    section('RUNNING adjudicator…');
    const run = await adjudicateClaim(CLAIM_ID);
    console.log(`stage       : ${run.stage ?? '(derived/none)'}`);
    console.log(`scheme      : ${run.context?.scheme}`);
    console.log(`insurer     : ${run.context?.insurer}`);
    console.log(`case_type   : ${run.context?.caseType}`);
    console.log(`rule_set    : ${run.ruleSetId ?? '(no match)'}`);
    console.log(`score       : ${run.readinessScore ?? '-'}`);
    console.log(`action      : ${run.recommendedAction}`);
  }

  // ── Step 2: Load the full review payload ───────────────────────────────────
  section('FULL REVIEW PAYLOAD');
  const review = await getClaimReview(CLAIM_ID);

  section('CONTEXT (resolved: scheme / route / insurer / stage / case_type)');
  if (review.context) {
    const c = review.context as any;
    console.log(`  scheme        : ${c.scheme ?? '—'}`);
    console.log(`  route         : ${c.route ?? '—'}`);
    console.log(`  insurer       : ${c.insurer_panel_id ?? '—'}`);
    console.log(`  stage         : ${c.stage ?? '—'}`);
    console.log(`  case_type     : ${c.case_type ?? '—'}`);
    console.log(`  flags         : ${JSON.stringify(c.flags ?? [])}`);
  } else {
    console.log('  (no context row — run adjudication first, or with --run)');
  }

  section("HARMONISED EPISODE (the AI's structured medical output)");
  const ep = review.episode as any;
  if (ep?.episode) {
    const e = ep.episode;
    console.log(`  patient       : ${e.patient_context?.first_name ?? ''} ${e.patient_context?.last_name ?? ''}`);
    console.log(`  episode_type  : ${e.meta?.episode_type ?? '—'}`);
    console.log(`  admission     : ${e.stay_summary?.admission_datetime ?? '—'}`);
    console.log(`  discharge     : ${e.stay_summary?.discharge_datetime ?? '—'}`);
    console.log(`  diagnosis     : ${e.diagnosis?.primary_diagnosis?.diagnosis_name ?? '—'}`);
    console.log(`  financial:    : ${JSON.stringify(e.financial_summary?.reconciliation ?? {})}`);
    console.log(`  ep status     : ${ep.status}  |  confidence: ${ep.confidence}  |  cost: ₹${ep.cost_inr}`);
  } else {
    console.log('  (no harmonised episode yet — run AI analysis first)');
  }

  section(`DOCUMENTS (${(review.documents as any[]).length} canonical sections)`);
  const byDoc: Record<string, any[]> = {};
  for (const s of review.documents as any[]) {
    (byDoc[s.file_name ?? 'unknown'] ??= []).push(s);
  }
  for (const [file, secs] of Object.entries(byDoc)) {
    console.log(`  📄 ${file}`);
    for (const s of secs) {
      const fields = s.extracted_fields ? Object.keys(s.extracted_fields).filter(k => !k.startsWith('_')).join(', ') : '—';
      console.log(`     pp ${s.page_start}–${s.page_end}  [${s.category ?? '?'}]  stage:${s.stage ?? '?'}  fields: ${fields || '—'}`);
    }
  }

  section('ADJUDICATION — hypotheses');
  for (const h of (review.adjudication as any).hypotheses) {
    const l4 = h.layer4_readiness ?? {};
    console.log(`  stage: ${h.stage || '(any)'}  |  rule_set: ${l4.rule_set ?? '—'}  |  score: ${l4.readiness_score ?? '-'}  |  action: ${l4.recommended_action ?? '—'}`);
    if (l4.blocking?.length)  console.log(`    ⛔ blocking : ${l4.blocking.join(', ')}`);
    if (l4.abstained?.length) console.log(`    ⚠️  abstained: ${l4.abstained.join(', ')}`);
    if (l4.warnings?.length)  console.log(`    ⚡ warnings : ${l4.warnings.join(', ')}`);
  }

  section('ADJUDICATION — per-rule outcomes');
  for (const e of (review.adjudication as any).evaluations) {
    const icon = e.status === 'PASS' ? '✅' : e.status === 'FAIL' ? '❌' : e.status === 'SKIP' ? '⏭️ ' : '⚠️ ';
    console.log(`  ${icon} [${e.stage || 'any'}] ${e.rule_id.padEnd(32)} ${e.status}  ${e.message.slice(0, 60)}`);
  }

  section('FEEDBACK recorded so far');
  const fbs = review.feedback as any[];
  if (fbs.length === 0) {
    console.log('  (none yet)');
  } else {
    for (const f of fbs) {
      console.log(`  ${f.verdict.toUpperCase().padEnd(9)} [${f.layer}] ${f.target_ref ?? '—'}  root:${f.root_cause ?? '—'}  "${f.notes ?? ''}"`);
    }
  }

  // ── Step 3: Demo feedback submission ────────────────────────────────────────
  section('DEMO: submitting sample feedback');
  const evals = (review.adjudication as any).evaluations as any[];
  const firstFail = evals.find((e: any) => e.status === 'FAIL');
  if (firstFail) {
    const id = await recordFeedback({
      claimId: CLAIM_ID,
      stage: firstFail.stage || null,
      layer: 'rules',
      targetRef: firstFail.rule_id,
      verdict: 'disagree',
      rootCause: 'rules',
      notes: `Demo feedback: rule "${firstFail.rule_id}" was flagged as over-strict by the reviewer.`,
    });
    console.log(`  ✅ feedback recorded (id: ${id})`);
    console.log('  This will surface in the rule-override calibration summary.');
  } else {
    console.log('  (no FAIL outcomes to demo — all rules passed/skipped)');
  }

  console.log('\n');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
