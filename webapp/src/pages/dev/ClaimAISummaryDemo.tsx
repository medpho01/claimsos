/**
 * Wave 9 — Claim AI Summary dev demo.
 *
 * Not routed. Render ad-hoc by temporarily importing it from App.tsx
 * during review:
 *
 *   import ClaimAISummaryDemo from '@/pages/dev/ClaimAISummaryDemo';
 *
 * Three demo variants: Empty / Partial / Full. Uses the KhatoonTHR
 * canonical example as the seed for the harmonised episode.
 */

import React, { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ClaimAISummary } from '@/pages/hospital/ClaimAISummary';
import type { HarmonisedEpisode } from '@/hooks/intelligence/useHarmonisedEpisode';
import type { RulesV2Result } from '@/hooks/intelligence/useRulesV2';
import type { AdjudicationReport } from '@/hooks/intelligence';
import type { AiAuditTrailRow } from '@/hooks/intelligence/useAiAuditTrail';

// ─── Mock data ────────────────────────────────────────────────────────────

const MOCK_HARMONISED: HarmonisedEpisode = {
  meta: {
    schema_version: 'claimsos.canonical.medical_episode.v2',
    episode_id: 'EP_2025_KHATOON_THR',
    episode_type: 'SURGICAL',
    episode_subtype: 'ORTHOPEDIC_JOINT_REPLACEMENT',
    episode_category: 'ELECTIVE',
    treatment_intent: 'CURATIVE',
    created_at: '2025-12-23T11:40:00+05:30',
    last_updated_at: '2025-12-31T12:49:00+05:30',
    data_completeness_score: 0.92,
    verification_status: 'VERIFIED',
  },
  patient_context: {
    patient_id: 'PAT_KHATOON_23730',
    uhid: '23730',
    first_name: 'Khatoon',
    age: 54,
    age_unit: 'YEARS',
    gender: 'F',
    address: { city: 'Moradabad', state: 'Uttar Pradesh' },
  },
  hospital_context: {
    hospital_id: 'HOSP_SADBHAVNA_001',
    ipd_number: '155',
    name: 'Sadbhavna Nursing Home',
    type: 'NURSING_HOME',
    specialties: ['ORTHOPEDICS'],
    treating_team: {
      primary_consultant: {
        name: 'Dr. Alok Agarwal',
        specialization: 'Orthopaedics',
        qualification: 'MBBS, MS (Orthopaedics)',
      },
    },
  },
  insurance_context: {
    policy_number: 'PM JAY Policy',
    insurer_name: 'PM JAY',
    insurer_tpa: 'PM JAY',
    policy_type: 'GOVERNMENT_SCHEME',
    scheme_name: 'Pradhan Mantri Jan Arogya Yojana',
    sum_insured: { amount: 500000, currency: 'INR' },
  },
  clinical_timeline: [
    {
      phase_code: 'ADMISSION',
      phase_number: 1,
      phase_name: 'Hospital Admission',
      location: 'WARD',
      start_datetime: '2025-12-23T11:40:00+05:30',
      end_datetime: '2025-12-26T08:00:00+05:30',
      duration: { value: 68.33, unit: 'HOURS' },
      presentation: {
        chief_complaints: [
          { complaint: 'Pain right hip', duration: '2 years', severity: 'SEVERE' },
        ],
      },
      clinical_assessment: { provisional_diagnosis: ['AVN RT HIP'] },
    },
    {
      phase_code: 'PRE_OPERATIVE',
      phase_number: 2,
      phase_name: 'Pre-operative Phase',
      location: 'WARD',
      start_datetime: '2025-12-26T08:00:00+05:30',
      end_datetime: '2025-12-26T18:00:00+05:30',
      duration: { value: 10, unit: 'HOURS' },
      diagnostics_performed: [
        {
          diagnostic_id: 'DIAG_001_XRAY',
          diagnostic_meta: {
            category: 'RADIOLOGY',
            test_name_raw: 'X-Ray Pelvis with Both Hips',
          },
          results: { summary_findings: 'AVN of right hip demonstrated' },
        },
      ],
    },
    {
      phase_code: 'INTRA_OPERATIVE',
      phase_number: 3,
      phase_name: 'Total Hip Replacement Surgery',
      location: 'OT',
      start_datetime: '2025-12-27T09:00:00+05:30',
      end_datetime: '2025-12-27T12:30:00+05:30',
      duration: { value: 3.5, unit: 'HOURS' },
      procedures_performed: [
        {
          procedure_id: 'PROC_001_THR',
          procedure_name: 'Total Hip Replacement',
          procedure_type: 'MAJOR_SURGERY',
          laterality: 'RIGHT',
          performed_by: 'Dr. Alok Agarwal',
          anesthesia: { type: 'SPINAL' },
        },
      ],
    },
    {
      phase_code: 'POST_OPERATIVE',
      phase_number: 4,
      phase_name: 'Post-operative Recovery',
      location: 'WARD',
      start_datetime: '2025-12-27T12:30:00+05:30',
      end_datetime: '2025-12-31T08:00:00+05:30',
      duration: { value: 91.5, unit: 'HOURS' },
      interventions: [
        { type: 'MEDICATION', item: 'Ceftriaxone', dose: '1g', route: 'INTRAVENOUS' },
        { type: 'MEDICATION', item: 'Tramadol', dose: '50mg', route: 'INTRAVENOUS' },
        { type: 'MEDICATION', item: 'Pantoprazole', dose: '40mg', route: 'ORAL' },
      ],
    },
    {
      phase_code: 'DISCHARGE',
      phase_number: 5,
      phase_name: 'Discharge',
      location: 'WARD',
      start_datetime: '2025-12-31T08:00:00+05:30',
      end_datetime: '2025-12-31T12:00:00+05:30',
      duration: { value: 4, unit: 'HOURS' },
    },
  ],
  diagnosis: {
    primary_diagnosis: {
      icd_code: 'M87.051',
      diagnosis_name: 'Idiopathic aseptic necrosis of right femur',
      certainty: 'CONFIRMED',
      diagnosis_date: '2025-12-23',
    },
    secondary_diagnosis: [
      {
        icd_code: 'I10',
        diagnosis_name: 'Essential hypertension',
      },
    ],
    comorbidities: [
      { icd_code: 'E11', condition_name: 'Type 2 Diabetes Mellitus', status: 'CONTROLLED' },
    ],
  },
  stay_summary: {
    admission_datetime: '2025-12-23T11:40:00+05:30',
    discharge_datetime: '2025-12-31T12:00:00+05:30',
    total_los: { value: 8.02, unit: 'DAYS' },
  },
  financial_summary: {
    currency: 'INR',
    estimated_total_cost: 195000,
    actual_total_cost: 189500,
    breakdown: {
      room_charges: { total_room_charges: 24000 },
      professional_fees: { total_professional_fees: 45000 },
      investigation_charges: { total_investigation_charges: 8500 },
      pharmacy_charges: { total_pharmacy_charges: 12000 },
      procedure_charges: { total_procedure_charges: 25000 },
      implant_charges: { total_implant_cost: 65000 },
      consumables: { total_consumables: 6500 },
      other_charges: { total_other_charges: 3500 },
    },
    insurance_coverage: {
      claimed_amount: 189500,
      approved_amount: 165000,
      rejected_amount: 24500,
    },
  },
  discharge_summary: {
    discharge_date: '2025-12-31',
    discharge_time: '12:00',
    discharge_type: 'REGULAR',
    discharge_condition: 'IMPROVED',
    final_diagnosis: ['AVN Right Hip - status post Total Hip Replacement'],
    course_in_hospital:
      'Patient underwent uneventful right Total Hip Replacement under spinal anesthesia. Post-op recovery was unremarkable. Mobilised on POD-2 with walker. Wound healed primarily.',
    follow_up_instructions: [
      'Follow up in OPD after 1 week',
      'Suture removal on POD-12',
      'Physiotherapy as per advised protocol',
    ],
  },
  _provenance: {
    '/diagnosis/primary_diagnosis/icd_code': {
      section_label: 'Discharge Summary p.1',
      confidence: 0.91,
      llm_provider: 'anthropic',
      llm_model: 'claude-opus-4-5',
      prompt_version: 'diagnosis_extract_v3',
    },
    '/diagnosis/primary_diagnosis/diagnosis_name': {
      section_label: 'Discharge Summary p.1',
      confidence: 0.94,
      llm_provider: 'anthropic',
      llm_model: 'claude-opus-4-5',
      prompt_version: 'diagnosis_extract_v3',
    },
    '/patient_context/age': {
      section_label: 'Admission Form p.1',
      confidence: 0.99,
      llm_provider: 'anthropic',
      llm_model: 'claude-haiku-4-5',
      prompt_version: 'patient_extract_v2',
    },
    '/insurance_context/sum_insured/amount': {
      section_label: 'Policy Card',
      confidence: 0.88,
      llm_provider: 'openai',
      llm_model: 'gpt-4o',
      prompt_version: 'policy_extract_v1',
    },
    '/stay_summary/total_los/value': {
      section_label: 'Discharge Summary p.2',
      confidence: 0.82,
      llm_provider: 'anthropic',
      llm_model: 'claude-opus-4-5',
      prompt_version: 'stay_summary_v1',
    },
  },
};

