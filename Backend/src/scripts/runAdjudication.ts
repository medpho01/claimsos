// =============================================================================
// Run the stage-aware adjudicator against a claim and print the result.
// Usage: POSTGRES_HOST=localhost npx tsx src/scripts/runAdjudication.ts <claimId>
// =============================================================================

import { pool } from '../DB/db.js';
import { adjudicateClaim } from '../Services/adjudication/stageAwareAdjudicator.service.js';

async function main(): Promise<void> {
  const claimId = process.argv[2];
  if (!claimId) {
    console.error('usage: npx tsx src/scripts/runAdjudication.ts <claimId>');
    process.exit(2);
  }
  const result = await adjudicateClaim(claimId);
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('adjudication failed:', err);
  process.exit(1);
});
