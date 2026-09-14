/**
 * Stamp `stage` + `stage_source` onto a document's sections.
 *
 * THE ONE PLACE resolveSectionStage IS CALLED IN PRODUCTION.
 *
 * Before this existed, docBundleClassifier and docSegmenter each ran their own
 * blanket UPDATE:
 *
 *     UPDATE document_sections SET stage = <claim's current stage>
 *      WHERE document_id = $1 AND status = 'auto'
 *
 * which is the WEAKEST tier of the precedence documentStageAffinity declares
 * (reviewer > declared > affinity > claim_stage), applied uniformly to every
 * section regardless of what the section actually is. It also silently did
 * nothing, because ipds.stage was NULL on 471 of 475 rows.
 *
 * Resolution is per CATEGORY, not per section: affinity is a property of the
 * document category, so N sections sharing a category resolve identically.
 * Deduplicating first turns a 40-section bundle into a handful of lookups.
 *
 * BEST-EFFORT, ALWAYS. Section persistence is the caller's real work; a stage
 * stamp is metadata on top of it. Every failure path here logs and returns
 * rather than throwing, exactly as the two blanket stamps it replaces did — a
 * claim whose sections exist with a NULL stage is recoverable, one whose
 * sections were rolled back because a lookup failed is not.
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import documentStageAffinityService from '../documentStageAffinity.service.js';
import claimStagesService from '../claimStages.service.js';
import { logger } from '../../Utils/logger.js';

/**
 * Structural, not `Pool | PoolClient`. The two call sites hand in different
 * things — the classifier a checked-out client mid-transaction, the segmenter
 * its own narrowed pool type — and this helper only ever calls `.query`.
 * Naming the one method it needs lets both pass without a cast.
 */
type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
};

// Referenced so the pg types stay imported for readers looking for the
// concrete shapes this is compatible with.
export type StampTarget = Pool | PoolClient;

/**
 * The two reference-data lookups, injected.
 *
 * They are NOT taken from `db` on purpose. The classifier calls this with a
 * client checked out mid-transaction, and document_stage_affinity /
 * claim_stages are configuration, not part of that transaction — reading them
 * on the pool is correct and avoids holding the client longer. Naming them
 * here makes that deliberate rather than an accident of which singleton
 * happened to be imported, and lets the tests run without a database.
 */
export interface StampDeps {
  resolveSectionStage: typeof documentStageAffinityService.resolveSectionStage;
  stageOrder: () => Promise<Map<string, number>>;
}

const defaultDeps: StampDeps = {
  resolveSectionStage: (input) => documentStageAffinityService.resolveSectionStage(input),
  stageOrder: () => claimStagesService.stageOrder(),
};

export interface StampResult {
  /** Sections whose stage was written (0 when nothing resolved). */
  stamped: number;
  /** Distinct categories resolved — the number of affinity lookups made.
   *  A category-less bucket counts as one. */
  categories: number;
}

/**
 * @param documentId  only this document's `status='auto'` sections are touched,
 *                    which spares rows a human has already corrected.
 */
export async function stampSectionStages(
  db: Queryable,
  documentId: string,
  claimId: string,
  deps: StampDeps = defaultDeps,
): Promise<StampResult> {
  const empty: StampResult = { stamped: 0, categories: 0 };

  try {
    const { rows: sections } = await db.query<{ id: string; category: string | null }>(
      `SELECT id, category
         FROM hospital.document_sections
        WHERE document_id = $1 AND status = 'auto'`,
      [documentId],
    );
    if (sections.length === 0) return empty;

    // The three inputs that are the same for every section on this document.
    const { rows: ctx } = await db.query<{
      claim_stage: string | null;
      declared_stage: string | null;
      admitted_at: string | null;
      discharged_at: string | null;
    }>(
      `SELECT i.stage         AS claim_stage,
              d.declared_stage AS declared_stage,
              i.admitted_at,
              i.discharged_at
         FROM hospital.ipd_doc d
         JOIN hospital.ipds i ON i.id = d.ipd_id
        WHERE d.id = $1`,
      [documentId],
    );
    const claimStage = ctx[0]?.claim_stage ?? null;
    const declaredStage = ctx[0]?.declared_stage ?? null;
    const admissionDate = ctx[0]?.admitted_at ?? null;
    const dischargeDate = ctx[0]?.discharged_at ?? null;

    // Lifecycle positions, fetched once — resolveSectionStage compares a
    // stage_floor against them and would otherwise re-query per section.
    const stageOrder = await deps.stageOrder();

    // A null category is its own bucket, not a row to skip. The segmenter
    // inserts sections before classification runs, so on that path EVERY
    // section is category-less — and an uploader who said "this file is for
    // pre-auth" has still said something true about those sections. Affinity
    // simply finds nothing and the precedence falls through to declared, then
    // claim stage. The classifier re-stamps the same rows once categories
    // exist, which is when affinity can finally apply.
    const categories = [...new Set(sections.map((s) => s.category ?? null))];

    let stamped = 0;
    for (const category of categories) {
      const resolved = await deps.resolveSectionStage({
        // '' matches no affinity row, which is exactly the "unmapped category"
        // default: no floor, not evergreen, the human's choice stands.
        docCategory: category ?? '',
        declaredStage,
        // A reviewer's correction is applied through the review queue, which
        // writes stage_source='reviewer' directly and is excluded here by the
        // status='auto' filter. There is no reviewer tier to read at stamp time.
        reviewerStage: null,
        claimStage,
        documentDate: null,
        admissionDate,
        dischargeDate,
        stageOrder,
      });

      // An evergreen category resolves to stage NULL on purpose — it is
      // evidence at every stage, so pinning it to one would imply a scope it
      // does not have. Record the source anyway, so a NULL stage that was
      // DECIDED is distinguishable from one that was never looked at.
      // IS NOT DISTINCT FROM, not `=`: `category = NULL` is never true, so a
      // plain equality would silently stamp zero of the segmenter's rows.
      const { rowCount } = await db.query(
        `UPDATE hospital.document_sections
            SET stage = $1, stage_source = $2
          WHERE document_id = $3 AND status = 'auto'
            AND category IS NOT DISTINCT FROM $4`,
        [resolved.stage, resolved.stage_source, documentId, category],
      );
      stamped += rowCount ?? 0;

      if (resolved.floor_violation) {
        logger.warn(
          { documentId, category, ...resolved.floor_violation },
          'stampSectionStages: declared stage is impossible for this category; floor applied',
        );
      }
      if (resolved.disputed) {
        logger.warn(
          { documentId, category, disputed: resolved.disputed },
          'stampSectionStages: stage disputed by document dates (flagged, not overridden)',
        );
      }
    }

    return { stamped, categories: categories.length };
  } catch (err) {
    logger.warn(
      { err, documentId, claimId },
      'stampSectionStages: failed (non-fatal; section stage stays NULL)',
    );
    return empty;
  }
}

export default stampSectionStages;