const MOCK_DOSSIER = {
  claim_id: 'demo-claim-001',
  current_stage: 'pre_auth_request_sent',
  amounts: [],
  doc_sections_by_category: {
    discharge_summary: [
      {
        id: 'sec-1',
        document_id: 'doc-discharge-1',
        category: 'discharge_summary',
        page_start: 1,
        page_end: 3,
        classification_confidence: 0.94,
        status: 'reviewed' as const,
      },
    ],
    final_bill: [
      {
        id: 'sec-2',
        document_id: 'doc-bill-1',
        category: 'final_bill',
        page_start: 1,
        page_end: 2,
        classification_confidence: 0.88,
        status: 'classified' as const,
      },
    ],
    investigation_report: [
      {
        id: 'sec-3',
        document_id: 'doc-investigation-1',
        category: 'investigation_report',
        page_start: 1,
        page_end: 1,
        classification_confidence: 0.71,
        status: 'classified' as const,
      },
      {
        id: 'sec-4',
        document_id: 'doc-investigation-1',
        category: 'investigation_report',
        page_start: 2,
        page_end: 4,
        classification_confidence: 0.55,
        status: 'pending' as const,
      },
    ],
    operative_notes: [
      {
        id: 'sec-5',
        document_id: 'doc-ot-1',
        category: 'operative_notes',
        page_start: 1,
        page_end: 2,
        classification_confidence: 0.92,
        status: 'reviewed' as const,
      },
    ],
    pre_auth_form: [
      {
        id: 'sec-6',
        document_id: 'doc-pa-1',
        category: 'pre_auth_form',
        page_start: 1,
        page_end: 1,
        classification_confidence: 0.41,
        status: 'pending' as const,
      },
    ],
  },
  events_summary: [],
  inbound_emails: [],
  outbound_submissions: [],
  active_queries: [],
  pending_actions: [],
  active_adjudication: null,
  ai_drafts_pending: [],
  matched_kb_patterns: [],
  closed_at: null,
  closure_outcome: null,
  retrospective_summary: null,
  updated_at: new Date().toISOString(),
};

