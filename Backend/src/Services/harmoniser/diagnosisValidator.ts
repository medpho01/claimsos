/**
 * Diagnosis validator for the Harmoniser (Task H2 from the 30-patient
 * smoke test).
 *
 * Background
 * ──────────
 * The smoke test surfaced six episodes where `diagnosis.primary_diagnosis.diagnosis_name`
 * had been hallucinated from the wrong section:
 *
 *   • Suneel              → "Saqish Singh"                            (person name, lifted from a consent form)
 *   • Mohd Aslam          → "Orthopaedics case - trauma/injury related" (LLM generic fallback)
 *   • Mohd Hasan          → "Surgical condition requiring intervention" (LLM generic fallback)
 *   • Hamshiran           → "WITH A/E POP SLAB"                        (fragment of treatment text)
 *
 * All four classes of failure share a single signature: the harmoniser
 * accepted a string that doesn't describe a medical condition, because
 * the LLM has no hard constraint on WHICH section a diagnosis must
 * originate from.
 *
 * Strategy
 * ────────
 * Two independent checks, applied AFTER the LLM responds:
 *
 *   1.  Pattern blocklist — exact phrases ("Orthopaedics case - trauma...")
 *       plus an anatomical-keyword heuristic. Any "diagnosis" with NO
 *       recognised body/condition/disease word is rejected; the
 *       harmoniser's "primary diagnosis" must mention SOMETHING the
 *       clinician would actually write down.
 *
 *   2.  Source-category allowlist — the diagnosis_name MUST come from a
 *       section whose category is clinical (discharge slip, OPD notes,
 *       OT notes, etc.). KYC sections, photos, ration cards, generic
 *       consent free-text are never legal sources. The harmoniser
 *       service passes the candidate-source category in; this module
 *       judges whether it's acceptable.
 *
 * Both checks are pure functions — no DB, no LLM. The harmoniser is
 * responsible for tracking which section the diagnosis came from
 * (currently coarse — it relies on the supporting_documents lineage) and
 * for writing validation_metadata when we reject.
 */

// ─── Allowed source categories for primary_diagnosis ───────────────────

/**
 * Categories whose extracted_fields are permitted to seed
 * primary_diagnosis.diagnosis_name. Mirrors the doc-category taxonomy
 * used by the docClassifier.
 *
 * surgery_consent_form is permitted but ONLY via its procedure_planned
 * field — patient names + signatures on the same form are NOT clinical.
 * The harmoniser cannot enforce that field-level constraint here (we
 * only see the bag of extracted_fields), but the source-allowlist
 * substantially narrows the surface anyway.
 */
export const ALLOWED_DIAGNOSIS_SOURCE_CATEGORIES: ReadonlySet<string> = new Set([
  'opd_notes',
  'opd_consultation',
  'discharge_summary',
  'surgical_discharge_slip',
  'ot_notes',
  'operative_notes',
  'admission_note',
  'admission_form',
  'preauth_form',
  'pa_approval',
  'enhancement_request',
  'progress_notes',
  'history_examination',
  'clinical_summary',
  'surgery_consent_form', // restricted-use; see note above
]);

// ─── Hard blocklist of known-bad values ────────────────────────────────

/**
 * Substring matches (case-insensitive). If any of these appear in the
 * candidate diagnosis_name, reject.
 */
const BLOCKLIST_SUBSTRINGS: ReadonlyArray<string> = [
  'orthopaedics case - trauma/injury related',
  'orthopedics case - trauma/injury related',
  'orthopaedics case-trauma',
  'surgical condition requiring intervention',
  'medical condition requiring',
  'with a/e pop slab',
  'a/e pop slab',
  'unknown condition',
  'unspecified condition',
  'patient condition',
];

// ─── Anatomical / condition keyword whitelist ──────────────────────────

/**
 * If the candidate string contains NONE of these tokens we treat it as
 * non-clinical and reject. The list is intentionally generous; we want
 * to catch obvious failures (person names, fragments of treatment text)
 * without rejecting legitimate-but-rare diagnoses. Compared
 * case-insensitively as substrings against the WORD-tokenised input.
 *
 * Includes:
 *   - Common condition suffixes (-itis, -osis, -oma, -pathy) — handled
 *     via the suffix list below to avoid bloating the keyword set.
 *   - Body parts (hip, knee, spine, abdomen…).
 *   - Conditions (fracture, tear, rupture, stenosis, infection…).
 *   - Specialty disease classes (cancer, carcinoma, sepsis, stroke…).
 */
