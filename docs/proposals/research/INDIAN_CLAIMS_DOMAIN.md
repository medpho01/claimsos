# The Indian Cashless Health-Claim Lifecycle and Its Deficiency Patterns

**A domain model for a hospital-side system that must eliminate deficiencies BEFORE submission.**

Status: research reference, v1 (2026-09-13). Owner: this file is exclusively owned by the research task; edit freely.
Audience: engineers building the ClaimsOS rules engine keyed on `stage × insurer × disease × claim_type`.

> **How to read this document.** Every section is written so it can be lifted into a table. Codes in
> `MONOSPACE_CAPS` are proposed canonical identifiers — they do not exist anywhere in Indian regulation,
> they are ours, and they are the join keys between the stage machine, the document catalog, the
> deficiency catalog and the deduction rules. Where a fact is regulatory it is cited. Where a fact is
> *market practice* (varies by insurer/TPA and is not written down anywhere authoritative) it is marked
> **[PRACTICE]** — those are the rows that must become configurable per payer rather than hard-coded.

---

## 1. Why this domain model exists

A hospital's cashless revenue leaks at three points, in this order of value:

1. **Pre-auth never obtained, obtained for the wrong procedure, or never enhanced** when the case changed
   in theatre or the stay extended. This is the single highest-value denial category because it attaches
   to planned surgery, cardiac and oncology — the big-ticket claims.
2. **Documentation deficiency** — discharge summary incomplete, an investigation report missing, a
   signature or hospital stamp absent, implant sticker not pasted. Recoverable, but only if someone
   actually resubmits.
3. **Deduction at settlement** — room-rent proportionate cut, non-payable consumables, tariff/package
   mismatch. Not a "rejection" at all; it arrives as a short payment against an approved claim and is
   usually never contested.

