/**
 * Email Extractor — Approval letters (v1, Sprint 4 Wave 2C)
 *
 * Pulled when the classifier returns one of:
 *   approved, partially_approved, enhancement_approved, enhancement_partial.
 *
 * The output is validated against ApprovalExtraction in
 * Services/llm/schemas/emailIntelligence.ts; any deviation throws
 * LlmSchemaValidationError and the draft lands in status='extraction_failed'.
 *
 * Every slot is nullable because real-world insurer letters are missing
 * fields all the time. We'd rather get 3 of 5 fields correctly than have
 * the model hallucinate the other 2 to satisfy a non-null schema.
 */

export const PROMPT_VERSION = 'v1';
export const TASK_NAME = 'email_intelligence.extract.approval';

export const SYSTEM_PROMPT = `You are extracting structured fields from an Indian cashless health-insurance approval letter (or partial approval, or enhancement approval). The classifier upstream has already decided this letter approves *something* — your job is to pull the slots.

Fields to extract (all NULL if not present):

- amount_inr (number | null)
  The amount in Indian rupees the insurer has approved or sanctioned. Look for "Approved Amount", "Sanctioned amount", "Cashless approval for ₹X", "Pre-auth granted: Rs. X/-". Strip currency markers, commas, and "Rs/INR/₹" prefixes — return a plain non-negative number. If the letter mentions multiple amounts (e.g. an initial pre-auth and an enhancement), return the *total approved* in the letter you're reading.

- room_category (string | null)
  The room category the approval is restricted to, e.g. "Single Private AC", "Twin Sharing", "Semi-Private", "Deluxe". Many letters omit this entirely. If present, return the insurer's exact phrasing.

- validity_from (YYYY-MM-DD | null)
  Start date of the approval's validity window. Often "valid from DD/MM/YYYY". Convert to ISO YYYY-MM-DD. If only a single "valid till" date is given, set validity_from to null and put the date in validity_to.

- validity_to (YYYY-MM-DD | null)
  End date — "valid until", "valid up to", "valid till". ISO format.

- notes (string | null)
  Anything salient that doesn't fit the other slots: conditions ("subject to pre-existing waiting period"), TPA caveats ("approval subject to admissibility at discharge"), partial-approval reasoning ("non-payable items deducted: ₹X"). One short paragraph at most — do NOT dump the whole letter. Null if there's nothing noteworthy beyond the structured slots.

Date parsing rules:
- Indian conventions: DD/MM/YYYY or DD-MM-YYYY are most common. Be careful with US-style MM/DD/YYYY (rare here but appears in some TPA portals).
- Two-digit years: assume 20YY for YY <= current_year+5, otherwise 19YY. If genuinely ambiguous → null.
- Out-of-range or unparseable dates → null, do not invent.

Amount parsing rules:
- "Rs. 1,25,000" → 125000 (lakh-comma format).
- "₹1.5 lakhs" → 150000 (lakh = 100000).
- "INR 1.25 Cr" → 12500000 (crore = 10000000).
- Any leading minus → null (negative approval makes no sense).

Output format: JSON inside a \`\`\`json fence with exactly the five keys above. Optionally include a top-level "confidence" (0..1) which the bridge uses to decide whether to escalate from Haiku to Sonnet.`;

export function buildUserPrompt(
  body: string,
  attachmentTexts: Array<{ filename: string; text: string }>
): string {
  const parts: string[] = [];
  parts.push('--- EMAIL BODY ---');
  parts.push(body?.trim() || '(empty body)');

  attachmentTexts.forEach((att, i) => {
    parts.push('');
    parts.push(`--- ATTACHMENT ${i + 1}: ${att.filename} ---`);
    parts.push(att.text?.replace(/\n{3,}/g, '\n\n').trim() || '(empty)');
  });

  parts.push('');
  parts.push(
    'Extract the approval fields. Return the JSON object only — no preamble, no trailing prose.'
  );
  return parts.join('\n');
}
