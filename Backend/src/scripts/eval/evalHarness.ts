// =============================================================================
// Stage-Adjudication EVAL HARNESS
//
// Turns "the engine runs" into "the engine is N% correct" by scoring the
// adjudicator's output against a human-labelled golden set.
//
// Usage:
//   POSTGRES_HOST=localhost npx tsx src/scripts/eval/evalHarness.ts
//   POSTGRES_HOST=localhost npx tsx src/scripts/eval/evalHarness.ts --golden path/to/set.json
//   POSTGRES_HOST=localhost npx tsx src/scripts/eval/evalHarness.ts --json   # machine-readable
//
// To score the LLM/vision (semantic) rules too, run this INSIDE the worker
// container where @anthropic-ai/sdk + credits are present:
//   docker exec hospital_backend_dev sh -c \
//     "cd /app && POSTGRES_HOST=localhost npx tsx src/scripts/eval/evalHarness.ts"
// On a host without the SDK, semantic rules SKIP and are reported as
// "unscored (env)" rather than counted as wrong.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from '../../DB/db.js';
import { adjudicateClaim } from '../../Services/adjudication/stageAwareAdjudicator.service.js';
import { SEMANTIC_KINDS } from '../../Services/rules/types.js';

type Status = 'PASS' | 'FAIL' | 'SKIP' | 'WARN' | 'ERROR';

