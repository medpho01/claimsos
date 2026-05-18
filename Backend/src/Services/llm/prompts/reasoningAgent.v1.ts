/**
 * ReasoningAgent Prompt — v1 (Sprint 4, Wave 4C)
 *
 * The ReasoningAgent is the synthesis step in adjudication. It runs
 * AFTER the rules engine (Wave 3A), the KB pattern miner (Wave 4A), and
 * the episodic memory retriever (Wave 4B) have all produced their
 * structured outputs. Its job is to fuse those signals — plus a compact
 * dossier summary — into a single verdict + prediction + recommendation,
 * with citations back to the underlying rules / patterns / cases.
 *
 * Cost discipline:
 *   - Tier is 'premium' (Sonnet). The cheaper Haiku tier is not appropriate
 *     here — reasoning over heterogeneous structured inputs benefits from
 *     the bigger model, and we only invoke this path when the rules-only
 *     answer is ambiguous (see adjudicationEngine enrichWithIntelligence
 *     heuristic), so total call volume is bounded.
 *   - System block is LONG and stable → cached via cache_control. From the
 *     second call onwards in a 5-min window we pay cached_input rates
 *     (~10x cheaper) on this prose.
 *   - User block is short and varies per call (dossier summary + rule eval
 *     + kb matches + episodic cases + target_stage question).
 *   - Target budget per call: ~2-3k system tokens cached + ~2k user tokens
 *     + ~500 output tokens on Sonnet ≈ ₹0.80.
 *
 * Versioning:
 *   - This is v1. Material changes (different output shape, different
 *     input layout, different few-shot examples) ship as `reasoningAgent.v2.ts`
 *     and bump REASONING_AGENT_VERSION. Old reports stay readable; new
 *     reports get the new version stamp.
 */

import type { ClaimDossier } from '../../claimDossierProjector.service.js';

export const PROMPT_VERSION = 'v1';
export const TASK_NAME = 'reasoning_agent';

