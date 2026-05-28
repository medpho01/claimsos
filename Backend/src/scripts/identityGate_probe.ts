/**
 * Smoke-test the identity gate against iter7 files mounted from the host.
 *
 *   docker exec hospital_worker_dev npx tsx src/scripts/identityGate_probe.ts
 *
 * We test:
 *   - A Vahadur consent-form page (should MATCH "Vahadur")
 *   - A clean Anuj OT-notes image (should MATCH "Anuj")
 *
 * Note: /tmp/iter7 lives on the host. Inside the container we'd need
 * the file mounted; this script just demonstrates the call surface
 * with a sample file path the worker can see if mounted, otherwise
 * gracefully skips.
 */
import * as fs from 'fs';
import { checkIdentity } from '../Services/identityGate.service.js';
import { pool } from '../DB/db.js';

const SAMPLES: Array<{ slug: string; path: string; mime: string; claim_id: string }> = [
  { slug: 'vahadur-discharge-slip',
    path: '/tmp/vahadur_sample.webp',
    mime: 'image/webp',
    claim_id: 'a5629506-bbd4-4993-9692-fc2d42ba2e9f' },
  { slug: 'anuj-ot-notes',
    path: '/tmp/anuj_sample.jpg',
    mime: 'image/jpeg',
    claim_id: '9fd5d57e-ec36-40c7-b291-a9f6d50406fb' },
];

async function main() {
  for (const s of SAMPLES) {
    console.log(`\n══ ${s.slug} ══`);
    if (!fs.existsSync(s.path)) {
      console.log(`  SKIP — file not visible from container: ${s.path}`);
      continue;
    }
    const r = await pool.query<{ first_name: string; last_name: string; hospital_id: string }>(
      `SELECT first_name, last_name, hospital_id FROM hospital.ipds WHERE id = $1`,
      [s.claim_id],
    );
    const ipds = r.rows[0];
    if (!ipds) { console.log('  SKIP — claim not found'); continue; }
    const result = await checkIdentity({
      file: { path: s.path, mime: s.mime },
      ipds: { id: s.claim_id, first_name: ipds.first_name, last_name: ipds.last_name, hospital_id: ipds.hospital_id },
    });
    console.log(JSON.stringify(result, null, 2));
  }
  await pool.end();
  setTimeout(() => process.exit(0), 200);
}
process.on('unhandledRejection', (e: any) => console.error('[unhandled]', e?.message ?? e));
main().catch((e) => { console.error(e); process.exit(1); });