interface GoldenClaim {
  claimId: string;
  label?: string;
  expectedAction?: 'file_now' | 'review' | 'request_doc';
  expectedRules?: Record<string, Status>;
  source?: 'human_feedback' | 'reviewer' | 'provisional';
  notes?: string;
}
interface GoldenSet {
  version: number;
  note?: string;
  claims: GoldenClaim[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenArg = argValue('--golden');
const GOLDEN_PATH = goldenArg
  ? resolve(process.cwd(), goldenArg)
  : resolve(__dirname, 'goldenSet.json');
const AS_JSON = process.argv.includes('--json');
const FROM_FEEDBACK = process.argv.includes('--from-feedback');
const DECISION_REF = '__decision__';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
}

interface RuleComparison {
  claimId: string;
  ruleId: string;
  expected: Status;
  actual: Status | 'MISSING';
  confidence: number | null;
  semantic: boolean;
  correct: boolean;
  falseBlock: boolean; // engine FAIL but expected PASS
  falsePass: boolean; // engine PASS but expected FAIL
  overAbstain: boolean; // engine SKIP but expected PASS/FAIL
  unscoredEnv: boolean; // semantic rule SKIP/ERROR on a no-SDK host
}

// ─── Feedback-derived benchmark ──────────────────────────────────────────────
// Turns the human Agree/Flag clicks captured via the UI feedback loop into an
// agreement benchmark — no hand-edited golden set required. 'agree' = engine
// was right; 'disagree'/'correct' = engine was wrong. Decision markers
// (target_ref = __decision__) are reviewer file/decline calls, NOT quality
// labels, so they are excluded.
async function runFromFeedback(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT layer, target_ref, verdict, claim_id
       FROM hospital.claim_hypothesis_feedback
      WHERE target_ref IS DISTINCT FROM $1`,
    [DECISION_REF],
  );

  const isAgree = (v: string) => v === 'agree';
  const total = rows.length;
  const agree = rows.filter((r) => isAgree(r.verdict)).length;
  const claims = new Set(rows.map((r) => r.claim_id)).size;

  // per (layer:target) tallies
  const byTarget = new Map<string, { agree: number; disagree: number }>();
  const byLayer = new Map<string, { agree: number; disagree: number }>();
  for (const r of rows) {
    const key = `${r.layer}:${r.target_ref ?? '(layer)'}`;
    const t = byTarget.get(key) ?? { agree: 0, disagree: 0 };
    if (isAgree(r.verdict)) t.agree++;
    else t.disagree++;
    byTarget.set(key, t);
    const l = byLayer.get(r.layer) ?? { agree: 0, disagree: 0 };
    if (isAgree(r.verdict)) l.agree++;
    else l.disagree++;
    byLayer.set(r.layer, l);
  }

  const report = {
    mode: 'from-feedback',
    totalFeedback: total,
    distinctClaims: claims,
    agreementRate: total ? agree / total : null,
    byLayer: Object.fromEntries(
      [...byLayer.entries()].map(([k, v]) => [
        k,
        { ...v, rate: v.agree + v.disagree ? v.agree / (v.agree + v.disagree) : null },
      ]),
    ),
    byTarget: [...byTarget.entries()]
      .map(([k, v]) => ({
        target: k,
        agree: v.agree,
        disagree: v.disagree,
        disagreementRate: v.agree + v.disagree ? v.disagree / (v.agree + v.disagree) : 0,
      }))
      .sort((a, b) => b.disagreementRate - a.disagreementRate),
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const H = (s: string) => console.log(`\n${'═'.repeat(64)}\n  ${s}\n${'═'.repeat(64)}`);
  H('EVAL HARNESS — agreement from UI feedback');
  console.log(`total feedback rows : ${total}  (across ${claims} claim${claims === 1 ? '' : 's'})`);
  console.log(`overall agreement   : ${agree}/${total}  (${pct(agree, total)})`);
  H('BY LAYER');
  for (const [layer, v] of byLayer)
    console.log(`  ${layer.padEnd(12)} agree ${v.agree} · disagree ${v.disagree}  → agreement ${pct(v.agree, v.agree + v.disagree)}`);
  H('MOST-DISPUTED RULES (where reviewers most often flag the engine)');
  for (const t of report.byTarget.slice(0, 15))
    console.log(`  ${t.target.padEnd(32)} disagree ${t.disagree}/${t.agree + t.disagree}  (${(t.disagreementRate * 100).toFixed(0)}%)`);
  H('VERDICT');
  if (total < 20)
    console.log(`⚠️  ${total} labels so far. Keep clicking Agree/Flag in the UI; re-run this\n   with --from-feedback as the count grows. ≥20 before quoting a rate.`);
  else console.log(`n=${total} labels — agreement rate above is reportable.`);
  console.log('');
}

async function main(): Promise<void> {
  if (FROM_FEEDBACK) {
    await runFromFeedback();
    await pool.end();
    return;
  }
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as GoldenSet;
  const scored = golden.claims.filter((c) => c.source && c.source !== 'provisional');
  const provisional = golden.claims.length - scored.length;

  // ── action-level tallies ──────────────────────────────────────────────────
  let actionLabelled = 0;
  let actionAgree = 0;
  let falseBlockClaims = 0; // engine request_doc, human did not
  let falsePassClaims = 0; // engine file_now, human did not
  const actionConfusion: Record<string, number> = {}; // "expected→actual"

  // ── rule-level tallies ──────────────────────────────────────────────────
  const ruleComparisons: RuleComparison[] = [];

  for (const g of scored) {
    const res = await adjudicateClaim(g.claimId);
    const actual = res.results ?? [];
    const byId = new Map(actual.map((r) => [r.ruleId, r]));

    // action scoring
    if (g.expectedAction) {
      actionLabelled++;
      const got = res.recommendedAction ?? '?';
      if (got === g.expectedAction) actionAgree++;
      actionConfusion[`${g.expectedAction}→${got}`] =
        (actionConfusion[`${g.expectedAction}→${got}`] ?? 0) + 1;
      if (got === 'request_doc' && g.expectedAction !== 'request_doc') falseBlockClaims++;
      if (got === 'file_now' && g.expectedAction !== 'file_now') falsePassClaims++;
    }

    // rule scoring
    for (const [ruleId, expected] of Object.entries(g.expectedRules ?? {})) {
      const r = byId.get(ruleId);
      const semantic = r ? SEMANTIC_KINDS.has(r.kind) : false;
      const actualStatus = (r?.status ?? 'MISSING') as Status | 'MISSING';
      const unscoredEnv =
        semantic && (actualStatus === 'SKIP' || actualStatus === 'ERROR');
      ruleComparisons.push({
        claimId: g.claimId,
        ruleId,
        expected,
        actual: actualStatus,
        confidence: r?.confidence ?? null,
        semantic,
        correct: actualStatus === expected,
        falseBlock: actualStatus === 'FAIL' && expected === 'PASS',
        falsePass: actualStatus === 'PASS' && expected === 'FAIL',
        overAbstain: actualStatus === 'SKIP' && (expected === 'PASS' || expected === 'FAIL'),
        unscoredEnv,
      });
    }
  }

  // rule metrics exclude env-unscored semantic rules from the denominator
  const ruleScorable = ruleComparisons.filter((c) => !c.unscoredEnv && c.actual !== 'MISSING');
  const ruleCorrect = ruleScorable.filter((c) => c.correct).length;
  const falseBlock = ruleScorable.filter((c) => c.falseBlock).length;
  const falsePass = ruleScorable.filter((c) => c.falsePass).length;
  const overAbstain = ruleScorable.filter((c) => c.overAbstain).length;
  const missing = ruleComparisons.filter((c) => c.actual === 'MISSING').length;
  const envUnscored = ruleComparisons.filter((c) => c.unscoredEnv).length;

  // ── confidence calibration: do confidence buckets predict correctness? ─────
  const buckets = [
    { lo: 0.0, hi: 0.5, label: '0.0–0.5' },
    { lo: 0.5, hi: 0.7, label: '0.5–0.7' },
    { lo: 0.7, hi: 0.9, label: '0.7–0.9' },
    { lo: 0.9, hi: 1.01, label: '0.9–1.0' },
  ];
  const calibration = buckets.map((b) => {
    const inB = ruleScorable.filter(
      (c) => c.confidence != null && c.confidence >= b.lo && c.confidence < b.hi,
    );
    return {
      bucket: b.label,
      n: inB.length,
      accuracy: inB.length ? inB.filter((c) => c.correct).length / inB.length : null,
    };
  });

  const report = {
    goldenPath: GOLDEN_PATH,
    coverage: {
      scoredClaims: scored.length,
      provisionalClaims: provisional,
      labelledActions: actionLabelled,
      labelledRules: ruleComparisons.length,
      scorableRules: ruleScorable.length,
      missingRules: missing,
      envUnscoredSemanticRules: envUnscored,
    },
    action: {
      agreement: actionLabelled ? actionAgree / actionLabelled : null,
      falseBlockClaims,
      falsePassClaims,
      confusion: actionConfusion,
    },
    rules: {
      accuracy: ruleScorable.length ? ruleCorrect / ruleScorable.length : null,
      falseBlock,
      falsePass,
      overAbstain,
    },
    calibration,
    mismatches: ruleComparisons
      .filter((c) => !c.correct && !c.unscoredEnv)
      .map((c) => ({
        claimId: c.claimId.slice(0, 8),
        ruleId: c.ruleId,
        expected: c.expected,
        actual: c.actual,
        confidence: c.confidence,
        kind: c.overAbstain
          ? 'over-abstain'
          : c.falseBlock
            ? 'false-block'
            : c.falsePass
              ? 'false-pass'
              : c.actual === 'MISSING'
                ? 'rule-not-evaluated'
                : 'mismatch',
      })),
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    await pool.end();
    return;
  }

  // ── human-readable report ──────────────────────────────────────────────────
  const H = (s: string) => console.log(`\n${'═'.repeat(64)}\n  ${s}\n${'═'.repeat(64)}`);

  H('EVAL HARNESS — stage adjudication vs golden set');
  console.log(`golden set     : ${GOLDEN_PATH}`);
  console.log(`scored claims  : ${scored.length}  (${provisional} provisional excluded)`);

  if (scored.length === 0) {
    console.log(
      '\n⚠️  No ground-truth labels yet. Add claims to goldenSet.json with\n' +
        '   source: "reviewer" (or capture them via the UI feedback loop) before\n' +
        '   any accuracy number is meaningful.',
    );
    await pool.end();
    return;
  }

  H('ACTION-LEVEL (the headline recommendation)');
  console.log(`labelled actions    : ${actionLabelled}`);
  console.log(`agreement w/ human  : ${actionAgree}/${actionLabelled}  (${pct(actionAgree, actionLabelled)})`);
  console.log(`false-block claims  : ${falseBlockClaims}  (engine said request_doc, human did not)`);
  console.log(`false-pass claims   : ${falsePassClaims}  (engine said file_now, human did not)`);
  console.log(`confusion (exp→got) :`, report.action.confusion);

  H('RULE-LEVEL');
  console.log(`scorable rule labels: ${ruleScorable.length}  (of ${ruleComparisons.length} labelled)`);
  console.log(`  rule accuracy     : ${ruleCorrect}/${ruleScorable.length}  (${pct(ruleCorrect, ruleScorable.length)})`);
  console.log(`  false-block       : ${falseBlock}   false-pass: ${falsePass}   over-abstain: ${overAbstain}`);
  console.log(`  not evaluated     : ${missing}   semantic unscored (env): ${envUnscored}`);

  H('CONFIDENCE CALIBRATION (does conf predict correctness?)');
  for (const c of calibration) {
    console.log(
      `  ${c.bucket}  n=${String(c.n).padStart(3)}  accuracy=${c.accuracy == null ? '—' : `${(c.accuracy * 100).toFixed(0)}%`}`,
    );
  }

  if (report.mismatches.length) {
    H('MISMATCHES (where the engine disagreed with the human)');
    for (const m of report.mismatches) {
      console.log(
        `  [${m.kind.padEnd(18)}] ${m.claimId} ${m.ruleId.padEnd(28)} expected ${m.expected} · got ${m.actual}` +
          (m.confidence != null ? ` (conf ${m.confidence})` : ''),
      );
    }
  }

  H('VERDICT');
  const n = scored.length;
  if (n < 20) {
    console.log(
      `⚠️  n=${n}. This is a SMOKE-LEVEL signal, not a benchmark. Label ≥20–50\n` +
        `   claims (the UI feedback loop is the collection tool) before quoting\n` +
        `   these percentages as the engine's accuracy.`,
    );
  } else {
    console.log(`Sample size n=${n} — metrics above are reportable.`);
  }
  console.log('');
  await pool.end();
}

main().catch((err) => {
  console.error('eval harness failed:', err);
  process.exit(1);
});
