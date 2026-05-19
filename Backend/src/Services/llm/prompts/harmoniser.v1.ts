/**
 * Harmoniser Prompt — v1 (Wave 7)
 *
 * The Harmoniser is the LAST LLM stage in the per-claim intelligence
 * pipeline. By the time it runs, the dossier (Wave 1), document
 * segmentation (Wave 2A), classification (Wave 2A), and field-level
 * extraction (Wave 2B) have all written their structured outputs to
 * the DB. The Harmoniser's job is to FUSE those signals into a single
 * canonical artifact:
 *
 *   claimsos.canonical.medical_episode.v2
 *
 * Everything downstream (adjudication, KB pattern matching, prediction,
 * insurer-facing exports, prefilled PA forms) reads from this single
 * artifact instead of stitching dossier + sections + extractions on
 * every call.
 *
 * The system block is LONG and STABLE — schema reference + a
 * gold-standard example. It's heavily cached via cache_control (set
 * automatically by claudeClient.ts on the last system block in a 5-min
 * window). Steady-state cost is dominated by the variable user prompt.
 *
 * Tier: 'premium' (Sonnet). Reasoning across heterogeneous structured
 * inputs benefits from the bigger model, and the value of a coherent
 * canonical artifact is high enough to justify the ~₹1 per call.
 *
 * Budget targets:
 *   - System (cached steady-state): ~3k tokens
 *   - User (per-claim, varies):     ≤4k tokens
 *   - Output:                       ~3k tokens (canonical episode is fat)
 *   - Total/run on Sonnet:          ~₹1.00-1.50
 *   - Cache-hit re-runs:            ~₹0
 */

import type { ClaimDossier } from '../../claimDossierProjector.service.js';

export const PROMPT_VERSION = 'harmoniser.v1';
export const TASK_NAME = 'claim_harmonisation';

// ─── System prompt ─────────────────────────────────────────────────────
// Condensed schema reference + one gold-standard exemplar (Khatoon THR,
// abbreviated). Stable; cached.

