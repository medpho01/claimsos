/**
 * harmonisedEpisode schema — coded-concept coercion.
 *
 * Regression cover for the 2026-09-14 production failure on claim
 * e54c89c0 (Shrikantha Rao), where a real harmonisation run died with:
 *
 *   invalid_type at clinical_timeline[2].procedures_performed[0].procedure_code
 *   expected object, received string
 *
 * The model had written `"procedure_code": "<code>"`. Because claudeClient has
 * no repair path, that single leaf discarded the entire episode — and the
 * HarmonisedEpisodePartial fallback could not rescue it either, since it
 * embeds the SAME clinical_timeline subtree. Both paths are asserted here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HarmonisedEpisodeSchema,
  HarmonisedEpisodePartial,
} from '../harmonisedEpisode.js';

function episode(procedureCode: unknown) {
  return {
    meta: {
      schema_version: 'claimsos.canonical.medical_episode.v2',
      episode_id: 'E1',
      episode_type: 'IPD',
      created_at: '2026-09-13T00:00:00+05:30',
    },
    patient_context: { patient_id: 'P1', first_name: 'Shrikantha' },
    hospital_context: { hospital_id: 'H1', name: 'Test Hospital' },
    clinical_timeline: [
      {
        phase_code: 'INTRA_OPERATIVE',
        phase_number: 1,
        phase_name: 'Surgery',
        location: 'OT',
        procedures_performed: [
          { procedure_name: 'MICS', procedure_code: procedureCode },
        ],
      },
    ],
    diagnosis: {},
  };
}

function procedureCodeOf(parsed: any) {
  return parsed.clinical_timeline[0].procedures_performed[0].procedure_code;
}

describe('harmonisedEpisode — procedure_code coercion', () => {
  it('lifts a bare code STRING into {code} (the production failure)', () => {
    const parsed = HarmonisedEpisodeSchema.parse(episode('MICS-2661'));
    assert.deepEqual(procedureCodeOf(parsed), { code: 'MICS-2661' });
  });

  it('still accepts the full {system, code, display} object', () => {
    const full = { system: 'CPT', code: '66984', display: 'Cataract surgery' };
    const parsed = HarmonisedEpisodeSchema.parse(episode(full));
    assert.deepEqual(procedureCodeOf(parsed), full);
  });

  it('trims surrounding whitespace on the string form', () => {
    const parsed = HarmonisedEpisodeSchema.parse(episode('  66984  '));
    assert.deepEqual(procedureCodeOf(parsed), { code: '66984' });
  });

  it('degrades an EMPTY string to {} rather than {code: ""}', () => {
    // Downstream `if (code)` checks must keep telling "absent" apart from
    // "present but empty".
    const parsed = HarmonisedEpisodeSchema.parse(episode('   '));
    assert.deepEqual(procedureCodeOf(parsed), {});
  });

  it('accepts the string form through HarmonisedEpisodePartial too', () => {
    // The partial fallback embeds the same clinical_timeline, so before the
    // fix it failed on exactly the same leaf — leaving no path to a result.
    const parsed: any = HarmonisedEpisodePartial.parse(episode('MICS-2661'));
    assert.deepEqual(procedureCodeOf(parsed), { code: 'MICS-2661' });
  });

  it('still REJECTS a structurally wrong coded concept', () => {
    // The coercion must not turn the schema into a rubber stamp: a number is
    // neither a code string nor a coded object.
    assert.throws(() => HarmonisedEpisodeSchema.parse(episode(66984)));
  });

  it('leaves an omitted procedure_code absent', () => {
    const ep: any = episode(undefined);
    delete ep.clinical_timeline[0].procedures_performed[0].procedure_code;
    const parsed = HarmonisedEpisodeSchema.parse(ep);
    assert.equal(procedureCodeOf(parsed), undefined);
  });
});
