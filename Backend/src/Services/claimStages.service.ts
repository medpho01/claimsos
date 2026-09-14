/**
 * Claim stages — the configurable claim lifecycle taxonomy.
 *
 * Backs the superadmin Claim Stages screen. The table (migration 077) is the
 * registry that the upload dropdown, the rule-pack `applicable_stages`
 * dimension and `insurer_document_requirements.stage` all reference.
 *
 * TWO RULES RUN THROUGH THIS WHOLE FILE
 *
 * 1. `code` is immutable and rows are never deleted. A stage code is a foreign
 *    key by convention across `ipds.stage`, `claim_context.stage`,
 *    `document_sections.stage` and the `insurer_rule_sets.applicable_stages`
 *    TEXT[] — none of which have a real FK (deliberately, per 067). Nothing in
 *    the database would stop a rename or a delete, and nothing would report the
 *    damage either: rule packs would simply stop matching, silently, and claims
 *    would stop being evaluated. So retirement is a flag, and creation is the
 *    only way to add a code.
 *
 * 2. Destructive-looking edits are previewed, never guessed. `retire()` reports
 *    what references the stage BEFORE flipping the flag.
 */

import { pool as defaultPool } from '../DB/db.js';
import type { Pool } from 'pg';

export interface ClaimStage {
  code: string;
  label: string;
  definition: string;
  entry_trigger: string | null;
  exit_trigger: string | null;
  expected_tat: string | null;
  sort_order: number;
  cycle_types: string[];
  legacy_codes: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Fields a superadmin may change on an existing stage. Note the absence of
 *  `code` and `legacy_codes` — see the header. */
export interface ClaimStagePatch {
  label?: string;
  definition?: string;
  entry_trigger?: string | null;
  exit_trigger?: string | null;
  expected_tat?: string | null;
  cycle_types?: string[];
}

export interface StageUsage {
  claims: number;
  rule_sets: number;
  document_requirements: number;
  document_sections: number;
}

const VALID_CYCLE_TYPES = new Set(['initial', 'query_response']);
const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

class ClaimStagesService {
  constructor(private readonly pool: Pool = defaultPool as Pool) {}

