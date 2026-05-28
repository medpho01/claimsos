/**
 * Probe the review queue service directly (bypassing HTTP auth) to verify
 * the iter7 patient flags surface correctly. Drop-test for Stage 7a.
 *
 *   docker exec hospital_backend_dev npx tsx src/scripts/reviewQueue_probe.ts
 */
import { listFlaggedClaims, getFlaggedClaim } from '../Services/reviewQueue.service.js';
import { pool } from '../DB/db.js';

async function main() {
  const list = await listFlaggedClaims({ limit: 50 });
  console.log(`Total flagged: ${list.total}`);
  for (const r of list.rows) {
    console.log(`  ${r.claim_id.slice(0,8)}  ${r.patient_first_name} ${r.patient_last_name ?? ''}  ` +
      `@${r.hospital_name ?? '?'}  completeness=${r.completeness_score ?? '?'}  ` +
      `flags=[${r.flag_types.join(',')}] (${r.total_flags})`);
  }
  // Detail for the most-flagged
  if (list.rows.length > 0) {
    const top = list.rows.slice().sort((a, b) => b.total_flags - a.total_flags)[0]!;
    console.log(`\n── DETAIL: ${top.patient_first_name} ──`);
    const d = await getFlaggedClaim(top.claim_id);
    if (d) {
      console.log(`flagged sections: ${d.flagged_sections.length}`);
      for (const s of d.flagged_sections) {
        console.log(`  [${s.flag_type}] section=${s.section_id.slice(0,8)} cat=${s.category} file=${s.file_name}`);
        console.log(`     detail=${JSON.stringify(s.detail).slice(0,200)}`);
      }
    }
  }
  await pool.end();
  setTimeout(() => process.exit(0), 200);
}
process.on('unhandledRejection', (e: any) => { console.error('[unhandled]', e?.message ?? e); });
main().catch((e) => { console.error(e); process.exit(1); });
