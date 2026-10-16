/**
 * The size ceiling is a claim-filing rule, not a tuning constant: PM-JAY's
 * portal rejects anything over 1 MB, and squeezing every other insurer's
 * documents to the same size was costing OCR accuracy for no reason.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetBytesForPanelCode,
  isPmjayPanel,
  PMJAY_MAX_BYTES,
  STANDARD_MAX_BYTES,
} from '../gsCompress.worker.js';

describe('targetBytesForPanelCode', () => {
  it('holds PMJAY to the portal cap', () => {
    assert.equal(targetBytesForPanelCode('PMJAY'), PMJAY_MAX_BYTES);
  });

  it('is case- and whitespace-insensitive', () => {
    // Panel codes are operator-entered through the superadmin screens.
    assert.equal(targetBytesForPanelCode('pmjay'), PMJAY_MAX_BYTES);
    assert.equal(targetBytesForPanelCode('  PmJay  '), PMJAY_MAX_BYTES);
  });

  it('gives every other panel the standard ceiling', () => {
    for (const code of ['STAR_HEALTH', 'ICICI_LOMBARD', 'MEDI_ASSIST', 'ACKO']) {
      assert.equal(targetBytesForPanelCode(code), STANDARD_MAX_BYTES);
    }
  });

  it('defaults to the standard ceiling when the panel is unknown', () => {
    // A claim with no panel yet must not be squeezed to PM-JAY's limit on the
    // chance it might become one.
    assert.equal(targetBytesForPanelCode(null), STANDARD_MAX_BYTES);
    assert.equal(targetBytesForPanelCode(undefined), STANDARD_MAX_BYTES);
    assert.equal(targetBytesForPanelCode(''), STANDARD_MAX_BYTES);
  });

  it('does not match a panel that merely contains PMJAY', () => {
    // "Sadbhawana / PMJAY" is a rule-set name, not a panel code. Only the
    // exact code carries the portal's limit.
    assert.equal(targetBytesForPanelCode('SADBHAWANA_PMJAY'), STANDARD_MAX_BYTES);
  });

  it('keeps both ceilings under their stated megabyte limits', () => {
    // Margin matters: the portals are not explicit about 1,000,000 vs
    // 1,048,576, and a rejected upload costs a round trip with the hospital.
    assert.ok(PMJAY_MAX_BYTES < 1_000_000, 'PMJAY ceiling must sit under 1 MB');
    assert.ok(STANDARD_MAX_BYTES < 2_000_000, 'standard ceiling must sit under 2 MB');
    assert.ok(STANDARD_MAX_BYTES > PMJAY_MAX_BYTES);
  });
});

describe('isPmjayPanel — which claims face a hard cap', () => {
  it('is true only for PMJAY', () => {
    assert.equal(isPmjayPanel('PMJAY'), true);
    assert.equal(isPmjayPanel('pmjay'), true);
    assert.equal(isPmjayPanel('STAR_HEALTH'), false);
    assert.equal(isPmjayPanel(null), false);
  });

  it('agrees with targetBytesForPanelCode', () => {
    // The two are read together at every call site; they must not disagree
    // about what PMJAY is.
    for (const code of ['PMJAY', 'pmjay', 'STAR_HEALTH', '', null, undefined]) {
      const expected = isPmjayPanel(code) ? PMJAY_MAX_BYTES : STANDARD_MAX_BYTES;
      assert.equal(targetBytesForPanelCode(code), expected, `disagreed on ${code}`);
    }
  });

  it('only PMJAY is allowed past the OCR floor', () => {
    // isPmjayPanel is what gets passed as `hardCap`. If it were ever true for
    // a non-PMJAY panel, that insurer's documents would be degraded to hit a
    // ceiling nobody enforces.
    assert.equal(isPmjayPanel('MEDI_ASSIST'), false);
    assert.equal(isPmjayPanel('SADBHAWANA_PMJAY'), false);
  });
});
