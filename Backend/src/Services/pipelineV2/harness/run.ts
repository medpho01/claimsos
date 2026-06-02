/**
 * Pipeline v2 — harness: the offline CLI entrypoint.
 *
 * Ties the harness together: load the corpus + ground truth, render+read each
 * patient through the (spend-guarded) bridge, run the deterministic Stage 0→7
 * pipeline, score against ground truth, and print a corpus report with the
 * REAL vs replayed spend.
 *
 * Run (free replay — the normal path):
 *   docker exec hospital_worker_dev \
 *     env LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=/tmp/probe/.llm-cache \
 *     npx tsx src/Services/pipelineV2/harness/run.ts
 *
 * Record (the ONE authorised real-spend pass — requires explicit opt-in):
 *   docker exec hospital_worker_dev \
 *     env LLM_REPLAY_MODE=record HARNESS_ALLOW_RECORD=1 \
 *         LLM_REPLAY_DIR=/tmp/probe/.llm-cache \
 *     npx tsx src/Services/pipelineV2/harness/run.ts
 *
 * Env:
 *   HARNESS_CORPUS_DIR   corpus root (default /tmp/probe)
 *   HARNESS_GROUND_TRUTH ground-truth JSON (default <corpus>/ground_truth.json)
 *   LLM_REPLAY_MODE      'replay' | 'record' (anything else is refused)
 *   LLM_REPLAY_DIR       record/replay cache dir
 *   HARNESS_ALLOW_RECORD '1' to permit a real-spend recording pass
 *
 * The bridge guard (assertReplaySafe) makes an accidental live full-corpus
 * spend impossible — this CLL also calls it up front to fail before any I/O.
 */

import * as path from 'node:path';

import { loadCorpus } from './corpus.js';
import { loadGroundTruth } from './groundTruth.js';
import { bridgePatient, assertReplaySafe } from './readBridge.js';
import { runClaim } from './runner.js';
import { scoreClaim, scoreCorpus, ClaimScore } from './scorer.js';
import { SignalKind } from '../runState.service.js';

const DEFAULT_CORPUS_DIR = '/tmp/probe';

/** Short tags for the per-patient signals column. */
const SIGNAL_TAG: Record<SignalKind, string> = {
  foreign_pages_removed: 'frm',
  multiple_identities: 'mid',
  possible_contamination: 'con',
  coverage_gap: 'cov',
  low_confidence_field: 'lcf',
};

export interface HarnessReport {
  scores: ClaimScore[];
  corpus: ReturnType<typeof scoreCorpus>;
  totalCostInr: number;
  fullyReplayed: boolean;
}

function pct(n: number | null): string {
  return n === null ? '  n/a' : `${(n * 100).toFixed(1)}%`;
}

/**
 * Run the whole harness over the corpus and return the structured report.
 * Side-effect-free except for the (guarded) LLM reads via the bridge.
 */