const MOCK_RULES: RulesV2Result = {
  rule_set_id: 'rs-pmjay-orthopedic-v3',
  rule_set_name: 'PM JAY · Orthopedic THR · v3',
  insurer_code: 'PMJAY',
  treatment_type: 'ORTHOPEDIC_JOINT_REPLACEMENT',
  readiness_score: 72,
  evaluated_at: new Date().toISOString(),
  evaluations: [
    {
      rule_id: 'rule-1',
      rule_code: 'POL.ACTIVE',
      rule_name: 'Policy must be active on admission date',
      rule_description:
        'PM JAY card must be active and the family must be on the eligible beneficiary list.',
      category: 'POLICY_ELIGIBILITY',
      severity: 'CRITICAL',
      status: 'PASS',
      evidence: { policy_status: 'ACTIVE', card_valid_till: '2026-03-31' },
    },
    {
      rule_id: 'rule-2',
      rule_code: 'POL.WAITPERIOD',
      rule_name: 'No waiting period applicable for this procedure',
      category: 'POLICY_ELIGIBILITY',
      severity: 'HIGH',
      status: 'PASS',
    },
    {
      rule_id: 'rule-3',
      rule_code: 'DOC.DISCHARGE',
      rule_name: 'Discharge summary signed by treating consultant',
      rule_description:
        'Discharge summary must carry a legible signature + reg. number of the treating consultant.',
      category: 'DOCUMENT_COMPLETENESS',
      severity: 'HIGH',
      status: 'PASS',
      evidence: { signer: 'Dr. Alok Agarwal', reg: '41254' },
    },
    {
      rule_id: 'rule-4',
      rule_code: 'DOC.IMPLANT.STICKER',
      rule_name: 'Implant sticker present on bill / OT notes',
      rule_description:
        'High-cost implants must carry serial-number stickers attached to the OT notes or the final bill.',
      category: 'DOCUMENT_COMPLETENESS',
      severity: 'CRITICAL',
      status: 'FAIL',
      message: 'No implant sticker located in any of the uploaded documents.',
      remediation_guidance:
        'Re-upload the OT bundle with the implant sticker page included.',
      required_documents: ['operative_notes', 'final_bill'],
      query_template:
        'Please share the implant invoice / sticker for the THR prosthesis (manufacturer, model, serial number).',
      estimated_deduction_amount: 65000,
    },
    {
      rule_id: 'rule-5',
      rule_code: 'CLIN.DXPROC.MATCH',
      rule_name: 'Diagnosis matches the procedure indication',
      category: 'CLINICAL_APPROPRIATENESS',
      severity: 'HIGH',
      status: 'PASS',
      evidence: { diagnosis: 'AVN Right Hip', procedure: 'Total Hip Replacement' },
    },
    {
      rule_id: 'rule-6',
      rule_code: 'FIN.PKG.WITHINLIMIT',
      rule_name: 'Claim amount within PM JAY package limit',
      category: 'FINANCIAL_LIMITS',
      severity: 'HIGH',
      status: 'WARN',
      message:
        'Claimed ₹ 1,89,500 exceeds standard package by ₹ 14,500 — partial deduction expected.',
      estimated_deduction_amount: 14500,
    },
    {
      rule_id: 'rule-7',
      rule_code: 'PROC.CONSENT',
      rule_name: 'Surgical consent on file',
      category: 'PROCEDURAL_COMPLIANCE',
      severity: 'CRITICAL',
      status: 'OVERRIDDEN',
      override: {
        overridden_by: 'Kratika',
        overridden_at: '2026-05-17T11:30:00.000Z',
        reason: 'Consent originally on paper, scan uploaded out-of-band on 17-May.',
      },
    },
    {
      rule_id: 'rule-8',
      rule_code: 'TEMP.PA.STILLVALID',
      rule_name: 'Pre-authorisation still valid on discharge date',
      category: 'TEMPORAL_VALIDITY',
      severity: 'MEDIUM',
      status: 'SKIP',
      message: 'Skipped — no pre-auth has been raised for this claim yet.',
    },
  ],
};

