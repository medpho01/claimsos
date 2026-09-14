/**
 * Slot promotion must never assert a DIFFERENT person's identifier as the
 * patient's.
 *
 * Production claim e54c89c0 (2026-09-14): after the identity gate correctly
 * flagged the patient's wife's Aadhaar card as foreign, the episode STILL
 * promoted her Aadhaar number into
 * patient_context.identification.aadhaar_number — because
 * CANONICAL_SLOT_PROMOTIONS lists `aadhaar_card` ahead of `aadhaar_front`.
 *
 * Flagging a document as foreign while simultaneously publishing its ID as
 * the patient's is worse than not flagging it: the flag lives in
 * validation_metadata, the wrong number lives in the field an insurer reads.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stitchSupportingDocuments } from '../harmonisation.service.js';

const PATIENT_SECTION = 'sec-front-patient';
const SPOUSE_SECTION = 'sec-card-spouse';

function sections(): any[] {
  return [
    {
      section_id: PATIENT_SECTION,
      category: 'aadhaar_front',
      document_id: 'doc-1',
      extracted_fields: { full_name: 'K Srikanth Rao', gender: 'M', aadhaar_number: '334603247720' },
    },
    {
      section_id: SPOUSE_SECTION,
      category: 'aadhaar_card',
      document_id: 'doc-2',
      extracted_fields: {
        holder_name: 'Kala Srikanth',
        gender: 'female',
        aadhaar_number: '878773290597',
        pin_code: '560020',
      },
    },
  ];
}

describe('slot promotion — hard-identifier conflicts', () => {
  it('promotes the SPOUSE aadhaar when nothing is excluded (the bug)', () => {
    // Pins the ordering that caused it: aadhaar_card outranks aadhaar_front.
    const episode: any = {};
    stitchSupportingDocuments(episode, sections());
    assert.equal(
      episode.patient_context.identification.aadhaar_number,
      '878773290597',
      'expected the pre-fix behaviour to be reproduced by this fixture',
    );
  });

  it('falls back to the PATIENT aadhaar when the spouse section is barred', () => {
    const episode: any = {};
    stitchSupportingDocuments(episode, sections(), new Set([SPOUSE_SECTION]));
    assert.equal(
      episode.patient_context.identification.aadhaar_number,
      '334603247720',
      "the patient's own aadhaar_front must win once the conflicting card is barred",
    );
  });

  it('still exposes the conflicting section in supporting_documents', () => {
    // The reviewer has to be able to SEE the offending document, and
    // collectIdValuesAcrossSections reads this to build id_conflicts. The bar
    // is on promotion only — never on visibility.
    const episode: any = {};
    stitchSupportingDocuments(episode, sections(), new Set([SPOUSE_SECTION]));
    const cards = episode.supporting_documents?.aadhaar_card ?? [];
    assert.equal(cards.length, 1);
    assert.equal(cards[0].aadhaar_number, '878773290597');
    assert.equal(cards[0]._section_id, SPOUSE_SECTION);
  });

  it('bars every slot fed by the conflicting section, not just aadhaar', () => {
    // address/pincode also promotes from aadhaar_card. Same person-mixing
    // risk, and it happened to be harmless here only because both addresses
    // shared a PIN.
    const s = sections();
    s[1].extracted_fields.pin_code = '999999';
    const episode: any = {};
    stitchSupportingDocuments(episode, s, new Set([SPOUSE_SECTION]));
    assert.notEqual(episode.patient_context?.address?.pincode, '999999');
  });

  it('is a no-op when there are no conflicts', () => {
    const episode: any = {};
    stitchSupportingDocuments(episode, sections(), new Set());
    assert.equal(episode.patient_context.identification.aadhaar_number, '878773290597');
  });
});
