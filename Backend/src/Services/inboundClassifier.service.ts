/**
 * Inbound Email Classifier (rule-based, v1)
 *
 * Given an insurer reply's subject + body, returns:
 *   - classification: one of {ack, query, approval, rejection, settlement, other}
 *   - action: a human-readable instruction (e.g. "Provide additional documents")
 *
 * This is keyword-based for v1 — fast, deterministic, no LLM dependency.
 * Real-world insurer language is consistent enough that this gets us ~80%
 * coverage. An LLM fallback can be added behind a feature flag later.
 *
 * The classifier prefers explicit signals (e.g. "denied" overrides "review")
 * and tracks the highest-priority match.
 */

export type InboundClassification =
  | 'ack'
  | 'query'
  | 'approval'
  | 'rejection'
  | 'settlement'
  | 'other';

export interface ClassifyResult {
  classification: InboundClassification;
  action: string;
  confidence: 'high' | 'medium' | 'low';
  matched_keywords: string[];
}

/** ordered: first matching rule with highest specificity wins */
const RULES: Array<{
  classification: InboundClassification;
  keywords: RegExp[];
  action: string;
  confidence: 'high' | 'medium' | 'low';
}> = [
  // Rejection — strongest signal, check first
  {
    classification: 'rejection',
    keywords: [
      /\bdenied\b/i,
      /\brejected\b/i,
      /\bdeclined\b/i,
      /\bnon[- ]admissible\b/i,
      /\bnot\s+admissible\b/i,
      /\bnot\s+payable\b/i,
      /\bwe\s+regret\b/i,
    ],
    action: 'Pre-auth rejected — review the reason and consider appeal',
    confidence: 'high',
  },
  // Approval
  {
    classification: 'approval',
    keywords: [
      /\bapproved\b/i,
      /\bauthoris(ed|ation)\b/i,
      /\bauthorized\b/i,
      /\bapproval\s+letter\b/i,
      /\bpre[- ]auth\s+(is\s+)?approved\b/i,
      /\bsanctioned\b/i,
    ],
    action: 'Pre-auth approved — proceed with treatment',
    confidence: 'high',
  },
  // Settlement (payment intimation)
  {
    classification: 'settlement',
    keywords: [
      /\bsettled\b/i,
      /\bsettlement\s+advice\b/i,
      /\bpayment\s+(has\s+been\s+)?(made|released|processed)\b/i,
      /\bremittance\b/i,
      /\bdisbursed\b/i,
    ],
    action: 'Settlement received — reconcile against bill amount',
    confidence: 'high',
  },
  // Query / additional documents requested
  {
    classification: 'query',
    keywords: [
      /\bplease\s+(provide|share|send|upload|attach)\b/i,
      /\bkindly\s+(provide|share|send|upload|attach)\b/i,
      /\brequest\s+you\s+to\s+(provide|share|send)\b/i,
      /\bsubmit\s+(additional|the\s+following)\b/i,
      /\bquery\b/i,
      /\binsufficient\s+(documents?|information)\b/i,
      /\bmissing\b/i,
      /\bwe\s+need\b/i,
      /\bawaiting\b/i,
      /\bclarification\s+(is\s+)?required\b/i,
      /\bhba1c\b/i,
      /\bdiagnost(ic|ics)\b/i,
    ],
    action: 'Insurer requested additional information — review and respond',
    confidence: 'medium',
  },
  // Acknowledgement (claim received, processing)
  {
    classification: 'ack',
    keywords: [
      /\bclaim\s+(has\s+been\s+)?received\b/i,
      /\bunder\s+(review|process|processing)\b/i,
      /\bcase\s+(no|number|reference|id)[\s:]/i,
      /\bccn\s*[:\-]/i,
      /\backnowledg(e|ed|ement)\b/i,
      /\bauto[- ]reply\b/i,
      /\bthank\s+you\s+for\s+(your\s+)?(email|submission)\b/i,
    ],
    action: 'Insurer acknowledged the claim — awaiting further response',
    confidence: 'medium',
  },
];

export function classifyInboundEmail(input: {
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
}): ClassifyResult {
  const haystack = [input.subject ?? '', input.bodyText ?? '', input.bodyHtml ?? '']
    .join('\n')
    .toLowerCase();

  // Walk rules in priority order, return first that matches
  for (const rule of RULES) {
    const hits: string[] = [];
    for (const pat of rule.keywords) {
      const m = haystack.match(pat);
      if (m) hits.push(m[0]);
    }
    if (hits.length > 0) {
      return {
        classification: rule.classification,
        action: rule.action,
        confidence: rule.confidence,
        matched_keywords: Array.from(new Set(hits)),
      };
    }
  }

  return {
    classification: 'other',
    action: 'Reply received — please open and review',
    confidence: 'low',
    matched_keywords: [],
  };
}