const MOCK_VERDICT: AdjudicationReport = {
  id: 'rpt-demo-001',
  claim_id: 'demo-claim-001',
  readiness: 0.72,
  recommended_action: 'review',
  blocking_gaps: [
    {
      id: 'g-1',
      doc_category: 'operative_notes',
      severity: 'blocker',
      message: 'Implant sticker missing from operative bundle.',
      fix_hint: 'Add the sticker page to the operative_notes PDF and re-upload.',
    },
  ],
  warnings: [
    {
      id: 'w-1',
      message: 'Package overrun of ₹ 14,500 likely to be deducted by PM JAY.',
      severity: 'medium',
    },
  ],
  predicted_outcome: {
    amount: 165000,
    p_approval: 0.62,
    p_partial: 0.31,
    p_query: 0.07,
    expected_value_inr: 142_000,
  },
  citations: {
    rule_ids: ['rule-4', 'rule-6'],
    pattern_ids: ['pat-thr-pmjay-01'],
    case_ids: ['case-2024-Q4-117'],
  },
  generated_at: '2026-05-18T10:42:00.000Z',
};

const MOCK_AUDIT: AiAuditTrailRow[] = [
  {
    id: 'log-1',
    task: 'document_classification',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    prompt_version: 'classify_doc_v4',
    cost_inr: 0.142,
    latency_ms: 850,
    tokens_input_uncached: 1200,
    tokens_input_cached: 0,
    tokens_output: 250,
    created_at: '2026-05-17T08:30:00.000Z',
    succeeded: true,
    confidence: 0.92,
  },
  {
    id: 'log-2',
    task: 'document_classification',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    prompt_version: 'classify_doc_v4',
    cost_inr: 0.118,
    latency_ms: 720,
    tokens_input_uncached: 200,
    tokens_input_cached: 900,
    tokens_output: 230,
    created_at: '2026-05-17T08:31:00.000Z',
    succeeded: true,
    confidence: 0.88,
  },
  {
    id: 'log-3',
    task: 'section_extraction',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    prompt_version: 'extract_section_v6',
    cost_inr: 1.342,
    latency_ms: 4220,
    tokens_input_uncached: 4800,
    tokens_input_cached: 1200,
    tokens_output: 1450,
    created_at: '2026-05-17T08:33:00.000Z',
    succeeded: true,
    confidence: 0.85,
  },
  {
    id: 'log-4',
    task: 'section_extraction',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    prompt_version: 'extract_section_v6',
    cost_inr: 0.92,
    latency_ms: 3950,
    tokens_input_uncached: 600,
    tokens_input_cached: 5400,
    tokens_output: 1180,
    created_at: '2026-05-17T08:35:00.000Z',
    succeeded: true,
    confidence: 0.81,
  },
  {
    id: 'log-5',
    task: 'section_extraction',
    provider: 'openai',
    model: 'gpt-4o',
    prompt_version: 'extract_section_v6',
    cost_inr: 0.65,
    latency_ms: 2880,
    tokens_input_uncached: 3200,
    tokens_input_cached: 0,
    tokens_output: 980,
    created_at: '2026-05-17T08:36:00.000Z',
    succeeded: false,
    error_message: 'Rate-limit exceeded — retried via anthropic.',
  },
  {
    id: 'log-6',
    task: 'harmonisation',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    prompt_version: 'harmonise_v9',
    cost_inr: 2.18,
    latency_ms: 6500,
    tokens_input_uncached: 8200,
    tokens_input_cached: 0,
    tokens_output: 2800,
    created_at: '2026-05-17T08:40:00.000Z',
    succeeded: true,
    confidence: 0.89,
    meta: { episode_id: 'EP_2025_KHATOON_THR' },
  },
  {
    id: 'log-7',
    task: 'harmonisation',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    prompt_version: 'harmonise_v9',
    cost_inr: 1.95,
    latency_ms: 6100,
    tokens_input_uncached: 1200,
    tokens_input_cached: 7000,
    tokens_output: 2600,
    created_at: '2026-05-17T09:10:00.000Z',
    succeeded: true,
    confidence: 0.9,
  },
  {
    id: 'log-8',
    task: 'rule_evaluation',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    prompt_version: 'rules_eval_v2',
    cost_inr: 0.48,
    latency_ms: 1800,
    tokens_input_uncached: 3100,
    tokens_input_cached: 0,
    tokens_output: 620,
    created_at: '2026-05-17T09:12:00.000Z',
    succeeded: true,
    confidence: 0.94,
  },
  {
    id: 'log-9',
    task: 'adjudication',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    prompt_version: 'adjudicate_v5',
    cost_inr: 1.62,
    latency_ms: 5400,
    tokens_input_uncached: 5800,
    tokens_input_cached: 1200,
    tokens_output: 1900,
    created_at: '2026-05-17T09:14:00.000Z',
    succeeded: true,
    confidence: 0.87,
  },
  {
    id: 'log-10',
    task: 'similar_case_lookup',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    prompt_version: 'similar_case_v1',
    cost_inr: 0.092,
    latency_ms: 540,
    tokens_input_uncached: 800,
    tokens_input_cached: 0,
    tokens_output: 180,
    created_at: '2026-05-17T09:15:00.000Z',
    succeeded: true,
    confidence: 0.76,
  },
  {
    id: 'log-11',
    task: 'query_draft',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    prompt_version: 'draft_query_v3',
    cost_inr: 0.38,
    latency_ms: 1450,
    tokens_input_uncached: 2200,
    tokens_input_cached: 0,
    tokens_output: 540,
    created_at: '2026-05-18T07:20:00.000Z',
    succeeded: true,
    confidence: 0.83,
  },
  {
    id: 'log-12',
    task: 'query_draft',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    prompt_version: 'draft_query_v3',
    cost_inr: 0.31,
    latency_ms: 1200,
    tokens_input_uncached: 300,
    tokens_input_cached: 2000,
    tokens_output: 480,
    created_at: '2026-05-18T07:25:00.000Z',
    succeeded: true,
    confidence: 0.85,
  },
  {
    id: 'log-13',
    task: 'harmonisation',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    prompt_version: 'harmonise_v9',
    cost_inr: 0,
    latency_ms: 120,
    tokens_input_uncached: 0,
    tokens_input_cached: 0,
    tokens_output: 0,
    created_at: '2026-05-18T08:00:00.000Z',
    succeeded: false,
    error_message: 'Schema validation failed: missing required field meta.episode_id.',
  },
  {
    id: 'log-14',
    task: 'adjudication',
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    prompt_version: 'adjudicate_v5',
    cost_inr: 1.7,
    latency_ms: 5600,
    tokens_input_uncached: 6100,
    tokens_input_cached: 0,
    tokens_output: 2000,
    created_at: '2026-05-18T10:42:00.000Z',
    succeeded: true,
    confidence: 0.88,
  },
  {
    id: 'log-15',
    task: 'rule_evaluation',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    prompt_version: 'rules_eval_v2',
    cost_inr: 0.51,
    latency_ms: 1880,
    tokens_input_uncached: 3300,
    tokens_input_cached: 0,
    tokens_output: 640,
    created_at: '2026-05-18T10:44:00.000Z',
    succeeded: true,
    confidence: 0.93,
  },
];