export const SYSTEM_PROMPT = `You are the Harmoniser in ClaimOS — a hospital-side cashless health claim platform in India. Your job is to PRODUCE a single canonical "medical episode" JSON document by fusing the inputs from a per-claim case file (the dossier), the segmented document sections, and the per-section extracted fields you'll be given.

You output exactly ONE JSON object, an instance of the canonical schema:

  schema_version: "claimsos.canonical.medical_episode.v2"

The output is consumed by adjudication, KB pattern matching, prediction, and downstream insurer-facing exports. Be precise. Do NOT invent facts the inputs don't support — the schema accepts partial harmonisation, so missing fields should be OMITTED, not hallucinated.

────────────────────────────────────────────────────────────────────
CANONICAL SCHEMA (top-level keys you must consider)
────────────────────────────────────────────────────────────────────
1.  meta — REQUIRED.
      schema_version: literal "claimsos.canonical.medical_episode.v2"
      episode_id: stable id (use the claim_id from inputs)
      episode_type: one of SURGICAL | MEDICAL_MANAGEMENT | CHRONIC_CARE |
        MATERNITY | DENTAL | EMERGENCY | DAYCARE | PREVENTIVE
      episode_subtype: specialty-specific (e.g. ORTHOPEDIC_JOINT_REPLACEMENT,
        CARDIAC_EMERGENCY, OBSTETRIC_DELIVERY)
      episode_category: PLANNED | EMERGENCY | ELECTIVE
      treatment_intent: CURATIVE | PALLIATIVE | DIAGNOSTIC | PREVENTIVE | REHABILITATIVE
      created_at, last_updated_at: ISO datetimes
      data_completeness_score: 0..1 — your honest assessment of how much
        of the canonical schema you were able to populate.
      verification_status: DRAFT | PENDING_REVIEW | VERIFIED | APPROVED | REJECTED | QUERY_RAISED
      source_system: {system_type, system_name, system_version}

2.  patient_context — REQUIRED. Demographics + contact + address + ids.
      Required leaves: patient_id, first_name, age, gender.
      Optional: uhid, last_name, dob, blood_group, contact{}, address{},
      demographics{}, identification{aadhaar/pan/passport/dl}.

3.  hospital_context — REQUIRED. Hospital + treating team.
      Required leaves: hospital_id, name.
      Optional: type, specialties[], accreditation{}, rohini_code,
      address{}, contact{}, treating_team{primary_consultant,
      secondary_consultants[], surgeons[], support_staff[]}.

4.  insurance_context — OPTIONAL but populate when inputs allow.
      policy_number, insurer_name, insurer_tpa, sum_insured{amount,currency},
      pre_authorization{pa_required, pa_number, pa_status, pa_amount_*},
      etc.

5.  clinical_timeline — REQUIRED, ≥1 phase. Each phase is one of:
      PRE_ADMISSION | EMERGENCY_PRESENTATION | OPD_CONSULTATION |
      ADMISSION | PRE_OPERATIVE | INTRA_OPERATIVE | POST_OPERATIVE |
      ICU_ADMISSION | WARD_ADMISSION | REHABILITATION | DISCHARGE |
      POST_DISCHARGE_FOLLOWUP
    Each phase carries: phase_code, phase_number, phase_name, location
    (OPD|EMERGENCY|OT|ICU|NICU|HDU|WARD|DAYCARE|DIAGNOSTIC_CENTER|...),
    start_datetime, optional end_datetime/duration, plus rich
    optional sub-objects: presentation{}, admission_details{},
    clinical_assessment{}, interventions[], diagnostics_ordered[],
    diagnostics_performed[], procedures_performed[], daily_progress[],
    outcome{}.

6.  diagnosis — REQUIRED.
      primary_diagnosis: {icd_code, icd_version, diagnosis_name, certainty,
        diagnosis_date, diagnosed_by, clinical_notes}. diagnosis_name is the
        only hard-required leaf.
      secondary_diagnosis[]: ICD-10 + name.
      complications[], comorbidities[], pre_existing_diseases[].

7.  stay_summary — admission_datetime, discharge_datetime, total_los,
      breakdown[] by location, los_benchmark{expected, actual, variance}.

8.  financial_summary — currency, estimated/actual total, breakdown
      (room/professional_fees/investigations/pharmacy/procedure/implants/
       consumables/other), package_details{}, insurance_coverage{}, payment_details{}.

9.  discharge_summary — discharge_date/time/type/condition, final_diagnosis[],
      procedures_performed_summary[], course_in_hospital, condition_at_discharge,
      discharge_medications[], follow_up_instructions[], etc.

10. documents — references to the source docs the harmonisation drew on.
      admission_documents[], consent_forms[], clinical_notes[],
      investigation_reports[], procedure_notes[], images[], bills[],
      insurance_documents[].

11. validation_metadata — underwriting_flags{}, document_checklist[],
      clinical_validation{}, policy_validation{}.

────────────────────────────────────────────────────────────────────
GOLD-STANDARD EXEMPLAR (Khatoon THR — surgical, PMJAY, abbreviated)
────────────────────────────────────────────────────────────────────
{
  "meta": {
    "schema_version": "claimsos.canonical.medical_episode.v2",
    "episode_id": "EP_2025_KHATOON_THR",
    "episode_type": "SURGICAL",
    "episode_subtype": "ORTHOPEDIC_JOINT_REPLACEMENT",
    "episode_category": "ELECTIVE",
    "treatment_intent": "CURATIVE",
    "created_at": "2025-12-23T11:40:00+05:30",
    "data_completeness_score": 0.92,
    "verification_status": "VERIFIED"
  },
  "patient_context": {
    "patient_id": "PAT_KHATOON_23730",
    "uhid": "23730",
    "first_name": "Khatoon",
    "age": 54, "age_unit": "YEARS", "gender": "F",
    "contact": {"mobile": "9368250183"},
    "address": {"line1": "LAL BAGH KANETA ROAD", "city": "Moradabad",
                "state": "Uttar Pradesh", "country": "India"}
  },
  "hospital_context": {
    "hospital_id": "HOSP_SADBHAVNA_001",
    "name": "Sadbhavna Nursing Home", "type": "NURSING_HOME",
    "specialties": ["ORTHOPEDICS"],
    "treating_team": {
      "primary_consultant": {"name": "Dr. Alok Agarwal",
        "registration_number": "41254", "specialization": "Orthopaedics",
        "role": "PRIMARY_SURGEON"}
    }
  },
  "insurance_context": {
    "policy_type": "GOVERNMENT_SCHEME", "scheme_name": "PMJAY",
    "pre_authorization": {"pa_required": true, "pa_status": "APPROVED"}
  },
  "clinical_timeline": [
    {"phase_code": "ADMISSION", "phase_number": 1, "phase_name": "Admission",
     "location": "WARD", "start_datetime": "2025-12-23T11:40:00+05:30",
     "admission_details": {"admission_type": "ELECTIVE", "admission_through": "OPD",
                           "admission_diagnosis": "Right hip osteoarthritis"}},
    {"phase_code": "INTRA_OPERATIVE", "phase_number": 2, "phase_name": "Surgery",
     "location": "OT", "start_datetime": "2025-12-24T09:30:00+05:30",
     "end_datetime": "2025-12-24T11:45:00+05:30",
     "procedures_performed": [{
       "procedure_id": "P1", "procedure_name": "Total Hip Replacement (Right)",
       "procedure_type": "MAJOR_SURGERY", "laterality": "RIGHT",
       "performed_by": "Dr. Alok Agarwal",
       "anesthesia": {"type": "SPINAL"},
       "implants_used": [{"implant_name": "Acetabular cup",
                          "manufacturer": "Smith & Nephew", "quantity": 1}],
       "status": "COMPLETED"
     }]},
    {"phase_code": "DISCHARGE", "phase_number": 3, "phase_name": "Discharge",
     "location": "WARD", "start_datetime": "2025-12-31T12:00:00+05:30",
     "outcome": {"disposition": "DISCHARGED", "clinical_status": "IMPROVED"}}
  ],
  "diagnosis": {
    "primary_diagnosis": {
      "icd_code": "M16.1", "icd_version": "ICD10",
      "diagnosis_name": "Right Hip Primary Osteoarthritis",
      "certainty": "CONFIRMED", "diagnosis_date": "2025-12-23"
    },
    "comorbidities": [{"condition_name": "Hypertension", "status": "CONTROLLED"}]
  },
  "stay_summary": {
    "admission_datetime": "2025-12-23T11:40:00+05:30",
    "discharge_datetime": "2025-12-31T12:00:00+05:30",
    "total_los": {"value": 8, "unit": "DAYS"}
  },
  "financial_summary": {
    "currency": "INR", "actual_total_cost": 125000,
    "package_details": {"is_package": true, "package_name": "PMJAY THR Package"}
  }
}

────────────────────────────────────────────────────────────────────
HARMONISATION RULES
────────────────────────────────────────────────────────────────────
1.  COPY-WHEN-PRESENT. If an extracted field directly maps to a
    canonical leaf (patient name → patient_context.first_name +
    last_name), use it verbatim. Do NOT paraphrase, normalise case,
    or "improve" it.

2.  TYPE-COERCE conservatively. Numeric strings → numbers. Date
    strings → ISO format if you can parse them unambiguously, else
    pass through as-is. NEVER guess a date — emit the raw string and
    drop into a comment-style field if needed.

3.  INFER PHASES from events_summary + section categories. Even if
    no explicit "phase" data exists, an admission timestamp +
    discharge timestamp imply at minimum {ADMISSION, DISCHARGE}
    phases. Add INTRA_OPERATIVE if procedure docs/sections exist.
    Add ICU_ADMISSION if ICU charges/section present. Phase
    enumeration must be from the canonical list.

4.  CITE PROVENANCE — for every leaf you populate, you must be able
    to point at a SOURCE: an extracted field, a doc section, or a
    dossier slot. Do NOT invent values. If the inputs only support
    "age ~55", emit age=55 and lower the data_completeness_score.

5.  OMIT what you don't have. The schema is lenient; missing fields
    are fine. Do not fill diagnosis_date with today's date just
    because the slot exists.

6.  episode_type is judged HOLISTICALLY:
      - any major/minor surgery procedure → SURGICAL
      - acute admission, no procedure → MEDICAL_MANAGEMENT
      - delivery / antenatal → MATERNITY
      - same-day-discharge → DAYCARE
      - emergency presentation with admission → EMERGENCY then later phase
      - long-term condition with planned admission → CHRONIC_CARE
    When ambiguous, prefer the more specific type and lower
    data_completeness_score.

7.  data_completeness_score:
      - 1.0 = every canonical section populated from clean inputs
      - 0.7-0.9 = good coverage, some optional leaves missing
      - 0.5-0.7 = critical leaves present, sub-objects sparse
      - 0.3-0.5 = partial harmonisation: required leaves only
      - <0.3 = degenerate; status='partial' downstream
    Be honest — adjudication uses this to decide whether to trust
    derived signals from your output.

8.  NEVER emit fields the schema doesn't define. If the inputs
    contain something interesting that doesn't map to a canonical
    leaf, drop it. Don't invent custom keys.

OUTPUT FORMAT:
  Return ONE JSON object inside a \`\`\`json fence. No preamble, no
  trailing commentary. The downstream Zod schema will reject anything
  malformed.`;

