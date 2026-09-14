/**
 * Document → stage mapping, and the stage-resolution policy built on it.
 *
 * Backs the superadmin Document Mapping screen, and owns `resolveSectionStage`
 * — the function that decides which stage a document section is evidence for.
 *
 * THE PRECEDENCE, AND WHY IT IS THIS WAY
 *
 *   reviewer  >  declared (upload dropdown)  >  affinity  >  claim stage
 *
 * ADJUDICATION_ARCHITECTURE §5.3 rule 1 states "explicit human assignment
 * always wins", so a category's affinity must NOT outrank what a person chose.
 * The one exception is `stage_floor`, and it is not really an exception: a
 * floor only ever says "that is physically impossible" (a final bill before
 * discharge), never "I think you meant something else". Rejecting the
 * impossible is compatible with trusting the human; overriding the merely
 * unlikely is not.
 *
 * Date evidence is deliberately NOT an override. A document date that
 * contradicts the chosen stage raises `disputed` for a person to look at.
 * Silently re-tagging on a date the extractor may have misread would move a
 * document into a different rule pack with nothing reporting it — and this
 * pipeline has already shipped one extractor that read `9993` as `9593`.
 */

import { pool as defaultPool } from '../DB/db.js';
import type { Pool } from 'pg';

export interface DocumentStageAffinity {
  doc_category: string;
  is_evergreen: boolean;
  stage_floor: string | null;
  affinity_stage: string | null;
  required_when: string | null;
  notes: string | null;
}

/** A doc_category joined to its mapping — the Document Mapping screen's row. */
export interface MappingRow extends DocumentStageAffinity {
  label: string;
  group_code: string | null;
  has_mapping: boolean;
}

export type StageSource = 'reviewer' | 'declared' | 'affinity' | 'claim_stage' | 'none';

export interface ResolvedStage {
  stage: string | null;
  stage_source: StageSource;
  /** True when the chosen stage is evergreen — it counts at every stage. */
  evergreen: boolean;
  /** Set when a human's choice was rejected as physically impossible. */
  floor_violation?: { declared: string; floor: string };
  /** Set when something disagrees but not hard enough to override. */
  disputed?: string;
}

class DocumentStageAffinityService {
  constructor(private readonly pool: Pool = defaultPool as Pool) {}

  /**
   * Every doc_category with its mapping, whether or not one exists.
   *
   * LEFT JOIN deliberately: ~215 of the 246 categories correctly have no row,
   * and the screen must show them as unmapped rather than hide them. An
   * unmapped category is the safe default — no floor, not evergreen, the
   * human's choice stands unconditionally.
   */
  async listMappings(groupCode?: string): Promise<MappingRow[]> {
    const params: unknown[] = [];
    let where = "m.category = 'doc_category'";
    if (groupCode) {
      params.push(groupCode);
      where += ` AND m.group_code = $${params.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT m.code                       AS doc_category,
              m.label                      AS label,
              m.group_code                 AS group_code,
              COALESCE(a.is_evergreen, FALSE) AS is_evergreen,
              a.stage_floor,
              a.affinity_stage,
              a.required_when,
              a.notes,
              (a.doc_category IS NOT NULL) AS has_mapping
         FROM hospital.master_options m
         LEFT JOIN hospital.document_stage_affinity a ON a.doc_category = m.code
        WHERE ${where}
        ORDER BY m.group_code NULLS LAST, m.sort_order, m.code`,
      params,
    );
    return rows as MappingRow[];
  }

