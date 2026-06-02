// =============================================================================
// Seed the stage-aware adjudication rule sets (the PDF's rules as DATA).
// Idempotent UPSERTs. Run: POSTGRES_HOST=localhost npx tsx src/scripts/seedAdjudicationRules.ts
//
// Doc-category codes below are REAL master_options(category='doc_category')
// codes observed in the local DB. Rule sets use the migration-068 selection
// dimensions; rules carry a `kind` + params (in validation_logic) for the
// Services/rules evaluators. applicable_treatments is left EMPTY on purpose so
// the legacy rulesEngineV2 (which requires a treatment match) ignores these and
// only the new stage-aware adjudicator (empty = wildcard) selects them.
// =============================================================================

import { pool } from '../DB/db.js';

interface SeedRule {
  ruleId: string;
  name: string;
  kind: string;
  category: string; // insurance_rules.category CHECK domain
  severity: string;
  impact: string;
  mandatory?: boolean;
  minConfidence?: number;
  params: Record<string, unknown>;
  failure: string;
}
interface SeedSet {
  ruleSetId: string;
  name: string;
  insurerCode: string | null;
  schemes: string[];
  routes: string[];
  stages: string[];
  caseTypes: string[];
  rules: SeedRule[];
}

const NAME_MATCH: SeedRule = {
  ruleId: 'NAME_MATCH',
  name: 'Patient name consistent across documents',
  kind: 'FUZZY_NAME',
  category: 'POLICY_ELIGIBILITY',
  severity: 'CRITICAL',
  impact: 'CLAIM_REJECTION',
  minConfidence: 0.4,
  params: {},
  failure: 'Patient name mismatch across KYC / diagnostics / prescription.',
};

const DISCHARGE_STAGES = ['discharge_draft', 'discharge_submitted', 'discharge_query_responded', 'discharge_approved', 'discharged'];
const PREAUTH_STAGES = ['draft', 'preauth_submitted', 'preauth_query_responded', 'preauth_approved'];

