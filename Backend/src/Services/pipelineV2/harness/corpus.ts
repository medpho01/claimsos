/**
 * Pipeline v2 — harness: corpus discovery over the offline benchmark set.
 *
 * The benchmark corpus is a flat directory (default /tmp/probe) laid out as:
 *
 *   MANIFEST.txt                       <claimId> <slug> <Name> <Hospital>  (one row per patient)
 *   <slug>/docs/<category>__<uuid>.<ext>   the Layer-A source uploads
 *   <slug>/ai/…                        the prior v1 output bundle (ignored here)
 *   reports/…                          Claude ground-truth audit prose (ignored here)
 *
 * A source FILE's category is the filename prefix before `__` (e.g. "admission",
 * "surgical_discharge_slip"). NOTE: these are the LEGACY pull-time labels, not
 * the v2 doc_category codes — they are a provenance hint only, never ground
 * truth for the vision reader's doc_type.
 *
 * The SAME logical document sometimes appears under several extensions
 * (`…__<uuid>.pdf`, `.jpg`, `.webp`). Each FILE is still its own Layer-A upload
 * (its own `ipd_doc`) — collapsing those is exactly Stage 3's cross-container
 * dedup job, so we deliberately surface each file as a distinct source.
 *
 * This module is file-I/O only: no rendering, no LLM. `parseManifest` is a pure
 * string function (unit-tested directly); `loadCorpus` walks the directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CorpusEntry {
  claimId: string;
  slug: string;
  name?: string;
  hospital?: string;
}

export interface SourceFile {
  /** Natural key for this upload — the file's basename (unique per extension). */
  sourceDocId: string;
  fileName: string;
  /** Filename prefix before `__` — the legacy pull-time category hint. */
  category: string;
  /** Lowercased extension without the dot, e.g. 'pdf' | 'jpg' | 'webp'. */
  ext: string;
  mime: string;
  absPath: string;
  isPdf: boolean;
}

export interface CorpusPatient extends CorpusEntry {
  docsDir: string;
  sources: SourceFile[];
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

export function mimeForExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Extensions we know how to ingest (render or read directly). */
export function isIngestibleExt(ext: string): boolean {
  return ext.toLowerCase() in MIME_BY_EXT;
}

/**
 * Parse a MANIFEST.txt body into corpus entries. Each non-blank line is
 * whitespace-separated `<claimId> <slug> [name] [hospital]`. Lines that don't
 * have at least a claimId and slug are skipped. Pure + deterministic.
 */
export function parseManifest(text: string): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 2) continue;
    out.push({
      claimId: cols[0],
      slug: cols[1],
      name: cols[2],
      hospital: cols[3],
    });
  }
  return out;
}

/** Split a corpus filename into its `<category>__<rest>` parts. */
function categoryOf(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const idx = base.indexOf('__');
  return idx === -1 ? base : base.slice(0, idx);
}

/** Enumerate the ingestible source files in one patient's docs directory. */
export function listSourceFiles(docsDir: string): SourceFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(docsDir);
  } catch {
    return [];
  }
  const out: SourceFile[] = [];
  for (const fileName of entries) {
    const ext = (path.extname(fileName).slice(1) || '').toLowerCase();
    if (!isIngestibleExt(ext)) continue;
    out.push({
      sourceDocId: fileName,
      fileName,
      category: categoryOf(fileName),
      ext,
      mime: mimeForExt(ext),
      absPath: path.join(docsDir, fileName),
      isPdf: ext === 'pdf',
    });
  }
  // Stable ordering for deterministic runs.
  out.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return out;
}

/**
 * Load the full corpus: parse MANIFEST.txt and, for each patient, enumerate the
 * source files under `<slug>/docs`. Patients with no docs directory are kept
 * (with an empty sources list) so they still appear in coverage as zero-doc
 * claims rather than silently vanishing.
 */
export function loadCorpus(rootDir: string): CorpusPatient[] {
  const manifestPath = path.join(rootDir, 'MANIFEST.txt');
  const entries = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  return entries.map((e) => {
    const docsDir = path.join(rootDir, e.slug, 'docs');
    return { ...e, docsDir, sources: listSourceFiles(docsDir) };
  });
}