// ─── Demo wrapper ─────────────────────────────────────────────────────────

type DemoState = 'empty' | 'partial' | 'full';

const EMPTY_DOSSIER = {
  ...MOCK_DOSSIER,
  doc_sections_by_category: {},
  current_stage: 'created',
};

const PARTIAL_DOSSIER = {
  ...MOCK_DOSSIER,
  doc_sections_by_category: {
    discharge_summary:
      MOCK_DOSSIER.doc_sections_by_category.discharge_summary,
    investigation_report:
      MOCK_DOSSIER.doc_sections_by_category.investigation_report,
  },
};

const PARTIAL_HARMONISED: HarmonisedEpisode = {
  meta: MOCK_HARMONISED.meta,
  patient_context: MOCK_HARMONISED.patient_context,
  hospital_context: MOCK_HARMONISED.hospital_context,
  diagnosis: MOCK_HARMONISED.diagnosis,
  _provenance: MOCK_HARMONISED._provenance,
};

const PARTIAL_RULES: RulesV2Result = {
  ...MOCK_RULES,
  readiness_score: 48,
  evaluations: MOCK_RULES.evaluations.slice(0, 4),
};

const PARTIAL_VERDICT: AdjudicationReport = {
  ...MOCK_VERDICT,
  readiness: 0.48,
  recommended_action: 'request_doc',
};

