/**
 * Wave 7 — Harmoniser Zod Schema
 *
 * Mirrors the canonical claimsos.canonical.medical_episode.v2 JSON
 * schema (see canonical-medical-documents/ReferenceStructure.json). Two
 * exports:
 *
 *   - HarmonisedEpisodeSchema: full but LENIENT — every top-level
 *     section is .partial() and nested optional sub-structures fall
 *     through z.record(z.unknown()). The LLM rarely produces a complete
 *     instance; partial harmonisation is the expected steady state. The
 *     provenance map (a sibling on the DB row, NOT on the JSON itself)
 *     tells us which JSONPath is filled, which is missing, and with
 *     what confidence.
 *
 *   - HarmonisedEpisodePartial: truly minimal — only meta +
 *     patient_context + diagnosis + clinical_timeline are required.
 *     Used as a fallback parse target when the lenient full schema
 *     still rejects. A row that validates against Partial but not Full
 *     is stored with status='partial'.
 *
 * Why lenient?
 *   - The canonical schema has 5+ levels of nesting, dozens of
 *     enums, and a lot of optional sub-objects. Strict Zod modeling
 *     would reject ~90% of LLM outputs on day one over a single
 *     ISO-date format slip or an out-of-list enum value.
 *   - The CONSUMERS of the harmonised episode (adjudication,
 *     prediction, KB miner, prefilled forms) can each tolerate
 *     missing fields and degrade gracefully. They don't need a
 *     guarantee that every enum value is in-list — they just need a
 *     stable shape.
 *   - z.unknown() / z.record(z.unknown()) on the deepest optional
 *     sub-fields preserves whatever the LLM emitted without throwing
 *     it away. A later wave (Wave 8?) can tighten these as we get
 *     evals on the harmoniser's output distribution.
 *
 * NOT a stable contract for downstream readers. Treat it as a
 * type-erasure boundary: read fields you care about defensively, with
 * fallbacks. The provenance map + the validation_metadata block on
 * the episode itself flag completeness.
 */

import { z } from 'zod';

// ─── Shared primitives ─────────────────────────────────────────────────
// Strings that look like dates / datetimes / money. We do NOT enforce
// format() at the Zod layer because LLMs often emit '2025-12-31 14:30'
// (space separator) or '31-Dec-2025' (Indian formatting). We accept
// whatever string the model produces and let downstream consumers do
// best-effort parsing.

const isoDate = z.string(); // looks like a date, may not parse
const isoDatetime = z.string();
const money = z
  .object({
    amount: z.number(),
    currency: z.string().optional(),
  })
  .partial()
  .passthrough();
const duration = z
  .object({
    value: z.number(),
    unit: z.string().optional(),
  })
  .partial()
  .passthrough();
const codeSystem = z
  .object({
    system: z.string().optional(),
    code: z.string().optional(),
    display: z.string().optional(),
    version: z.string().optional(),
  })
  .partial()
  .passthrough();

// ─── meta ──────────────────────────────────────────────────────────────
const Meta = z
  .object({
    schema_version: z.literal('claimsos.canonical.medical_episode.v2'),
    episode_id: z.string(),
    episode_type: z.string(),
    episode_subtype: z.string().optional(),
    episode_category: z.string().optional(),
    treatment_intent: z.string().optional(),
    created_at: isoDatetime,
    last_updated_at: isoDatetime.optional(),
    data_completeness_score: z.number().min(0).max(1).optional(),
    verification_status: z.string().optional(),
    source_system: z.record(z.unknown()).optional(),
  })
  .passthrough();

// ─── patient_context ───────────────────────────────────────────────────
const PatientContact = z
  .object({
    mobile: z.string().optional(),
    alternate_mobile: z.string().optional(),
    email: z.string().optional(),
    emergency_contact: z.record(z.unknown()).optional(),
  })
  .partial()
  .passthrough();