// ─── User prompt builder ───────────────────────────────────────────────
// Compact summaries of:
//   - dossier (~600 tokens)
//   - sections grouped by category (~1.5k tokens for ≤30 sections)
//   - extracted fields keyed by category (~1.5k tokens)
//   - IPD / hospital seed facts (~150 tokens)
// Total target: ≤4k tokens.

export interface HarmoniserSectionInput {
  section_id: string;
  document_id: string;
  document_filename: string | null;
  document_s3_key: string | null;
  category: string | null;
  classifier_confidence: number | null;
  page_start: number | null;
  page_end: number | null;
  title: string | null;
  status: string | null;
  extracted_fields: any | null;
  extraction_confidence: any | null;
}

export interface HarmoniserSeedFacts {
  claim_id: string;
  hospital_id: string;
  hospital_name?: string | null;
  patient_first_name?: string | null;
  patient_last_name?: string | null;
  admission_type?: string | null;
  panel_id?: string | null;
  insurer_id?: string | null;
}

/**
 * Compact dossier summary for the harmoniser. Different shape from the
 * reasoningAgent summary — here we lean on patient + amounts +
 * sections + events; we skip the rules-engine and adjudication state.
 */
export function buildHarmoniserDossierSummary(dossier: ClaimDossier): string {
  const lines: string[] = [];
  lines.push(`CLAIM_ID: ${dossier.claim_id}`);
  if (dossier.current_stage) lines.push(`CURRENT_STAGE: ${dossier.current_stage}`);
  if (dossier.current_panel_id) lines.push(`PANEL: ${dossier.current_panel_id}`);
  if (dossier.current_insurer_id) lines.push(`INSURER/TPA: ${dossier.current_insurer_id}`);

  const ps: any = dossier.patient_summary ?? {};
  const patientBits: string[] = [];
  for (const k of [
    'first_name',
    'last_name',
    'name',
    'uhid',
    'age',
    'gender',
    'room',
    'admission_type',
    'admission_date',
    'discharge_date',
    'primary_diagnosis',
    'procedure',
  ]) {
    if (ps[k] != null && ps[k] !== '') patientBits.push(`${k}=${ps[k]}`);
  }
  if (patientBits.length) lines.push(`PATIENT: ${patientBits.join(', ')}`);

  const amt: any = dossier.amounts ?? {};
  const amtBits: string[] = [];
  for (const k of [
    'claimed',
    'pre_auth_approved',
    'enhancement_approved',
    'final_approved',
    'deducted',
    'patient_share',
  ]) {
    if (amt[k] != null) amtBits.push(`${k}=₹${amt[k]}`);
  }
  if (amtBits.length) lines.push(`AMOUNTS: ${amtBits.join(', ')}`);

  const sections = dossier.doc_sections_by_category ?? {};
  const sectionKeys = Object.keys(sections);
  if (sectionKeys.length) {
    lines.push(
      `DOC_CATEGORIES: ${sectionKeys
        .map((k) => `${k}(${(sections as any)[k]?.length ?? 0})`)
        .join(', ')}`,
    );
  }

  const evs = dossier.events_summary ?? [];
  if (evs.length) {
    const recent = evs.slice(-10);
    lines.push(`RECENT_EVENTS (last ${recent.length}):`);
    for (const e of recent) {
      lines.push(`  - ${e.at} ${e.kind}`);
    }
  }

  if (dossier.closed_at) {
    lines.push(`CLOSED_AT: ${dossier.closed_at.toISOString?.() ?? dossier.closed_at}`);
    if (dossier.closure_outcome) lines.push(`CLOSURE_OUTCOME: ${dossier.closure_outcome}`);
  }

  return lines.join('\n');
}

