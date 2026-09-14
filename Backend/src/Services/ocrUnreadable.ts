/**
 * ocrUnreadable — the shared vocabulary every OCR consumer uses to handle a
 * page that vision could not read.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GLOBAL RULE, which every per-consumer rule is an instance of:
 *
 *   An unreadable page is a HOLE, not an empty page. It is never silently
 *   substituted, it never causes the document to be dropped, it never blocks
 *   the remaining pages, and it is always counted and surfaced. Page
 *   NUMBERING is always preserved, because every section boundary in this
 *   system is expressed in page numbers and dropping a page silently shifts
 *   every boundary after it.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Before this module existed, an unreadable page silently became Tesseract
 * text: every consumer could assume `page.text` was a transcription. It no
 * longer is. `text === ''` with `unreadable === true` means "there is no text
 * for this page and there never will be without operator action" — which is a
 * completely different fact from "this page is blank", and the two must never
 * be conflated.
 *
 * Writes go to hospital.claim_ai_unreadable_pages (migration 076), keyed
 * (run_id, doc_id, page_number). Rows are PER-RUN, so a resume that succeeds
 * simply deletes the ones it fixed — the table always describes the CURRENT
 * truth of the run, never a history of attempts.
 *
 * ocr.service does NOT write these rows: it has no run_id and no business
 * knowing about runs. The CONSUMERS, which do know, write them.
 */

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import type {
  OcrPage,
  OcrResult,
  OcrUnreadablePage,
  UnreadableReason,
} from './ocr.service.js';

export type { OcrUnreadablePage, UnreadableReason };

export type UnreadablePhase =
  | 'ingest'
  | 'classify'
  | 'dedup'
  | 'extract'
  | 'harmonise';

// ────────────────────────────────────────────────────────────────────────────
// Pure predicates — no I/O. Cheap enough to call per page.
// ────────────────────────────────────────────────────────────────────────────

/**
 * TRUE when this page carries no text and never will without operator action.
 *
 * Deliberately keyed on the explicit `unreadable` flag rather than on
 * `text === ''`: a genuinely blank verso page IS readable (we read it, it was
 * blank) and must keep flowing through the pipeline as ordinary content.
 */
export function isUnreadable(p: OcrPage): boolean {
  return (p as any).unreadable === true;
}

/**
 * The pages that actually carry text. This is what goes into a classification
 * or extraction PROMPT — never the placeholder strings, which exist only to
 * preserve numbering inside the bundle classifier's page array.
 */
export function readablePages(r: OcrResult): OcrPage[] {
  return (r?.pages ?? []).filter((p) => !isUnreadable(p));
}

/** Unreadable pages whose pageNumber falls in [from, to], inclusive. */
export function unreadableIn(
  r: OcrResult,
  from: number,
  to: number,
): OcrUnreadablePage[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return (r?.pages ?? [])
    .filter((p) => isUnreadable(p) && p.pageNumber >= lo && p.pageNumber <= hi)
    .map((p) => ({
      pageNumber: p.pageNumber,
      reason: ((p as any).unreadableReason ?? 'vision_failed') as UnreadableReason,
      detail: (p as any).unreadableDetail ?? undefined,
    }));
}

/**
 * Every page of this read is unreadable. NOT the same as "the read produced
 * nothing": a zero-page result is a parse failure and is handled separately by
 * each consumer's own zero-page branch.
 */
export function allUnreadable(r: OcrResult): boolean {
  const pages = r?.pages ?? [];
  return pages.length > 0 && pages.every((p) => isUnreadable(p));
}

