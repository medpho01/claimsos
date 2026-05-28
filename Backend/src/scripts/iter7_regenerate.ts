/**
 * Iter7 — fresh harmoniser run on the 5 benchmark patients to validate
 * Fixes 16-22. Invokes harmonisationService.regenerate() directly,
 * bypassing the queue. Reports the new validation_metadata blocks so we
 * can see which guards fired.
 *
 * Run inside the worker container:
 *   docker exec hospital_worker_dev npx tsx src/scripts/iter7_regenerate.ts
 */
import { harmonisationService } from '../Services/harmonisation.service.js';
import { pool } from '../DB/db.js';

const ONLY_SLUG = process.env.ONLY_SLUG; // run a single patient
const ALL_PATIENTS: Array<{ slug: string; claim_id: string }> = [
  { slug: 'anuj',    claim_id: '9fd5d57e-ec36-40c7-b291-a9f6d50406fb' },
  { slug: 'sunil',   claim_id: '687f1f2a-d7b4-46b5-a809-9ec1e4ac0bcc' },
  { slug: 'shabana', claim_id: '9e9795d3-510b-4257-9f36-617a9c4836cf' },
  { slug: 'kalksum', claim_id: '6f82c826-33b8-48f6-9b77-271cb5ba39c4' },
  { slug: 'vahadur', claim_id: 'a5629506-bbd4-4993-9692-fc2d42ba2e9f' },
];
const PATIENTS = ONLY_SLUG
  ? ALL_PATIENTS.filter((p) => p.slug === ONLY_SLUG)
  : ALL_PATIENTS;

async function main() {
  for (const { slug, claim_id } of PATIENTS) {
    process.stdout.write(`\n══════════ ${slug} (${claim_id}) ══════════\n`);
    try {
      // Need hospital_id for the call signature
      const r = await pool.query<{ hospital_id: string }>(
        `SELECT hospital_id FROM hospital.ipds WHERE id = $1`,
        [claim_id],
      );
      const hospital_id = r.rows[0]?.hospital_id;
      if (!hospital_id) { console.log('  no hospital row, skip'); continue; }

      const row = await harmonisationService.regenerate(claim_id, hospital_id);

      const ep: any = row.episode ?? {};
      const meta = ep.meta ?? {};
      const vm = ep.validation_metadata ?? {};
      const stay = ep.stay_summary ?? {};
      const dx = ep.diagnosis ?? {};
      const procs = Array.isArray(ep.clinical_timeline)
        ? ep.clinical_timeline.flatMap((p: any) => p?.procedures_performed ?? [])
        : [];

      console.log(JSON.stringify({
        completeness:        meta.data_completeness_score,
        episode_type:        meta.episode_type,
        episode_subtype:     meta.episode_subtype,
        diagnosis_filled:    Object.keys(dx).length > 0,
        primary_diagnosis:   dx.primary?.candidate_name ?? dx.primary_diagnosis?.candidate_name ?? null,
        admit_datetime:      stay.admission_datetime,
        discharge_datetime:  stay.discharge_datetime,
        procedure_count:     procs.length,
        procedure_dates:     procs.map((p: any) => p?.performed_at).filter(Boolean),
        procedure_laterality: procs.map((p: any) => p?.laterality).filter(Boolean),
        // Fix surfaces
        foreign_patient_sections: vm.foreign_patient_sections ?? null,
        date_incoherent_sections: vm.date_incoherent_sections ?? null,
        gps_photo_clustering:     vm.gps_photo_clustering ?? null,
        dates_promoted_from_sections: vm.dates_promoted_from_sections ?? null,
        dates_promoted_from_timeline: vm.dates_promoted_from_timeline ?? null,
        completeness_penalties:   vm.completeness_penalties ?? null,
      }, null, 2));
    } catch (e: any) {
      console.error(`  ERROR for ${slug}: ${e?.message ?? e}`);
      if (e?.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
    }
  }
  await pool.end();
  // Fire-and-forget; the dossier projector queue may throw on shutdown
  // because the worker has its own Redis pool. We've already saved the
  // harmonised row, so just exit.
  setTimeout(() => process.exit(0), 500);
}

// Don't crash on unhandled Redis errors during cleanup — the harmoniser
// already saved its result by the time the dossier projector enqueue
// fails, and the catch-up cron will re-enqueue.
process.on('unhandledRejection', (e: any) => {
  console.error('  [unhandled]', e?.message ?? e);
});
process.on('uncaughtException', (e: any) => {
  console.error('  [uncaught]', e?.message ?? e);
});

main().catch((e) => { console.error(e); process.exit(1); });
