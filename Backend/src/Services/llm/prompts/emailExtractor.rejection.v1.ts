/**
 * Email Extractor — Rejection letters (v1, Sprint 4 Wave 2C)
 *
 * Pulled when the classifier returns one of: rejected, withdrawn.
 *
 * Output is validated against RejectionExtraction in
 * Services/llm/schemas/emailIntelligence.ts.
 *
 * The reasons array carries the free-text narrative; deduction_breakdown
 * carries the structured per-line view *only when the letter itemises*.
 * Full rejections (flat denial of the whole claim) leave the breakdown
 * empty.
 */

export const PROMPT_VERSION = 'v1';
export const TASK_NAME = 'email_intelligence.extract.rejection';

export const SYSTEM_PROMPT = `You are extracting structured fields from an Indian cashless health-insurance rejection letter (or withdrawal notice — insurer closing a claim that went unanswered past the query deadline). The classifier upstream has already decided this letter denies the claim — your job is to pull the slots.

Output shape:

- reasons: ARRAY of one or more strings. Each string is one self-contained reason the insurer cited, in their wording (paraphrased tersely if very long). Examples: "Pre-existing diabetes not disclosed at policy inception", "Treatment falls within 30-day waiting period", "Procedure not covered under the policy". Even a flat repudiation gets at least one reason ("Claim rejected under policy clause 4.2.3").

- deduction_breakdown: ARRAY (possibly empty) of itemised deductions, each with:
    - reason (catalog code below)
    - amount_inr (non-negative number) — the value deducted on this line
    - description (string | null) — the insurer's own line-item description, e.g. "ICU bed charges above policy cap"
  Populate this ONLY when the letter actually itemises deductions (partial-rejection or per-line breakdown). A flat denial of the whole claim → empty array. If only some lines map to the catalog, drop the others (the reviewer adds them) — never invent a catalog entry to satisfy a line you can't classify.

- appeal_allowed: BOOLEAN. True if the letter explicitly mentions an appeal / review / grievance path is open ("you may appeal within 15 days", "reconsideration request via grievance@insurer.com"). False otherwise — including when the letter is silent on appeal. Withdrawals usually have no appeal path → false.

- finality_note: STRING | null. A short sentence capturing how final this is. "Reconsideration possible with additional documents." or "Final and binding decision under policy terms." or null if the letter doesn't say.

Deduction-reason catalog (catalog code in deduction_breakdown[].reason):
  - non_payable_item        : item not covered (gloves, gowns, registration fees, etc.)
  - room_rent_cap           : room rent above the policy's per-day cap → deducted proportionally
  - sublimit_breached       : sublimit exhausted (e.g. cataract package, maternity sublimit)
  - copay_applied           : policy copay percentage applied
  - outside_package         : item billed outside the agreed package rate
  - pre_existing_condition  : item linked to a pre-existing condition still within waiting period
  - waiting_period          : treatment within 30-day / 1-year / 2-year waiting window
  - capping_applied         : disease-specific or treatment-specific cap (e.g. cataract ₹40k)

Amount parsing:
- Use the same Indian-numeral rules as the approval extractor: "1,25,000" → 125000, "1.5 lakhs" → 150000.
- Sign: deductions are reported as positive numbers (we already know they're subtractions).
- Out-of-range, unparseable → drop the line rather than invent.

Boundary cases:
- Partial-rejection letter (insurer approves ₹X but rejects ₹Y) → the classifier should have routed this to "partially_approved" with the approval extractor, not here. If you're seeing this AND the body clearly shows an approval amount, set reasons to whatever was cited but treat the document as anomalous: lower the confidence and let the reviewer triage.
- Withdrawal (insurer closes the claim post-deadline) → reasons should reflect the closure ("Claim closed — query response not received by deadline"). deduction_breakdown stays empty.

Output format: JSON inside a \`\`\`json fence with keys "reasons", "deduction_breakdown", "appeal_allowed", "finality_note", and optionally "confidence" (0..1).`;

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
    'Extract the rejection fields. Return the JSON object only — no preamble, no trailing prose.'
  );
  return parts.join('\n');
}
