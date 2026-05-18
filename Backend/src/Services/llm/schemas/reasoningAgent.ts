/**
 * ReasoningAgent — Zod schema (Sprint 4, Wave 4C)
 *
 * Output shape of the ReasoningAgent LLM call. The agent receives:
 *   - a compact dossier summary
 *   - the RulesEngine evaluation (readiness, blocking_gaps, warnings,
 *     scope_resolution)
 *   - the top-K KB pattern matches
 *   - the top-K retrieved similar cases (episodic memory)
 * …and emits a structured verdict + prediction + recommendation. Every
 * material claim has to cite which rule / pattern / case backed it
 * (citations object below), so the cockpit can render the lineage.
 *
 * Versioning: bumped together with the prompt — see `prompts/reasoningAgent.v1.ts`.
 * If the schema shape changes (new field, dropped field) we ship a v2 file
 * and bump REASONING_AGENT_VERSION in `reasoningAgent.service.ts`. Old
 * v1 records in adjudication_reports.reasoning stay valid (free-text only),
 * and the parsed `predicted_outcome` jsonb that came from v1 will still
 * be readable.
 */

import { z } from 'zod';

export const ReasoningAgentOutput = z.object({
  // Coarse-grained verdict the cockpit shows as a chip. Maps onto our
  // existing readiness vocabulary but is the *agent's* judgement after
  // factoring in patterns and prior cases — not the rules engine's raw
  // score. The two can disagree (delta_to_rules below records that).
  readiness_verdict: z.enum(['ready', 'almost_ready', 'blocked']),

  // Does the agent agree with the rules engine? `agrees: false` means the
  // agent overrode rules based on patterns / case history; `reason` then
  // carries a 1-sentence justification that the cockpit surfaces.
  delta_to_rules: z.object({
    agrees: z.boolean(),
    reason: z.string().nullable(),
  }),

  // Numeric prediction over likely insurer outcome. All amount fields in
  // INR. Nullable when the agent can't form a numeric estimate (e.g.
  // very-novel claim shape with no similar cases to anchor on); the
  // cockpit then shows "no prediction" instead of a misleading number.
  predicted_outcome: z.object({
    approval_probability: z.number().min(0).max(1),
    expected_amount_inr: z.number().nonnegative().nullable(),
    expected_deduction_pct: z.number().min(0).max(1).nullable(),
    p_query: z.number().min(0).max(1),
    expected_deductions: z
      .array(
        z.object({
          reason: z.string(),
          amount_inr: z.number().nullable(),
          likelihood: z.number().min(0).max(1),
        })
      )
      .default([]),
  }),

  // What should the operator DO right now? Same vocabulary as
  // AdjudicationReport.recommended_action — the agent's value may
  // override the rules-derived recommendation; the adjudication engine
  // logs the override in the reasoning narrative.
  recommended_action: z.enum([
    'file_now',
    'request_doc',
    'review',
    'wait',
    'escalate_to_human',
  ]),

  // 1-2 paragraph narrative. The model is instructed to keep this
  // ground-truthy: every assertion (e.g. "TPA X tends to query consent
  // forms") must reference a citation id from the citations block.
  // 20–2000 chars: 20 keeps us from accepting an empty-string hallucination,
  // 2000 prevents a token-blowout on prolix outputs.
  reasoning: z.string().min(20).max(2000),

  // Provenance. The cockpit renders chips next to the reasoning so a
  // reviewer can drill into which rule / pattern / case justified the
  // claim. Empty arrays are valid (the agent might form a judgement
  // purely from the dossier).
  citations: z.object({
    rule_ids: z.array(z.string()).default([]),
    pattern_ids: z.array(z.string()).default([]),
    case_ids: z.array(z.string()).default([]),
  }),

  // Free-text "what I'm unsure about". Distinct from `reasoning` because
  // it's specifically surfaced as a warning chip — the reviewer should
  // pay attention to these before approving the action. Null when the
  // agent has no caveats worth flagging.
  uncertainty_notes: z.string().nullable(),
});

export type ReasoningAgentOutputT = z.infer<typeof ReasoningAgentOutput>;
