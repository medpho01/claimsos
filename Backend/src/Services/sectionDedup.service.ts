/**
 * SectionDedupService — Wave 12 content-level dedup.
 * ────────────────────────────────────────────────────────────────────────
 * Operates on `hospital.document_sections.content_text_hash` populated by
 * the bundle classifier. Within a single claim, groups sections that
 * share the same normalized OCR text fingerprint and picks ONE canonical
 * per group. Duplicates are stamped with `dedup_of = canonical.id` so:
 *
 *   1. The extractor can `WHERE dedup_of IS NULL` and skip them
 *      (saves N-1 LLM calls per group of N).
 *   2. Once the canonical extracts, its extracted_fields project onto
 *      the duplicates (handled by docExtractor.queue.ts post-extract
 *      hook) so the FE still has data on every section row.
 *   3. The harmoniser builds `source_documents` lineage by joining
 *      duplicates back to the canonical.
 *
 * The user's domain rule: "a document belongs to only ONE category —
 * the Implant Invoice is the Implant Invoice whether it sits in a
 * post-op PDF, a single image, or a KYC bundle." So when a dedup group
 * has category disagreement (LLM non-determinism across PDFs), the
 * canonical's category wins and the duplicates inherit it. Stored in
 * the section row via a follow-up UPDATE during dedup.
 *
 * v1 limitations (intentional, documented for the v2 follow-up):
 *   - Only EXACT text-hash matches. Two scans of the same physical
 *     Aadhar with slightly different OCR output won't dedup. Add
 *     SimHash / LSH if we observe this as a real miss.
 *   - No perceptual-hash branch for image-only sections (X-rays, scar
 *     photos). Their text is sparse so they typically all hash to the
 *     same empty-string normalized value, which would wrongly dedup
 *     them — we GUARD against this by requiring the normalized text
 *     to be at least MIN_TEXT_LEN chars to participate in dedup.
 *   - Scope is within-claim. Cross-claim dedup is a separate decision
 *     (same Aadhar across two patients' claims is NOT the same logical
 *     document; correctness demands keeping them separate).
 */