const CLINICAL_KEYWORDS: ReadonlyArray<string> = [
  // structural injuries
  'fracture', 'fractured', 'fx', 'displaced', 'comminuted',
  'tear', 'torn', 'rupture', 'ruptured',
  'sprain', 'strain', 'dislocation', 'dislocated',
  'injury', 'trauma', 'wound', 'laceration', 'burn',
  // degenerative / disease processes
  'arthritis', 'osteoarthritis', 'osteoporosis', 'osteomyelitis',
  'necrosis', 'avn', 'avascular',
  'stenosis', 'spondylosis', 'spondylitis', 'spondylolisthesis',
  'herniation', 'prolapse', 'protrusion',
  'tumour', 'tumor', 'cancer', 'carcinoma', 'sarcoma', 'lymphoma', 'malignancy',
  'cyst', 'abscess', 'fistula', 'polyp', 'nodule',
  // organ-system disease words
  'infection', 'sepsis', 'pneumonia', 'tuberculosis', 'tb',
  'hepatitis', 'cirrhosis', 'jaundice',
  'gastritis', 'colitis', 'enteritis', 'appendicitis', 'pancreatitis',
  'cholelithiasis', 'cholecystitis', 'cholelithiasis',
  'nephritis', 'nephrolithiasis', 'pyelonephritis',
  'cystitis', 'urethritis', 'prostatitis',
  'meningitis', 'encephalitis',
  'dermatitis', 'cellulitis', 'erysipelas',
  // cardiovascular / metabolic
  'ischemia', 'ischaemia', 'infarction', 'mi', 'angina',
  'hypertension', 'hypotension', 'diabetes', 'mellitus', 'hyperglycemia',
  'stroke', 'cva', 'tia', 'hemorrhage', 'haemorrhage', 'bleeding',
  'failure', 'arrhythmia', 'fibrillation', 'tachycardia', 'bradycardia',
  // respiratory
  'asthma', 'copd', 'bronchitis', 'pleurisy', 'effusion', 'pneumothorax',
  // ob/gyn
  'pregnancy', 'pregnant', 'gravida', 'parity', 'antenatal', 'labour', 'labor',
  'delivery', 'caesarean', 'cesarean', 'lscs', 'abortion', 'ectopic',
  // urology / gi
  'hernia', 'piles', 'haemorrhoid', 'hemorrhoid', 'stone', 'calculus',
  'hydrocele', 'varicocele', 'phimosis',
  // ophthalmology / ent
  'cataract', 'glaucoma', 'retinopathy', 'tonsillitis', 'sinusitis',
  // catch-all condition / syndrome / disease words
  'disease', 'syndrome', 'disorder', 'pain', 'ache', 'lesion', 'mass',
  'oedema', 'edema', 'inflammation', 'inflamed', 'swelling',
  // anatomy (lets "Hip Replacement" type strings be flagged elsewhere
  // but allows "Right Hip Osteoarthritis" through)
  'hip', 'knee', 'shoulder', 'spine', 'lumbar', 'cervical', 'thoracic',
  'femur', 'tibia', 'fibula', 'humerus', 'radius', 'ulna', 'clavicle',
  'wrist', 'ankle', 'elbow', 'foot', 'hand', 'finger', 'toe',
  'abdomen', 'pelvis', 'chest', 'thorax', 'head', 'neck',
  'liver', 'kidney', 'gallbladder', 'pancreas', 'spleen', 'stomach',
  'intestine', 'colon', 'rectum', 'bladder', 'uterus', 'ovary',
  'breast', 'thyroid', 'prostate', 'testis', 'lung', 'heart', 'brain',
];

/**
 * Conditions that end in a clinical suffix even without a matching
 * keyword. Catches "appendicitis", "spondylosis", "lymphoma" etc. when
 * the keyword list doesn't already cover them.
 */
const CLINICAL_SUFFIXES: ReadonlyArray<string> = [
  'itis', 'osis', 'oma', 'pathy', 'algia', 'aemia', 'emia', 'cele',
  'plegia', 'paresis', 'rrhoea', 'rrhea', 'rrhage', 'genic',
];

// ─── Heuristics ────────────────────────────────────────────────────────

