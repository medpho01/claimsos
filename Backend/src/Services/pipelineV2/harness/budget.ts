/**
 * Pipeline v2 — harness: the error-budget CLI.
 *
 * Replays the corpus (free), scores it, and prints a STAGE-ATTRIBUTED error
 * budget: every miss tagged with the stage that most likely caused it, rolled
 * up by cause, plus the claim-level quarantine flags. This is the report you
 * read BEFORE touching pipeline code — it tells you which bucket is biggest so
 * you optimise the dominant failure mode instead of the flashiest one.
 *
 * Run (free replay):
 *   docker exec hospital_worker_dev \
 *     env LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=/tmp/probe-bench12/.llm-cache \
 *         HARNESS_CORPUS_DIR=/tmp/probe-bench12 \
 *     npx tsx src/Services/pipelineV2/harness/budget.ts
 *
 * Env: same as run.ts (HARNESS_CORPUS_DIR, HARNESS_GROUND_TRUTH, LLM_REPLAY_*).
 * Uncached patients are skipped (logged), never fatal — the budget covers every
 * patient the replay cache can serve.
 */

import * as path from 'node:path';

import { loadCorpus } from './corpus.js';
import { loadGroundTruth } from './groundTruth.js';
import { bridgePatient, assertReplaySafe } from './readBridge.js';
import { runClaim } from './runner.js';
import { scoreClaim } from './scorer.js';
import {
  attributeClaim,
  buildErrorBudget,
  CAUSE_STAGE,
  ClaimAttribution,
  MISS_CAUSES,
} from './errorBudget.js';

const DEFAULT_CORPUS_DIR = '/tmp/probe-bench12';

async function main() {
  assertReplaySafe();

  const corpusDir = process.env.HARNESS_CORPUS_DIR ?? DEFAULT_CORPUS_DIR;
  const gtPath = process.env.HARNESS_GROUND_TRUTH ?? path.join(corpusDir, 'ground_truth.json');
  const patients = loadCorpus(corpusDir);
  const groundTruth = loadGroundTruth(gtPath);

  const attributions: ClaimAttribution[] = [];
  const skipped: { slug: string; error: string }[] = [];

  for (const patient of patients) {
    try {
      const bridged = await bridgePatient(patient);
      const result = runClaim({
        claimId: patient.claimId,
        sources: bridged.sources,
        pages: bridged.pages,
      });
      const score = scoreClaim(patient.claimId, groundTruth[patient.claimId] ?? {}, result);
      attributions.push(attributeClaim({ score, result, pages: bridged.pages }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push({ slug: patient.slug, error: msg.split('\n')[0].slice(0, 160) });
    }
  }

  const budget = buildErrorBudget(attributions);

  // ── per-claim detail ──────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('── per-claim misses ────────────────────────────────────────');
  for (const c of budget.claims) {
    if (!c.misses.length && !c.flags.length) continue;
    const flagStr = c.flags.length ? `  ⚑ ${c.flags.join(', ')}` : '';
    // eslint-disable-next-line no-console
    console.log(
      `\n${(c.patient ?? c.claimId).padEnd(16)} ` +
        `ids=${c.distinctUhids}(raw)/${c.foreignIdentities}(foreign) ` +
        `q=${c.quarantinedPages}/${c.totalPages}${flagStr}`,
    );
    for (const m of c.misses) {
      const s = m.signals;
      // eslint-disable-next-line no-console
      console.log(
        `   [${m.cause.padEnd(13)}] ${m.field.padEnd(18)} ` +
          `exp=${JSON.stringify(m.expected)} got=${JSON.stringify(m.actual ?? null)} ` +
          `(seen:${s.expectedTokenSeen ? 'Y' : 'N'}${s.expectedFullySeen ? '+full' : ''} ` +
          `present:${s.actualPresent ? 'Y' : 'N'})`,
      );
    }
  }

  // ── roll-up by cause ──────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n── error budget by cause ───────────────────────────────────');
  for (const cause of MISS_CAUSES) {
    const n = budget.byCause[cause];
    if (n === 0) continue;
    const pct = budget.totalMisses > 0 ? ((n / budget.totalMisses) * 100).toFixed(0) : '0';
    // eslint-disable-next-line no-console
    console.log(`   ${cause.padEnd(14)} ${String(n).padStart(2)}  (${pct}%)  → ${CAUSE_STAGE[cause]}`);
  }
  // eslint-disable-next-line no-console
  console.log(`   ${'TOTAL'.padEnd(14)} ${String(budget.totalMisses).padStart(2)}`);

  // ── claim-level accuracy flags ────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n── page-exclusion accuracy ─────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log(
    `   UNDER (foreign pages leaked → JSON mixes two patients): ` +
      `${budget.flagged.QUARANTINE_UNDER.length} — ${budget.flagged.QUARANTINE_UNDER.join(', ') || '—'}`,
  );

  if (skipped.length) {
    // eslint-disable-next-line no-console
    console.log(`\n⚠ ${skipped.length} patient(s) skipped (replay miss): ${skipped.map((s) => s.slug).join(', ')}`);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
