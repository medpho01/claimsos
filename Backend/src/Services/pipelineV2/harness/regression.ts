/**
 * Pipeline v2 — harness: the regression gate.
 *
 * The error budget (budget.ts) tells you what to fix. This tells you a fix
 * didn't quietly break something else. It snapshots the corpus outcome
 * (per-claim quarantine count, the advisory signals raised, and per-field hits)
 * to a committed baseline, and on every later run fails if any claim REGRESSED:
 *
 *   HARD FAIL (exit 1):
 *     • a field that was a HIT becomes a MISS.
 *   The pipeline INTERPRETS, it does not adjudicate — so JSON ACCURACY is the
 *   only thing that can hard-regress. A fix for patient A may not silently cost
 *   patient B a correct field.
 *
 *   DRIFT (warn, never fails): the set of advisory signals raised, and
 *   quarantine-count changes. Signals never block, so a change in them is for
 *   human eyes, not a gate.
 *
 *   IMPROVEMENT (info): miss → hit.
 *
 * After an intended behaviour change, re-bless the baseline:
 *   docker exec hospital_worker_dev \
 *     env LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=/tmp/probe-bench12/.llm-cache \
 *         HARNESS_CORPUS_DIR=/tmp/probe-bench12 HARNESS_UPDATE_BASELINE=1 \
 *     npx tsx src/Services/pipelineV2/harness/regression.ts
 *
 * Check (the default — exits non-zero on any hard regression):
 *   docker exec hospital_worker_dev \
 *     env LLM_REPLAY_MODE=replay LLM_REPLAY_DIR=/tmp/probe-bench12/.llm-cache \
 *         HARNESS_CORPUS_DIR=/tmp/probe-bench12 \
 *     npx tsx src/Services/pipelineV2/harness/regression.ts
 *
 * The baseline is keyed by claimId and records its covered set, so the gate
 * compares only the intersection and warns about any baseline claim the replay
 * cache can no longer serve (a cache/corpus regression in its own right).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCorpus } from './corpus.js';
import { loadGroundTruth } from './groundTruth.js';
import { bridgePatient, assertReplaySafe } from './readBridge.js';
import { runClaim } from './runner.js';
import { scoreClaim } from './scorer.js';

const DEFAULT_CORPUS_DIR = '/tmp/probe-bench12';
const BASELINE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'regression.baseline.json');

interface ClaimSnapshot {
  patient?: string;
  quarantineCount: number;
  /** Sorted advisory signal kinds raised this run — drift only, never a hard fail. */
  signalKinds: string[];
  scoredFields: number;
  fieldHits: number;
  /** field name → did it hit. Only fields the ground truth pinned appear here. */
  fields: Record<string, boolean>;
}

interface Baseline {
  generatedAt: string;
  note: string;
  claims: Record<string, ClaimSnapshot>;
}

/** Replay + score the corpus into a per-claim snapshot map (resilient to misses). */
async function snapshotCorpus(): Promise<{ claims: Record<string, ClaimSnapshot>; skipped: string[] }> {
  assertReplaySafe();
  const corpusDir = process.env.HARNESS_CORPUS_DIR ?? DEFAULT_CORPUS_DIR;
  const gtPath = process.env.HARNESS_GROUND_TRUTH ?? path.join(corpusDir, 'ground_truth.json');
  const patients = loadCorpus(corpusDir);
  const groundTruth = loadGroundTruth(gtPath);

  const claims: Record<string, ClaimSnapshot> = {};
  const skipped: string[] = [];

  for (const patient of patients) {
    try {
      const bridged = await bridgePatient(patient);
      const result = runClaim({
        claimId: patient.claimId,
        sources: bridged.sources,
        pages: bridged.pages,
      });
      const score = scoreClaim(patient.claimId, groundTruth[patient.claimId] ?? {}, result);
      const fields: Record<string, boolean> = {};
      for (const f of score.fields) fields[f.field] = f.hit;
      claims[patient.claimId] = {
        patient: score.patient,
        quarantineCount: result.identity.quarantinedPageIds.length,
        signalKinds: result.runState.signals.map((s) => s.kind).sort(),
        scoredFields: score.scoredFields,
        fieldHits: score.fieldHits,
        fields,
      };
    } catch {
      skipped.push(patient.slug);
    }
  }
  return { claims, skipped };
}

