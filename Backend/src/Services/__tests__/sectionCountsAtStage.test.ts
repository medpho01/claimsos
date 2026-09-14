/**
 * sectionCountsAtStage — which documents satisfy a presence rule at a stage.
 *
 * Before this existed, buildRuleContext had no stage predicate at all: every
 * section on the claim counted at every stage, so a DOCUMENT_PRESENCE rule at
 * pre-auth could be satisfied by a discharge summary filed a week later. That
 * fails in the expensive direction — it reports a claim ready to file when it
 * is not, which is the deduction this product exists to prevent.
 *
 * The backward-compatibility case (stage NULL still counts) is the one that
 * matters most operationally: it is what lets stage scoping ship without
 * retroactively failing claims that passed the day before.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sectionCountsAtStage } from '../adjudication/stageAwareAdjudicator.service.js';

const ORDER = new Map([
  ['ELIGIBILITY_CHECK', 10],
  ['PREAUTH', 20],
  ['ENHANCEMENT', 30],
  ['FINAL_AUTH', 40],
  ['CLAIM_FILE', 50],
]);

const sec = (stage: string | null, is_evergreen = false) => ({ stage, is_evergreen });

describe('sectionCountsAtStage', () => {
  it('counts an earlier stage document at a later stage', () => {
    // Pre-auth paperwork is not re-filed at discharge.
    assert.equal(sectionCountsAtStage(sec('PREAUTH'), 'FINAL_AUTH', ORDER), true);
  });

  it('counts a document from the same stage', () => {
    assert.equal(sectionCountsAtStage(sec('PREAUTH'), 'PREAUTH', ORDER), true);
  });

  it('does NOT count a later stage document at an earlier stage', () => {
    // The whole point: a final bill cannot complete a pre-auth file.
    assert.equal(sectionCountsAtStage(sec('FINAL_AUTH'), 'PREAUTH', ORDER), false);
    assert.equal(sectionCountsAtStage(sec('CLAIM_FILE'), 'ELIGIBILITY_CHECK', ORDER), false);
  });

  it('counts an evergreen document at every stage, including earlier ones', () => {
    // An Aadhaar card tagged FINAL_AUTH is still identity at pre-auth.
    assert.equal(sectionCountsAtStage(sec('FINAL_AUTH', true), 'PREAUTH', ORDER), true);
    assert.equal(sectionCountsAtStage(sec(null, true), 'ELIGIBILITY_CHECK', ORDER), true);
  });

  it('counts an unstamped section — preserves pre-release behaviour', () => {
    // document_sections.stage was 916/916 NULL. If this returned false,
    // enabling stage scoping would fail every existing claim at once.
    assert.equal(sectionCountsAtStage(sec(null), 'PREAUTH', ORDER), true);
  });

  it('does not narrow when the claim stage is unknown', () => {
    assert.equal(sectionCountsAtStage(sec('CLAIM_FILE'), null, ORDER), true);
  });

  it('does not narrow on a stage code the registry does not know', () => {
    // Retired-and-removed, or an inbound spelling nobody mapped. Presence
    // checks degrade permissive, never to "nothing counts".
    assert.equal(sectionCountsAtStage(sec('SOME_OLD_CODE'), 'PREAUTH', ORDER), true);
  });

  it('degrades to counting everything when the registry is empty', () => {
    // loadStageOrder returns an empty map on failure. That must mean "cannot
    // narrow", not "fail every rule on the claim".
    const empty = new Map<string, number>();
    assert.equal(sectionCountsAtStage(sec('CLAIM_FILE'), 'PREAUTH', empty), true);
  });
});
