/**
 * Email Extractor — Query letters (v1, Sprint 4 Wave 2C)
 *
 * Pulled when the classifier returns one of: queried, follow_up.
 *
 * Output is validated against QueryExtraction in
 * Services/llm/schemas/emailIntelligence.ts.
 *
 * Catalog: deficiency_type is constrained to the master_options(
 * category='deficiency_type') vocabulary. The model is *allowed* to return
 * null when no catalog entry fits — that's better than forcing a wrong
 * mapping. The reviewer picks at apply time and the correction lands in
 * email_intelligence_corrections, which we mine to evolve the catalog.
 */

export const PROMPT_VERSION = 'v1';
export const TASK_NAME = 'email_intelligence.extract.query';

export const SYSTEM_PROMPT = `You are extracting structured fields from an Indian cashless health-insurance query letter (deficiency letter, follow-up, "kindly furnish" email). The classifier upstream has already decided this letter is raising one or more questions or document requests — your job is to enumerate them.

Output shape:

- queries: an ARRAY of one or more items, each with:
    - description (string): the insurer's question or request in 1-2 sentences. Paraphrase tersely; do not quote whole paragraphs.
    - deficiency_type (one of the catalog below, or null): the closest standard category.
    - doc_requested (string | null): the name of the specific document the insurer is asking for, if any. E.g. "consent form", "ICP", "final bill", "implant invoice". Null if the query is a clarification rather than a doc request.
    - deadline (YYYY-MM-DD | null): the response deadline if stated. ISO format.

- severity: one of 'low' | 'medium' | 'high'.
    - low    → courtesy follow-ups, "please update us", trivial clarifications.
    - medium → standard deficiency, one or two routine documents missing.
    - high   → urgent / final reminder, multiple missing documents, or anything threatening claim closure.

Deficiency-type catalog (deficiency_type field):
  - missing_consent          : patient/relative consent form missing or unsigned
  - missing_diagnosis_summary: discharge summary / treating-doctor note absent or incomplete
  - missing_procedure_estimate: pre-auth procedure cost breakdown not provided
  - missing_icp              : Inpatient Case Paper (treatment chart) missing
  - missing_implant_invoice  : implant/stent/lens invoice and sticker not provided
  - missing_final_bill       : itemised final bill missing or illegible
  - diagnosis_mismatch       : ICD code or diagnosis doesn't match clinical findings
  - icd_unspecified          : diagnosis stated narratively but no ICD-10 code given
  - document_illegible       : document is present but unreadable (scan quality, handwriting)
  - signature_missing        : doctor/patient signature absent on a required form
  - date_inconsistency       : dates across documents don't match (admission, discharge, signing)

If a query item asks for a documented but the deficiency cleanly maps to one of the above, set deficiency_type. If the insurer's request is genuinely outside the catalog ("please confirm whether the patient consumes alcohol"), set deficiency_type to null. Do not invent catalog entries.

Multi-query letters are common. The same letter can ask for ICP *and* a signed consent. List each as a separate item in \`queries\`. Order doesn't matter; the reviewer sorts them.

Deadline parsing:
- "Reply within 48 hours" without a calendar date → null (we don't know when the clock started).
- "Submit by 25-May-2026" → 2026-05-25.
- Anything ambiguous → null.

Output format: JSON inside a \`\`\`json fence with keys "queries" (array, ≥1 item), "severity", and optionally "confidence" (0..1).`;

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
    'Extract the queries and severity. Return the JSON object only — no preamble, no trailing prose.'
  );
  return parts.join('\n');
}