const PatientContext = z
  .object({
    patient_id: z.string(),
    uhid: z.string().optional(),
    first_name: z.string(),
    middle_name: z.string().optional(),
    last_name: z.string().optional(),
    age: z.number().min(0).optional().nullable(),
    age_unit: z.string().optional(),
    date_of_birth: isoDate.optional(),
    gender: z.string().optional().nullable(),
    blood_group: z.string().optional(),
    contact: PatientContact.optional(),
    address: z.record(z.unknown()).optional(),
    demographics: z.record(z.unknown()).optional(),
    identification: z.record(z.unknown()).optional(),
  })
  .passthrough();

// ─── hospital_context ──────────────────────────────────────────────────
const TreatingMember = z
  .object({
    name: z.string().optional(),
    registration_number: z.string().optional(),
    registration_council: z.string().optional(),
    specialization: z.string().optional(),
    qualification: z.string().optional(),
    department: z.string().optional(),
    role: z.string().optional(),
    contact: z.record(z.unknown()).optional(),
  })
  .partial()
  .passthrough();

const TreatingTeam = z
  .object({
    primary_consultant: TreatingMember.optional(),
    secondary_consultants: z.array(TreatingMember).optional(),
    surgeons: z.array(TreatingMember).optional(),
    support_staff: z.array(z.record(z.unknown())).optional(),
  })
  .partial()
  .passthrough();

const HospitalContext = z
  .object({
    hospital_id: z.string(),
    hospital_registration_id: z.string().optional(),
    ipd_number: z.string().optional(),
    mrn_number: z.string().optional(),
    name: z.string(),
    type: z.string().optional(),
    specialties: z.array(z.string()).optional(),
    accreditation: z.record(z.unknown()).optional(),
    rohini_code: z.string().optional(),
    address: z.record(z.unknown()).optional(),
    contact: z.record(z.unknown()).optional(),
    treating_team: TreatingTeam.optional(),
  })
  .passthrough();

// ─── insurance_context ─────────────────────────────────────────────────
const InsuranceContext = z
  .object({
    policy_number: z.string().optional(),
    insurer_name: z.string().optional(),
    insurer_code: z.string().optional(),
    insurer_tpa: z.string().optional(),
    tpa_code: z.string().optional(),
    policy_type: z.string().optional(),
    scheme_name: z.string().optional(),
    sum_insured: money.optional(),
    available_sum_insured: money.optional(),
    policy_start_date: isoDate.optional(),
    policy_end_date: isoDate.optional(),
    copay_percentage: z.number().optional(),
    deductible: money.optional(),
    waiting_periods: z.record(z.unknown()).optional(),
    room_eligibility: z.record(z.unknown()).optional(),
    sublimits: z.array(z.record(z.unknown())).optional(),
    exclusions: z.array(z.string()).optional(),
    claim_history: z.array(z.record(z.unknown())).optional(),
    pre_authorization: z.record(z.unknown()).optional(),
    enhancement_requests: z.array(z.record(z.unknown())).optional(),
  })
  .partial()
  .passthrough();

// ─── clinical_timeline ─────────────────────────────────────────────────
const Intervention = z
  .object({
    intervention_id: z.string().optional(),
    type: z.string().optional(),
    item: z.string().optional(),
    generic_name: z.string().optional(),
    dose: z.string().optional(),
    route: z.string().optional(),
    frequency: z.string().optional(),
    duration: z.string().optional(),
    timing: z.string().optional(),
    start_datetime: isoDatetime.optional(),
    end_datetime: isoDatetime.optional(),
    indication: z.string().optional(),
    prescribed_by: z.string().optional(),
  })
  .partial()
  .passthrough();

const DiagnosticPerformed = z
  .object({
    diagnostic_id: z.string().optional(),
    diagnostic_meta: z.record(z.unknown()).optional(),
    results: z.record(z.unknown()).optional(),
    images: z.array(z.record(z.unknown())).optional(),
    cost: money.optional(),
  })
  .partial()
  .passthrough();