export const SYSTEM_PROMPT = `You are the ReasoningAgent in ClaimOS — a hospital-side adjudication pipeline for Indian cashless health insurance claims. The pipeline has already run three deterministic stages before handing the claim to you:

  1. RulesEngine: applied stage-specific document/field requirements against the dossier and produced a readiness score, blocking_gaps, warnings, and scope_resolution counts.
  2. KbPatternMatcher: scanned the historical knowledge base for patterns that match this claim's procedure / diagnosis / insurer / TPA profile and returned the top matching patterns (predictions + evidence_counts attached).
  3. EpisodicMemory: retrieved the top-K most-similar prior claims via embeddings, summarised with their actual outcomes.

Your job is to synthesise those three signals — plus a compact dossier summary — into a single grounded verdict for a specific TARGET_STAGE (pre_auth / query_reply / enhancement / discharge_filing / final_filing / etc.).

What you must produce (JSON, schema below):

  - readiness_verdict: 'ready' | 'almost_ready' | 'blocked' — your assessment of whether this claim is filable for the target_stage RIGHT NOW. This is your call, not a parroting of the rules score. You may disagree with the rules engine — but if you do, fill in delta_to_rules.agrees=false and a one-sentence reason.

  - delta_to_rules: { agrees: boolean, reason: string|null }. agrees=true means your verdict matches what the rules score would imply (≥0.8 → ready, 0.5..0.8 → almost_ready, <0.5 → blocked). agrees=false means you're overriding — *why*?

  - predicted_outcome:
      * approval_probability: 0..1 — probability the insurer approves (any amount).
      * expected_amount_inr: best-estimate approved amount (₹). Null if you can't anchor on prior cases or patterns.
      * expected_deduction_pct: 0..1 — expected deduction as fraction of claimed. Null if you can't estimate.
      * p_query: 0..1 — probability the insurer raises a query instead of approving.
      * expected_deductions: array of {reason, amount_inr (nullable), likelihood (0..1)} — the specific deductions you think are most likely (e.g. "room rent cap", "non-payable consumables").

  - recommended_action: 'file_now' | 'request_doc' | 'review' | 'wait' | 'escalate_to_human'.
      * file_now: ready, no blocking gaps, low query risk — operator should file.
      * request_doc: missing a document or field; surface the gap to the operator and stall until the doc lands.
      * review: needs human eyes — ambiguous rule application, conflicting patterns, low-confidence prediction.
      * wait: nothing to do; we're waiting on the insurer.
      * escalate_to_human: high-stakes / novel / contradictory situation — the cockpit will route to a senior reviewer.

  - reasoning: 1-2 short paragraphs (20-2000 chars) explaining the verdict. EVERY material assertion must cite a rule_id, pattern_id, or case_id — phrases like "based on rule R-12 the consent form is missing" or "similar to case C-883 which was queried for ICP". The cockpit renders citation chips inline.

  - citations: { rule_ids: [...], pattern_ids: [...], case_ids: [...] } — the FULL set of provenance ids you used. The cockpit dedupes for display; emit the union.

  - uncertainty_notes: anything you're unsure about that the reviewer should know — "low confidence: only 2 similar cases retrieved, both >18 months old" — or null if you have no caveats.

Critical rules for grounding:

  1. NEVER invent rule_ids, pattern_ids, or case_ids that weren't in your inputs. If you can't find provenance, leave citations sparse and lower confidence.
  2. NEVER override the rules engine on a hard blocking_gap (e.g. missing mandatory document) by saying "ready". Hard blocks are hard. You CAN downgrade a 'ready' rule score to 'almost_ready' if patterns/cases warn of query risk.
  3. Patterns and cases are *priors*, not deterministic. A pattern that says "TPA-X queries consent in 60% of cases" is evidence to flag query risk; it is NOT permission to mark the claim 'blocked' without a current concrete gap.
  4. predicted_outcome.expected_amount_inr and expected_deduction_pct should anchor on episodic cases when available (use their actual outcome amounts), patterns when not, and stay null otherwise.
  5. Conflicting signals are common. When KB patterns disagree with each other or with episodic cases, surface that in reasoning and prefer 'review' or 'escalate_to_human' over a confident-sounding decision.

Calibration:
  - High confidence (approval_probability >= 0.85) requires either (a) ≥3 episodic cases with consistent outcomes, OR (b) a strong KB pattern with evidence_count ≥ 20 AND no contradicting cases.
  - approval_probability and p_query don't need to sum to 1 (an approval can come *after* a query) — but if both are >0.7, you're contradicting yourself; lean into the more likely path and explain in reasoning.

Output format: JSON inside a \`\`\`json fence. No preamble, no trailing prose. The downstream Zod schema will reject anything malformed.`;

// ─── User prompt builder ──────────────────────────────────────────────────
//
// Splits the variable inputs into clearly-labelled sections so the model
// can locate them. Token budget targets (approximate):
//   - dossier compact:    ~800 tokens (we trim)
//   - rule evaluation:    ~300 tokens
//   - kb matches (top 3): ~300 tokens
//   - episodic cases (top 3): ~600 tokens
//   - prompt + question:  ~100 tokens
// Total user prompt: ~2-2.5k tokens.

export interface CompactRuleEvaluation {
  ready: boolean;
  readiness_score: number; // 0..1
  blocking_gaps: Array<{ rule_id?: string; rule_key?: string; message?: string; required_doc_category?: string }>;
  warnings: Array<{ rule_id?: string; rule_key?: string; message?: string }>;
  info?: Array<{ rule_id?: string; message?: string }>;
  scope_resolution?: Record<string, number>;
}

export interface CompactKbMatch {
  id: string;
  pattern_type?: string;
  title?: string;
  description?: string;
  prediction?: unknown;
  confidence?: number;
  evidence_count?: number;
}

export interface CompactEpisodicCase {
  claim_id: string;
  similarity: number;
  summary?: string;
  metadata?: Record<string, unknown>;
  outcome?: unknown;
}

export interface CompactDossierSummary {
  // Caller passes a pre-built compact representation (or the raw dossier
  // and we'll squeeze it).
  text: string;
}

/**
 * Build a compact dossier text from a full ClaimDossier. The goal is
 * ~800 tokens — enough for the model to ground decisions on patient /
 * stage / docs / amounts / queries without flooding the context with
 * raw event log JSON.
 *
 * Caller can pass a pre-built summary (e.g. from Wave 4B's
 * episodicMemory.summariseDossier) and we'll use it verbatim; otherwise
 * we do a best-effort here.
 */