/**
 * Compact representation of the per-section extractions. We group by
 * category so the harmoniser can scan e.g. all `discharge_summary`
 * sections together. Each section emits:
 *   - section_id, document filename, page range, classifier confidence
 *   - extracted_fields (truncated to ~600 chars of JSON per section)
 *   - extraction confidence (max value, for chip-style hinting)
 */
function summariseSections(sections: HarmoniserSectionInput[]): string {
  if (!sections.length) return '(no document sections)';
  const grouped = new Map<string, HarmoniserSectionInput[]>();
  for (const s of sections) {
    const cat = s.category ?? 'unclassified';
    const arr = grouped.get(cat) ?? [];
    arr.push(s);
    grouped.set(cat, arr);
  }
  const lines: string[] = [];
  for (const [cat, arr] of grouped) {
    lines.push(`### category=${cat} (${arr.length} section${arr.length === 1 ? '' : 's'})`);
    for (const s of arr) {
      const head = [
        `section_id=${s.section_id}`,
        s.document_filename ? `file="${s.document_filename}"` : null,
        s.page_start != null
          ? `pages=${s.page_start}${s.page_end != null ? `-${s.page_end}` : ''}`
          : null,
        s.classifier_confidence != null
          ? `clf_conf=${s.classifier_confidence.toFixed(2)}`
          : null,
        s.title ? `title="${s.title.slice(0, 60)}"` : null,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`  - ${head}`);
      if (s.extracted_fields && typeof s.extracted_fields === 'object') {
        const json = JSON.stringify(s.extracted_fields);
        lines.push(
          `    fields: ${json.length > 600 ? json.slice(0, 600) + '...<truncated>' : json}`,
        );
      }
    }
  }
  return lines.join('\n');
}

