/**
 * Pipeline v2 — harness: the render + vision-read bridge.
 *
 * This is the ONE place in the harness that can cost money. Everything else
 * (corpus walk, runner composition, scorer) is pure and free. The bridge turns
 * a corpus patient's Layer-A source FILES into the Layer-B `PipelinePage[]` the
 * deterministic runner consumes:
 *
 *   source file ──render──▶ page image(s) ──hash──▶ DerivedPage
 *                                        └─vision read (Stage 1)─▶ PageRead
 *
 * PDFs rasterise to one image per page (pdf-to-png-converter); single-image
 * uploads are their own one page. Each page image is content-hashed
 * (sha256 + pHash + dHash) so the runner's Stage-3 dedup has the signal it
 * needs, then sent through PageReaderService for the structured vision read.
 *
 * SPEND GUARD — the bridge REFUSES to run unless the process is explicitly in a
 * replay-safe mode:
 *   • LLM_REPLAY_MODE=replay                      → free; reads served from disk.
 *   • LLM_REPLAY_MODE=record + HARNESS_ALLOW_RECORD=1
 *                                                 → the ONE authorised real-spend
 *                                                   recording pass (records every
 *                                                   read to disk for future free
 *                                                   replays).
 *   • anything else ('live' / unset / record without the flag)
 *                                                 → throws, before any LLM call.
 * This makes an accidental full-corpus spend impossible: recording is a
 * deliberate, separately-authorised act, and the default path is free replay.
 *
 * Offline-coverage note: with no independent page-count oracle, a source's
 * `expectedPages` is the number of pages we actually rendered+read here — so the
 * Stage-0 soft-drop (E6) is exercised by the unit tests with hand-built
 * fixtures, not by this bridge. The bridge's job is faithful rendering, not
 * inventing a denominator it cannot observe.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

import { PipelinePage, SourceDocRef, DerivedPage } from '../types.js';
import { PageReaderService, PageImage } from '../pageReader.service.js';
import { computePhash, computeDhash } from '../../../Utils/perceptualHash.util.js';
import { CANONICAL_DOC_CATEGORIES } from '../../llm/prompts/docSegmenter.v1.js';
import { CorpusPatient, SourceFile } from './corpus.js';

export interface BridgeOptions {
  /** doc_category candidate list for the vision read. Defaults to the canonical set. */
  candidateCategories?: readonly string[];
  /** PDF rasterisation scale (kept at 2.0 to match the production hashing path). */
  viewportScale?: number;
  /**
   * Injected reader for tests. Defaults to a real PageReaderService, which —
   * via the factory — is record/replay-wrapped whenever LLM_REPLAY_MODE is set.
   */
  reader?: PageReaderService;
}

export interface PatientBridgeResult {
  claimId: string;
  sources: SourceDocRef[];
  pages: PipelinePage[];
  /** Real INR billed across every read (0 on a fully-replayed run). */
  costInr: number;
  /** true ⇔ at least one page AND every read was served from the replay cache. */
  fullyReplayed: boolean;
}

/**
 * Guard the process is in a replay-safe mode BEFORE any rendering or reading.
 * Throws (with an actionable message) otherwise. Exported so the CLI can fail
 * fast at startup and the unit test can assert the guard.
 */
export function assertReplaySafe(env: NodeJS.ProcessEnv = process.env): void {
  const mode = (env.LLM_REPLAY_MODE ?? 'live').toLowerCase();
  if (mode === 'replay') return;
  if (mode === 'record') {
    if (env.HARNESS_ALLOW_RECORD === '1') return;
    throw new Error(
      "readBridge: LLM_REPLAY_MODE='record' needs HARNESS_ALLOW_RECORD=1. " +
        'Recording makes real, billable vision calls for every page in the corpus — ' +
        'it must be explicitly authorised, never the default.',
    );
  }
  throw new Error(
    `readBridge: refusing to run in '${mode}' mode (would spend per page with no replay cache). ` +
      'Set LLM_REPLAY_MODE=replay for a free run, or LLM_REPLAY_MODE=record + HARNESS_ALLOW_RECORD=1 ' +
      'for the one-time authorised recording pass.',
  );
}