const SETS: SeedSet[] = [
  {
    ruleSetId: 'PMJAY_DISCHARGE_CONSERVATIVE_V1',
    name: 'PMJAY — Discharge (Conservative)',
    insurerCode: 'PMJAY',
    schemes: ['PMJAY'],
    routes: [],
    stages: DISCHARGE_STAGES,
    caseTypes: ['MEDICAL_MANAGEMENT'],
    rules: [
      {
        ruleId: 'CONS_DISCHARGE_DOCS',
        name: 'Conservative discharge documents present',
        kind: 'DOCUMENT_PRESENCE',
        category: 'DOCUMENT_COMPLETENESS',
        severity: 'HIGH',
        impact: 'QUERY',
        mandatory: true,
        params: { requiredCategories: ['discharge_slip', 'blood_test_reports', 'medication_charts'], mode: 'all' },
        failure: 'Conservative discharge requires discharge summary, investigations, and nursing/medication charts.',
      },
      {
        ruleId: 'DIAG_SUPPORTS_DISCHARGE',
        name: 'Diagnostics within 1 day before discharge',
        kind: 'TEMPORAL_WINDOW',
        category: 'TEMPORAL_VALIDITY',
        severity: 'MEDIUM',
        impact: 'QUERY',
        params: { docType: 'blood_test_reports', relativeTo: 'discharge', withinDays: 1, direction: 'before' },
        failure: 'No diagnostic report dated within 1 day before discharge to support discharge.',
      },
      NAME_MATCH,
    ],
  },
  {
    ruleSetId: 'PMJAY_DISCHARGE_SURGICAL_V1',
    name: 'PMJAY — Discharge (Surgical)',
    insurerCode: 'PMJAY',
    schemes: ['PMJAY'],
    routes: [],
    stages: DISCHARGE_STAGES,
    caseTypes: ['SURGICAL'],
    rules: [
      {
        ruleId: 'SURG_DISCHARGE_DOCS',
        name: 'Surgical discharge documents present',
        kind: 'DOCUMENT_PRESENCE',
        category: 'DOCUMENT_COMPLETENESS',
        severity: 'HIGH',
        impact: 'QUERY',
        mandatory: true,
        params: { requiredCategories: ['discharge_slip', 'ot_notes', 'surgery_consent_form', 'gps_tagged_patient_photos'], mode: 'all' },
        failure: 'Surgical discharge requires discharge summary, OT notes, consent, and GPS-tagged OT/patient photos.',
      },
      NAME_MATCH,
    ],
  },
  {
    ruleSetId: 'PMJAY_PREAUTH_V1',
    name: 'PMJAY — Pre-auth',
    insurerCode: 'PMJAY',
    schemes: ['PMJAY'],
    routes: [],
    stages: PREAUTH_STAGES,
    caseTypes: [],
    rules: [
      {
        ruleId: 'PREAUTH_DOCS',
        name: 'Pre-auth documents present',
        kind: 'DOCUMENT_PRESENCE',
        category: 'DOCUMENT_COMPLETENESS',
        severity: 'HIGH',
        impact: 'QUERY',
        mandatory: true,
        params: { requiredCategories: [['aadhaar_front', 'aadhaar_card', 'aadhaar_back'], 'pmjay_card', 'opd_notes', 'gps_tagged_patient_photos'], mode: 'all' },
        failure: 'Pre-auth requires KYC (Aadhaar + PMJAY card), doctor prescription, and a GPS-tagged patient photo.',
      },
      {
        ruleId: 'TREATMENT_DIAGNOSIS_COHERENCE',
        name: 'Prescription/treatment aligns with diagnostics & diagnosis',
        kind: 'LLM_COHERENCE',
        category: 'CLINICAL_APPROPRIATENESS',
        severity: 'MEDIUM',
        impact: 'QUERY',
        minConfidence: 0.6,
        params: {
          question: 'Do the OPD / prescription notes and the diagnostic reports support the recorded diagnosis (are they clinically consistent)?',
          sources: [
            { label: 'OPD / prescription', fromCategory: 'opd_notes' },
            { label: 'diagnostics', fromCategory: 'blood_test_reports' },
            { label: 'recorded diagnosis', fromEpisodePath: 'diagnosis.primary_diagnosis.diagnosis_name' },
          ],
        },
        failure: 'Prescribed treatment does not appear consistent with the diagnostics / recorded diagnosis.',
      },
      NAME_MATCH,
    ],
  },
  // --- Network Private Insurer (route = network) --------------------------------
  {
    ruleSetId: 'NETWORK_PRIVATE_PREAUTH_V1',
    name: 'Network Private Insurer — Pre-auth',
    insurerCode: null,
    schemes: ['NETWORK_PRIVATE'],
    routes: ['network'],
    stages: PREAUTH_STAGES,
    caseTypes: [],
    rules: [
      { ruleId: 'NP_PREAUTH_DOCS', name: 'Pre-auth documents present', kind: 'DOCUMENT_PRESENCE', category: 'DOCUMENT_COMPLETENESS', severity: 'HIGH', impact: 'QUERY', mandatory: true, params: { requiredCategories: [['aadhaar_front', 'aadhaar_card', 'aadhaar_back'], 'opd_notes', 'blood_test_reports'], mode: 'all' }, failure: 'Pre-auth requires policy card + Aadhaar, doctor prescription, and supporting diagnostics.' },
      NAME_MATCH,
    ],
  },
  {
    ruleSetId: 'NETWORK_PRIVATE_DISCHARGE_V1',
    name: 'Network Private Insurer — Discharge',
    insurerCode: null,
    schemes: ['NETWORK_PRIVATE'],
    routes: ['network'],
    stages: DISCHARGE_STAGES,
    caseTypes: [],
    rules: [
      { ruleId: 'NP_DISCHARGE_DOCS', name: 'Discharge documents present', kind: 'DOCUMENT_PRESENCE', category: 'DOCUMENT_COMPLETENESS', severity: 'HIGH', impact: 'QUERY', mandatory: true, params: { requiredCategories: ['discharge_slip', 'final_bill'], mode: 'all' }, failure: 'Discharge requires discharge summary and a full bill breakdown.' },
      NAME_MATCH,
    ],
  },
  // --- Cashless Everywhere (route = cashless_everywhere) -------------------------
  {
    ruleSetId: 'CASHLESS_EVERYWHERE_PREAUTH_V1',
    name: 'Cashless Everywhere — Pre-auth',
    insurerCode: null,
    schemes: ['CASHLESS_EVERYWHERE'],
    routes: ['cashless_everywhere'],
    stages: PREAUTH_STAGES,
    caseTypes: [],
    rules: [
      { ruleId: 'CE_PREAUTH_DOCS', name: 'Pre-auth documents present', kind: 'DOCUMENT_PRESENCE', category: 'DOCUMENT_COMPLETENESS', severity: 'HIGH', impact: 'QUERY', mandatory: true, params: { requiredCategories: [['aadhaar_front', 'aadhaar_card', 'aadhaar_back'], 'opd_notes', 'blood_test_reports'], mode: 'all' }, failure: 'Pre-auth requires policy card + Aadhaar, doctor prescription, and supporting diagnostics.' },
      NAME_MATCH,
    ],
  },
  {
    ruleSetId: 'CASHLESS_EVERYWHERE_DISCHARGE_V1',
    name: 'Cashless Everywhere — Discharge',
    insurerCode: null,
    schemes: ['CASHLESS_EVERYWHERE'],
    routes: ['cashless_everywhere'],
    stages: DISCHARGE_STAGES,
    caseTypes: [],
    rules: [
      { ruleId: 'CE_DISCHARGE_DOCS', name: 'Discharge documents present', kind: 'DOCUMENT_PRESENCE', category: 'DOCUMENT_COMPLETENESS', severity: 'HIGH', impact: 'QUERY', mandatory: true, params: { requiredCategories: ['discharge_slip', 'final_bill'], mode: 'all' }, failure: 'Discharge requires discharge summary and a full bill breakdown.' },
      NAME_MATCH,
    ],
  },
];

