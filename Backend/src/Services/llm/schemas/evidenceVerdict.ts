import { z } from 'zod';

/** Output schema for an EVIDENCE_CHECK (vision) rule — is the asserted evidence
 *  visible in the submitted photo(s)? Interpret-only: judges visibility, not the
 *  claim outcome. */
export const EvidenceVerdictSchema = z
  .object({
    present: z.boolean(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  })
  .passthrough();

export type EvidenceVerdict = z.infer<typeof EvidenceVerdictSchema>;