/** Stable DerivedPage id / replay cacheKey for a (source, page) pair. */
function pageId(sourceDocId: string, pageIndex: number): string {
  return `${sourceDocId}:${pageIndex}`;
}

/**
 * Rasterise one source file into page images. A single-image upload is its own
 * page; a PDF renders to one PNG per page. Returns the images in page order.
 */
async function renderSource(file: SourceFile, viewportScale: number): Promise<PageImage[]> {
  const bytes = await fs.readFile(file.absPath);
  if (!file.isPdf) {
    return [{ data: bytes, mime: file.mime }];
  }
  const mod: any = await import('pdf-to-png-converter');
  const pdfToPng = mod?.pdfToPng ?? mod?.default?.pdfToPng;
  if (typeof pdfToPng !== 'function') {
    throw new Error('readBridge: pdf-to-png-converter API not found (cannot rasterise PDF source).');
  }
  const rendered: Array<{ content: Buffer }> = await pdfToPng(bytes, { viewportScale });
  return rendered
    .filter((r) => r?.content)
    .map((r) => ({ data: r.content, mime: 'image/png' }));
}

/** sha256 hex of a buffer (Layer-B content address for exact-duplicate detection). */
function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build the runner inputs for ONE corpus patient: render every source file,
 * hash + vision-read each page, and assemble the SourceDocRef[] (coverage
 * denominator) + PipelinePage[] (Stage-1 reads).
 *
 * MUST be called only after assertReplaySafe() — the CLI enforces that; this
 * function also calls it defensively so a stray import can't spend.
 */
export async function bridgePatient(
  patient: CorpusPatient,
  options: BridgeOptions = {},
): Promise<PatientBridgeResult> {
  assertReplaySafe();
  const reader = options.reader ?? new PageReaderService();
  const candidateCategories = options.candidateCategories ?? CANONICAL_DOC_CATEGORIES;
  const viewportScale = options.viewportScale ?? 2.0;

  const sources: SourceDocRef[] = [];
  const pages: PipelinePage[] = [];
  let costInr = 0;
  let allReplayed = true;
  let readCount = 0;

  for (const file of patient.sources) {
    const images = await renderSource(file, viewportScale);
    let renderedForSource = 0;

    for (let i = 0; i < images.length; i++) {
      const pageIndex = i + 1;
      const image = images[i];
      const [sha256, phash, dhash] = await Promise.all([
        Promise.resolve(sha256Hex(image.data)),
        computePhash(image.data).catch(() => undefined),
        computeDhash(image.data).catch(() => undefined),
      ]);

      const page: DerivedPage = {
        id: pageId(file.sourceDocId, pageIndex),
        sourceDocId: file.sourceDocId,
        pageIndex,
        transform: file.isPdf ? 'pdf_render' : 'source_image',
        s3Key: `offline/${patient.slug}/${file.sourceDocId}/${pageIndex}`,
        mime: image.mime,
        sha256,
        phash,
        dhash,
      };

      const result = await reader.readPage({
        image,
        candidateCategories,
        claimId: patient.claimId,
        pageKey: page.id,
        context: { sourceLabel: file.category, pageIndex, totalPages: images.length },
      });

      pages.push({ page, read: result.read, costInr: result.costInr, tier: result.tier });
      costInr += result.costInr;
      if (!result.replayedFromCache) allReplayed = false;
      readCount += 1;
      renderedForSource += 1;
    }

    sources.push({
      sourceDocId: file.sourceDocId,
      fileName: file.fileName,
      mime: file.mime,
      // No independent oracle offline — the denominator is what we rendered+read.
      expectedPages: renderedForSource,
    });
  }

  return {
    claimId: patient.claimId,
    sources,
    pages,
    costInr: Math.round(costInr * 100) / 100,
    fullyReplayed: readCount > 0 && allReplayed,
  };
}