/**
 * Two capitalised words and nothing else == probably a person name.
 * Examples this catches: "Saqish Singh", "Joginder Singh", "Ram Lal".
 *
 * Conservative — we only flag the very narrow shape:
 *   /^[A-Z][a-z]+\s+[A-Z][a-z]+$/
 * (i.e. exactly two capitalised tokens, all letters). A real diagnosis
 * almost never satisfies this — "Right Hip Osteoarthritis" has three
 * tokens and "fracture neck femur" has lowercase tokens.
 */
function looksLikePersonName(raw: string): boolean {
  return /^[A-Z][a-z]+\s+[A-Z][a-z]+\s*$/.test(raw.trim());
}

/** Strict word-boundary keyword match. Case-insensitive. */
function containsClinicalKeyword(raw: string): boolean {
  const lower = raw.toLowerCase();
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  if (!tokens.length) return false;
  const tokenSet = new Set(tokens);
  for (const kw of CLINICAL_KEYWORDS) {
    if (tokenSet.has(kw)) return true;
    // Also allow embedded matches for multi-word phrases ("oa hip").
    if (kw.includes(' ') && lower.includes(kw)) return true;
  }
  // Suffix-based fallback.
  for (const token of tokens) {
    if (token.length < 5) continue;
    for (const suf of CLINICAL_SUFFIXES) {
      if (token.endsWith(suf)) return true;
    }
  }
  return false;
}

// ─── Public validator ─────────────────────────────────────────────────

export interface DiagnosisValidationResult {
  ok: boolean;
  /** Free-text reason captured to validation_metadata when ok=false. */
  reason?: string;
}

/**
 * Run pattern checks on a diagnosis_name candidate. Returns
 * {ok: false, reason} when:
 *   - the value matches a known blocklist phrase (case-insensitive)
 *   - the value looks like a two-token person name
 *   - the value contains zero clinical keywords / suffixes
 *
 * Source-category gating (Task H2 step 2) is enforced separately —
 * see {@link isAllowedSourceCategory}.
 */
export function validateDiagnosisName(
  raw: string | null | undefined,
): DiagnosisValidationResult {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, reason: 'empty_or_non_string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length < 3) {
    return { ok: false, reason: 'too_short' };
  }
  const lower = trimmed.toLowerCase();
  for (const phrase of BLOCKLIST_SUBSTRINGS) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `blocklist_phrase:${phrase}` };
    }
  }
  if (looksLikePersonName(trimmed)) {
    return { ok: false, reason: 'looks_like_person_name' };
  }
  if (!containsClinicalKeyword(trimmed)) {
    return { ok: false, reason: 'no_clinical_keywords' };
  }
  return { ok: true };
}

/**
 * Returns true iff the given section category is permitted to source a
 * primary_diagnosis.diagnosis_name. Categories outside the allowlist
 * (aadhaar / ration_card / pmjay_card / photos / consent_form free text)
 * are silently dropped from diagnosis consideration.
 */
export function isAllowedSourceCategory(
  category: string | null | undefined,
): boolean {
  if (!category) return false;
  return ALLOWED_DIAGNOSIS_SOURCE_CATEGORIES.has(category);
}

/**
 * Convenience: find the most likely source category for a diagnosis
 * name by scanning the section list for an extracted_fields entry whose
 * value matches the diagnosis (substring, case-insensitive). Returns
 * null when no section claims it.
 *
 * Used by the harmoniser to discover the lineage post-hoc when the
 * LLM didn't return explicit provenance.
 */
export function inferDiagnosisSourceCategory(
  diagnosisName: string,
  sections: ReadonlyArray<{
    category: string | null;
    extracted_fields: any;
  }>,
): string | null {
  if (!diagnosisName) return null;
  const needle = diagnosisName.toLowerCase().trim();
  if (needle.length < 4) return null;
  // Walk in section list order. Diagnostic-bearing fields tend to live
  // in canonical names like diagnosis / primary_diagnosis /
  // chief_complaints / procedure_planned. We don't insist on the field
  // key — any string value substring-matching the diagnosis counts.
  for (const s of sections) {
    if (!s.category) continue;
    const f = s.extracted_fields;
    if (!f || typeof f !== 'object') continue;
    for (const v of Object.values(f)) {
      if (typeof v !== 'string') continue;
      const lower = v.toLowerCase();
      if (lower.includes(needle) || needle.includes(lower)) {
        return s.category;
      }
    }
  }
  return null;
}
