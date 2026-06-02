import { z } from 'zod';

/** Output schema for a rule-coherence (semantic) check. Interpret-only: the
 *  model judges consistency, NOT whether to approve/hold the claim. */
export const CoherenceVerdictSchema = z
  .object({
    coheres: z.boolean(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  })
  .passthrough();

export type CoherenceVerdict = z.infer<typeof CoherenceVerdictSchema>;