/** Every unreadable page of a read, in page order. */
export function unreadablePagesOf(r: OcrResult): OcrUnreadablePage[] {
  if (!r) return [];
  const explicit = (r as any).unreadablePages as OcrUnreadablePage[] | undefined;
  if (Array.isArray(explicit) && explicit.length > 0) return explicit;
  return unreadableIn(r, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
}

/**
 * The placeholder a page contributes to the BUNDLE classifier's page array.
 *
 * This string exists for exactly one purpose: keeping `pages[]` index-aligned
 * with real page numbers so a boundary the model emits means the page the
 * operator will open. It is explicitly NOT content, and it must never reach a
 * classification or extraction prompt as if it were — see docClassifier C.3.1
 * and docExtractor C.3.4, both of which filter to readablePages() first.
 */
export function unreadablePlaceholderText(p: OcrPage): string {
  const reason = (p as any).unreadableReason ?? 'vision_failed';
  return `[UNREADABLE PAGE ${p.pageNumber} — ${reason}]`;
}

/**
 * Compact display form for a set of page numbers: [4,5,6,7,11] => "4-7, 11".
 * Used by the end-of-run summary so the UI says "pages 5-12" rather than
 * printing eight numbers.
 */
export function formatPageRanges(pageNumbers: number[]): string {
  const sorted = [...new Set(pageNumbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!;
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(', ');
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

interface PoolLike {
  query: (
    text: string,
    values?: any[],
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
}

let poolRef: PoolLike = defaultPool as any;

/** Test seam. Production never calls this. */
export function __setUnreadablePool(p: PoolLike): void {
  poolRef = p;
}

export interface PersistUnreadableInput {
  run_id: string;
  doc_id: string;
  section_id?: string | null;
  phase: UnreadablePhase;
  pages: OcrUnreadablePage[];
}

/**
 * UPSERT one row per unreadable page.
 *
 * LAST WRITER WINS, deliberately: a later phase reads the same page under a
 * different (usually wider) budget, so its verdict is the more authoritative
 * one. An extract-phase 'vision_failed' should replace a classify-phase
 * 'cost_budget' — the page was affordable in the end and genuinely could not
 * be read, which is a different operator action.
 *
 * Best-effort by design. This table drives an end-of-run BANNER; failing the
 * pipeline because the banner could not be written would be the wrong trade.
 */
export async function persistUnreadablePages(
  input: PersistUnreadableInput,
): Promise<void> {
  const { run_id, doc_id, phase } = input;
  const pages = (input.pages ?? []).filter(
    (p) => p && Number.isFinite(p.pageNumber),
  );
  if (!run_id || !doc_id || pages.length === 0) return;

  for (const p of pages) {
    try {
      await poolRef.query(
        `INSERT INTO hospital.claim_ai_unreadable_pages
           (run_id, doc_id, page_number, reason, detail, phase, section_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (run_id, doc_id, page_number) DO UPDATE
           SET reason     = EXCLUDED.reason,
               detail     = EXCLUDED.detail,
               phase      = EXCLUDED.phase,
               section_id = COALESCE(EXCLUDED.section_id, hospital.claim_ai_unreadable_pages.section_id),
               updated_at = NOW()`,
        [
          run_id,
          doc_id,
          p.pageNumber,
          p.reason,
          p.detail ? String(p.detail).slice(0, 200) : null,
          phase,
          input.section_id ?? null,
        ],
      );
    } catch (err) {
      logger.warn(
        { err, run_id, doc_id, page: p.pageNumber, phase },
        'ocrUnreadable: persist failed (non-fatal — the page is still unreadable, we just cannot show it)',
      );
    }
  }

  logger.info(
    {
      run_id,
      doc_id,
      phase,
      pages: pages.map((p) => p.pageNumber),
      reasons: [...new Set(pages.map((p) => p.reason))],
    },
    'ocrUnreadable: recorded unreadable pages',
  );
}

/**
 * Called when a re-read SUCCEEDS for pages previously marked unreadable.
 *
 * The table describes the CURRENT truth of the run, not a history of
 * attempts: if the extractor's own render produced an image for a page the
 * ingest read marked 'render_failed', the end-of-run summary must not still
 * be asking the user to re-upload a document that worked.
 */
export async function clearUnreadablePages(
  run_id: string,
  doc_id: string,
  pageNumbers: number[],
): Promise<void> {
  const pages = [...new Set((pageNumbers ?? []).filter(Number.isFinite))];
  if (!run_id || !doc_id || pages.length === 0) return;
  try {
    const r = await poolRef.query(
      `DELETE FROM hospital.claim_ai_unreadable_pages
        WHERE run_id = $1 AND doc_id = $2 AND page_number = ANY($3::int[])`,
      [run_id, doc_id, pages],
    );
    if ((r.rowCount ?? 0) > 0) {
      logger.info(
        { run_id, doc_id, pages, cleared: r.rowCount },
        'ocrUnreadable: cleared markers for pages that turned out to be readable',
      );
    }
  } catch (err) {
    logger.warn(
      { err, run_id, doc_id, pages },
      'ocrUnreadable: clear failed (non-fatal)',
    );
  }
}

/**
 * Convenience for the consumers: record whatever this read could not read,
 * and return the unreadable page list so the caller can branch on it.
 * Returns [] when there is no run cursor (unattended paths).
 */
export async function recordReadUnreadables(args: {
  run_id: string | null;
  doc_id: string;
  section_id?: string | null;
  phase: UnreadablePhase;
  ocr: OcrResult;
}): Promise<OcrUnreadablePage[]> {
  const pages = unreadablePagesOf(args.ocr);
  if (pages.length > 0 && args.run_id) {
    await persistUnreadablePages({
      run_id: args.run_id,
      doc_id: args.doc_id,
      section_id: args.section_id ?? null,
      phase: args.phase,
      pages,
    });
  }
  return pages;
}