const Procedure = z
  .object({
    procedure_id: z.string().optional(),
    procedure_code: codeSystem.optional(),
    procedure_name: z.string().optional(),
    procedure_name_normalized: z.string().optional(),
    procedure_type: z.string().optional(),
    laterality: z.string().optional(),
    performed_at: isoDatetime.optional(),
    duration: duration.optional(),
    performed_by: z.string().optional(),
    assisted_by: z.array(z.string()).optional(),
    department: z.string().optional(),
    indication: z.string().optional(),
    anesthesia: z.record(z.unknown()).optional(),
    operative_findings: z.string().optional(),
    procedure_details: z.string().optional(),
    technique: z.string().optional(),
    implants_used: z.array(z.record(z.unknown())).optional(),
    consumables_used: z.array(z.record(z.unknown())).optional(),
    blood_loss: z.string().optional(),
    specimens_sent: z.array(z.record(z.unknown())).optional(),
    complications: z.array(z.record(z.unknown())).optional(),
    status: z.string().optional(),
    post_procedure_instructions: z.string().optional(),
    cost: money.optional(),
  })
  .partial()
  .passthrough();

const Phase = z
  .object({
    phase_code: z.string(),
    phase_number: z.number().int().min(1),
    phase_name: z.string(),
    location: z.string(),
    bed_number: z.string().optional(),
    ward: z.string().optional(),
    room_category: z.string().optional(),
    start_datetime: isoDatetime.optional(),
    end_datetime: isoDatetime.optional(),
    duration: duration.optional(),
    presentation: z.record(z.unknown()).optional(),
    admission_details: z.record(z.unknown()).optional(),
    clinical_assessment: z.record(z.unknown()).optional(),
    interventions: z.array(Intervention).optional(),
    diagnostics_ordered: z.array(z.record(z.unknown())).optional(),
    diagnostics_performed: z.array(DiagnosticPerformed).optional(),
    procedures_performed: z.array(Procedure).optional(),
    daily_progress: z.array(z.record(z.unknown())).optional(),
    outcome: z.record(z.unknown()).optional(),
  })
  .passthrough();

const ClinicalTimeline = z.array(Phase).min(1);

// ─── diagnosis ─────────────────────────────────────────────────────────
const PrimaryDiagnosis = z
  .object({
    icd_code: z.string().optional(),
    icd_version: z.string().optional(),
    diagnosis_name: z.string(),
    diagnosis_type: z.string().optional(),
    certainty: z.string().optional(),
    diagnosis_date: isoDate.optional(),
    diagnosed_by: z.string().optional(),
    clinical_notes: z.string().optional(),
  })
  .passthrough();

const SecondaryDiagnosis = z
  .object({
    icd_code: z.string().optional(),
    icd_version: z.string().optional(),
    diagnosis_name: z.string().optional(),
    diagnosis_type: z.string().optional(),
    certainty: z.string().optional(),
    diagnosis_date: isoDate.optional(),
  })
  .partial()
  .passthrough();

