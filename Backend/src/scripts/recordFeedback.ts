// =============================================================================
// Demo/test the M7 feedback loop against the local DB.
// Usage: POSTGRES_HOST=localhost npx tsx src/scripts/recordFeedback.ts [claimId]
// =============================================================================

import { pool } from '../DB/db.js';
import { recordFeedback, getFeedback, ruleOverrideSummary } from '../Services/adjudication/feedback.service.js';

async function main(): Promise<void> {
  const claimId = process.argv[2] ?? '952d0778-fc6d-41dd-95c1-18b8816a4190';

  // Simulate a reviewer working a claim: disagree with an over-strict required-doc
  // rule (root cause = the rule itself), and agree with the readiness call.
  await recordFeedback({
    claimId,
    stage: 'discharge_submitted',
    layer: 'rules',
    targetRef: 'SURG_DISCHARGE_DOCS',
    verdict: 'disagree',
    rootCause: 'rules',
    notes: 'gps_tagged_patient_photos should not be mandatory for this hospital.',
  });
  await recordFeedback({
    claimId,
    stage: 'discharge_submitted',
    layer: 'readiness',
    verdict: 'agree',
    notes: 'recommended action looks right.',
  });

  console.log(`=== feedback history for ${claimId} ===`);
  console.log(JSON.stringify(await getFeedback(claimId), null, 2));
  console.log('\n=== rule-override summary (calibration signal — which rules reviewers reject) ===');
  console.log(JSON.stringify(await ruleOverrideSummary(), null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