  /** All stages in lifecycle order. `includeRetired` defaults to false because
   *  the dropdown must never offer a retired stage. */
  async list(includeRetired = false): Promise<ClaimStage[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM hospital.claim_stages
        ${includeRetired ? '' : 'WHERE is_active'}
        ORDER BY sort_order`,
    );
    return rows as ClaimStage[];
  }

  async get(code: string): Promise<ClaimStage | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM hospital.claim_stages WHERE code = $1',
      [code],
    );
    return (rows[0] as ClaimStage) ?? null;
  }

  /**
   * Count what references a stage code.
   *
   * Used to (a) show a superadmin the blast radius before they retire a stage
   * and (b) decide whether a code is still editable. Counts BOTH the new code
   * and any legacy codes it absorbs, because until the cutover migration runs,
   * live claims still carry the migration-024 spellings — a naive count on the
   * new code alone would report zero and make a in-use stage look retirable.
   */
  async usage(code: string): Promise<StageUsage> {
    const stage = await this.get(code);
    const codes = [code, ...(stage?.legacy_codes ?? [])];

    const q = async (sql: string, params: unknown[] = [codes]) => {
      try {
        const { rows } = await this.pool.query(sql, params);
        return Number(rows[0]?.n ?? 0);
      } catch {
        // A table that does not exist yet in this environment must not break
        // the whole usage report — an under-count is visible in the UI, a
        // 500 is not actionable.
        return 0;
      }
    };

    return {
      claims: await q('SELECT count(*)::int n FROM hospital.ipds WHERE stage = ANY($1)'),
      rule_sets: await q(
        'SELECT count(*)::int n FROM hospital.insurer_rule_sets WHERE applicable_stages && $1',
      ),
      document_requirements: await q(
        'SELECT count(*)::int n FROM hospital.insurer_document_requirements WHERE stage = ANY($1)',
      ),
      document_sections: await q(
        'SELECT count(*)::int n FROM hospital.document_sections WHERE stage = ANY($1)',
      ),
    };
  }

  private validateCycleTypes(cycleTypes: string[]): void {
    const bad = cycleTypes.filter((c) => !VALID_CYCLE_TYPES.has(c));
    if (bad.length) {
      throw new Error(
        `invalid cycle_types: ${bad.join(', ')} (allowed: ${[...VALID_CYCLE_TYPES].join(', ')})`,
      );
    }
    if (!cycleTypes.includes('initial')) {
      // Every stage has a first submission. A stage with only 'query_response'
      // could never be entered, and its document requirements would be
      // unreachable — a silent dead end rather than a visible error.
      throw new Error("cycle_types must include 'initial'");
    }
  }

  async create(input: {
    code: string;
    label: string;
    definition: string;
    entry_trigger?: string | null;
    exit_trigger?: string | null;
    expected_tat?: string | null;
    sort_order: number;
    cycle_types?: string[];
  }): Promise<ClaimStage> {
    if (!CODE_RE.test(input.code)) {
      throw new Error(
        'code must be SCREAMING_SNAKE_CASE, 3-64 chars, starting with a letter',
      );
    }
    const cycleTypes = input.cycle_types?.length ? input.cycle_types : ['initial'];
    this.validateCycleTypes(cycleTypes);

    const { rows } = await this.pool.query(
      `INSERT INTO hospital.claim_stages
         (code, label, definition, entry_trigger, exit_trigger, expected_tat,
          sort_order, cycle_types)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        input.code,
        input.label,
        input.definition,
        input.entry_trigger ?? null,
        input.exit_trigger ?? null,
        input.expected_tat ?? null,
        input.sort_order,
        cycleTypes,
      ],
    );
    return rows[0] as ClaimStage;
  }

  /** Patch the editable fields. `code`, `sort_order` and `legacy_codes` are
   *  handled by dedicated paths so each can carry its own guard. */
  async update(code: string, patch: ClaimStagePatch): Promise<ClaimStage | null> {
    if (patch.cycle_types) this.validateCycleTypes(patch.cycle_types);

    const sets: string[] = [];
    const params: unknown[] = [code];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) return this.get(code);

    const { rows } = await this.pool.query(
      `UPDATE hospital.claim_stages SET ${sets.join(', ')}
        WHERE code = $1 RETURNING *`,
      params,
    );
    return (rows[0] as ClaimStage) ?? null;
  }

  /**
   * Reorder the lifecycle.
   *
   * `sort_order` carries a UNIQUE index, and reordering inevitably collides
   * mid-update, so this runs in one transaction and parks every row in a
   * negative band first. Negative because the band has to be one no real row
   * can occupy — otherwise a partially-applied reorder could still collide.
   */
  async reorder(orderedCodes: string[]): Promise<ClaimStage[]> {
    const client = await (this.pool as any).connect();
    try {
      await client.query('BEGIN');

      const { rows: existing } = await client.query(
        'SELECT code FROM hospital.claim_stages',
      );
      const known = new Set(existing.map((r: any) => r.code));
      const missing = [...known].filter((c) => !orderedCodes.includes(c as string));
      if (missing.length) {
        // A partial list would leave the omitted stages parked in the negative
        // band, i.e. ordered before everything and invisible in the UI.
        throw new Error(`reorder must include every stage; missing: ${missing.join(', ')}`);
      }
      const unknown = orderedCodes.filter((c) => !known.has(c));
      if (unknown.length) {
        throw new Error(`unknown stage code(s): ${unknown.join(', ')}`);
      }

      for (let i = 0; i < orderedCodes.length; i += 1) {
        await client.query(
          'UPDATE hospital.claim_stages SET sort_order = $1 WHERE code = $2',
          [-(i + 1), orderedCodes[i]],
        );
      }
      for (let i = 0; i < orderedCodes.length; i += 1) {
        await client.query(
          'UPDATE hospital.claim_stages SET sort_order = $1 WHERE code = $2',
          [(i + 1) * 10, orderedCodes[i]],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return this.list(true);
  }

  /**
   * Retire or reinstate a stage. Never deletes.
   *
   * Retiring is allowed even when the stage is in use — an operator may need to
   * stop OFFERING a stage while historical claims still sit in it — but the
   * caller gets the usage counts back so the UI can say exactly what is
   * affected rather than asking for blind confirmation.
   */
  async setActive(code: string, isActive: boolean): Promise<{ stage: ClaimStage | null; usage: StageUsage }> {
    const usage = await this.usage(code);
    const { rows } = await this.pool.query(
      'UPDATE hospital.claim_stages SET is_active = $2 WHERE code = $1 RETURNING *',
      [code, isActive],
    );
    return { stage: (rows[0] as ClaimStage) ?? null, usage };
  }

  /**
   * The stages an uploader may pick, given the claim's current stage.
   *
   * Past stages are free — back-filling a document someone forgot is routine
   * over a 7-10 day burst. The NEXT stage is offered but marked `confirm`,
   * because hospitals genuinely do prepare ahead. Anything further out is
   * withheld: a clerk who can reach it will eventually pick it by accident,
   * and a mis-tagged document routes to the wrong rule pack silently.
   */
  async uploadOptions(currentStageCode: string | null): Promise<
    Array<{ code: string; label: string; definition: string; relation: 'past' | 'current' | 'next'; confirm: boolean }>
  > {
    const stages = await this.list(false);
    const currentIdx = currentStageCode
      ? stages.findIndex(
          (s) => s.code === currentStageCode || s.legacy_codes.includes(currentStageCode),
        )
      : -1;

    // Unknown or unset current stage: offer only the first stage rather than
    // the whole lifecycle. Guessing wide here is how everything ends up tagged
    // with whatever sits at the top of the list.
    const anchor = currentIdx === -1 ? 0 : currentIdx;

    return stages.slice(0, anchor + 2).map((s, i) => ({
      code: s.code,
      label: s.label,
      definition: s.definition,
      relation: i < anchor ? 'past' : i === anchor ? 'current' : 'next',
      confirm: i > anchor,
    }));
  }
}

export default new ClaimStagesService();
export { ClaimStagesService };
