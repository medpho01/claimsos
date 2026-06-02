/**
 * Pipeline v2 — Stage 0: page manifest + content-coverage invariant (E6).
 *
 * Stage 0 is the FIRST trust gate and the foundation of the two-layer artifact
 * model. It answers one question: did every Layer-A source upload (`ipd_doc`)
 * actually contribute the Layer-B renders (`derived_page`) we expected? The
 * cross-validation's E6 finding was a SILENT soft-drop — a PDF page that failed
 * to rasterise just vanished, and because nothing counted Layer-A pages, the
 * pipeline harmonised a bundle that was quietly missing a page. A missing page
 * is a missing fact, and a missing fact gets filled by a stale neighbour.
 *
 * The invariant is deliberately measured against LAYER A, never Layer B:
 *   • The denominator is `expectedPages` summed over the source uploads.
 *   • The numerator is the count of renders that map back to each source.
 *   • Rendering one 14-page PDF into 14 rows can therefore never inflate the
 *     document count or paper over a drop — coverage is about sources, not
 *     renders.
 *
 * Coverage FAILS (ok=false) when EITHER:
 *   • a source rendered FEWER pages than expected — the E6 soft-drop; or
 *   • a render references a source absent from the manifest — an orphan render,
 *     an accounting break between the two layers.
 *
 * Pure + deterministic: a DB adapter loads `ipd_doc` rows (sources) and
 * `derived_page` rows (renders) and hands them here. No DB, no S3, no LLM — so
 * it is free to unit-test with hand-built fixtures and free to re-run.
 */

import {
  PageManifest,
  SourceDocRef,
  DerivedPage,
  CoverageReport,
} from './types.js';

/**
 * Assemble a deterministic PageManifest from a claim's Layer-A sources and
 * Layer-B renders.
 *
 * Sources are de-duplicated by `sourceDocId` (last occurrence wins) so a
 * doubled source row cannot inflate the coverage denominator. The page list is
 * preserved as-is — coverage groups by `sourceDocId`, so render order does not
 * matter.
 *
 * @param claimId — the claim/admission these artifacts belong to.
 * @param sources — Layer-A `ipd_doc` references, each with its expected page count.
 * @param pages — Layer-B `derived_page` renders read in Stage 1.
 */
export function buildManifest(
  claimId: string,
  sources: SourceDocRef[],
  pages: DerivedPage[],
): PageManifest {
  const byId = new Map<string, SourceDocRef>();
  for (const s of sources) byId.set(s.sourceDocId, s);
  return { claimId, sources: [...byId.values()], pages };
}

/**
 * Compute the Stage-0 content-coverage invariant over a claim's manifest.
 *
 * @param manifest — the Layer-A sources + Layer-B renders for one claim.
 * @returns a CoverageReport whose `ok` is the hard input Stage 7 consumes: true
 *   only when no source was under-rendered AND no render is orphaned.
 */
export function computeCoverage(manifest: PageManifest): CoverageReport {
  const { sources, pages } = manifest;

  // Renders per source (the numerator).
  const renderedBySource = new Map<string, number>();
  for (const p of pages) {
    renderedBySource.set(p.sourceDocId, (renderedBySource.get(p.sourceDocId) ?? 0) + 1);
  }

  const knownSourceIds = new Set(sources.map((s) => s.sourceDocId));

  const missing: CoverageReport['missing'] = [];
  let totalExpectedPages = 0;
  for (const s of sources) {
    const rendered = renderedBySource.get(s.sourceDocId) ?? 0;
    totalExpectedPages += s.expectedPages;
    // Under-rendered ⇒ a soft-drop. Over-rendering (rendered > expected) is NOT
    // a coverage failure — a duplicate render is Stage 3's concern, not a
    // missing page — so we only flag shortfalls here.
    if (rendered < s.expectedPages) {
      missing.push({
        sourceDocId: s.sourceDocId,
        fileName: s.fileName,
        expectedPages: s.expectedPages,
        renderedPages: rendered,
      });
    }
  }

  // Orphans: a render whose source upload is not declared in the manifest — an
  // accounting break between Layer B and Layer A.
  const orphanSourceDocIds = [
    ...new Set(pages.map((p) => p.sourceDocId).filter((id) => !knownSourceIds.has(id))),
  ];

  // Stable ordering for deterministic output.
  missing.sort((a, b) => a.sourceDocId.localeCompare(b.sourceDocId));
  orphanSourceDocIds.sort();

  return {
    ok: missing.length === 0 && orphanSourceDocIds.length === 0,
    totalSources: sources.length,
    totalExpectedPages,
    totalRenderedPages: pages.length,
    missing,
    orphanSourceDocIds,
  };
}
