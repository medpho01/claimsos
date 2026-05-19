/**
 * CARDIAC_002 — Cardiac Enzymes for ACS Diagnosis.
 *
 * If the primary diagnosis is ACS-related (ICD I20-I25, or diagnosis_name
 * contains 'ACS' / 'Coronary Syndrome'), at least one cardiac enzyme test
 * (Troponin / CKMB) anywhere in clinical_timeline must show an elevated /
 * critical / high result.
 *
 * SKIP when the diagnosis is not ACS — the rule simply doesn't apply.
 */
import type { CustomFunction } from './index.js';

const ACS_NAME_HINTS = ['ACS', 'ACUTE CORONARY', 'STEMI', 'NSTEMI', 'UNSTABLE ANGINA'];
const ACS_ICD_PREFIXES = ['I20', 'I21', 'I22', 'I23', 'I24', 'I25'];
const ENZYME_HINTS = ['TROPONIN', 'CKMB', 'CK-MB', 'CK MB'];
const ELEVATED_FLAGS = ['HIGH', 'ELEVATED', 'CRITICAL', 'ABNORMAL_HIGH', 'POSITIVE'];

function isAcsDiagnosis(episode: any): boolean {
  const primary = episode?.diagnosis?.primary_diagnosis ?? {};
  const icd: string = String(primary.icd_code ?? '').toUpperCase();
  const name: string = String(primary.diagnosis_name ?? '').toUpperCase();
  if (ACS_ICD_PREFIXES.some((p) => icd.startsWith(p))) return true;
  return ACS_NAME_HINTS.some((h) => name.includes(h));
}

function* iterDiagnostics(episode: any): Generator<any> {
  const tl = Array.isArray(episode?.clinical_timeline) ? episode.clinical_timeline : [];
  for (const phase of tl) {
    const diags = Array.isArray(phase?.diagnostics_performed) ? phase.diagnostics_performed : [];
    for (const d of diags) yield d;
  }
}

function isCardiacEnzyme(d: any): boolean {
  const cat = String(d?.diagnostic_meta?.category ?? '').toUpperCase();
  const nameN = String(d?.diagnostic_meta?.test_name_normalized ?? '').toUpperCase();
  const name = String(d?.diagnostic_meta?.test_name ?? '').toUpperCase();
  if (cat === 'CARDIAC' || cat === 'BIOCHEMISTRY' || cat === 'PATHOLOGY') {
    return ENZYME_HINTS.some((h) => nameN.includes(h) || name.includes(h));
  }
  return ENZYME_HINTS.some((h) => nameN.includes(h) || name.includes(h));
}

function isElevated(d: any): boolean {
  const flag = String(d?.result_flag ?? d?.flag ?? d?.interpretation ?? '').toUpperCase();
  if (ELEVATED_FLAGS.some((f) => flag.includes(f))) return true;
  const numeric = Number(d?.numeric_value ?? d?.value);
  const refHigh = Number(d?.reference_range_high ?? d?.diagnostic_meta?.reference_range_high);
  if (Number.isFinite(numeric) && Number.isFinite(refHigh) && numeric > refHigh) return true;
  return false;
}

export const validateCardiacEnzymesForAcs: CustomFunction = async (episode) => {
  if (!isAcsDiagnosis(episode)) {
    return {
      status: 'SKIP',
      evidence: { reason: 'primary diagnosis is not ACS-related' },
      message: null,
    };
  }
  const enzymeTests: any[] = [];
  const elevatedTests: any[] = [];
  for (const d of iterDiagnostics(episode)) {
    if (!isCardiacEnzyme(d)) continue;
    enzymeTests.push({
      test: d?.diagnostic_meta?.test_name_normalized ?? d?.diagnostic_meta?.test_name,
      flag: d?.result_flag ?? d?.flag,
      value: d?.numeric_value ?? d?.value,
    });
    if (isElevated(d)) elevatedTests.push(enzymeTests[enzymeTests.length - 1]);
  }
  if (enzymeTests.length === 0) {
    return {
      status: 'FAIL',
      evidence: { enzyme_tests_found: 0 },
      message: 'No cardiac enzyme tests (Troponin/CKMB) found in the episode',
    };
  }
  if (elevatedTests.length === 0) {
    return {
      status: 'FAIL',
      evidence: { enzyme_tests_found: enzymeTests.length, elevated: 0, tests: enzymeTests },
      message: 'Cardiac enzymes present but none flagged elevated/critical',
    };
  }
  return {
    status: 'PASS',
    evidence: { elevated_count: elevatedTests.length, elevated: elevatedTests },
    message: null,
  };
};
