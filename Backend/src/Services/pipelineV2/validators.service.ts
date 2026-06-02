/**
 * Pipeline v2 — Stage 6: Value-level validation + LOUD abstention.
 *
 * Stages 1-5 read and fuse faithfully; Stage 6 asks a different question: is
 * the fused value PHYSICALLY POSSIBLE and INTERNALLY CONSISTENT? This is the
 * E5 (value-level validation) + E4 (loud abstention) layer, and it is the last
 * line before harmonisation.
 *
 * What it catches (all deterministic, no LLM):
 *  - DECIMAL-SHIFT lab/vital errors. A misread/misplaced decimal turns pH 7.02
 *    into 70.2 or K⁺ 5.5 into 55 — physically impossible values that, left
 *    alone, drive a wrong critical-value adjudication. For analytes with HARD
 *    physiological bounds we detect when ÷10/÷100 (or ×10/×100) lands the value
 *    back in range and flag it as a decimal shift with the corrected value.
 *  - LENGTH-OF-STAY sanity. A single misread admission/discharge digit produced
 *    a 66-day stay in the cross-validation. Negative LOS (discharge before
 *    admission) is impossible → abstain; an implausibly long LOS → review.
 *  - WRONG-SIDE-SURGERY guard. A laterality slot contested between Left and
 *    Right is the highest-stakes conflict in the whole pipeline → abstain.
 *  - DIAGNOSIS WITHOUT AN AUTHORITATIVE SOURCE (the D3 partner rule). A primary
 *    diagnosis that surfaced ONLY from an unranked page, or at very low
 *    confidence, must abstain ("diagnosis pending source review") rather than
 *    emit a value a stale page invented.
 *
 * Abstention is LOUD: a `mustAbstain` issue BLOCKS auto-harmonisation in
 * Stage 7 and routes the field to the human review queue. A degraded-but-
 * flagged episode beats a confident-wrong one.
 */

import { FusedEpisode, FusedField } from './fusion.service.js';
import { parseClinicalDay } from './identityGate.service.js';
import { FIELD_AUTHORITY } from './types.js';

export type Severity = 'info' | 'warn' | 'abstain';

export interface ValidationIssue {
  /** Canonical field or a synthetic check name ('length_of_stay'). */
  field: string;
  severity: Severity;
  /** Machine code for routing/metrics. */
  code:
    | 'decimal_shift'
    | 'lab_out_of_range'
    | 'negative_los'
    | 'los_implausible'
    | 'laterality_conflict'
    | 'diagnosis_no_authority'
    | 'low_confidence';
  message: string;
  value?: string;
  /** Suggested corrected value (decimal-shift only). */
  suggested?: string;
  sourcePageId?: string;
}

export interface ValidationReport {
  issues: ValidationIssue[];
  /** true ⇔ ≥1 abstain-severity issue. Stage 7 must NOT auto-harmonise. */
  mustAbstain: boolean;
  /** Distinct fields carrying an abstain issue — review-queue routing. */
  abstainedFields: string[];
}

/** Below this fused confidence, a primary diagnosis abstains. */
export const LOW_CONFIDENCE_ABSTAIN = 0.5;
/** LOS above this is surfaced for review (warn). */
export const MAX_PLAUSIBLE_LOS_DAYS = 120;
/** LOS above this is physically implausible → abstain. */
export const HARD_MAX_LOS_DAYS = 365;

/**
 * Analytes with HARD physiological bounds — values outside these are not
 * "unusual", they are impossible, which is exactly the decimal-shift
 * signature. Deliberately conservative: we only list analytes where an
 * out-of-range value cannot be a real (if extreme) result. We do NOT bound
 * liver enzymes (SGPT/SGOT can genuinely reach 1000s in acute hepatitis), so
 * we never false-flag a real critical value as a decimal shift.
 */
interface LabBound {
  name: string;
  pattern: RegExp;
  min: number;
  max: number;
  unit: string;
}
const LAB_BOUNDS: LabBound[] = [
  { name: 'pH', pattern: /\bp\s*h\b/i, min: 6.5, max: 7.9, unit: '' },
  { name: 'Hemoglobin', pattern: /\b(h[ae]moglobin|hgb|hb)\b/i, min: 2, max: 25, unit: 'g/dL' },
  { name: 'Potassium', pattern: /\b(potassium|serum\s*k|k\s*\+)\b/i, min: 1.5, max: 9, unit: 'mmol/L' },
  { name: 'Sodium', pattern: /\b(sodium|serum\s*na|na\s*\+)\b/i, min: 100, max: 180, unit: 'mmol/L' },
  { name: 'Temperature', pattern: /\b(temp(erature)?)\b/i, min: 30, max: 45, unit: '°C' },
  { name: 'Creatinine', pattern: /\b(creatinine|s\.?\s*creat)\b/i, min: 0.1, max: 25, unit: 'mg/dL' },
];