export function buildUserPrompt(args: {
  dossier: ClaimDossier;
  sections: HarmoniserSectionInput[];
  seed: HarmoniserSeedFacts;
}): string {
  const parts: string[] = [];
  parts.push('=== SEED_FACTS ===');
  const seedBits: string[] = [];
  seedBits.push(`claim_id=${args.seed.claim_id}`);
  seedBits.push(`hospital_id=${args.seed.hospital_id}`);
  if (args.seed.hospital_name) seedBits.push(`hospital_name="${args.seed.hospital_name}"`);
  if (args.seed.patient_first_name)
    seedBits.push(`patient_first_name="${args.seed.patient_first_name}"`);
  if (args.seed.patient_last_name)
    seedBits.push(`patient_last_name="${args.seed.patient_last_name}"`);
  if (args.seed.admission_type) seedBits.push(`admission_type=${args.seed.admission_type}`);
  if (args.seed.panel_id) seedBits.push(`panel_id=${args.seed.panel_id}`);
  if (args.seed.insurer_id) seedBits.push(`insurer_id=${args.seed.insurer_id}`);
  parts.push(seedBits.join('\n'));
  parts.push('');
  parts.push('=== DOSSIER_SUMMARY ===');
  parts.push(buildHarmoniserDossierSummary(args.dossier));
  parts.push('');
  parts.push('=== DOCUMENT_SECTIONS_AND_EXTRACTIONS ===');
  parts.push(summariseSections(args.sections));
  parts.push('');
  parts.push(
    `TASK: Produce ONE JSON document — an instance of claimsos.canonical.medical_episode.v2 — that fuses the above inputs into the canonical shape. Use claim_id="${args.seed.claim_id}" as episode_id. Omit fields the inputs don't support. Return JSON only, inside a \`\`\`json fence.`,
  );
  return parts.join('\n');
}