async function main(): Promise<void> {
  let setCount = 0;
  let ruleCount = 0;
  for (const s of SETS) {
    const setRes = await pool.query(
      `INSERT INTO hospital.insurer_rule_sets
         (rule_set_id, rule_set_name, version, insurer_code,
          applicable_treatments, applicable_specialties,
          applicable_schemes, applicable_routes, applicable_stages, applicable_case_types, status)
       VALUES ($1,$2,'1.0',$3, ARRAY[]::text[], ARRAY[]::text[], $4,$5,$6,$7,'live')
       ON CONFLICT (rule_set_id) DO UPDATE SET
         rule_set_name = EXCLUDED.rule_set_name, insurer_code = EXCLUDED.insurer_code,
         applicable_schemes = EXCLUDED.applicable_schemes, applicable_routes = EXCLUDED.applicable_routes,
         applicable_stages = EXCLUDED.applicable_stages, applicable_case_types = EXCLUDED.applicable_case_types,
         status = 'live', updated_at = NOW()
       RETURNING id`,
      [s.ruleSetId, s.name, s.insurerCode, s.schemes, s.routes, s.stages, s.caseTypes],
    );
    const ruleSetUuid = setRes.rows[0].id as string;
    setCount++;
    for (let i = 0; i < s.rules.length; i++) {
      const r = s.rules[i];
      await pool.query(
        `INSERT INTO hospital.insurance_rules
           (rule_set_id, rule_id, rule_name, category, severity, impact, enabled, mandatory,
            validation_logic, failure_message, kind, min_confidence, order_index)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8::jsonb,$9,$10,$11,$12)
         ON CONFLICT (rule_set_id, rule_id) DO UPDATE SET
           rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, severity = EXCLUDED.severity,
           impact = EXCLUDED.impact, enabled = true, mandatory = EXCLUDED.mandatory,
           validation_logic = EXCLUDED.validation_logic, failure_message = EXCLUDED.failure_message,
           kind = EXCLUDED.kind, min_confidence = EXCLUDED.min_confidence, order_index = EXCLUDED.order_index`,
        [ruleSetUuid, r.ruleId, r.name, r.category, r.severity, r.impact, r.mandatory ?? false,
          JSON.stringify(r.params), r.failure, r.kind, r.minConfidence ?? null, i],
      );
      ruleCount++;
    }
    console.log(`seeded rule set ${s.ruleSetId} (${s.rules.length} rules)`);
  }
  console.log(`\nDone: ${setCount} rule sets, ${ruleCount} rules.`);
  await pool.end();
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