function writeBaseline(claims: Record<string, ClaimSnapshot>): void {
  const baseline: Baseline = {
    generatedAt: new Date().toISOString(),
    note: 'Known-good corpus outcome. Re-bless with HARNESS_UPDATE_BASELINE=1 after an intended behaviour change.',
    claims,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log(`✔ baseline written: ${BASELINE_PATH}\n  ${Object.keys(claims).length} claim(s) blessed.`);
}

function loadBaseline(): Baseline | null {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  } catch {
    return null;
  }
}

async function main() {
  const update = process.env.HARNESS_UPDATE_BASELINE === '1' || process.argv.includes('--update');
  const { claims, skipped } = await snapshotCorpus();

  if (update) {
    writeBaseline(claims);
    if (skipped.length) {
      // eslint-disable-next-line no-console
      console.log(`  (note: ${skipped.length} uncached patient(s) not blessed: ${skipped.join(', ')})`);
    }
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    // eslint-disable-next-line no-console
    console.error(
      `✗ no baseline at ${BASELINE_PATH}. Bless one first with HARNESS_UPDATE_BASELINE=1.`,
    );
    process.exitCode = 1;
    return;
  }

  const regressions: string[] = [];
  const drift: string[] = [];
  const improvements: string[] = [];
  const missing: string[] = [];

  for (const [claimId, base] of Object.entries(baseline.claims)) {
    const now = claims[claimId];
    const who = base.patient ?? claimId;
    if (!now) {
      missing.push(who);
      continue;
    }
    // Field-level: hit → miss is a hard regression; miss → hit an improvement.
    for (const [field, wasHit] of Object.entries(base.fields)) {
      const nowHit = now.fields[field];
      if (nowHit === undefined) {
        drift.push(`${who}: field "${field}" no longer scored`);
      } else if (wasHit && !nowHit) {
        regressions.push(`${who}: "${field}" HIT → MISS`);
      } else if (!wasHit && nowHit) {
        improvements.push(`${who}: "${field}" MISS → HIT`);
      }
    }
    // Signals / quarantine: drift only — they are advisory, the pipeline never
    // blocks on them, so a change is for human eyes rather than a gate.
    const baseSig = (base.signalKinds ?? []).join(',');
    const nowSig = (now.signalKinds ?? []).join(',');
    if (baseSig !== nowSig) {
      drift.push(`${who}: signals [${baseSig || '—'}] → [${nowSig || '—'}]`);
    }
    if (base.quarantineCount !== now.quarantineCount) {
      drift.push(`${who}: quarantine ${base.quarantineCount} → ${now.quarantineCount}`);
    }
  }

  const newClaims = Object.keys(claims).filter((id) => !(id in baseline.claims));

  // eslint-disable-next-line no-console
  console.log(`── regression gate (baseline ${baseline.generatedAt}) ──────────`);
  const report = (label: string, items: string[]) => {
    // eslint-disable-next-line no-console
    console.log(`\n${label}: ${items.length}`);
    for (const i of items) console.log(`   ${i}`);
  };
  if (regressions.length) report('🔴 REGRESSIONS (hard fail)', regressions);
  if (improvements.length) report('🟢 improvements', improvements);
  if (drift.length) report('🟡 drift (review)', drift);
  if (missing.length) report('⚠ baseline claims not in this run', missing);
  if (newClaims.length) report('＋ new claims (not yet baselined)', newClaims);
  if (skipped.length) {
    // eslint-disable-next-line no-console
    console.log(`\n(${skipped.length} uncached patient(s) skipped: ${skipped.join(', ')})`);
  }

  if (regressions.length) {
    // eslint-disable-next-line no-console
    console.log(`\n✗ FAIL — ${regressions.length} regression(s). If intended, re-bless with HARNESS_UPDATE_BASELINE=1.`);
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log(`\n✓ PASS — no regressions.${improvements.length ? ` (${improvements.length} improvement(s).)` : ''}`);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
