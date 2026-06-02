/**
 * Pipeline v2 — harness: the deterministic stage composition.
 *
 * This is the one place every v2 stage is wired together end-to-end. Given a
 * claim's Layer-A sources and its Stage-1-read Layer-B pages, it runs
 * Stages 0 → 7 and returns every intermediate artifact plus the final
 * RunState. It contains NO LLM call — the expensive vision read (Stage 1) has
 * already happened upstream (the harness reads/replays it). So this whole
 * composition is pure, deterministic, and free to unit-test and re-run.
 *
 * Stage order + why:
 *   0. coverage       — Layer-A vs Layer-B accounting (does NOT depend on the
 *                       others; computed independently from the manifest).
 *   2. identity gate  — quarantine foreign-patient pages FIRST, so a different
 *                       patient's page can never become a dedup representative
 *                       or contribute a fact.
 *   3. dedup          — collapse visual duplicates AMONG THE SURVIVORS, keeping
 *                       the most-legible render of each visual cluster.
 *   4. extraction     — route Stage-1 facts to canonical slots, EXCLUDING
 *                       quarantined pages, different-episode review pages, and
 *                       non-representative duplicates.
 *   5. fusion         — authority-rank the surviving facts into one episode.
 *   6. validation     — value-level sanity + low-confidence abstention.
 *   7. run signals    — advisory signals over 0 + 2 + 6 (NEVER a gate): foreign
 *                       pages removed, possible contamination, coverage gaps,
 *                       low-confidence fields. Adjudication is the rules layer's.
 *
 * Note: review-flagged pages (episode outliers from Stage 2) are EXCLUDED from
 * fusion — a page from a different admission does not define THIS claim's
 * episode, so letting it contribute would fuse two treatment journeys into one
 * JSON. They are STILL surfaced as a possible-contamination signal (never a
 * block): we interpret accurately and flag; adjudication is the rules layer's.
 */

import {
  PipelinePage,
  SourceDocRef,
  CoverageReport,
  SectionFact,
} from '../types.js';
import { buildManifest, computeCoverage } from '../pageManifest.service.js';
import { runIdentityGate, IdentityGateResult, IdentityGateOptions } from '../identityGate.service.js';
import { dedupPages, DedupResult, DedupOptions } from '../dedup.service.js';
import { extractSectionFacts } from '../extraction.service.js';
import { fuseEpisode, FusedEpisode } from '../fusion.service.js';
import { validateEpisode, ValidationReport } from '../validators.service.js';
import { evaluateRunState, RunState } from '../runState.service.js';

export interface ClaimRunInput {
  claimId: string;
  /** Layer-A source uploads with their expected page counts (coverage denominator). */
  sources: SourceDocRef[];
  /** Stage-1-read Layer-B pages for the claim. */
  pages: PipelinePage[];
  identityOptions?: IdentityGateOptions;
  dedupOptions?: DedupOptions;
}

export interface ClaimRunResult {
  claimId: string;
  coverage: CoverageReport;
  identity: IdentityGateResult;
  dedup: DedupResult;
  /** Pages excluded from fusion = quarantined ∪ episode-outlier review ∪ non-representative duplicates. */
  excludedPageIds: string[];
  facts: SectionFact[];
  episode: FusedEpisode;
  validation: ValidationReport;
  runState: RunState;
}

/**
 * Run the full deterministic v2 pipeline over one claim's read pages.
 *
 * Pure: same input ⇒ same ClaimRunResult. No DB, no S3, no LLM.
 */
export function runClaim(input: ClaimRunInput): ClaimRunResult {
  const { claimId, sources, pages } = input;

  // Stage 0 — coverage over the Layer-A manifest (independent of the rest).
  const coverage = computeCoverage(
    buildManifest(claimId, sources, pages.map((p) => p.page)),
  );

  // Stage 2 — identity gate over ALL pages.
  const identity = runIdentityGate(pages, input.identityOptions);
  // Pages removed from THIS claim's episode before fusion: foreign-PATIENT pages
  // (quarantine) AND foreign-EPISODE pages (a different admission of the same
  // patient, flagged for review). Both feed Stage-7 signals; NEITHER blocks.
  // Dropping a different-episode page is accurate interpretation, not
  // adjudication — it belongs to another treatment journey, so it must not
  // define THIS claim's fields (Divyansh's hernia-readmission dates/diagnosis
  // were leaking into a fracture claim through a review-flagged discharge slip).
  const removedPageIds = new Set<string>([
    ...identity.quarantinedPageIds,
    ...identity.reviewPageIds,
  ]);

  // Stage 3 — dedup the SURVIVORS only (post-removal), so a removed page can
  // never be chosen as a cluster representative and drop its legit members.
  const survivors = pages.filter((p) => !removedPageIds.has(p.page.id));
  const dedup = dedupPages(survivors, input.dedupOptions);

  // Pages excluded from fusion: removed (foreign patient/episode) + duplicate renders.
  const excluded = new Set<string>([...removedPageIds, ...dedup.duplicatePageIds]);

  // Stage 4 — extraction over all pages, excluding the dropped set.
  const facts = extractSectionFacts(pages, { excludePageIds: excluded });

  // Stage 5 — authority-ranked fusion.
  const episode = fuseEpisode(facts);

  // Stage 6 — value-level validation + loud abstention.
  const validation = validateEpisode(episode);

  // Stage 7 — advisory signals over 0 + 2 + 6 (with dedup counts). Non-blocking.
  const runState = evaluateRunState({ coverage, identity, validation, dedup, pages });

  return {
    claimId,
    coverage,
    identity,
    dedup,
    excludedPageIds: [...excluded].sort(),
    facts,
    episode,
    validation,
    runState,
  };
}