export async function runHarness(): Promise<HarnessReport> {
  assertReplaySafe(); // fail fast, before any rendering or reading

  const corpusDir = process.env.HARNESS_CORPUS_DIR ?? DEFAULT_CORPUS_DIR;
  const gtPath =
    process.env.HARNESS_GROUND_TRUTH ?? path.join(corpusDir, 'ground_truth.json');

  // Smallest-first: when a budget ceiling (HARNESS_MAX_INR) is set, this makes
  // the loop score the maximum number of patients per rupee and bounds the
  // overshoot of the ceiling-crossing patient. Cheap proxy: source-file count
  // (exact page count isn't known until render, which itself costs).
  const patients = loadCorpus(corpusDir)
    .slice()
    .sort((a, b) => a.sources.length - b.sources.length);
  const groundTruth = loadGroundTruth(gtPath);

  const scores: ClaimScore[] = [];
  const failures: { slug: string; error: string }[] = [];
  let totalCostInr = 0;
  let anyRealSpend = false;

  // Hard budget ceiling (₹). When set, the loop stops before reading the next
  // patient once cumulative REAL spend reaches the cap — a guarantee that an
  // authorised record pass can never overrun its approved budget. Cache-first
  // record mode means everything paid for so far is persisted, so a re-run
  // resumes for free. 0/unset = no ceiling (the normal free replay path).
  const maxInr = Number(process.env.HARNESS_MAX_INR ?? '0');

  for (const patient of patients) {
    if (maxInr > 0 && totalCostInr >= maxInr) {
      // eslint-disable-next-line no-console
      console.log(
        `\n⛔ budget ceiling ₹${maxInr} reached (real spend ₹${totalCostInr.toFixed(2)}) — ` +
          `stopping before ${patient.slug}. Already-read pages are cached; re-run to resume free.`,
      );
      break;
    }
    try {
      const bridged = await bridgePatient(patient);
      const result = runClaim({
        claimId: patient.claimId,
        sources: bridged.sources,
        pages: bridged.pages,
      });
      const gt = groundTruth[patient.claimId] ?? {};
      const score = scoreClaim(patient.claimId, gt, result);
      scores.push(score);

      totalCostInr += bridged.costInr;
      if (!bridged.fullyReplayed) anyRealSpend = true;

      // The headline mark now tracks JSON ACCURACY (the pipeline's actual job),
      // not a harmonisation verdict: ✓ all pinned fields hit, ✗ a miss, · nothing pinned.
      const mark = score.fieldAccuracy === null ? '·' : score.fieldAccuracy === 1 ? '✓' : '✗';
      const sigTags = result.runState.signals.map((s) => SIGNAL_TAG[s.kind]).join(',') || '—';
      // eslint-disable-next-line no-console
      console.log(
        `${mark} ${(score.patient ?? patient.slug).padEnd(16)} ` +
          `fields ${pct(score.fieldAccuracy)} (${score.fieldHits}/${score.scoredFields})  ` +
          `q=${score.quarantineActual}  ${sigTags.padEnd(16)} ₹${bridged.costInr.toFixed(2)}` +
          `${bridged.fullyReplayed ? ' (replay)' : ''}`,
      );
    } catch (err) {
      // Resilience: a single un-readable page (e.g. an oversize image the
      // provider rejects) must NOT abort the whole corpus and strand the
      // patients after it. Record mode is cache-first, so everything read
      // before the throw is already persisted (paid once); we log the bad
      // patient and press on.
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ slug: patient.slug, error: msg.split('\n')[0].slice(0, 200) });
      // eslint-disable-next-line no-console
      console.log(`✗ ${patient.slug.padEnd(16)} READ_FAILED   ${msg.split('\n')[0].slice(0, 120)}`);
    }
  }

  const corpus = scoreCorpus(scores);

  // eslint-disable-next-line no-console
  console.log('\n── corpus ──────────────────────────────────────────────');
  // eslint-disable-next-line no-console
  console.log(
    `claims=${corpus.claims}  scored=${corpus.scoredClaims}  ` +
      `field accuracy=${pct(corpus.fieldAccuracy)} ` +
      `(${corpus.totalFieldHits}/${corpus.totalScoredFields})`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `page-exclusion accuracy ${corpus.quarantineHits}/${corpus.quarantineScored} ` +
      `(expected foreign-page removals matched)`,
  );
  for (const f of corpus.byField) {
    if (f.scored === 0) continue;
    // eslint-disable-next-line no-console
    console.log(`   ${f.field.padEnd(20)} ${pct(f.accuracy)} (${f.hits}/${f.scored})`);
  }
  // eslint-disable-next-line no-console
  console.log(
    `\nspend: ₹${totalCostInr.toFixed(2)} real this run` +
      `${anyRealSpend ? '' : ' — fully replayed (free)'}`,
  );
  if (failures.length) {
    // eslint-disable-next-line no-console
    console.log(`\n⚠ ${failures.length} patient(s) failed to read:`);
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.log(`   ${f.slug.padEnd(16)} ${f.error}`);
    }
  }

  return { scores, corpus, totalCostInr, fullyReplayed: !anyRealSpend };
}

// Run when invoked directly (tsx src/.../run.ts), not when imported by a test.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  runHarness().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