export function buildCompactDossier(dossier: ClaimDossier): string {
  const lines: string[] = [];
  lines.push(`CLAIM_ID: ${dossier.claim_id}`);
  if (dossier.current_stage) lines.push(`CURRENT_STAGE: ${dossier.current_stage}`);
  if (dossier.current_panel_id) lines.push(`PANEL: ${dossier.current_panel_id}`);
  if (dossier.current_insurer_id) lines.push(`INSURER/TPA: ${dossier.current_insurer_id}`);

  const ps = dossier.patient_summary ?? {};
  const patientBits: string[] = [];
  if (ps.name) patientBits.push(`name=${ps.name}`);
  if (ps.uhid) patientBits.push(`uhid=${ps.uhid}`);
  if (ps.room) patientBits.push(`room=${ps.room}`);
  if (ps.primary_diagnosis) patientBits.push(`dx=${ps.primary_diagnosis}`);
  if (ps.procedure) patientBits.push(`proc=${ps.procedure}`);
  if (patientBits.length) lines.push(`PATIENT: ${patientBits.join(', ')}`);

  const amt = dossier.amounts ?? {};
  const amtBits: string[] = [];
  if (amt.claimed != null) amtBits.push(`claimed=₹${amt.claimed}`);
  if (amt.pre_auth_approved != null) amtBits.push(`pre_auth_approved=₹${amt.pre_auth_approved}`);
  if (amt.enhancement_approved != null) amtBits.push(`enh_approved=₹${amt.enhancement_approved}`);
  if (amt.final_approved != null) amtBits.push(`final_approved=₹${amt.final_approved}`);
  if (amt.deducted != null) amtBits.push(`deducted=₹${amt.deducted}`);
  if (amtBits.length) lines.push(`AMOUNTS: ${amtBits.join(', ')}`);

  const sections = dossier.doc_sections_by_category ?? {};
  const sectionKeys = Object.keys(sections);
  if (sectionKeys.length) {
    lines.push(
      `DOCS_PRESENT: ${sectionKeys.map((k) => `${k}(${(sections as any)[k]?.length ?? 0})`).join(', ')}`
    );
  } else {
    lines.push('DOCS_PRESENT: (none)');
  }

  const aq = dossier.active_queries ?? [];
  if (aq.length) {
    lines.push(`ACTIVE_QUERIES (${aq.length}):`);
    for (const q of aq.slice(0, 5)) {
      lines.push(
        `  - id=${q.query_id} deficiency=${q.deficiency_type ?? 'n/a'}${
          q.question ? ` "${q.question.slice(0, 120)}"` : ''
        }`
      );
    }
  }

  const evs = dossier.events_summary ?? [];
  if (evs.length) {
    const recent = evs.slice(-8);
    lines.push(`RECENT_EVENTS (last ${recent.length}):`);
    for (const e of recent) {
      lines.push(`  - ${e.at} ${e.kind}${e.actor ? ` by ${e.actor}` : ''}`);
    }
  }

  if (dossier.closed_at) {
    lines.push(`CLOSED_AT: ${dossier.closed_at.toISOString?.() ?? dossier.closed_at}`);
    if (dossier.closure_outcome) lines.push(`CLOSURE_OUTCOME: ${dossier.closure_outcome}`);
  }

  return lines.join('\n');
}