Published industry figures for Indian hospitals: TPA/insurer claims are **20–40% of billing revenue**;
**10–20% of submitted claim value is rejected or short-paid** as a matter of routine; recovery on
*properly* resubmitted deficiency claims runs **60–80%**, but most rejected claims are never resubmitted
at all and are written off at quarter end
([accredready.in](https://accredready.in/learn/tpa-insurance-claim-denials)).
**[PRACTICE]** — treat these as order-of-magnitude, not audited.

The design consequence: the system's job is **pre-submission adjudication**. Every check an insurer or
TPA will run after submission should be run by us before submission, against the same inputs, with the
same rule keys. That is only possible if the stage taxonomy, document catalog and deficiency catalog are
explicit and enumerable — which is what the rest of this document supplies.

---

## 2. Actors, identifiers and the entity spine

| Entity | Canonical id | Notes |
|---|---|---|
| Hospital / provider | `ROHINI_ID` (13-digit) | Registry of Hospitals in Network of Insurance, run by the Insurance Information Bureau (IIB) under IRDAI; GS1-based 13-digit unique id, ~33,000 hospitals. No facility is empanelled by an insurer without a ROHINI certificate, and it is the de-facto entry requirement for cashless, CGHS, ESIC and PMJAY ([rohini.iib.gov.in/about_us](https://rohini.iib.gov.in/about_us)) |
| Hospital ↔ payer link | `HOSPITAL_TPA_ID` | Payer-issued provider code. Appears as a distinct field on the standard pre-auth form alongside ROHINI ID. |
| Insurer | `IRDAI_REG_NO` | e.g. "IRDAI Reg. 153". One insurer may use several TPAs and also process in-house. |
| TPA | `IRDAI_TPA_LICENCE` | Medi Assist, Paramount, Vidal, Good Health, Health India, Ericson, MDIndia, etc. The TPA — not the insurer — is usually the counterparty the hospital talks to. |
| Policy | `POLICY_NO` + `UIN` | UIN (e.g. `ADIHLIP21062V022021`) identifies the *product*, and therefore which sub-limit/non-payable annexure applies. **The UIN is the correct join key for benefit rules, not the insurer name.** |
| Member | `TPA_CARD_ID` / `ABHA` / `PMJAY_ID` | PMJAY uses the Ayushman card + BIS; ABDM/NHCX uses ABHA. |
| Episode | `IP_NO` (hospital) ↔ `PREAUTH_NO` (payer) ↔ `CLAIM_NO` (payer) | Three different ids for one episode. Mismatch between them is itself a common query. |
| Exchange | `NHCX` correlation id | For payers live on the National Health Claims Exchange. |

**Modelling note.** The rules engine must key on `UIN` where available and fall back to
`insurer × product_family`. Two policies from the same insurer routinely have different room-rent caps
and different non-payable lists.

---

## 3. Canonical stage taxonomy

### 3.1 Stage codes

| Code | Stage name | Triggered by | Payer decision outcomes |
|---|---|---|---|
| `S00_ELIGIBILITY` | Eligibility / coverage check | Patient presents card or policy | Eligible / Not eligible / Not found |
| `S01_INTIMATION` | Intimation of admission | Planned: before admission. Emergency: at/after admission | Acknowledged (no adjudication) |
| `S02_PREAUTH_REQ` | Pre-authorisation request | Pre-auth form submitted | → `S03` / `S04` / `S05` |
| `S03_PREAUTH_QUERY` | Pre-auth query / deficiency | Payer raises query | Returns to `S02` on reply |
| `S04_PREAUTH_APPROVED` | Pre-auth approval (initial/partial) | Payer approves an amount, with conditions | Carries caps, validity window |
| `S05_PREAUTH_DENIED` | Pre-auth denial | Payer rejects | → `S13_APPEAL` or convert to reimbursement/cash |
| `S06_ENHANCEMENT_REQ` | Enhancement / interim request | Stay extends, procedure changes, cost overruns, ICU shift | → `S07` / `S08` / `S09` |
| `S07_ENHANCEMENT_QUERY` | Enhancement query | Payer wants justification | Returns to `S06` |
| `S08_ENHANCEMENT_APPROVED` | Enhancement approved | | Increments approved amount |
| `S09_ENHANCEMENT_DENIED` | Enhancement denied | | Balance becomes patient liability or appeal |
| `S10_DISCHARGE_REQ` | Final/discharge authorisation request | Final bill + discharge summary submitted while patient is in bed | The 3-hour clock |
| `S11_FINAL_APPROVED` | Final authorisation | Payer states final payable + deductions | Patient can be discharged |
| `S12_CLAIM_SUBMITTED` | Claim file / bill submission to payer | Physical or digital claim folder dispatched post-discharge | |
| `S12Q_CLAIM_QUERY` | Post-submission claim query | Payer/CPD raises document query on the file | Returns to `S12` |
| `S13_SETTLED` | Settlement / payment received | Payment advice + UTR | |
| `S14_SHORT_PAID` | Short payment / deduction | Settled amount < approved amount | → `S15` |
| `S15_APPEAL` | Appeal / reconsideration / grievance | Hospital or insured contests denial or deduction | → `S13` / `S16` |
| `S16_OMBUDSMAN` | Insurance Ombudsman / SGRC escalation | Internal grievance exhausted | Outside hospital's routine flow |
| `S17_WRITE_OFF` | Write-off | Time-barred or abandoned | Terminal |

### 3.2 State machine (the part that matters for a rules engine)

```
S00 ─► S01 ─► S02 ─┬─► S03 ─► S02   (query loop, bounded)
                   ├─► S05 ─► S15
                   └─► S04 ─┬─► S06 ─┬─► S07 ─► S06
                            │        ├─► S09
                            │        └─► S08 ─┐
                            └────────────────►┴─► S10 ─► S11 ─► S12 ─┬─► S12Q ─► S12
                                                                     └─► S13 ─► S14 ─► S15
```

Three properties the engine must enforce:

1. **`S04`/`S08` carry conditions, not just an amount.** An approval letter is a *constraint object*:
   approved amount, room category/room-rent cap, co-pay %, named diagnosis, named procedure, named
   hospital, admission-date validity window, list of pre-excluded non-payables. Every one of these is a
   later deduction if violated. Parse and store them; do not store "approved ₹X".
2. **Any divergence of the actual episode from the `S04` constraint object is an enhancement trigger**,
   and an un-enhanced divergence is the highest-value denial in the taxonomy. Lap-chole converted to
   open, ward → ICU, 3 days → 7 days, a second procedure in the same sitting.
3. **Query loops are bounded.** PMJAY explicitly caps the claim-stage query at three rounds and
   auto-rejects on TAT breach; private TPAs will "close" a pre-auth on non-response. The engine must
   model an expiring clock per query, not an open task.

### 3.3 Vocabulary the payer side uses (so we can map inbound messages)

- PMJAY/NHA: **PPD** = Pre-authorisation Processing Doctor, **CPD** = Claim Processing Doctor,
  **MEDCO/PMAM** = hospital-side coordinators, **EHCP** = Empanelled Health Care Provider,
  **TMS** = Transaction Management System, **SHA** = State Health Agency,
  **HBP** = Health Benefit Package
  ([NHA Claims Adjudication Manual 2.0](https://sha.kerala.gov.in/wp-content/uploads/2022/08/Claims-Adjudication-Manual-2_0-final.pdf)).
- Private: **pre-auth**, **enhancement**, **query/shortfall**, **final authorisation**, **denial**,
  **deduction/disallowance**, **reconsideration**.
- NHCX/FHIR: `CoverageEligibilityRequest` → `Claim` (use = `preauthorization` | `claim`) →
  `ClaimResponse`, with `Communication` / `CommunicationRequest` carrying the deficiency query and
  `Task` carrying document requests; `PaymentNotice` / `PaymentReconciliation` for settlement
  ([NRCeS FHIR IG for ABDM, NHCX profiles](https://www.nrces.in/preview/ndhm/fhir/r4/hcx-profile.html)).

---

## 4. Turnaround times (the clocks the engine must run)

### 4.1 Private cashless — IRDAI Master Circular on Health Insurance Business, 29 May 2024 (IRDAI/HLT/CIR/MISC/77/05/2024)

| Clock | Norm | Notes |
|---|---|---|
| Cashless authorisation decision | **Immediately, and not later than 1 hour** of receiving the request | Systems compliance was required by 31 Jul 2024 |
| Final authorisation at discharge | **Not later than 3 hours** of receiving the discharge-authorisation request | If the hospital's extra charges accrue because the insurer overran 3 hours, the insurer bears them **from shareholders' funds**, not from the sum insured |
| Claim settlement (reimbursement) | 30 days (with penal interest beyond) | |
| Document collection | **"Insurers and TPAs shall collect the required documents from the Hospitals. Policyholder shall not be required to submit the documents."** | This shifts the entire documentation burden onto the hospital — the direct justification for a hospital-side pre-submission engine |
| Repudiation | Only on the decision of a three-member **Claims Review Committee** (a PMC subgroup) | |
| Moratorium | **60 months** of continuous cover; thereafter no contest on non-disclosure/misrepresentation except established fraud | Reduced from 96 months |
| Portability data | Existing insurer supplies underwriting/claims history via IIB portal within **72 hours**; acquiring insurer decides within **5 days** | |
| Ombudsman award non-compliance | **₹5,000/day** penalty to the complainant | |

Source: [Master Circular text, TaxGuru reproduction](https://taxguru.in/corporate-law/master-circular-irdai-insurance-productsregulations-2024health-insurance.html);
[Annexure to the Master Circular (IAI mirror)](https://www.actuariesindia.org/sites/default/files/inline-files/6.%20Annexure%20to%20Master%20Circular%20on%20Health%20Insurance%20Business%2029052024.pdf);
summaries at [lexcomply](https://lexcomply.com/blog/key-highlights-master-circular-on-irdai-insurance-products-regulations-2024-health-insurance/),
[NYVO](https://nyvo.in/health-insurance/irdai-master-circular-2024).

Also from the 2024 regime (IRDAI (Insurance Products) Regulations, 2024, w.e.f. 1 Apr 2024):
**PED waiting period capped at 36 months** (down from 48) and **specific-disease waiting period capped at
36 months** ([Business Today](https://www.businesstoday.in/personal-finance/insurance/story/irdai-reduces-pre-existing-disease-waiting-period-from-4-to-3-years-here-is-what-existing-policyholders-should-know-425325-2024-04-12)).

### 4.2 Cashless Everywhere (General Insurance Council, Jan 2024) — the non-network path

| Condition | Value |
|---|---|
| Hospital eligibility | Registered under the Clinical Establishment Act with the state health authority, **minimum 15 beds** |
| Elective admission intimation | **≥ 48 hours before** the proposed admission date |
| Emergency admission intimation | **within 48 hours of** admission |
| Form | Prescribed cashless request form signed by **both the insured and the hospital**, plus valid policyholder ID |
| Non-network hospital consent | Written consent from the hospital to extend cashless |
| Admissibility | Subject to policy terms and the insurer's operating guidelines; insurer retains discretion to accept or reject the cashless request |

Sources: [GI Council press release](https://www.gicouncil.in/news-media/events/press-release-launch-of-cashless-everywhere/),
[DigitalHealthNews summary](https://www.digitalhealthnews.com/general-insurance-council-unveils-cashless-hospitalisation-facility-to-policyholders).

**Engine implication.** `claim_type = CASHLESS_EVERYWHERE` has a *hard intimation deadline* that
`claim_type = EMPANELLED_CASHLESS` does not, and it needs two extra artefacts (hospital consent letter,
tariff/rate agreement for the episode). A 48-hour elective-intimation miss is unrecoverable and must be
a blocking pre-submission check on the day the surgery is scheduled, not on the day of admission.

### 4.3 PMJAY / government scheme — NHA uniform TAT

Private EHCP ([NHA Claims Adjudication Manual 2.0](https://sha.kerala.gov.in/wp-content/uploads/2022/08/Claims-Adjudication-Manual-2_0-final.pdf), §10.1; O.M. S-12017/40/2019-NHA):

| Activity | TAT | System action on breach |
|---|---|---|
| Pre-auth initiation after patient registration (by hospital) | **48 h** post registration | Reminder at 24 h; **auto-rejection at 48 h**; new registration needed |
| Pre-auth decision (by PPD) | **6 h** (working hours) | **Auto-approval after 6 h** |
| Response to PPD query (by hospital) | **24 h** | Reminders at 24 h and 48 h; **auto-reject at 72 h**; SHA may revoke |
| Claim submission after discharge | **≤ 7 days**; 7–21 days needs SHA approval; 21–45 days needs CEO-SHA approval; **beyond 45 days not admissible** | Auto reminders D+1, D+3, D+5 |
| Response to CPD query | **≤ 7 days** | Reminders D+1, D+3; **auto-reject after D+7** |
| Claim payment | 15 days intra-state, 30 days inter-state (portability) | |

Public EHCP is looser: 72 h pre-auth initiation, 5 days for PPD query, 15 days for claim submission
(30/60 with escalation, beyond 60 not admissible), 15 days for CPD query.

**TAT is computed excluding time the claim sits with the hospital** — the manual works two examples of
this. Our clock model must therefore be a *payer-side accumulator*, not wall-clock age.

### 4.4 Private post-discharge submission windows **[PRACTICE]**

No regulation fixes these; they come from the empanelment MOU. Typical:
claim folder within **7 days** of discharge (Vidal's published hospital guide says exactly this);
deficiency/shortfall response window **30–60 days** from the query; late-submission requests need a
written justification. Model as `payer_config.claim_submission_days`,
`payer_config.query_response_days`, `payer_config.retro_preauth_hours` (emergency retrospective pre-auth
commonly 24–48 h).
Sources: [Vidal Health TPA pre-authorisation guide](https://vidalhealthtpa.com/vidalhealthtpa/pre-authorisation-guide.html),
[accredready](https://accredready.in/learn/tpa-insurance-claim-denials).

---

## 5. Claim-type dimension

`claim_type` is a first-class rule key because it changes the document set, the clocks and the deduction
model — not just the payer.

| `claim_type` | Payer | Benefit basis | Distinctive requirements |
|---|---|---|---|
| `EMPANELLED_CASHLESS` | Insurer via TPA or in-house | Indemnity, policy T&C + empanelment tariff | Standard pre-auth form; tariff is the negotiated hospital rate card |
| `CASHLESS_EVERYWHERE` | Insurer direct | Indemnity | 48 h elective / 48 h emergency intimation; hospital consent; rate agreed ad hoc; higher denial discretion |
| `GOVT_SCHEME_PMJAY` | SHA / ISA / insurer under scheme | **Package (HBP) rates**, not itemised | TMS workflow, PPD/CPD, mandatory STG documents, clinical photographs, Aadhaar biometric at admission and discharge in some states, package-code correctness |
| `GOVT_SCHEME_STATE` | State scheme (e.g. state-specific packages atop PM-JAY) | Package | State-reserved packages; specialty empanelment gating |
| `CGHS_ESIC_RAILWAY` | Central govt | Rate list | Referral/permission letters are the dominant deficiency |
| `CORPORATE_GROUP` | Insurer via TPA, employer-sponsored | Indemnity, usually **waivers**: PED waiver, first-year waiver, maternity cover, often no room-rent cap | Employee ID and corporate name are mandatory fields; benefit table is per-corporate, not per-UIN |
| `RETAIL_INDIVIDUAL_FLOATER` | Insurer | Indemnity | Waiting periods and PED bite hardest here; room-rent caps and disease sub-limits common |
| `REIMBURSEMENT` | Insurer | Indemnity | Originals, patient-signed bills, KYC, NEFT mandate; hospital is not the payee |
| `TOP_UP_SUPER_TOPUP` | Second insurer | Indemnity above deductible | Needs the primary insurer's settlement letter as a document |
| `MULTI_POLICY` | ≥2 insurers | | Per the 2024 Master Circular the policyholder nominates a primary insurer, who must coordinate with the others to settle the balance |

**Corporate vs retail is the most under-modelled axis.** A corporate GMC frequently removes precisely the
clauses that generate retail deductions (room cap, PED wait, co-pay) and adds others (per-family limits,
disease-wise sub-limits on cataract/hernia/maternity/ortho). Deduction rules must be resolved from the
*benefit table for that group policy*, not from the insurer's retail product.
([Pazcare on disease-specific sub-limits in group plans](https://www.pazcare.com/blog/disease-specific-sub-limits-in-group-health-insurance-what-hrs-must-know))

---

## 6. Master document catalog

These are the atoms. Everything in §7 references these codes.

### 6.1 Identity, policy and consent

| Code | Document | Notes / failure mode |
|---|---|---|
| `DOC_PREAUTH_FORM` | Pre-authorisation request form (see §6.5) | Must be the payer's **current** form version; block letters; all pages |
| `DOC_CLAIM_FORM_A` | IRDA Claim Form Part A (by insured) | Policy no, employee/TPA id, name, communication address, registered email, bank/NEFT details |
| `DOC_CLAIM_FORM_B` | IRDA Claim Form Part B (by hospital) | Patient name, IP registration no, gender, age, DOB, date & type of admission, date of discharge, **ICD-10 codes for primary diagnosis, additional diagnosis, comorbidities**, **ICD-10-PCS for procedures**, bill break-up, and the hospital's confirmation of the document list handed over at discharge ([Medi Assist on Part B](https://blog.mediassist.in/irda-claim-form-part-b/), [Part A](https://blog.mediassist.in/irdai-claim-form-part-a/)) |
| `DOC_ID_PHOTO` | Government photo ID of patient (Aadhaar/PAN/passport/voter) | Name/DOB must match the policy record exactly — see `DEF_ID_MISMATCH` |
| `DOC_TPA_CARD` | TPA/e-health card | |
| `DOC_POLICY_COPY` | Policy schedule / e-card / corporate benefit table | Needed to evaluate caps before billing |
| `DOC_KYC` | KYC per insurer AML norms (usually for high-value claims) | |
| `DOC_CONSENT_CASHLESS` | Insured + hospital signed cashless request | Mandatory for `CASHLESS_EVERYWHERE` |
| `DOC_HOSPITAL_CONSENT` | Non-network hospital's written consent to extend cashless | `CASHLESS_EVERYWHERE` only |
| `DOC_ROHINI_CERT` | ROHINI registration certificate / hospital registration | Asked for at empanelment and re-asked on disputed claims |
| `DOC_NEFT_MANDATE` | Cancelled cheque / bank mandate | Reimbursement and settlement |

### 6.2 Clinical

| Code | Document | Notes |
|---|---|---|
| `DOC_DISCHARGE_SUMMARY` | Discharge summary | The most-queried document in the whole system. See §6.4 for the required field set |
| `DOC_DEATH_SUMMARY` | Death summary / LAMA / DAMA summary | Required in place of discharge summary in those outcomes |
| `DOC_ADMISSION_NOTES` | Admission notes / initial assessment | |
| `DOC_ICP` | Indoor case papers / case sheet | Daily vitals, progress notes, treatment given. **"Continue same treatment (CST)" alone is explicitly unacceptable** to NHA adjudicators |
| `DOC_OT_NOTES` | Operation theatre notes | On hospital stationery, **not plain paper**: date/time start and end, surgeon name, anaesthetist name, type of anaesthesia, surgery done with **site, side and findings**, immediate post-op care, complications, **surgeon's signature** |
| `DOC_ANAESTHESIA_NOTES` | Anaesthesia record | |
| `DOC_INVESTIGATION_REPORTS` | Lab, imaging and pathology reports | With patient name and date on each |
| `DOC_IMAGING_FILMS` | X-ray / CT / MRI / USG films, ECG strip, ABG chart, CAG/angio images, EEG | Must carry patient name + date |
| `DOC_HPE` | Histopathology / biopsy / FNAC / PET-CT report | Mandatory for any malignancy claim |
| `DOC_CLINICAL_PHOTO` | Clinical photograph | Face of patient and site of surgery **in the same frame**, with consent; explicitly must not be a stock/Google image |
| `DOC_PRESCRIPTION` | Treating doctor's prescription advising hospitalisation, with diagnosis | The main defence against "OPD converted into IPD" |
| `DOC_REFERRAL` | Referral letter (govt hospital referral for some schemes; corporate/CGHS permission letters) | |
| `DOC_MLC_FIR` | MLC / FIR copy | Any RTA, injury, assault, poisoning, burn |
| `DOC_ALCOHOL_REPORT` | Blood alcohol / substance test report | Insurer's own pre-auth form asks whether injury was substance-related and demands the report if yes |
| `DOC_SELF_DECLARATION` | Signed narration of the incident: date, place, time | Accident claims without MLC |
| `DOC_DIALYSIS_CHART` | Haemodialysis chart + justification for frequency | |
| `DOC_ICU_EVIDENCE` | Photo of patient in ICU with ventilator; ICU chart | NHA asks for this in ICU-ventilator claims |
| `DOC_PRE_POST_IMAGING` | Pre- and post-procedure imaging | Mandatory for joint replacement under PM-JAY STG |
| `DOC_PRE_POST_PHOTO` | Pre- and post-procedure clinical photograph, post-op scar photo | Same |

### 6.3 Financial

| Code | Document | Notes |
|---|---|---|
| `DOC_FINAL_BILL` | Final consolidated hospital bill, numbered, with hospital seal | |
| `DOC_BILL_BREAKUP` | Detailed break-up: room rent, nursing, ICU, OT, professional fees, investigations, pharmacy, consumables, implants, others | Without this, proportionate deduction cannot be argued and the payer will apply the worst case |
| `DOC_PHARMACY_BILLS` | Itemised pharmacy/indent bills, matched to prescriptions | |
| `DOC_IMPLANT_INVOICE` | Original implant/stent/IOL/prosthesis **invoice** with payment receipt | Must show make, model, and price; checked against NPPA ceilings and insurer tariffs |
| `DOC_IMPLANT_STICKER` | Implant / stent / IOL / mesh **sticker or barcode**, pasted and attested | Carries model, serial number, batch number; proves the billed device is the implanted device ([Medi Assist on implant details](https://blog.mediassist.in/implant-details/)) |
| `DOC_PAYMENT_RECEIPTS` | Receipts for co-pay, deposits, non-payables collected from patient | Vidal: *"If co-pay receipt is not submitted the claim will be denied"* |
| `DOC_PREAUTH_LETTERS` | Original pre-auth request + all approval/enhancement letters | Must accompany the settlement folder |
| `DOC_COVERING_LETTER` | Per-case covering letter quoting the pre-auth number | Prevents the folder being orphaned at the TPA |
| `DOC_TARIFF_SHEET` | Applicable empanelment tariff / package rate card | Internal evidence for disputing tariff deductions |
| `DOC_PRIMARY_SETTLEMENT` | Primary insurer's settlement letter | Top-up / second-policy claims |

### 6.4 Discharge summary — the required field set

Derived from the NHA standard discharge-summary format (Annexure 3 of the Claims Adjudication Manual),
which is the most explicit published specification and maps cleanly onto private-insurer expectations:

Hospital name, hospital code, hospital address, district · Patient name, scheme/policy id, address, age,
sex, contact number · IPD number · Case id · Package/procedure booked · Treating consultant's name,
contact, **qualification, registration number, specialty** · **Date and time of admission** · **Date and
time of discharge** · Date of operation (surgical cases) · Presenting complaints **with duration** ·
Initial assessment · **Significant past medical and surgical history** · Primary diagnosis at admission ·
**Final diagnosis at discharge** · **ICD-10 code(s) for the final diagnosis** · Key investigations ·
Investigation findings · Treatment given during hospitalisation · **Operative findings (surgical cases)** ·
Complications if any · Status at discharge · Next follow-up date · Advice on discharge · **Name and
signature of treating consultant** · Name and signature of hospital coordinator · **Name and
signature/thumb impression of patient or attendant**.

Every one of those is a machine-checkable field. A discharge summary missing time-of-admission, the
consultant's registration number, the ICD-10 code, or the patient's signature is a query waiting to
happen.

### 6.5 Pre-authorisation form — the required field set

The industry-standard "Request for Cashless Hospitalisation for Health Insurance Policy" form has four
numbered sections (verified field-by-field against the
[Good Health TPA form](https://goodhealthtpa.com/wp-content/uploads/2020/01/Preauthorization-Request-Form.pdf);
Vidal, ICICI Lombard, Care, Future Generali and Health India variants carry the same skeleton):

**Section 1 — TPA and hospital.** Name of TPA, toll-free phone, toll-free fax, hospital name, hospital
location, **hospital ROHINI ID**, **hospital TPA ID**, hospital fax, phone, email.

**Section 2 — Insured/patient (patient-filled).** Patient name; gender (male/female/third gender); age in
years/months; DOB; contact no; contact of attending relative; occupation; **TPA card ID**; policy
no/corporate name; **employee ID**; address of insured; *do you have any other mediclaim* (Y/N) with
policy no and insurer name; *do you have a family physician* (Y/N) with name and contact.

**Section 3 — Treating doctor/hospital (doctor-filled).** Treating doctor name and contact; **nature of
illness/disease with presenting complaints**; **relevant clinical findings**; **duration of present
ailment (days)**; **date of first consultation**; **past history of present ailment**; **provisional
diagnosis**; **ICD-10 code**; proposed line of treatment (medical management / surgical management /
intensive care / investigation / non-allopathic); if investigation or medical management — details; if
surgical — **name of surgery** and **ICD-10-PCS code**; other treatment; route of drug administration;
if accident — is it RTA, reported to police, date of injury, FIR no, **how did injury occur**; whether
injury/disease is due to substance abuse or alcohol and the test conducted to establish it (attach
report); if maternity — G/P/L/A status and **expected date of delivery**.

**Section 4 — Admission and cost estimate.** Date and time of admission; emergency vs planned;
**expected number of days of stay**; **days in ICU**; **room type**; **per-day room rent + nursing +
service charges + patient diet**; expected cost of investigations and diagnostics; ICU charges; OT
charges; professional fees (surgeon + anaesthetist + consultation); **medicines + consumables + cost of
implants (specify)**; other hospital expenses; **all-inclusive package charges if applicable**;
**sum-total expected cost**; **mandatory past history of chronic illness with "since (MM/YYYY)"** for
diabetes, heart disease, hypertension, hyperlipidaemia, osteoarthritis, asthma/COPD/bronchitis, cancer,
alcohol/drug abuse, HIV/STD, any other; declaration; treating doctor's **name, qualification,
registration number with state code**; **hospital seal including hospital ID**; **patient/insured name
and signature**.

**This form is the single richest source of pre-submission checks in the entire domain.** Note the two
fields that quietly decide the claim: *duration of present ailment* + *since MM/YYYY* on chronic illness
(these drive PED and waiting-period adjudication), and *per-day room rent* (which drives the
proportionate-deduction exposure before a single rupee has been billed).

---

## 7. Deficiency / query catalog

This is the core artefact. Each row is a rule. `stage` says when we can detect it; `blocking` says
whether we must refuse submission or merely warn.

### 7.1 Category A — Identity, policy and eligibility

| Code | Deficiency | Detect at | Typical payer wording |
|---|---|---|---|
| `DEF_ID_MISMATCH` | Patient name / DOB / gender on ID ≠ policy record ≠ hospital registration | `S00`, `S02` | "KYC mismatch", "insured name not matching" |
| `DEF_ID_ILLEGIBLE` | ID or document scan unreadable | any | "Re-upload legible copy of requested documents" |
| `DEF_POLICY_NOT_FOUND` | Policy/member not traceable, card expired, employee separated | `S00` | "Not an active member" |
| `DEF_SI_EXHAUSTED` | Sum insured / family wallet insufficient | `S02`, `S06` | PM-JAY: "Patient's family wallet does not have sufficient amount" |
| `DEF_NOT_COVERED` | Patient not covered under the scheme/policy | `S02` | PM-JAY rejection reason |
| `DEF_MULTIPLE_POLICY_UNDISCLOSED` | "Other mediclaim" field blank but a second policy exists | `S02` | |
| `DEF_WRONG_PAYER` | Claim routed to the wrong TPA/insurer for that policy | `S02`, `S12` | |

### 7.2 Category B — Timeliness

| Code | Deficiency | Detect at | Notes |
|---|---|---|---|
| `DEF_LATE_INTIMATION` | Elective admission not intimated ≥48 h ahead (`CASHLESS_EVERYWHERE`), or emergency not intimated within 48 h | `S01` | Hard deadline; unrecoverable |
| `DEF_PREAUTH_NOT_INITIATED` | Pre-auth not raised within the payer's window after registration | `S02` | PM-JAY auto-rejects at 48 h (private EHCP) |
| `DEF_RETRO_PREAUTH_WINDOW_MISSED` | Emergency retrospective pre-auth not filed inside 24–48 h **[PRACTICE]** | `S02` | |
| `DEF_QUERY_RESPONSE_LATE` | Query not answered inside the window | `S03`,`S07`,`S12Q` | PM-JAY auto-reject at 72 h (pre-auth) / D+7 (claim) |
| `DEF_CLAIM_SUBMISSION_LATE` | Folder dispatched after the MOU window | `S12` | PM-JAY: >45 days inadmissible outright |
| `DEF_PREAUTH_EXPIRED` | Admission fell outside the approval's validity window | `S10` | Approval letters are date-bounded |

### 7.3 Category C — Clinical documentation

| Code | Deficiency | Detect at | Notes |
|---|---|---|---|
| `DEF_DS_MISSING` | No discharge summary / death / LAMA / DAMA summary | `S10`,`S12` | |
| `DEF_DS_INCOMPLETE` | Discharge summary missing any §6.4 field | `S10` | NHA query text: "Provide complete discharge summary (patient name, gender, age, complaints, treatment done, diagnosis, DOA & DOD etc.)" |
| `DEF_DS_NO_SIGNATURE` | Treating consultant's signature / registration no / hospital seal absent | `S10` | |
| `DEF_DS_NO_PATIENT_SIGN` | Patient or attendant signature / thumb impression absent | `S10` | |
| `DEF_ICP_MISSING` | Indoor case papers not attached | `S12` | |
| `DEF_ICP_THIN` | Progress notes lack vitals/treatment; "CST" entries only | `S12` | Explicitly called out by NHA |
| `DEF_OT_NOTES_MISSING` | No OT/anaesthesia notes for a surgical claim | `S10` | |
| `DEF_OT_NOTES_DEFECTIVE` | OT notes on plain paper, or missing site/side/findings/surgeon signature/times | `S10` | |
| `DEF_INVESTIGATION_MISSING` | Reports supporting the diagnosis not attached | `S02`,`S12` | The #1 pre-auth query in the NHA standard list |
| `DEF_IMAGING_FILM_MISSING` | X-ray/MRI/CT/USG/EEG film, ECG graph, ABG chart or CAG diagram not provided | `S02`,`S12` | Must carry patient name + date |
| `DEF_HPE_MISSING` | Biopsy/HPE/FNAC/PET confirming malignancy absent in an oncology claim | `S02`,`S12` | |
| `DEF_CLINICAL_PHOTO_MISSING` | Clinical photo / post-op scar photo absent or non-compliant | `S02`,`S12` | Scheme claims mainly |
| `DEF_ICU_EVIDENCE_MISSING` | ICU-ventilator claim without ICU chart/photo | `S12` | |
| `DEF_DIALYSIS_CHART_MISSING` | Dialysis claim without chart and frequency justification | `S02`,`S12` | |
| `DEF_MLC_MISSING` | Injury/RTA/poisoning without MLC or FIR or self-declaration | `S02` | |
| `DEF_ALCOHOL_REPORT_MISSING` | Substance-related injury without the confirming test report | `S02` | |
| `DEF_ADMISSION_NOT_JUSTIFIED` | Clinical findings do not justify inpatient care | `S02`,`S12` | Payer wording: "OPD converted into IPD — justification for admission not found"; also "Hospitalisation for evaluation/diagnostic purpose" is a listed non-payable |
| `DEF_PRESCRIPTION_MISSING` | No doctor's prescription advising hospitalisation with diagnosis | `S02` | |
| `DEF_REFERRAL_MISSING` | Scheme/CGHS referral or permission letter absent | `S02` | |

### 7.4 Category D — Coding and internal consistency

| Code | Deficiency | Detect at |
|---|---|---|
| `DEF_ICD_MISSING` | ICD-10 diagnosis code absent on pre-auth or Claim Form B | `S02`,`S12` |
| `DEF_PCS_MISSING` | ICD-10-PCS procedure code absent for a surgical claim | `S02`,`S12` |
| `DEF_CODE_DIAGNOSIS_MISMATCH` | ICD code does not match the narrative diagnosis | `S02` |
| `DEF_CROSSDOC_DIAGNOSIS_MISMATCH` | Diagnosis differs between pre-auth, discharge summary, Claim Form B and bill | `S10` |
| `DEF_CROSSDOC_PROCEDURE_MISMATCH` | Procedure billed ≠ procedure in OT notes ≠ procedure approved | `S10` |
| `DEF_CROSSDOC_DATE_MISMATCH` | DOA/DOD inconsistent across summary, bill, pre-auth and case sheet | `S10` |
| `DEF_CROSSDOC_AMOUNT_MISMATCH` | Bill total ≠ sum of break-up ≠ amount claimed | `S10`,`S12` |
| `DEF_PACKAGE_MISMATCH` | Package code ≠ disease / treatment / gender / age | `S02`,`S12` |
| `DEF_SPECIALTY_NOT_EMPANELLED` | Hospital not empanelled for that specialty | `S02` |
| `DEF_RESERVED_PACKAGE` | Package reserved for government facilities | `S02` |
| `DEF_OVERWRITTEN_DOCS` | Unclear or overwritten documents | `S12` |
| `DEF_ID_NUMBER_INCONSISTENT` | IP no / pre-auth no / claim no do not tie together across the folder | `S12` |

### 7.5 Category E — Financial and billing

| Code | Deficiency | Detect at |
|---|---|---|
| `DEF_BILL_BREAKUP_MISSING` | No head-wise break-up | `S10` |
| `DEF_BILL_UNSIGNED` | Bill not signed by patient / not sealed by hospital / no bill number | `S10` |
| `DEF_IMPLANT_INVOICE_MISSING` | Implant billed without original invoice + payment receipt | `S10` |
| `DEF_IMPLANT_STICKER_MISSING` | Implant billed without sticker/barcode showing model, serial and batch | `S10` |
| `DEF_IMPLANT_ABOVE_CAP` | Implant price exceeds NPPA ceiling or insurer tariff | `S10` |
| `DEF_PHARMACY_UNMATCHED` | Pharmacy items with no corresponding prescription or indent | `S10` |
| `DEF_NONPAYABLE_BILLED` | List I / II / III / IV items billed separately (see §8.4) | `S10` |
| `DEF_COPAY_RECEIPT_MISSING` | Co-pay not collected or receipt not enclosed | `S10` |
| `DEF_TARIFF_EXCEEDED` | Charges above the empanelment tariff / package rate | `S10` |
| `DEF_PACKAGE_VS_ITEMISED` | Package case billed itemised (or vice versa) contrary to the MOU | `S10` |
| `DEF_CASH_BILL` | Bill already generated and paid by patient in a cashless case | `S12` | PM-JAY standard rejection reason |
| `DEF_PREAUTH_AMOUNT_SHORT` | Final bill exceeds approved amount with no enhancement on file | `S10` |

### 7.6 Category F — Policy/benefit adjudication (denials, not deficiencies)

| Code | Ground | Detect at |
|---|---|---|
| `DEN_EXCLUSION` | Treatment falls in policy/scheme exclusions | `S02` |
| `DEN_PED` | Pre-existing disease within the (≤36-month) PED waiting period | `S02` |
| `DEN_WAITING_PERIOD` | Initial 30-day, specific-disease (≤36-month), or maternity waiting period not served | `S02` |
| `DEN_NON_DISCLOSURE` | Material non-disclosure — **unavailable to the insurer after the 60-month moratorium except for established fraud** | `S02`,`S12` |
| `DEN_NOT_MEDICALLY_NECESSARY` | Admission or procedure not medically necessary | `S02` |
| `DEN_DAYCARE_NOT_LISTED` | <24 h stay and the procedure is not in the policy's day-care list | `S02` |
| `DEN_FRAUD` | False or fraudulent claim | any |
| `DEN_LIMIT_EXHAUSTED` | Sub-limit or sum insured exhausted | `S02`,`S10` |

**Important distinction for the engine:** Categories A–E are **deficiencies** (soft; recoverable by
resubmission inside a window). Category F are **denials** (coverage decisions; recoverable only by
appeal, with clinical/ legal argument, and per the 2024 Master Circular a repudiation must pass a
three-member Claims Review Committee). The product should route them to completely different queues.

---

## 8. Deduction logic

### 8.1 Room-rent capping and proportionate deduction

The rule: if the policy caps room rent (commonly 1% of sum insured per day for normal room, 2% for ICU,
or a flat ₹ per day, or "single private AC room" category) and the patient occupies a costlier room, the
insurer pays **not only a reduced room rent but a proportionate share of the associated charges**, on the
theory that the hospital's tariff for surgeon fees, nursing and OT scales with room category.

```
eligible_ratio = min(1, room_rent_eligible_per_day / room_rent_actual_per_day)
payable(associated_head) = billed(associated_head) × eligible_ratio
```

Worked example (₹5,00,000 SI, 1% cap = ₹5,000/day eligible; actual room ₹10,000/day → ratio 0.5; on
₹40,000 of associated charges, ₹20,000 is deducted)
([Ditto](https://joinditto.in/articles/health-insurance/proportionate-deduction-in-health-insurance/),
[SMC](https://www.smcinsurance.com/health-insurance/room-rent-limits-and-proportionate-deduction-in-health-insurance)).

**Heads normally excluded from the proportionate base** (i.e. paid in full): ICU charges, medicines and
pharmacy, implants, consumables, and diagnostics
([Ditto](https://joinditto.in/articles/health-insurance/proportionate-deduction-in-health-insurance/)).
**[PRACTICE]** — the exclusion set is policy-wording-dependent and is a frequent dispute; model it as a
per-UIN set `proportionate_exempt_heads[]` rather than a constant.

Engine requirement: this is computable **at admission**, from the pre-auth form's own
"per-day room rent" field versus the policy cap. The system should refuse to let a patient be placed in a
room that silently costs the hospital (or the patient) a proportionate cut, or at minimum produce a signed
patient acknowledgement of the differential before admission.

### 8.2 Co-pay, deductibles, sub-limits

- **Co-pay**: a fixed % of every admissible claim borne by the insured (commonly age-linked, e.g. applied
  only above 60, or voluntarily chosen for premium discount — a 20% voluntary co-pay typically earns ~15%
  premium discount). Must be **collected from the patient and receipted**; a missing co-pay receipt is by
  itself a denial trigger at some TPAs.
- **Deductible**: applies to top-up / super-top-up; the primary insurer's settlement letter becomes a
  mandatory document.
- **Disease/procedure sub-limits**: cataract commonly **₹20,000–₹40,000 per eye** (often expressed as
  "10% of SI or ₹40,000 per eye, whichever is lower"); hernia, hysterectomy, joint replacement, maternity
  (normal vs LSCS, with separate newborn cover) routinely carry their own caps, especially in group
  policies ([OneAssure on cataract limits](https://www.oneassure.in/insurance/health-insurance-guides/cataract-surgery-limits-health-insurance-2026),
  [Pazcare](https://www.pazcare.com/blog/disease-specific-sub-limits-in-group-health-insurance-what-hrs-must-know)).
- **Ambulance, pre/post-hospitalisation**: usually capped amounts and fixed day-windows (commonly 30 days
  pre / 60 days post; PM-JAY defines its own 3/15-day windows).

### 8.3 Package rates vs itemised billing

- PM-JAY and state schemes pay **HBP package rates**; itemised billing is not entertained, and the package
  is deemed to include pre-hospitalisation, the admission, implants where specified, and post-discharge
  follow-up. Package-code selection errors (`DEF_PACKAGE_MISMATCH`) are a top standard rejection reason.
- Private empanelment MOUs mix both: a negotiated package for defined procedures, itemised-at-tariff for
  everything else. Billing an MOU-package procedure itemised (or splitting a package to bill implants
  separately) produces `DEF_PACKAGE_VS_ITEMISED` and a clean deduction.
- Anything above tariff is simply disallowed — there is no negotiation at settlement.

### 8.4 Non-payables — the IRDAI four-list structure

IRDAI's standardisation regime (Guidelines on Standardization in Health Insurance, 2016; consolidated in
the Master Circular on Standardization of Health Insurance Products, **IRDAI/HLT/REG/CIR/193/07/2020**,
22 Jul 2020) fixes a single national Annexure-I with four lists that every insurer reproduces verbatim in
its policy wording
([IRDAI Master Circular on Standardization (PDF)](https://irdai.gov.in/documents/37343/366029/Master+Circular+on+Standardization+of+Health+Insurance+Products.pdf),
[2016 Guidelines](https://policyholder.gov.in/documents/38105/48616/Guidelines+on+Standardization+in+Health+Insurance+2016.pdf),
verified item-by-item against a live carrier annexure —
[Aditya Birla Activ Care Annexure I](https://www.adityabirlacapital.com/healthinsurance/assets/PDF/20200930T090713.pdf)).

| List | Meaning | Billing consequence | Count |
|---|---|---|---|
| **List I** | Items for which **coverage is not available** (optional items; insurers *may* cover via a consumables add-on) | Payable by the patient; must be collected and receipted before discharge | 68 items |
| **List II** | Items **to be subsumed into room charges** | Cannot be billed as a separate line at all | 37 items |
| **List III** | Items **to be subsumed into procedure charges** | Cannot be billed separately | 23 items |
| **List IV** | Items **to be subsumed into the cost of treatment** | Cannot be billed separately | 18 items |

Representative items (the full lists should be loaded as reference data, matched against the pharmacy and
"other charges" heads of the bill by fuzzy name match):

- **List I (not payable)** — baby food, baby utilities, beauty services, belts/braces, buds, cold/hot pack,
  carry bags, email/internet charges, food charges other than patient diet, leggings, laundry, mineral
  water, sanitary pad, telephone, guest services, crepe bandage, diapers, eyelet collar, slings, blood
  grouping and cross-matching of *donor* samples, service charges where nursing is also charged,
  television, surcharges, attendant charges, extra diet, birth certificate, certificate charges, courier,
  conveyance, medical certificate, medical records, photocopies, mortuary charges, walking aids, oxygen
  cylinder for use outside the hospital, spacer, spirometer, nebuliser kit, steam inhaler, armsling,
  thermometer, cervical collar, splint, diabetic footwear, knee braces, knee/shoulder immobiliser,
  lumbo-sacral belt, nimbus/water/air bed, ambulance collar, ambulance equipment, abdominal binder,
  private/special nursing, sugar-free tablets, creams/powders/lotions (toiletries), ECG electrodes,
  **gloves**, nebulisation kit, **any kit with no details mentioned (delivery kit, ortho kit, recovery
  kit)**, kidney tray, mask, ounce glass, oxygen mask, pelvic traction belt, pan can, trolley cover,
  urometer/urine jug, ambulance, vasofix safety.
- **List II (into room charges)** — baby charges unless specified, hand wash, shoe cover, caps, cradle,
  comb, room fresheners, foot cover, gown, slippers, tissue paper, tooth paste/brush, bed pan, face mask,
  flexi mask, hand holder, sputum cup, disinfectant lotions, **luxury tax**, HVAC, housekeeping, air
  conditioner, **IM/IV injection charges**, clean sheet, blanket/warmer, admission kit, diabetic chart,
  **documentation/administrative charges**, **discharge procedure charges**, daily chart, entrance/visitor
  pass, expenses related to discharge prescription, **file opening charges**, incidental/misc charges not
  explained, patient identification band, pulse-oximeter charges.
- **List III (into procedure charges)** — hair removal cream, disposable razor for site preparation, eye
  pad/shield/drape/kit, camera cover, DVD/CD charges, gauze and gauze soft, ward and theatre booking
  charges, arthroscopy and endoscopy instruments, microscope cover, surgical blades/harmonic
  scalpel/shaver, surgical drill, X-ray film, Boyle's apparatus charges, cotton, cotton bandage, surgical
  tape, apron, tourniquet, ortho bundle / gynaec bundle.
- **List IV (into cost of treatment)** — admission/registration charges, **hospitalisation for
  evaluation/diagnostic purpose**, urine container, blood reservation and antenatal booking charges, BiPAP
  machine, CPAP/CAPD equipment, infusion pump cost, hydrogen peroxide/spirit/disinfectants, dietician/diet
  charges, HIV kit, antiseptic mouthwash, lozenges, mouth paint, vaccination charges, alcohol swabs, scrub
  solution/sterillium, glucometer and strips, urine bag.

Two engine-relevant nuances:

1. **List II–IV items are not "patient payable" — they are "already paid for".** Billing them separately
   is a billing *defect* on the hospital's side, not a patient liability. The system should strip them
   from the bill pre-submission, not move them to the patient's counter.
2. The 29 May 2024 Master Circular sharpened the medical-necessity test and pushed insurers to sell a paid
   **Consumables Cover** rider; where such a rider or a corporate waiver exists, List I items *are*
   payable. So the non-payable evaluation is `list_membership × policy_rider_state`, not a static
   blacklist ([righttoinformation.wiki analysis](https://righttoinformation.wiki/consumables-deducted-health-insurance-claim)).

### 8.5 Implant and device price caps (NPPA)

Statutory ceilings under the DPCO regime, checked by payers against `DOC_IMPLANT_INVOICE`:

| Device | Ceiling (ex-GST) | Effective |
|---|---|---|
| Bare-metal stent (BMS) | ₹10,762.15 | Apr 2025 |
| Drug-eluting stent (DES), incl. metallic DES and BVS/biodegradable | ₹39,186.03 | Apr 2025 |
| Primary knee replacement system (titanium/oxidised-zirconium coated variants priced separately) | ₹51,563 (cobalt-chromium primary tier) | capped since 2017, extended by successive NPPA orders |
| Revision knee replacement system | ₹83,547 | same |

Sources: [TheHealthMaster on 2025 stent prices](https://thehealthmaster.com/2025/03/28/new-prices-of-coronary-stents-2025/),
[Medical Dialogues on the 2026 revision](https://medicaldialogues.in/amp/news/industry/medical-devices/nppa-revises-coronary-stent-prices-des-at-rs-39186-and-bms-at-rs-10762-from-april-2026-168192),
[Business Standard on the knee-implant cap extension](https://www.business-standard.com/industry/news/nppa-extends-knee-implant-price-ceiling-november-2026-125111701358_1.html).

**These are WPI-revised annually and extended by order.** They must live in a dated reference table
(`effective_from`, `effective_to`), never as constants — a stent billed at last year's ceiling after a
revision is a deduction. IRDAI's 2025 fraud reporting flags implant overbilling above NPPA caps or
insurer-negotiated tariffs in a meaningful share of implant claims **[PRACTICE — single secondary
source, treat as directional]**.

---

## 9. Disease / procedure dimension

The rule key must include a procedure or disease axis because the *mandatory evidence set* and the
*benefit treatment* both change. A workable taxonomy, with the concrete deltas:

| Group | Extra mandatory evidence | Benefit / deduction specifics | Characteristic deficiency |
|---|---|---|---|
| **Cardiac — PTCA/PCI, CABG, EP/device** | CAG diagram/images with patient name and date, ECG, Trop-I/CPK-MB, echo; **stent invoice + sticker per stent**; catheterisation-lab notes | NPPA stent ceiling; number of stents must match the number of invoices and stickers; often a package under MOU/HBP | `DEF_IMPLANT_STICKER_MISSING`, `DEF_IMPLANT_ABOVE_CAP`, stent count mismatch |
| **Ortho — TKR/THR, spine, trauma fixation** | **Pre- and post-procedure imaging**, **pre- and post-procedure clinical photograph**, detailed operative notes (NHA STG, verbatim); implant invoice + sticker; for THR a documented history of trauma / AVN / severe OA with supporting X-ray or CT (this is literally the PPD's checklist) | NPPA knee-implant ceilings; joint-replacement sub-limits common in group policies; ortho-bundle/ortho-kit is a List I/III non-payable | `DEF_INVESTIGATION_MISSING` (no pre-op film), `DEF_OT_NOTES_DEFECTIVE` (site/side absent) |
| **Maternity** | LMP/EDD, antenatal record, USG reports, delivery notes, newborn record; LSCS indication note | Maternity waiting period (typically 9–48 months; retail often excluded, corporate usually covered); normal vs LSCS sub-limits; separate newborn cover; antenatal booking charges are a **List IV** non-payable | `DEN_WAITING_PERIOD`, sub-limit overshoot, delivery-kit billed (List I) |
| **Cataract / ophthalmic** | Vision assessment, biometry/A-scan, **IOL sticker + invoice**, per-eye operative notes | Per-eye sub-limit (₹20,000–₹40,000 typical), 24-month specific-disease waiting period in many retail products, both eyes often not payable in the same policy year; eye pad/shield/drape/kit are List III | `DEN_WAITING_PERIOD`, sub-limit, `DEF_IMPLANT_STICKER_MISSING` (IOL) |
| **Oncology** | **Biopsy / HPE / FNAC / PET-CT confirming malignancy** (explicit NHA query text), staging, chemo protocol and cycle number, day-care eligibility for each cycle | Package vs itemised for chemo; day-care listing; high-value drugs need batch/invoice; critical-illness benefit policies pay on diagnosis, not on bill | `DEF_HPE_MISSING`, `DEN_DAYCARE_NOT_LISTED` |
| **Dialysis / nephrology** | **Haemodialysis chart plus justification for frequency**, creatinine/urea trend, AV-fistula notes | Day-care procedure; per-session package rates; frequency caps | `DEF_DIALYSIS_CHART_MISSING` |
| **ICU / critical care** | ICU chart, ventilator record, **photo of patient in ICU with ventilator** for scheme claims | ICU sub-limit (often 2% of SI/day); ICU charges typically exempt from the proportionate base | proportionate deduction disputes |
| **Trauma / RTA / poisoning / burns** | **MLC or FIR**, how-injury-occurred narrative, date of injury, alcohol/substance test report if flagged | Intoxication and self-inflicted injury exclusions | `DEF_MLC_MISSING`, `DEF_ALCOHOL_REPORT_MISSING` |
| **Short-stay / day care** | Procedure must appear in the policy's day-care list; time-in / time-out documented | The 24-hour rule; "hospitalisation for evaluation/diagnostic purpose" is a List IV non-payable | `DEN_DAYCARE_NOT_LISTED`, `DEF_ADMISSION_NOT_JUSTIFIED` |
| **Psychiatry, AYUSH, bariatric, transplant, infertility** | Scheme/product-specific; transplant needs donor documentation and authorisation-committee clearance | Frequently sub-limited or excluded; AYUSH requires a recognised AYUSH hospital | `DEN_EXCLUSION` |

Cross-cutting rule: **the evidence set is a function of the procedure, and the payer's own
standard-treatment guidelines (STG/HBP for schemes, internal medical protocol for private) define it.**
Scheme STGs are published; private protocols are not — so the private side must be learned from actual
query history per payer and per procedure.

---

## 10. Regulatory and infrastructure layer

| Instrument | What it fixes | Engine relevance |
|---|---|---|
| **IRDAI Master Circular on Health Insurance Business, 29 May 2024** (IRDAI/HLT/CIR/MISC/77/05/2024) | 1-hour cashless, 3-hour discharge, 30-day settlement, 60-month moratorium, Claims Review Committee for repudiation, "TPAs/insurers collect documents from hospitals", TPA remuneration decoupled from ICR, multi-policy coordination, ₹5,000/day ombudsman-award penalty. Repealed and consolidated 55 earlier circulars | Defines the clocks and the *legal* shift of documentation burden to the hospital |
| **IRDAI (Insurance Products) Regulations, 2024** (w.e.f. 1 Apr 2024) | PED waiting period ≤36 months; specific-disease waiting period ≤36 months | PED/waiting-period rule evaluation |
| **Master Circular on Standardization of Health Insurance Products, IRDAI/HLT/REG/CIR/193/07/2020** (22 Jul 2020) + Guidelines on Standardization in Health Insurance (2016) | Standard definitions, standard exclusions, **Annexure-I Lists I–IV of non-medical expenses**, standard claim forms, customer information sheet | The non-payable engine and the Form A/B field model |
| **Standard Claim Form Part A / Part B** | Part A by the insured; **Part B by the hospital**, carrying ICD-10 and ICD-10-PCS codes, bill break-up and a document-handover confirmation | The hospital's obligatory structured output |
| **Standard cashless pre-authorisation form** | The four-section form in §6.5 | The hospital's obligatory structured input |
| **General Insurance Council "Cashless Everywhere", Jan 2024** | Cashless at non-network hospitals: ≥15 beds, CEA registration, 48 h elective / 48 h emergency intimation | A distinct `claim_type` with its own hard clock |
| **ROHINI (IIB)** | 13-digit GS1 unique hospital id; precondition for empanelment | Provider master key |
| **NHCX (NHA + IRDAI, live June 2024, under ABDM)** | FHIR R4 exchange of eligibility, pre-auth, claim, adjudication, payment and **queries** (`Communication` / `CommunicationRequest`), replacing bespoke insurer portals | The target integration surface; the NRCeS IG defines `ClaimBundle`, `ClaimResponseBundle`, `CoverageEligibilityRequest/ResponseBundle`, `InsurancePlanBundle`, `TaskBundle` |
| **PM-JAY Claims Adjudication Manual 2.0 (NHA, Oct 2020) + HBP + Field Investigation and Medical Audit Manual** | PPD/CPD workflow, standard query reasons, standard rejection reasons, uniform TAT, discharge-summary format, OT-note and clinical-photo templates | **The single best published specification of a payer's adjudication rulebook in India** — private TPAs are structurally similar and undocumented |
| **NPPA / DPCO ceiling-price orders** | Stent and knee-implant ceilings, WPI-revised | Implant price validation |
| **Insurance Ombudsman (RPG Rules 2017)** | Free quasi-judicial escalation after the insurer's internal grievance is exhausted | Terminal appeal stage |

**NHCX status note.** NHCX went live June 2024; IRDAI's Health Insurance Sub-Committee has been pushing
insurer and provider onboarding with incentives tied to onboarding, payment and faster settlement, with
PSU insurers being onboarded through 2025–26
([TaxGuru on the IRDAI sub-committee](https://taxguru.in/corporate-law/irdai-health-insurance-committee-advances-customer-trust-nhcx-adoption.html),
[Nathealth NHCX brief](https://nathealthindia.org/wp-content/uploads/2025/06/National-Health-Claims-Exchange_Latest.pdf)).
I found **no** circular mandating "100% cashless by 2027"; treat that claim, which circulates in vendor
marketing, as unverified.

---

## 11. Proposed rule-engine shape

The whole of §§3–9 reduces to six tables plus a resolver.

```
payer                 (payer_id, type: INSURER|TPA|SHA, irdai_ref, nhcx_participant, parent_insurer_id)
payer_config          (payer_id, claim_type, key, value, effective_from, effective_to)
                        -- claim_submission_days, query_response_days, retro_preauth_hours,
                        -- preauth_decision_tat_minutes, discharge_tat_minutes, max_query_rounds

benefit_plan          (uin | group_policy_id, insurer_id, room_cap_rule, icu_cap_rule, copay_rule,
                       deductible, ped_wait_months, specific_wait_months, maternity_wait_months,
                       proportionate_exempt_heads[], consumables_rider, sublimits{procedure→cap})

doc_requirement       (stage, claim_type, payer_id|NULL, procedure_group|NULL, doc_code,
                       obligation: MANDATORY|CONDITIONAL|OPTIONAL, condition_expr, source)
                        -- NULL payer/procedure = applies to all; most specific row wins

deficiency_rule       (def_code, category, stage_detectable, blocking, predicate_expr,
                       remediation_text, payer_id|NULL, claim_type|NULL, procedure_group|NULL)

deduction_rule        (ded_code, basis: ROOM_PROP|SUBLIMIT|COPAY|NONPAYABLE|TARIFF|PACKAGE|NPPA,
                       scope_heads[], formula_expr, uin|group_policy_id|payer_id, effective_from)

reference_nonpayable  (list_no 1..4, item_name, normalised_tokens[], source_circular)
reference_nppa_cap    (device_class, ceiling_ex_gst, effective_from, effective_to, order_ref)
```

**Resolution order** (most specific wins, then union for documents, then max-severity for deficiencies):

```
(payer_id, claim_type, procedure_group, uin)
  → (payer_id, claim_type, procedure_group)
  → (payer_id, claim_type)
  → (claim_type)
  → (*)
```

**Three design commitments that fall out of the research:**

1. **Approvals are constraint objects, not amounts.** `S04`/`S08` must persist room cap, co-pay %, named
   diagnosis, named procedure, validity window and pre-excluded heads. Almost every §8 deduction is a
   violation of something written in the approval letter that nobody parsed.
2. **The engine must run at three moments, not one:** at admission (room category, intimation clock,
   waiting-period and sub-limit exposure — all computable from the pre-auth form alone), continuously
   during the stay (enhancement triggers on divergence from the constraint object), and at pre-discharge
   (the full document and cross-document consistency sweep, before the 3-hour final-authorisation clock
   starts). A single pre-submission gate at discharge catches the documentation defects and misses every
   one of the timing and pre-auth defects, which are the expensive ones.
3. **Private payer rulebooks are not published; the scheme rulebook is.** Seed the deficiency catalog from
   the NHA standard query and rejection reason lists (§7 is largely that, generalised), then learn the
   per-payer deltas from actual inbound query text. `deficiency_rule.payer_id` exists for exactly this.

---

## 12. Open questions / things to verify before coding

1. **The 2024 Master Circular's annexures could not be retrieved directly** (irdai.gov.in and the IAI
   mirror both failed TLS/fetch from here). The claim-document list and any standardised query taxonomy in
   those annexures should be pulled from the official PDF before the document catalog is frozen.
2. **Per-TPA submission and query windows** are MOU terms, not public. Extract them from the hospital's own
   empanelment agreements — that is the authoritative source and it is sitting in the finance office.
3. **Proportionate-deduction exempt heads** vary by policy wording and are disputed. Read the actual UIN
   wordings for the top 10 payers by volume at the client hospitals.
4. **NPPA ceilings move annually.** Wire the reference table to the NPPA order feed or accept a manual
   dated update; a stale constant becomes a silent deduction.
5. **ICD-10 vs ICD-10-PCS coverage.** Claim Form Part B demands PCS codes for procedures; most Indian HIS
   installations do not produce them. Verify what the hospital can actually emit before making
   `DEF_PCS_MISSING` blocking.
6. **PM-JAY TAT figures above are from Claims Adjudication Manual 2.0 (Oct 2020)** via the Kerala SHA
   mirror. NHA has issued later operational orders; confirm the current TAT before enforcing auto-reject
   clocks for scheme claims.

---

## Sources

Regulatory and official
- [IRDAI Master Circular on Health Insurance Business, 29 May 2024 — full text reproduction](https://taxguru.in/corporate-law/master-circular-irdai-insurance-productsregulations-2024health-insurance.html)
- [Annexure to the Master Circular on Health Insurance Business, 29 May 2024 (IAI mirror)](https://www.actuariesindia.org/sites/default/files/inline-files/6.%20Annexure%20to%20Master%20Circular%20on%20Health%20Insurance%20Business%2029052024.pdf)
- [Master Circular on Standardization of Health Insurance Products, IRDAI/HLT/REG/CIR/193/07/2020](https://irdai.gov.in/documents/37343/366029/Master+Circular+on+Standardization+of+Health+Insurance+Products.pdf)
- [Guidelines on Standardization in Health Insurance, 2016](https://policyholder.gov.in/documents/38105/48616/Guidelines+on+Standardization+in+Health+Insurance+2016.pdf)
- [NHA / Kerala SHA — Claims Adjudication Manual 2.0 (AB PM-JAY)](https://sha.kerala.gov.in/wp-content/uploads/2022/08/Claims-Adjudication-Manual-2_0-final.pdf)
- [NHA — Operation Manual for AB PM-JAY](https://nha.gov.in/img/resources/Operation%20Manual%20for%20AB%20PM-JAY.pdf)
- [NRCeS — FHIR Implementation Guide for ABDM, NHCX profiles](https://www.nrces.in/preview/ndhm/fhir/r4/hcx-profile.html)
- [General Insurance Council — Cashless Everywhere press release](https://www.gicouncil.in/news-media/events/press-release-launch-of-cashless-everywhere/)
- [ROHINI — Registry of Hospitals in Network of Insurance (IIB)](https://rohini.iib.gov.in/about_us)
- [IRDAI Health Insurance Sub-Committee on NHCX adoption](https://taxguru.in/corporate-law/irdai-health-insurance-committee-advances-customer-trust-nhcx-adoption.html)

Forms and payer artefacts
- [Good Health TPA — Pre-Authorisation Request Form (4-section standard form)](https://goodhealthtpa.com/wp-content/uploads/2020/01/Preauthorization-Request-Form.pdf)
- [Vidal Health TPA — Pre-Authorisation Guide for hospitals](https://vidalhealthtpa.com/vidalhealthtpa/pre-authorisation-guide.html)
- [Medi Assist — IRDA Claim Form Part B](https://blog.mediassist.in/irda-claim-form-part-b/) · [Part A](https://blog.mediassist.in/irdai-claim-form-part-a/) · [Implant details](https://blog.mediassist.in/implant-details/)
- [Aditya Birla Health — Annexure I, Lists I–IV of non-medical expenses](https://www.adityabirlacapital.com/healthinsurance/assets/PDF/20200930T090713.pdf)
- [Paramount TPA — Health Claim Form Part B (Oriental)](https://www.paramounttpa.com/Home/ClaimForms/Oriental%20Insurance/Health%20Claim%20Form%20Part-B.pdf)

Market practice and analysis
- [Why TPA and insurance claims get rejected in Indian hospitals — and how to recover them](https://accredready.in/learn/tpa-insurance-claim-denials)
- [Ditto — Proportionate deduction in health insurance](https://joinditto.in/articles/health-insurance/proportionate-deduction-in-health-insurance/)
- [SMC — Room rent limits and proportionate deduction](https://www.smcinsurance.com/health-insurance/room-rent-limits-and-proportionate-deduction-in-health-insurance)
- [Pazcare — Disease-specific sub-limits in group health insurance](https://www.pazcare.com/blog/disease-specific-sub-limits-in-group-health-insurance-what-hrs-must-know)
- [OneAssure — Cataract surgery limits and lens coverage](https://www.oneassure.in/insurance/health-insurance-guides/cataract-surgery-limits-health-insurance-2026)
- [TheHealthMaster — NPPA coronary stent prices 2025](https://thehealthmaster.com/2025/03/28/new-prices-of-coronary-stents-2025/)
- [Medical Dialogues — NPPA revises coronary stent ceiling prices](https://medicaldialogues.in/amp/news/industry/medical-devices/nppa-revises-coronary-stent-prices-des-at-rs-39186-and-bms-at-rs-10762-from-april-2026-168192)
- [Business Standard — NPPA extends knee implant price ceiling](https://www.business-standard.com/industry/news/nppa-extends-knee-implant-price-ceiling-november-2026-125111701358_1.html)
- [Business Today — IRDAI reduces PED waiting period to 3 years](https://www.businesstoday.in/personal-finance/insurance/story/irdai-reduces-pre-existing-disease-waiting-period-from-4-to-3-years-here-is-what-existing-policyholders-should-know-425325-2024-04-12)
- [Nathealth — National Health Claims Exchange brief](https://nathealthindia.org/wp-content/uploads/2025/06/National-Health-Claims-Exchange_Latest.pdf)