const Diagnosis = z
  .object({
    primary_diagnosis: PrimaryDiagnosis,
    secondary_diagnosis: z.array(SecondaryDiagnosis).optional(),
    complications: z.array(z.record(z.unknown())).optional(),
    comorbidities: z.array(z.record(z.unknown())).optional(),
    pre_existing_diseases: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

// ─── stay_summary / financial_summary / discharge_summary / documents ─
const StaySummary = z
  .object({
    admission_datetime: isoDatetime.optional(),
    discharge_datetime: isoDatetime.optional(),
    total_los: duration.optional(),
    breakdown: z.array(z.record(z.unknown())).optional(),
    los_benchmark: z.record(z.unknown()).optional(),
  })
  .partial()
  .passthrough();

const FinancialSummary = z
  .object({
    currency: z.string().optional(),
    estimated_total_cost: z.number().optional(),
    actual_total_cost: z.number().optional(),
    breakdown: z.record(z.unknown()).optional(),
    package_details: z.record(z.unknown()).optional(),
    insurance_coverage: z.record(z.unknown()).optional(),
    payment_details: z.record(z.unknown()).optional(),
  })
  .partial()
  .passthrough();

const DischargeSummary = z
  .object({
    discharge_date: isoDate.optional(),
    discharge_time: z.string().optional(),
    discharge_type: z.string().optional(),
    discharge_condition: z.string().optional(),
    final_diagnosis: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    procedures_performed_summary: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    course_in_hospital: z.string().optional(),
    condition_at_discharge: z.string().optional(),
    discharge_medications: z.array(z.record(z.unknown())).optional(),
    follow_up_instructions: z.array(z.string()).optional(),
    activity_restrictions: z.array(z.string()).optional(),
    dietary_advice: z.string().optional(),
    wound_care_instructions: z.string().optional(),
    next_review_date: isoDate.optional(),
    follow_up_with: z.string().optional(),
    red_flag_symptoms: z.array(z.string()).optional(),
    fitness_certificate: z.record(z.unknown()).optional(),
  })
  .partial()
  .passthrough();

const Documents = z
  .object({
    admission_documents: z.array(z.record(z.unknown())).optional(),
    consent_forms: z.array(z.record(z.unknown())).optional(),
    clinical_notes: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    investigation_reports: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    procedure_notes: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    images: z.array(z.record(z.unknown())).optional(),
    discharge_documents: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    bills: z.array(z.record(z.unknown())).optional(),
    insurance_documents: z.array(z.record(z.unknown())).optional(),
  })
  .partial()
  .passthrough();

const ValidationMetadata = z
  .object({
    underwriting_flags: z.record(z.unknown()).optional(),
    document_checklist: z.array(z.record(z.unknown())).optional(),
    clinical_validation: z.record(z.unknown()).optional(),
    policy_validation: z.record(z.unknown()).optional(),
  })
  .partial()
  .passthrough();

// ─── Full + partial exports ────────────────────────────────────────────

/**
 * Full schema — lenient. Required: meta, patient_context, hospital_context,
 * clinical_timeline (≥1 phase), diagnosis (with primary_diagnosis.name).
 * Everything else is optional and falls through to z.record(z.unknown())
 * at deep optional leaves so LLM-produced extras don't get stripped.
 */
export const HarmonisedEpisodeSchema = z
  .object({
    meta: Meta,
    patient_context: PatientContext,
    hospital_context: HospitalContext,
    insurance_context: InsuranceContext.optional(),
    clinical_timeline: ClinicalTimeline,
    diagnosis: Diagnosis,
    stay_summary: StaySummary.optional(),
    financial_summary: FinancialSummary.optional(),
    discharge_summary: DischargeSummary.optional(),
    documents: Documents.optional(),
    validation_metadata: ValidationMetadata.optional(),
    claim_processing_metadata: z.record(z.unknown()).optional(),
    audit_trail: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export type HarmonisedEpisodeT = z.infer<typeof HarmonisedEpisodeSchema>;

/**
 * Minimal fallback schema — meta + patient_context + diagnosis +
 * clinical_timeline only. When the full lenient schema still rejects,
 * the service tries this as a last-resort parse target and persists with
 * status='partial'. Adjudication can still operate on a partial episode.
 */
export const HarmonisedEpisodePartial = z
  .object({
    meta: Meta.partial({ schema_version: true }).extend({
      schema_version: z.string(), // looser — partial may not echo the literal
    }),
    patient_context: PatientContext,
    clinical_timeline: ClinicalTimeline,
    diagnosis: Diagnosis,
  })
  .passthrough();

export type HarmonisedEpisodePartialT = z.infer<typeof HarmonisedEpisodePartial>;