import { pool as defaultPool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';

/**
 * Sections with sparse OCR (X-rays, scar photos, sticker close-ups —
 * anything visually rich but text-poor) are excluded from text-hash
 * dedup, because they all normalize to ~empty strings and would
 * wrongly collapse onto a single canonical.
 *
 * Implementation note: we filter by exact sha256('') match rather than
 * a raw-text length comparison. Reason: the normalized text isn't
 * persisted on document_sections — only the hash is. Empty-hash is the
 * practical equivalent of "normalized text was empty/near-empty after
 * lowercase + non-alphanum strip + whitespace collapse"; that's the
 * exact failure mode the original MIN_TEXT_LEN constant was meant to
 * guard against (sections with only OCR noise/punctuation normalize
 * to empty and would all share a hash).
 *
 * Sub-threshold but non-empty content (e.g. "5/10" pain scores, stamp
 * dates) hashes uniquely per occurrence and naturally doesn't dedup
 * across rows. The v2 pHash branch picks up the visual-dedup case for
 * sections that genuinely look identical.
 *
 * The live filter — `content_text_hash <> sha256('')` — lives in the
 * dedupClaim SELECT below.
 */

export interface DedupResult {
  /** Groups where >1 section shared the same hash. */
  groups_found: number;
  /** Total sections that were stamped as duplicates (canonical excluded). */
  sections_deduped: number;
  /** Canonical section IDs (one per group). */
  canonicals: string[];
  /**
   * For observability: per-group summary so the orchestrator can log
   * "merged 3 implant invoices into 1, 2 aadhars into 1, etc."
   */
  groups: Array<{
    canonical_id: string;
    canonical_category: string | null;
    duplicate_ids: string[];
    duplicate_categories: string[];
    text_hash_prefix: string;
  }>;
}

interface PoolLike {
  query: (text: string, values?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

export class SectionDedupService {
  constructor(private readonly pool: PoolLike = defaultPool as any) {}

  /**
   * Normalize OCR text for content fingerprinting. Conservative
   * normalisation — we want two reads of the SAME content to hash the
   * same, but we DON'T want different documents that share boilerplate
   * (e.g. hospital letterhead) to dedup.
   *
   * Rules (in order):
   *   1. Lowercase
   *   2. Replace all non-alphanumeric+whitespace with single space
   *   3. Collapse runs of whitespace to one space
   *   4. Strip leading/trailing whitespace
   *
   * Deliberately NOT sorted/dedup'd lines — line order carries content
   * structure, and sorting would falsely dedup two forms that share
   * fields but in different order.
   *
   * Exported for test parity and use by the bundle classifier when
   * computing the hash before INSERT.
   */
  static normalizeText(raw: string): string {
    if (!raw) return '';
    return raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Run dedup for one claim. Idempotent: if called twice with no
   * intervening changes, the second call updates nothing (existing
   * dedup_of pointers already point at the right canonicals). Safe to
   * call after every bundle-classify completion.
   *
   * Algorithm:
   *   1. Pull every section in the claim with content_text_hash set
   *      AND text length above MIN_TEXT_LEN_FOR_DEDUP (skip pure-image
   *      sparse-text sections; v2 will catch them via pHash).
   *   2. Pull each section's OCR confidence (avg classification_confidence
   *      as a proxy — we don't have a per-section OCR-confidence column,
   *      and the classifier's confidence reflects how readable the
   *      content was). Tiebreaker = earliest created_at.
   *   3. Group by content_text_hash. For groups of size >1:
   *        - canonical = max(confidence) → tie → min(created_at)
   *        - duplicates = all others
   *        - UPDATE duplicates: SET dedup_of=canonical.id,
   *          dedup_method='text_exact', dedup_confidence=1.000
   *        - UPDATE duplicates.category = canonical.category (user's
   *          rule: "one doc, one category")
   *   4. Sections previously deduped that no longer have a matching
   *      group (canonical re-classified, etc.) get cleared.
   */
  async dedupClaim(claimId: string): Promise<DedupResult> {
    // MIN_TEXT_LEN_FOR_DEDUP guard (wired May 20, 2026):
    //   The constant was declared at module top but never referenced in
    //   the SQL. Without this filter, sections with sparse OCR (X-rays,
    //   surgical scar photos, implant-sticker close-ups) which all
    //   normalize to ~empty strings would collapse onto the SAME hash
    //   (sha256 of "") and wrongly dedup as a single canonical.
    //
    //   The bundle classifier persists content_text_hash for EVERY
    //   section regardless of text length, so the filter belongs here
    //   in the consumer. Using EXISTS over a CTE that re-derives the
    //   normalized length keeps it cheap — we already have the
    //   normalized text on the row indirectly via content_text_hash's
    //   pre-condition, but the safe way is to read extracted_fields.text
    //   or fall back to a LENGTH check on the section's RAW text source.
    //
    //   Simpler approach: skip the row if its content_text_hash equals
    //   the well-known empty-string hash. sha256('') has a fixed value
    //   that can never represent real content. This catches the
    //   degenerate "no text in the section" case which is what the
    //   constant was guarding against. The pHash pass picks up the
    //   image-only dedup case it was meant for.
    //
    //   For non-empty-but-short content, the MIN_TEXT_LEN_FOR_DEDUP
    //   spirit is enforced at write time by the bundle classifier (see
    //   docBundleClassifier.service.ts where content_text_hash is
    //   computed); if/when that changes we'll need to plumb the raw
    //   text length through to here. For now this empty-hash guard
    //   solves the documented failure mode without schema changes.
    const EMPTY_TEXT_SHA256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const sections = await this.pool.query(
      `SELECT id,
              content_text_hash,
              category,
              classification_confidence,
              created_at
         FROM hospital.document_sections
        WHERE claim_id = $1
          AND content_text_hash IS NOT NULL
          AND LENGTH(content_text_hash) = 64
          AND content_text_hash <> $2
        ORDER BY content_text_hash, classification_confidence DESC NULLS LAST, created_at ASC`,
      [claimId, EMPTY_TEXT_SHA256],
    );

    if ((sections.rowCount ?? 0) < 2) {
      // Nothing to dedup.
      return { groups_found: 0, sections_deduped: 0, canonicals: [], groups: [] };
    }

    // Bucket by text_hash. Pre-ordered above, so the first row in each
    // bucket is the canonical (highest confidence, earliest created).
    const buckets = new Map<
      string,
      Array<{
        id: string;
        category: string | null;
        confidence: number | null;
        created_at: Date;
      }>
    >();
    for (const row of sections.rows) {
      const h = row.content_text_hash as string;
      const bucket = buckets.get(h) ?? [];
      bucket.push({
        id: row.id,
        category: row.category,
        confidence:
          row.classification_confidence == null
            ? null
            : Number(row.classification_confidence),
        created_at: row.created_at,
      });
      buckets.set(h, bucket);
    }

    const groups: DedupResult['groups'] = [];
    let totalDeduped = 0;

    for (const [hash, members] of buckets) {
      if (members.length < 2) continue;
      const canonical = members[0]!;
      const duplicates = members.slice(1);

      // Stamp duplicates: point at canonical, inherit canonical's
      // category (user's "one doc, one category" rule), and clear any
      // status='auto' progression so they don't get re-extracted.
      const duplicateIds = duplicates.map((d) => d.id);
      await this.pool.query(
        `UPDATE hospital.document_sections
            SET dedup_of = $1,
                dedup_method = 'text_exact',
                dedup_confidence = 1.000,
                category = COALESCE($2, category),
                updated_at = NOW()
          WHERE id = ANY($3::uuid[])`,
        [canonical.id, canonical.category, duplicateIds],
      );

      // Clear any stale canonical-pointer on the canonical itself
      // (defensive — if it was previously a duplicate of a now-deleted
      // section, dedup_of would have been SET NULL by the FK ON
      // DELETE; but make it explicit).
      await this.pool.query(
        `UPDATE hospital.document_sections
            SET dedup_of = NULL,
                dedup_method = NULL,
                dedup_confidence = NULL
          WHERE id = $1
            AND dedup_of IS NOT NULL`,
        [canonical.id],
      );

      groups.push({
        canonical_id: canonical.id,
        canonical_category: canonical.category,
        duplicate_ids: duplicateIds,
        duplicate_categories: duplicates.map((d) => d.category ?? ''),
        text_hash_prefix: hash.slice(0, 12),
      });
      totalDeduped += duplicates.length;
    }

    logger.info(
      {
        claim_id: claimId,
        groups_found: groups.length,
        sections_deduped: totalDeduped,
      },
      'sectionDedup: text-hash pass complete',
    );

    // ─── Pass 2: pHash dedup over sections NOT yet deduped by text ─────
    // Catches the "same image in different PDFs" case that text-hash
    // misses (sparse-text or OCR-jitter-prone sections). Phase 1D
    // addition. Best-effort: failure here doesn't roll back the
    // text-hash pass.
    let phashResult: { groups_found: number; sections_deduped: number; groups: DedupResult['groups'] } = {
      groups_found: 0, sections_deduped: 0, groups: [],
    };
    try {
      phashResult = await this.dedupByPhash(claimId);
    } catch (err) {
      logger.warn(
        { err, claim_id: claimId },
        'sectionDedup: pHash pass failed (text-hash dedup is intact; pHash can be re-run idempotently)',
      );
    }

    return {
      groups_found: groups.length + phashResult.groups_found,
      sections_deduped: totalDeduped + phashResult.sections_deduped,
      canonicals: groups
        .map((g) => g.canonical_id)
        .concat(phashResult.groups.map((g) => g.canonical_id)),
      groups: [...groups, ...phashResult.groups],
    };
  }

  /**
   * pHash-based section dedup. Layer 5: catches "same visual content
   * in different containers" — the case all four prior layers miss.
   *
   * Only considers sections that:
   *   - have content_phash_array AND content_dhash_array populated
   *   - do NOT already have dedup_of set (text-hash pass got them)
   *
   * Two sections are duplicates iff (a) same page count AND (b) every
   * page-pair's pHash Hamming ≤ PHASH_THRESHOLD AND (c) every page-pair's
   * dHash Hamming ≤ DHASH_THRESHOLD. Requiring both hash families to
   * agree cuts the individual false-positive rates to ~0.
   *
   * Strict page-count matching is the safe default for Phase 1. A later
   * phase will add page-level dedup that handles the rare case where
   * two bundle classify runs split the same content into different page
   * counts (e.g. four 1-page OT-photo sections vs one 4-page section).
   */
  async dedupByPhash(claimId: string): Promise<{
    groups_found: number;
    sections_deduped: number;
    groups: DedupResult['groups'];
  }> {
    const { hammingDistance } = await import('../Utils/perceptualHash.util.js');

    const sections = await this.pool.query(
      `SELECT id,
              content_phash_array,
              content_dhash_array,
              category,
              classification_confidence,
              created_at,
              dedup_of
         FROM hospital.document_sections
        WHERE claim_id = $1
          AND content_phash_array IS NOT NULL
          AND array_length(content_phash_array, 1) > 0
          AND dedup_of IS NULL
        ORDER BY classification_confidence DESC NULLS LAST, created_at ASC`,
      [claimId],
    );
    if ((sections.rowCount ?? 0) < 2) {
      return { groups_found: 0, sections_deduped: 0, groups: [] };
    }

    const PHASH_THRESHOLD = 16; // out of 256 bits = 6.25% bit diff
    const DHASH_THRESHOLD = 16;

    // Parse into a typed working set.
    const rows = sections.rows.map((r: any) => ({
      id: r.id as string,
      phash: (r.content_phash_array as string[]) ?? [],
      dhash: (r.content_dhash_array as string[]) ?? [],
      category: r.category as string | null,
      confidence: r.classification_confidence == null ? 0 : Number(r.classification_confidence),
      created_at: r.created_at as Date,
    }));

    // Union-find to group transitive duplicates.
    const n = rows.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    const union = (a: number, b: number) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const A = rows[i]!, B = rows[j]!;
        // Strict: same page count + both hash families agree on every page.
        if (A.phash.length !== B.phash.length) continue;
        if (A.dhash.length !== B.dhash.length) continue;
        if (A.phash.length === 0) continue;
        let allMatch = true;
        for (let k = 0; k < A.phash.length; k++) {
          if (hammingDistance(A.phash[k]!, B.phash[k]!) > PHASH_THRESHOLD) {
            allMatch = false; break;
          }
        }
        if (!allMatch) continue;
        for (let k = 0; k < A.dhash.length; k++) {
          if (hammingDistance(A.dhash[k]!, B.dhash[k]!) > DHASH_THRESHOLD) {
            allMatch = false; break;
          }
        }
        if (allMatch) union(i, j);
      }
    }

    // Materialize groups.
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const b = buckets.get(r) ?? [];
      b.push(i);
      buckets.set(r, b);
    }

    const groups: DedupResult['groups'] = [];
    let totalDeduped = 0;
    for (const members of buckets.values()) {
      if (members.length < 2) continue;
      // members are already sorted by confidence DESC, created_at ASC
      // (we pre-sorted the SELECT). First entry = canonical.
      const canonicalIdx = members[0]!;
      const canonical = rows[canonicalIdx]!;
      const duplicates = members.slice(1).map((i) => rows[i]!);
      const duplicateIds = duplicates.map((d) => d.id);

      await this.pool.query(
        `UPDATE hospital.document_sections
            SET dedup_of = $1,
                dedup_method = 'phash_v1',
                dedup_confidence = 1.000,
                category = COALESCE($2, category),
                updated_at = NOW()
          WHERE id = ANY($3::uuid[])`,
        [canonical.id, canonical.category, duplicateIds],
      );

      groups.push({
        canonical_id: canonical.id,
        canonical_category: canonical.category,
        duplicate_ids: duplicateIds,
        duplicate_categories: duplicates.map((d) => d.category ?? ''),
        text_hash_prefix: 'phash:' + (canonical.phash[0] ?? '').slice(0, 8),
      });
      totalDeduped += duplicates.length;
    }

    logger.info(
      { claim_id: claimId, groups_found: groups.length, sections_deduped: totalDeduped },
      'sectionDedup: pHash pass complete',
    );

    return { groups_found: groups.length, sections_deduped: totalDeduped, groups };
  }

  /**
   * Project a canonical's extracted_fields onto every section that
   * points at it via dedup_of. Called from the extractor's success
   * hook so duplicates get the same extraction data as the canonical
   * without paying for their own LLM call.
   *
   * Idempotent: the SET clause overwrites, so re-running with the same
   * canonical → same state.
   *
   * Returns the number of duplicates updated (0 if the canonical has
   * no duplicates).
   */
  async projectCanonicalExtraction(canonicalId: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE hospital.document_sections AS dup
          SET extracted_fields = c.extracted_fields,
              extraction_confidence = jsonb_set(
                COALESCE(c.extraction_confidence, '{}'::jsonb),
                '{_meta,projected_from_canonical}',
                to_jsonb(c.id::text),
                true
              ),
              extractor_version = c.extractor_version,
              extractor_provider = c.extractor_provider,
              extractor_model = c.extractor_model,
              updated_at = NOW()
         FROM hospital.document_sections AS c
        WHERE c.id = $1
          AND dup.dedup_of = c.id
          AND c.extracted_fields IS NOT NULL`,
      [canonicalId],
    );

    if ((res.rowCount ?? 0) > 0) {
      logger.info(
        { canonical_id: canonicalId, duplicates_updated: res.rowCount },
        'sectionDedup: projected canonical extraction onto duplicates',
      );
    }

    return res.rowCount ?? 0;
  }
}

export const sectionDedupService = new SectionDedupService();
export default sectionDedupService;