/** Extract the first numeric token from a free-text lab/vital value. */
function firstNumber(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * True ⇔ the raw value carries a Fahrenheit unit marker. Matches `°F`, `degF`/
 * `deg F`/`degrees F`, a bare `F` token sitting on its own, or an `F`/`°F`
 * attached right after the number (e.g. "98.6F", "100.5°F") — but NOT an `F`
 * buried in an unrelated word (e.g. "fever", "Faint", "Ferritin") so a stray
 * letter never flips a Celsius read to Fahrenheit.
 */
function looksLikeFahrenheit(raw: string): boolean {
  return (
    /°\s*F(?![a-z])/i.test(raw) || // °F (degree sign + F, not e.g. °Foo)
    /\bdeg(?:rees?)?\s*F(?![a-z])/i.test(raw) || // deg F / degrees F
    /\d\s*°?\s*F(?![a-z])/i.test(raw) || // a number immediately followed by F / °F
    /(?:^|\s)F(?![a-z])/i.test(raw) // a standalone F token (preceded by start/space)
  );
}

/**
 * Validate a single lab/vital value string against the hard-bound table.
 * Returns an issue when the value is out of range, distinguishing a recoverable
 * decimal shift (÷/×10, ÷/×100 lands in range) from a genuinely out-of-range
 * read. Returns null when the analyte is unknown or the value is in range.
 */
export function validateLabValue(raw: string, sourcePageId?: string): ValidationIssue | null {
  const bound = LAB_BOUNDS.find((b) => b.pattern.test(raw));
  if (!bound) return null;
  const n = firstNumber(raw);
  if (n === null) return null;

  // Temperature is scale-ambiguous: the same chart prints °C and °F. A normal
  // fever (~38.5 °C / 101.3 °F) must validate either way. If the value looks
  // Fahrenheit — an explicit F unit in the raw text, OR a magnitude no human
  // Celsius temperature reaches (≥ 50; Fahrenheit body temps are ~95–108) —
  // validate against the equivalent Fahrenheit physiological window (86–113 °F,
  // i.e. 30–45 °C) and treat an in-range reading as VALID. A Fahrenheit-looking
  // value that is in NEITHER window (e.g. a decimal-shifted 385) still falls
  // through to the shared decimal-shift / out-of-range logic below, so 385 ×0.1
  // = 38.5 is reported as a decimal_shift, not silently accepted. Celsius reads
  // (< 50, no F unit) keep the original °C behaviour unchanged.
  if (bound.name === 'Temperature' && (looksLikeFahrenheit(raw) || n >= 50)) {
    const F_MIN = 86; // 30 °C
    const F_MAX = 113; // 45 °C
    if (n >= F_MIN && n <= F_MAX) return null;
    // else: out of the Fahrenheit window too — fall through to decimal-shift /
    // out-of-range handling against the canonical (°C) bound.
  }

  if (n >= bound.min && n <= bound.max) return null;

  // Out of range — is it a clean power-of-ten shift?
  const factors = [10, 100, 0.1, 0.01];
  for (const f of factors) {
    const c = n * f;
    if (c >= bound.min && c <= bound.max) {
      return {
        field: 'lab_value',
        severity: 'abstain',
        code: 'decimal_shift',
        message: `${bound.name} read as ${n} is physically impossible; a decimal shift to ${trimNum(c)} ${bound.unit} fits the physiological range — re-read required`,
        value: raw,
        suggested: `${trimNum(c)}${bound.unit ? ' ' + bound.unit : ''}`,
        sourcePageId,
      };
    }
  }
  return {
    field: 'lab_value',
    severity: 'warn',
    code: 'lab_out_of_range',
    message: `${bound.name} value ${n} is outside the physiological range ${bound.min}–${bound.max} ${bound.unit}`,
    value: raw,
    sourcePageId,
  };
}

function trimNum(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/** Validate the admission→discharge length of stay. */
export function validateLengthOfStay(
  admission: FusedField | undefined,
  discharge: FusedField | undefined,
): ValidationIssue | null {
  if (!admission || !discharge) return null;
  const a = parseClinicalDay(admission.value);
  const d = parseClinicalDay(discharge.value);
  if (a === null || d === null) return null;
  const los = d - a;
  if (los < 0) {
    return {
      field: 'length_of_stay',
      severity: 'abstain',
      code: 'negative_los',
      message: `discharge (${discharge.value}) precedes admission (${admission.value}) — a date misread`,
      value: `${los} days`,
    };
  }
  if (los > HARD_MAX_LOS_DAYS) {
    return {
      field: 'length_of_stay',
      severity: 'abstain',
      code: 'los_implausible',
      message: `length of stay ${los} days exceeds the plausible maximum — likely a misread admission/discharge digit`,
      value: `${los} days`,
    };
  }
  if (los > MAX_PLAUSIBLE_LOS_DAYS) {
    return {
      field: 'length_of_stay',
      severity: 'warn',
      code: 'los_implausible',
      message: `length of stay ${los} days is unusually long — review the admission/discharge dates`,
      value: `${los} days`,
    };
  }
  return null;
}

/**
 * Full Stage-6 validation over a fused episode.
 *
 * @param episode — the Stage-5 fused episode.
 * @returns the issue list plus the loud `mustAbstain` gate Stage 7 consumes.
 */
export function validateEpisode(episode: FusedEpisode): ValidationReport {
  const issues: ValidationIssue[] = [];

  // 1. Length-of-stay sanity.
  const los = validateLengthOfStay(episode.admission_date, episode.discharge_date);
  if (los) issues.push(los);

  // 2. Lab + vital value bounds / decimal shift.
  for (const lab of [...episode.lab_values, ...episode.vitals]) {
    const issue = validateLabValue(lab.value, lab.sourcePageId);
    if (issue) issues.push(issue);
  }

  // 3. Wrong-side-surgery guard: a Left↔Right laterality conflict abstains.
  if (episode.laterality?.contested) {
    const vals = new Set(
      episode.laterality.candidates.map((c) => c.value.toLowerCase()),
    );
    if (vals.has('left') && vals.has('right')) {
      issues.push({
        field: 'laterality',
        severity: 'abstain',
        code: 'laterality_conflict',
        message: 'laterality is contested between Left and Right across sources — wrong-side risk, human confirmation required',
        value: episode.laterality.value,
        sourcePageId: episode.laterality.sourcePageId,
      });
    }
  }

  // 4. Diagnosis-without-authority (the D3 partner rule) + low confidence.
  if (episode.primary_diagnosis) {
    const dx = episode.primary_diagnosis;
    if (!dx.fromAuthoritativeSource) {
      // D3 protects against an unranked/stale page inventing a diagnosis WHEN a
      // real authoritative source (discharge/OT/clinical) exists in the bundle.
      // But a short admission whose bundle has NO such source at all (e.g. only
      // an admission note) should HARMONISE WITH A FLAG, not block — otherwise
      // every short medical admission hard-abstains. So: if we know the bundle's
      // doc types and NONE of them is authoritative for the diagnosis, downgrade
      // to a warn. If an authoritative source WAS present (the winner just isn't
      // it) — or the present set is unknown — keep the D3 abstain.
      const present = episode.presentDocTypes ?? [];
      const hasAuthority = FIELD_AUTHORITY.primary_diagnosis.some((dt) =>
        present.includes(dt),
      );
      if (present.length > 0 && !hasAuthority) {
        issues.push({
          field: 'primary_diagnosis',
          severity: 'warn',
          code: 'diagnosis_no_authority',
          message: `primary diagnosis "${dx.value}" came from a non-authoritative page (${dx.sourceDocType}) and no discharge/OT/clinical source exists in this bundle — emitted for review`,
          value: dx.value,
          sourcePageId: dx.sourcePageId,
        });
      } else {
        issues.push({
          field: 'primary_diagnosis',
          severity: 'abstain',
          code: 'diagnosis_no_authority',
          message: `primary diagnosis "${dx.value}" came only from a non-authoritative page (${dx.sourceDocType}); no discharge/OT/clinical source corroborates it — pending source review`,
          value: dx.value,
          sourcePageId: dx.sourcePageId,
        });
      }
    } else if (dx.confidence < LOW_CONFIDENCE_ABSTAIN) {
      issues.push({
        field: 'primary_diagnosis',
        severity: 'abstain',
        code: 'low_confidence',
        message: `primary diagnosis "${dx.value}" fused confidence ${dx.confidence.toFixed(2)} is below the abstention threshold ${LOW_CONFIDENCE_ABSTAIN}`,
        value: dx.value,
        sourcePageId: dx.sourcePageId,
      });
    }
  }

  const abstainIssues = issues.filter((i) => i.severity === 'abstain');
  return {
    issues,
    mustAbstain: abstainIssues.length > 0,
    abstainedFields: [...new Set(abstainIssues.map((i) => i.field))],
  };
}
