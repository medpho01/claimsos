/**
 * TEMP benchmark helper (not committed): replay the bench corpus and dump full
 * per-patient detail (per-page reads, identity decisions, fused episode,
 * validation, run-state, score) to <corpus>/detail.json for offline analysis.
 * Free: runs only in replay mode against the existing cache.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCorpus } from './corpus.js';
import { loadGroundTruth } from './groundTruth.js';
import { bridgePatient, assertReplaySafe } from './readBridge.js';
import { runClaim } from './runner.js';
import { scoreClaim } from './scorer.js';

async function main() {
  assertReplaySafe();
  const dir = process.env.HARNESS_CORPUS_DIR ?? '/tmp/probe-bench3';
  const gt = loadGroundTruth(process.env.HARNESS_GROUND_TRUTH ?? path.join(dir, 'ground_truth.json'));
  const patients = loadCorpus(dir);
  const out: any[] = [];
  const skipped: { slug: string; error: string }[] = [];
  for (const p of patients) {
    try {
      const bridged = await bridgePatient(p);
      const result = runClaim({ claimId: p.claimId, sources: bridged.sources, pages: bridged.pages });
      const score = scoreClaim(p.claimId, gt[p.claimId] ?? {}, result);
      out.push({
        slug: p.slug,
        claimId: p.claimId,
        pages: bridged.pages.map((pg) => ({ id: pg.page.id, tier: pg.tier, read: pg.read })),
        identity: result.identity,
        dedup: result.dedup,
        excludedPageIds: result.excludedPageIds,
        episode: result.episode,
        validation: result.validation,
        runState: result.runState,
        score,
      });

      // Compact stdout summary.
      const q = result.identity.quarantinedPageIds ?? [];
      // eslint-disable-next-line no-console
      console.log(
        `\n=== ${p.slug} (${p.claimId}) ===\n` +
          `signals=[${result.runState.signals.map((s) => s.kind).join(',') || '—'}] ` +
          `quarantined=${q.length} excluded=${result.excludedPageIds.length}`,
      );
    } catch (e) {
      // Replay misses (uncached pages) must not abort the whole dump — log and
      // press on so every cached patient still gets written.
      const msg = e instanceof Error ? e.message : String(e);
      skipped.push({ slug: p.slug, error: msg.split('\n')[0].slice(0, 160) });
      // eslint-disable-next-line no-console
      console.log(`\n✗ ${p.slug} SKIPPED — ${msg.split('\n')[0].slice(0, 120)}`);
    }
  }
  if (skipped.length) {
    // eslint-disable-next-line no-console
    console.log(`\n⚠ ${skipped.length} patient(s) skipped (replay miss):`);
    for (const s of skipped) console.log(`   ${s.slug.padEnd(16)} ${s.error}`);
  }
  const outPath = path.join(dir, 'detail.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nwrote ${outPath} with ${out.length} patients`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
