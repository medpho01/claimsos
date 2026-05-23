/**
 * Custom Function Registry (Wave 8 Rules Engine v2)
 *
 * Rules in `hospital.insurance_rules` with logic_type COMPLEX_CONDITION /
 * CUSTOM declare a `validation_logic.custom_function` string. The engine
 * resolves that string against this registry; unknown names produce status
 * ERROR with a descriptive message (NOT a FAIL — operator must triage).
 *
 * All functions share a deterministic, pure-ish shape:
 *
 *     (episode, ruleContext, services) =>
 *       Promise<CustomFunctionOutcome>
 *
 * They MUST be side-effect free except for read-only queries through
 * `services.pool`. Persistence of the outcome is the engine's job.
 */

import type { Pool } from 'pg';

export type CustomFunctionStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR';

export interface CustomFunctionOutcome {
  status: CustomFunctionStatus;
  evidence: any;
  message: string | null;
}

export interface CustomFunctionContext {
  rule: {
    rule_id: string;
    rule_name: string;
    category: string;
    severity: string;
    impact: string;
    validation_logic: any;
    estimated_deduction_amount: number | null;
    required_documents: string[];
  };
  rule_set: {
    id: string;
    rule_set_id: string;
    insurer_code: string | null;
  };
  hospital_id: string | null;
  claim_id: string;
}

export interface CustomFunctionServices {
  pool: Pick<Pool, 'query'>;
}

export type CustomFunction = (
  episode: any,
  ruleContext: CustomFunctionContext,
  services: CustomFunctionServices
) => Promise<CustomFunctionOutcome>;

import { validateCardiacEnzymesForAcs } from './validate_cardiac_enzymes_for_acs.js';
import { validateIcuStayCardiacMedicalMgmt } from './validate_icu_stay_cardiac_medical_mgmt.js';
import { validateRoomEligibility } from './validate_room_eligibility.js';
import { validatePreExistingCondition } from './validate_pre_existing_condition.js';
import { validatePhysiotherapyPrescription } from './validate_physiotherapy_prescription.js';
import { validatePmjayPackageMatch } from './validate_pmjay_package_match.js';
import { validateLosAgainstBenchmark } from './validate_los_against_benchmark.js';

export const CUSTOM_FUNCTIONS: Readonly<Record<string, CustomFunction>> = Object.freeze({
  validate_cardiac_enzymes_for_acs: validateCardiacEnzymesForAcs,
  validate_icu_stay_cardiac_medical_mgmt: validateIcuStayCardiacMedicalMgmt,
  validate_room_eligibility: validateRoomEligibility,
  validate_pre_existing_condition: validatePreExistingCondition,
  validate_physiotherapy_prescription: validatePhysiotherapyPrescription,
  validate_pmjay_package_match: validatePmjayPackageMatch,
  validate_los_against_benchmark: validateLosAgainstBenchmark,
});

export function resolveCustomFunction(name: string | undefined | null): CustomFunction | null {
  if (!name) return null;
  return CUSTOM_FUNCTIONS[name] ?? null;
}
