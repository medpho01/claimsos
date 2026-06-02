/**
 * Pipeline v2 — Stage 3: Vision-led cross-container dedup.
 *
 * Indian claim uploads routinely contain the SAME page more than once across
 * DIFFERENT container files: a discharge summary that is both its own PDF and
 * a page inside a "full file" PDF; a photo re-uploaded after a failed upload; a
 * re-scan at a different angle. File-level sha256 (Layer A) cannot catch these
 * — the bytes differ — so a duplicate discharge summary would otherwise be
 * fused TWICE and masquerade as independent corroboration, inflating
 * confidence on whatever it says.
 *
 * Stage 3 deduplicates on the PERCEPTUAL hash of the rendered page (Layer B):
 * two renders within a small Hamming distance are the same physical page. It
 * runs BEFORE fusion so each real page contributes exactly once, and it keeps
 * the MOST LEGIBLE render of each visual cluster as the representative (a
 * sharp re-scan beats a blurry first attempt).
 *
 * Pure + deterministic: the expensive part (computing pHash/dHash from image
 * bytes via sharp) happens at render time in Stage 0; this stage only groups
 * precomputed hashes, so it is free to unit-test and free to re-run.
 *
 * Reuses Utils/perceptualHash.util.ts (hammingDistance + the tuned default
 * threshold) so v2 dedup and the legacy section dedup share one definition of
 * "visually identical".
 */

import {
  hammingDistance,
  DEFAULT_HAMMING_THRESHOLD,
} from '../../Utils/perceptualHash.util.js';
import { PipelinePage } from './types.js';

export interface DedupCluster {
  /** Page id kept as the canonical representative of this visual group. */
  representativePageId: string;
  /** All page ids in the group (includes the representative). */
  memberPageIds: string[];
  size: number;
}

export interface DedupResult {
  clusters: DedupCluster[];
  /** One representative page id per cluster — the set Stage 4/5 should consume. */
  keepPageIds: string[];
  /** Page ids that are visual duplicates of a kept representative. */
  duplicatePageIds: string[];
  /** duplicate page id → the representative it collapses into (lineage/UI). */
  duplicateOf: Record<string, string>;
}

export interface DedupOptions {
  /** Max Hamming distance (bits) for two pHashes to be "the same page". */
  phashThreshold?: number;
  /** Max Hamming distance for dHash corroboration. */
  dhashThreshold?: number;
  /**
   * When true (default), BOTH pHash and dHash must agree for a merge — far
   * fewer false merges (different pages that happen to share a pHash). When a
   * page lacks a dHash, the decision falls back to pHash alone.
   */
  requireBoth?: boolean;
}

/** Simple union-find for clustering. */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Hamming distance, but tolerant: null when either hash is missing or lengths differ. */
function safeHamming(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b || a.length !== b.length) return null;
  try {
    return hammingDistance(a, b);
  } catch {
    return null;
  }
}

/**
 * Decide whether two pages are the same physical page given the hash
 * thresholds. pHash must be present and within threshold; dHash corroborates
 * when `requireBoth` and both pages carry one.
 */
function isDuplicate(a: PipelinePage, b: PipelinePage, opts: Required<DedupOptions>): boolean {
  const pd = safeHamming(a.page.phash, b.page.phash);
  if (pd === null || pd > opts.phashThreshold) return false;
  if (opts.requireBoth) {
    const dd = safeHamming(a.page.dhash, b.page.dhash);
    // If both have a dHash, it must also agree; if either lacks one, pHash
    // (already within threshold) carries the decision.
    if (dd !== null && dd > opts.dhashThreshold) return false;
  }
  return true;
}

/** Pick the representative of a cluster: most legible, then legible-flag, then stable id. */
function pickRepresentative(pages: PipelinePage[]): PipelinePage {
  return [...pages].sort((a, b) => {
    if (b.read.legibility !== a.read.legibility) return b.read.legibility - a.read.legibility;
    if (a.read.is_legible !== b.read.is_legible) return a.read.is_legible ? -1 : 1;
    return a.page.id.localeCompare(b.page.id);
  })[0];
}

/**
 * Cluster a claim's pages by visual identity and return the kept
 * representatives plus the duplicate lineage.
 *
 * @param pages — Stage-1-read pages (ideally already identity-gated).
 * @returns clusters + keep/duplicate sets. Pages with no pHash are always kept
 *   (un-deduplicable), each as its own singleton.
 */
export function dedupPages(pages: PipelinePage[], options: DedupOptions = {}): DedupResult {
  const opts: Required<DedupOptions> = {
    phashThreshold: options.phashThreshold ?? DEFAULT_HAMMING_THRESHOLD,
    dhashThreshold: options.dhashThreshold ?? DEFAULT_HAMMING_THRESHOLD,
    requireBoth: options.requireBoth ?? true,
  };

  const uf = new UnionFind(pages.length);
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (isDuplicate(pages[i], pages[j], opts)) uf.union(i, j);
    }
  }

  // Gather clusters by root.
  const groups = new Map<number, PipelinePage[]>();
  pages.forEach((p, i) => {
    const root = uf.find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(p);
  });

  const clusters: DedupCluster[] = [];
  const keepPageIds: string[] = [];
  const duplicatePageIds: string[] = [];
  const duplicateOf: Record<string, string> = {};

  for (const members of groups.values()) {
    const rep = pickRepresentative(members);
    keepPageIds.push(rep.page.id);
    clusters.push({
      representativePageId: rep.page.id,
      memberPageIds: members.map((m) => m.page.id),
      size: members.length,
    });
    for (const m of members) {
      if (m.page.id !== rep.page.id) {
        duplicatePageIds.push(m.page.id);
        duplicateOf[m.page.id] = rep.page.id;
      }
    }
  }

  // Stable ordering for deterministic output.
  clusters.sort((a, b) => a.representativePageId.localeCompare(b.representativePageId));
  keepPageIds.sort();
  duplicatePageIds.sort();

  return { clusters, keepPageIds, duplicatePageIds, duplicateOf };
}