  async get(docCategory: string): Promise<DocumentStageAffinity | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM hospital.document_stage_affinity WHERE doc_category = $1',
      [docCategory],
    );
    return (rows[0] as DocumentStageAffinity) ?? null;
  }

  /**
   * Create or update one category's mapping.
   *
   * Validates against the live registries rather than a hard-coded list — the
   * stage taxonomy is superadmin-editable now, so anything compiled in would
   * drift the moment someone adds a stage.
   */
  async upsert(
    docCategory: string,
    patch: Partial<Omit<DocumentStageAffinity, 'doc_category'>>,
    updatedBy?: string,
  ): Promise<DocumentStageAffinity> {
    const known = await this.pool.query(
      "SELECT 1 FROM hospital.master_options WHERE category='doc_category' AND code=$1",
      [docCategory],
    );
    if (!known.rowCount) throw new Error(`unknown doc_category: ${docCategory}`);

    for (const field of ['stage_floor', 'affinity_stage'] as const) {
      const value = patch[field];
      if (value) {
        const ok = await this.pool.query(
          'SELECT 1 FROM hospital.claim_stages WHERE code = $1',
          [value],
        );
        if (!ok.rowCount) throw new Error(`unknown stage code for ${field}: ${value}`);
      }
    }

    // "Counts at every stage" and "cannot exist before stage X" cannot both be
    // true. Caught here as well as in the seed, because the screen is the path
    // most likely to produce it.
    const merged = { ...(await this.get(docCategory)), ...patch };
    if (merged.is_evergreen && merged.stage_floor) {
      throw new Error('a category cannot be both evergreen and floored');
    }

    const { rows } = await this.pool.query(
      `INSERT INTO hospital.document_stage_affinity
         (doc_category, is_evergreen, stage_floor, affinity_stage, required_when, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (doc_category) DO UPDATE SET
         is_evergreen   = EXCLUDED.is_evergreen,
         stage_floor    = EXCLUDED.stage_floor,
         affinity_stage = EXCLUDED.affinity_stage,
         required_when  = EXCLUDED.required_when,
         notes          = EXCLUDED.notes,
         updated_by     = EXCLUDED.updated_by
       RETURNING *`,
      [
        docCategory,
        merged.is_evergreen ?? false,
        merged.stage_floor ?? null,
        merged.affinity_stage ?? null,
        merged.required_when ?? null,
        merged.notes ?? null,
        updatedBy ?? null,
      ],
    );
    return rows[0] as DocumentStageAffinity;
  }

  /** Set the evergreen flag across a whole doc_category_group. */
  async bulkSetEvergreen(groupCode: string, isEvergreen: boolean, updatedBy?: string): Promise<number> {
    if (isEvergreen) {
      // Refuse rather than silently clear a floor — the two are contradictory
      // and the operator should see which categories conflict.
      const { rows } = await this.pool.query(
        `SELECT a.doc_category FROM hospital.document_stage_affinity a
           JOIN hospital.master_options m
             ON m.category='doc_category' AND m.code=a.doc_category
          WHERE m.group_code = $1 AND a.stage_floor IS NOT NULL`,
        [groupCode],
      );
      if (rows.length) {
        throw new Error(
          `these categories have a stage floor and cannot be evergreen: ${rows
            .map((r: any) => r.doc_category)
            .join(', ')}`,
        );
      }
    }

    const { rowCount } = await this.pool.query(
      `INSERT INTO hospital.document_stage_affinity (doc_category, is_evergreen, updated_by)
       SELECT m.code, $2, $3 FROM hospital.master_options m
        WHERE m.category='doc_category' AND m.group_code = $1
       ON CONFLICT (doc_category) DO UPDATE SET
         is_evergreen = EXCLUDED.is_evergreen,
         updated_by   = EXCLUDED.updated_by`,
      [groupCode, isEvergreen, updatedBy ?? null],
    );
    return rowCount ?? 0;
  }

  /** doc_category_group list, for the screen's filter and bulk actions. */
  async listGroups(): Promise<Array<{ group_code: string; label: string; count: number }>> {
    const { rows } = await this.pool.query(
      `SELECT m.group_code,
              COALESCE(g.label, m.group_code) AS label,
              count(*)::int AS count
         FROM hospital.master_options m
         LEFT JOIN hospital.master_options g
                ON g.category='doc_category_group' AND g.code = m.group_code
        WHERE m.category='doc_category' AND m.group_code IS NOT NULL
        GROUP BY m.group_code, g.label
        ORDER BY m.group_code`,
    );
    return rows as Array<{ group_code: string; label: string; count: number }>;
  }

  /**
   * Decide which stage a section is evidence for.
   *
   * `stageOrder` maps a stage code to its lifecycle position so a floor can be
   * compared. Passed in rather than queried so callers batching many sections
   * fetch the lifecycle once.
   */
  async resolveSectionStage(input: {
    docCategory: string;
    declaredStage?: string | null;
    reviewerStage?: string | null;
    claimStage?: string | null;
    documentDate?: string | null;
    admissionDate?: string | null;
    dischargeDate?: string | null;
    stageOrder: Map<string, number>;
  }): Promise<ResolvedStage> {
    const affinity = await this.get(input.docCategory);
    const evergreen = affinity?.is_evergreen ?? false;

    // An evergreen document is evidence everywhere, so a stage on it carries no
    // meaning and resolving one would imply a scope it does not have.
    if (evergreen) {
      return { stage: null, stage_source: 'none', evergreen: true };
    }

    const floor = affinity?.stage_floor ?? null;
    const floorPos = floor ? input.stageOrder.get(floor) : undefined;
    const belowFloor = (stage: string | null | undefined): boolean => {
      if (!stage || floorPos === undefined) return false;
      const pos = input.stageOrder.get(stage);
      return pos !== undefined && pos < floorPos;
    };

    // 1. A reviewer's correction is final and is never floor-checked: a human
    //    looking at the document outranks our model of what is possible.
    if (input.reviewerStage) {
      return { stage: input.reviewerStage, stage_source: 'reviewer', evergreen: false };
    }

    // 2. The uploader's declared stage, unless physically impossible.
    if (input.declaredStage) {
      if (belowFloor(input.declaredStage)) {
        return {
          stage: floor,
          stage_source: 'affinity',
          evergreen: false,
          floor_violation: { declared: input.declaredStage, floor: floor! },
        };
      }
      return {
        stage: input.declaredStage,
        stage_source: 'declared',
        evergreen: false,
        ...this.dateDispute(input, input.declaredStage),
      };
    }

    // 3. Category affinity — the hint for inbound documents nobody tagged.
    if (affinity?.affinity_stage) {
      return { stage: affinity.affinity_stage, stage_source: 'affinity', evergreen: false };
    }

    // 4. The claim's current stage. Last because it is the weakest signal:
    //    documents arrive in bursts over 7-10 days and the claim moves on
    //    between them, so arrival time is a poor proxy for evidence stage.
    if (input.claimStage && !belowFloor(input.claimStage)) {
      return { stage: input.claimStage, stage_source: 'claim_stage', evergreen: false };
    }

    return { stage: floor, stage_source: floor ? 'affinity' : 'none', evergreen: false };
  }

  /**
   * Flag, never override. A bill dated after discharge but tagged pre-auth is
   * worth a human's attention; silently re-tagging it on a possibly-misread
   * date is not.
   */
  private dateDispute(
    input: { documentDate?: string | null; dischargeDate?: string | null },
    declared: string,
  ): { disputed?: string } {
    if (!input.documentDate || !input.dischargeDate) return {};
    if (declared !== 'PREAUTH') return {};
    if (new Date(input.documentDate) > new Date(input.dischargeDate)) {
      return {
        disputed: `document is dated ${input.documentDate}, after discharge on ${input.dischargeDate}, but was tagged pre-auth`,
      };
    }
    return {};
  }
}

export default new DocumentStageAffinityService();
export { DocumentStageAffinityService };
