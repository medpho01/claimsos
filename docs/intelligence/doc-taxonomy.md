# Document Taxonomy (Stage 1A)

The Intelligence Layer needs a single, canonical vocabulary for the
documents that flow through a hospital cashless or reimbursement claim.
Migration `042_doc_taxonomy_expansion.sql` expands the doc_category vocabulary
from the original 21 codes (migration 028) to ~215 codes organised under 15
top-level groups, derived from the in-house hospital claims document
taxonomy reference.

## 15 Top-Level Groups

Each group lives in `hospital.master_options` under
`category='doc_category_group'`. Every `doc_category` row is tagged with its
parent group via the new `group_code` column on `master_options`.

| group_code | Group | Coverage |
|---|---|---|
| `kyc_identity_insurance` | KYC / Identity / Insurance | Aadhaar, PAN, policy card, ABHA, registration form (~17 codes) |
| `insurance_authorization` | Insurance & Authorization | Pre-auth, enhancement, approval / denial letters, claim forms (~19) |
| `clinical_medical` | Clinical / Medical | OPD notes, ICP, nursing charts, ER/triage notes (~27) |
| `diagnostic_investigation` | Diagnostic & Investigation | Labs, radiology, cardiology, fitness reports (~25) |
| `surgical_procedure` | Surgical / Procedure | OT notes, implant docs, CSSD, surgical checklists (~15) |
| `billing_financial` | Billing & Financial | Estimates, interim/final bills, receipts, TPA settlement (~22) |
| `discharge_outcome` | Discharge & Outcome | Discharge summary, follow-up, LAMA/DAMA, death certs (~12) |
| `consent_legal` | Consent & Legal | General/surgery/ICU consents, MLC, police intimation (~15) |
| `patient_photos_visual` | Patient Photos & Visual Evidence | OT photos, scar/wound photos, implant photos (~11) |
| `icu_critical_care` | ICU / Critical Care | Ventilator/ABG charts, sedation, dialysis (~8) |
| `pharmacy_medication` | Pharmacy & Medication | Med charts, narcotics register, vaccination (~6) |
| `rehabilitation_therapy` | Rehabilitation & Therapy | Physio, OT, speech, mobility assessments (~5) |
| `specialized_treatment` | Specialized Treatment | Chemo, dialysis, obstetrics, pediatrics (~9) |
| `administrative_operational` | Administrative & Operational | Admission form, transfer notes, duty rosters (~9) |
| `audit_intelligence_metadata` | Audit & Claims Intelligence Metadata | AI-generated artifacts (OCR scores, fraud indicators, audit trails) (~17) |

## Common Codes in the Dataset

Per claims-ops observation, the most frequently seen documents are:

- `discharge_summary` (and the migration-028 alias `discharge_slip`)
- `final_breakup_of_bill`, `consolidated_bill`, `pharmacy_bill`
- `pre_authorization_form`, `cashless_approval_letter`
- `investigations` (legacy) and the more granular `blood_test_reports`, `xray_reports`, `ecg`
- `ot_notes`, `ot_notes_and_photos` (legacy)
- `aadhaar_card`, `policy_card`

The legacy migration-028 codes (`discharge_slip`, `investigations`,
`ot_notes_and_photos`, etc.) are preserved as-is because
`document_sections` rows already reference them. Where the new taxonomy
overlaps (e.g. `discharge_summary` vs. `discharge_slip`), both codes
coexist and `concept_aliases` resolves the surface form.

## BIS Screenshot

`bis_screenshot` (label: "BIS Screenshot") was added to the
`audit_intelligence_metadata` group on top of the reference taxonomy. This
code captures Biometric / fraud-signal screenshots that ops uploads as
audit evidence — it has no equivalent in the original taxonomy but is
required for the fraud-detection pipeline.

## Alias Resolution Pattern

Surface forms (typed by ops, extracted by the LLM, parsed from emails)
rarely match a canonical code exactly. Resolution flows through
`hospital.concept_aliases`:

```
Surface form ───┐
                │
                ▼
   lower(alias) lookup in concept_aliases
                │
                ▼
   (concept_category, concept_code) → canonical row in master_options
```

Common alias buckets seeded by migration 042:

- Cardiology abbreviations — `ecg` ⇐ `ekg`, `electrocardiogram`; `echo` ⇐ `echocardiogram`, `2d echo`
- Radiology variants — `xray_reports` ⇐ `x-ray`, `xray`, `x ray`, `radiograph`
- Lab abbreviations — `blood_test_reports` ⇐ `cbc`, `lft`, `kft`, `blood report`
- Identity — `aadhaar_card` ⇐ `aadhar`, `aadhar card`, `uid`
- Authorization — `pre_authorization_form` ⇐ `pre auth`, `preauth`, `pre-authorization`
- Discharge — `discharge_summary` ⇐ `discharge note`, `ds`, `final discharge summary`

New aliases are appended over time as the LLM extraction layer flags
unknown surface forms; manual entries default to `alias_source='manual'`,
`confidence=1.0`. Mined entries record the model's confidence so
low-trust mappings can be filtered at lookup time.

## Reading the Hierarchy

A convenience view `hospital.doc_category_groups` joins each
`doc_category` row to its parent group label. Downstream code (rules
engine, dashboards, configurators) should read this view instead of
re-joining `master_options` to itself.

## Frontend Note

`webapp/src/components/modals/PatientPhotosModal/hooks/usePhotosData.ts`
keeps a narrow static `FIELD_NAMES` map for the photo-pill UI — that
component is admission-type-aware and intentionally surfaces only a
small curated set. All other FE code paths should fetch dynamically via
`useMasterOptions('doc_category')`.