const ClaimAISummaryDemo: React.FC = () => {
  const [state, setState] = useState<DemoState>('full');

  const overrides = (() => {
    if (state === 'empty') {
      return {
        dossier: EMPTY_DOSSIER,
        harmonised: null,
        rules: { ...MOCK_RULES, no_match: true, evaluations: [] } as RulesV2Result,
        verdict: null,
        auditTrail: [] as AiAuditTrailRow[],
      };
    }
    if (state === 'partial') {
      return {
        dossier: PARTIAL_DOSSIER,
        harmonised: PARTIAL_HARMONISED,
        rules: PARTIAL_RULES,
        verdict: PARTIAL_VERDICT,
        auditTrail: MOCK_AUDIT.slice(0, 5),
      };
    }
    return {
      dossier: MOCK_DOSSIER,
      harmonised: MOCK_HARMONISED,
      rules: MOCK_RULES,
      verdict: MOCK_VERDICT,
      auditTrail: MOCK_AUDIT,
    };
  })();

  return (
    <MemoryRouter
      initialEntries={['/portal/hospital-1/patient/demo-claim-001/ai-summary']}
    >
      <div>
        <div className="bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 px-6 py-2 text-xs flex items-center gap-3 sticky top-0 z-50">
          <span className="font-semibold text-amber-900 dark:text-amber-200">
            DEMO
          </span>
          <span className="text-amber-700 dark:text-amber-300">
            Mock data — no network calls. Toggle variants:
          </span>
          {(['empty', 'partial', 'full'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setState(v)}
              className={
                v === state
                  ? 'rounded-md bg-amber-200 dark:bg-amber-800/60 px-2 py-0.5 font-medium text-amber-900 dark:text-amber-100'
                  : 'rounded-md px-2 py-0.5 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40'
              }
            >
              {v}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-amber-700/70 dark:text-amber-300/70">
            Wave 9 · Claim AI Summary
          </span>
        </div>

        <Routes>
          <Route
            path="/portal/:hospitalId/patient/:patientId/ai-summary"
            element={
              <ClaimAISummary
                claimIdOverride="demo-claim-001"
                offline
                overrides={overrides}
              />
            }
          />
        </Routes>
      </div>
    </MemoryRouter>
  );
};

export default ClaimAISummaryDemo;