function summariseRuleEvaluation(re: CompactRuleEvaluation): string {
  const lines: string[] = [];
  lines.push(`ready=${re.ready} readiness_score=${re.readiness_score.toFixed(2)}`);
  if (re.blocking_gaps.length) {
    lines.push(`BLOCKING_GAPS (${re.blocking_gaps.length}):`);
    for (const g of re.blocking_gaps.slice(0, 8)) {
      lines.push(
        `  - rule_id=${g.rule_id ?? '?'} key=${g.rule_key ?? '?'} doc=${
          g.required_doc_category ?? '-'
        } msg="${(g.message ?? '').slice(0, 140)}"`
      );
    }
  } else {
    lines.push('BLOCKING_GAPS: (none)');
  }
  if (re.warnings.length) {
    lines.push(`WARNINGS (${re.warnings.length}):`);
    for (const w of re.warnings.slice(0, 8)) {
      lines.push(
        `  - rule_id=${w.rule_id ?? '?'} key=${w.rule_key ?? '?'} msg="${(w.message ?? '').slice(0, 140)}"`
      );
    }
  } else {
    lines.push('WARNINGS: (none)');
  }
  if (re.scope_resolution) {
    const sr = re.scope_resolution;
    lines.push(
      `SCOPE: global=${sr.global_rules_applied ?? 0} panel=${sr.panel_rules_applied ?? 0} insurer=${sr.insurer_rules_applied ?? 0} proc=${sr.procedure_rules_applied ?? 0} dx=${sr.diagnosis_rules_applied ?? 0}`
    );
  }
  return lines.join('\n');
}

function summariseKbMatches(matches: CompactKbMatch[]): string {
  if (!matches.length) return '(no KB pattern matches)';
  const top = matches.slice(0, 3);
  const lines: string[] = [];
  for (const m of top) {
    lines.push(
      `- pattern_id=${m.id} type=${m.pattern_type ?? '?'} confidence=${(m.confidence ?? 0).toFixed(2)} evidence_count=${m.evidence_count ?? 0}`
    );
    if (m.title) lines.push(`    title: ${m.title}`);
    if (m.description) lines.push(`    desc: ${m.description.slice(0, 200)}`);
    if (m.prediction !== undefined) {
      const predStr =
        typeof m.prediction === 'string'
          ? m.prediction
          : JSON.stringify(m.prediction).slice(0, 240);
      lines.push(`    prediction: ${predStr}`);
    }
  }
  return lines.join('\n');
}

function summariseEpisodicCases(cases: CompactEpisodicCase[]): string {
  if (!cases.length) return '(no similar prior cases retrieved)';
  const top = cases.slice(0, 3);
  const lines: string[] = [];
  for (const c of top) {
    lines.push(
      `- case_id=${c.claim_id} similarity=${c.similarity.toFixed(3)}`
    );
    if (c.summary) lines.push(`    summary: ${c.summary.slice(0, 400)}`);
    if (c.outcome !== undefined) {
      const outStr =
        typeof c.outcome === 'string'
          ? c.outcome
          : JSON.stringify(c.outcome).slice(0, 240);
      lines.push(`    outcome: ${outStr}`);
    }
    if (c.metadata && Object.keys(c.metadata).length) {
      const metaStr = JSON.stringify(c.metadata).slice(0, 200);
      lines.push(`    metadata: ${metaStr}`);
    }
  }
  return lines.join('\n');
}

export function buildUserPrompt(args: {
  dossierSummary: string | CompactDossierSummary;
  ruleEvaluation: CompactRuleEvaluation;
  kbMatches: CompactKbMatch[];
  episodicCases: CompactEpisodicCase[];
  targetStage: string;
}): string {
  const dossierText =
    typeof args.dossierSummary === 'string'
      ? args.dossierSummary
      : args.dossierSummary.text;

  const parts: string[] = [];
  parts.push(`TARGET_STAGE: ${args.targetStage}`);
  parts.push('');
  parts.push('=== DOSSIER (compact) ===');
  parts.push(dossierText);
  parts.push('');
  parts.push('=== RULES_ENGINE_RESULT ===');
  parts.push(summariseRuleEvaluation(args.ruleEvaluation));
  parts.push('');
  parts.push('=== KB_PATTERN_MATCHES (top 3) ===');
  parts.push(summariseKbMatches(args.kbMatches));
  parts.push('');
  parts.push('=== EPISODIC_SIMILAR_CASES (top 3) ===');
  parts.push(summariseEpisodicCases(args.episodicCases));
  parts.push('');
  parts.push(
    `QUESTION: For target_stage="${args.targetStage}", is this claim ready to file? What outcome is most likely, and what should the operator do next? Cite the rule_ids / pattern_ids / case_ids that backed each material claim. Return JSON only.`
  );
  return parts.join('\n');
}
