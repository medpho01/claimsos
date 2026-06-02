// =============================================================================
// Batch-adjudicate N real claims and print the spread (validation shakedown).
// Usage: POSTGRES_HOST=localhost npx tsx src/scripts/batchAdjudicate.ts [limit]
// Writes only the shadow eval tables (claim_rule_evaluations / claim_hypothesis).
// =============================================================================

import { pool } from '../DB/db.js';
import { adjudicateClaim } from '../Services/adjudication/stageAwareAdjudicator.service.js';

function bump(o: Record<string, number>, k: string): void {
  o[k] = (o[k] ?? 0) + 1;
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 30);
  const { rows } = await pool.query(
    `SELECT i.id
       FROM hospital.ipds i
       JOIN hospital.claim_harmonised_episodes che ON che.claim_id = i.id AND che.episode IS NOT NULL
      WHERE EXISTS (SELECT 1 FROM hospital.document_sections ds WHERE ds.claim_id = i.id AND ds.dedup_of IS NULL)
      ORDER BY i.id
      LIMIT $1`,
    [limit],
  );

  const byRuleSet: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let noMatch = 0, noKinded = 0, skips = 0, fails = 0, errors = 0;

  console.log(`claim    | scheme            | stage                | rule set                         | score | action`);
  console.log('-'.repeat(120));
  for (const r of rows) {
    const res = await adjudicateClaim(r.id as string);
    const rs = res.ruleSetId ?? '(no match)';
    bump(byRuleSet, rs);
    bump(byStage, res.stage ?? '(none)');
    bump(byAction, res.recommendedAction ?? '?');
    if (!res.ruleSetId) noMatch++;
    else if ((res.results?.length ?? 0) === 0) noKinded++;
    for (const e of res.results ?? []) {
      if (e.status === 'SKIP') skips++;
      else if (e.status === 'FAIL') fails++;
      else if (e.status === 'ERROR') errors++;
    }
    console.log(
      `${(r.id as string).slice(0, 8)} | ${(res.context?.scheme ?? '?').padEnd(17)} | ${(res.stage ?? '(none)').padEnd(20)} | ${rs.padEnd(32)} | ${String(res.readinessScore ?? '-').padEnd(5)} | ${res.recommendedAction ?? '?'}`,
    );
  }

  console.log('\n=== AGGREGATE ===');
  console.log('claims adjudicated :', rows.length);
  console.log('by rule set        :', byRuleSet);
  console.log('by stage           :', byStage);
  console.log('by recommendation  :', byAction);
  console.log(`no rule-set match  : ${noMatch}   |  selected-but-no-deterministic-rules: ${noKinded}`);
  console.log(`rule SKIPs (abstain): ${skips}   |  rule FAILs: ${fails}   |  rule ERRORs: ${errors}`);
  await pool.end();
}

main().catch((err) => {
  console.error('batch failed:', err);
  process.exit(1);
});
