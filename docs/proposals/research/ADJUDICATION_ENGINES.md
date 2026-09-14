# The Best Claims Adjudication Engines in the World

**A deep reference on architectures, rule representations, and product features — read for what transfers to a hospital-side, PRE-submission adjudication engine.**

Research date: 2026-09-13. External research only; no ClaimsOS code was read for this document.

---

## 0. How to read this

Our target system is unusual. Almost every mature adjudication engine in the world is built by the **payer** to decide *how much to pay*. We are building the mirror image: a **provider-side engine whose success condition is that the payer's engine finds nothing**. By the time a claim (pre-auth, enhancement, or final bill) reaches the insurer/TPA, **zero deficiencies should be discoverable**.

That inversion changes three things, and every section below is written against them:

1. **Our output is not a payment decision — it is a deficiency list plus an evidence binding.** The payer engine emits "deny, CARC 16". We must emit "this claim will be denied under CARC-16-equivalent unless you attach the post-op scar photograph, because package X's STG requires it."
2. **Our false-positive cost is different.** A payer's false-positive edit costs it provider abrasion and an appeal. Our false positive costs a biller 5 minutes and, if repeated, all credibility. Our **false negative** — telling the hospital a claim is clean when the TPA will query it — is the expensive one. Mature systems manage this asymmetry explicitly (§4.7, §7.6).
3. **We must be right about *someone else's* rules,** which we do not control, which vary per insurer/TPA/scheme, and which change without notice. Every design decision below about versioning, effective-dating, and confidence calibration exists because of this.

---

## 1. The core mental model: adjudication is a layered pipeline, not a bag of rules

The single most transferable idea in the entire US stack is that claim validation is **ordered into levels of increasing semantic depth**, and a claim must clear each level before the next is meaningful. This is codified as the **WEDI SNIP types 1–7**:

| Level | Name | What it validates |
|---|---|---|
| 1 | EDI Standards Integrity | Syntax: segment names, element data types, delimiters, min/max lengths |
| 2 | Implementation Guide Requirement | Loop/segment repeat counts, usage designations, valid code values, HL parent-child hierarchy, sequence |
| 3 | Balancing | Service-line amounts sum to claim-level amounts; calculated summary fields reconcile |
| 4 | Inter-Segment Situational | Conditional logic across segments — "if A present then B required," value-dependent usage |
| 5 | External Code Set | Values against external lists: ICD-10, CPT/HCPCS, NDC, zip/state |
| 6 | Product Type / Type of Service | The code billed is coherent with the *type* of claim (professional vs institutional vs dental) |
| 7 | Trading Partner Specific | Rules unique to one payer, beyond the national standard |

Sources: [RDPCrystal SNIP levels](https://www.rdpcrystal.com/sniplevels/), [Stedi: what are claim edits and repairs](https://www.stedi.com/blog/what-are-claim-edits-and-repairs), [UHC EDI claim edits mapped to SNIP](https://www.uhcprovider.com/content/dam/provider/docs/public/resources/edi/EDI-HIPAA-Claim-Edits.pdf), [EDI Sumo on SNIP 1–7 validation](https://www.edisumo.com/blogs/what-software-can-run-wedi-snip-levels-17-validation-on-837-claim-files-and-explain-errors-for-payer-teams).

**Why this matters to us.** Level 7 — trading-partner-specific — is where *all* the Indian insurer/TPA variation lives, and it is deliberately the *last* layer. A system that mixes "the discharge summary PDF is unreadable" (our Level 1) with "Star Health requires the ICP for a 3-day-plus stay" (our Level 7) into one flat rule list will be unmaintainable within a year. Levels also give a natural **stop rule**: don't emit Level 5 medical-necessity findings on a claim that failed Level 1 document integrity, or you drown the user in cascading noise.

### 1.1 Edit vs. repair vs. rejection vs. denial

A distinction the US stack is rigorous about and most in-house systems blur:

- **Edit** — an automated rule that *identifies* a problem. It never modifies the claim.
- **Repair** — an automatic, deterministic *correction* of a structural defect (stripping formatting from a phone number). Repairs modify the claim but are narrowly scoped and **never touch clinical content**.
- **Rejection** — the claim never entered adjudication; it bounced at the front end. No appeal rights, must be corrected and resubmitted.
- **Denial** — the claim was adjudicated and the answer was "no". Different remedy path entirely.

([Stedi](https://www.stedi.com/blog/what-are-claim-edits-and-repairs))

**Transferable:** we should implement all four categories with the same discipline, and never let an auto-repair touch a clinical field. Auto-repairing "date format" is fine. Auto-"correcting" a diagnosis code is a fabrication risk and a compliance risk.

### 1.2 The metric that should define our product: clean claim rate vs first-pass yield

- **Clean Claim Rate (CCR)** = % of claims that pass *your own* scrubber and the payer's front-end without manual intervention. A **pre-submission** accuracy score.
- **First Pass Yield (FPY)** = % of claims **paid in full on first submission** with no rework, no query, no appeal.

High performers hit ≥95% on both. Critically: **a high CCR can coexist with a low FPY** — the claim was structurally perfect and still got denied for eligibility or medical necessity that no scrubber caught.

([Inovalon](https://www.inovalon.com/blog/first-pass-yield-vs-clean-claim-rate/), [Office Ally](https://cms.officeally.com/blog/first-pass-yield-vs-clean-claim-rate), [OS Healthcare: focus on FPY not CCR](https://www.os-healthcare.com/news-and-blog/changing-the-conversation-on-denials-make-your-focus-first-pass-yield-and-not-clean-claim-rate), [AMS clean claim benchmark](https://ams-solutions.com/clean-claim-rate-benchmark/))

**This is the single most important framing for our product.** The industry consensus is explicit that CCR is the vanity metric and FPY is the real one. "Zero deficiencies discoverable by the insurer" **is FPY = 100%** — i.e. no TPA query, no deduction, no reimbursement fallback. We should instrument FPY per insurer, per specialty, per package **from day one**, and treat our own CCR as a leading indicator only. The gap between our CCR and our realised FPY is precisely the measure of our blind spots, and it is the feedback signal that trains rule authoring (§7.6).

For the same reason, hospital-side vendors measure **DNFB** (Discharged Not Final Billed) and **DNFC** (Discharged Not Final Coded) as the upstream queues: DNFC tracks coding/documentation completion, DNFB tracks billing edits still unresolved. ([FTI Consulting](https://www.fticonsulting.com/insights/articles/blocking-tackling-revenue-cycle))

---

## 2. The US payer / clearinghouse stack

### 2.1 The content layer: where edit *content* comes from

Edits are not invented by the vendor; they are **sourced, cited, and versioned**. This is the part most in-house engines get wrong.

**NCCI (National Correct Coding Initiative)** — CMS-published, two edit families:

- **PTP (Procedure-to-Procedure) edits**: Column One / Column Two code pairs that may not be billed together, each with a **modifier indicator** (0 = never bypassable, 1 = bypassable with an appropriate modifier, 9 = not applicable) and an **edit rationale**. Separate tables for practitioner vs outpatient-hospital settings.
- **MUE (Medically Unlikely Edits)**: max units of service for a HCPCS/CPT code, per patient, per date of service, per provider. Each MUE carries an **MAI (MUE Adjudication Indicator)**: MAI 1 = claim-line edit (auto-deny the line); MAI 2/3 = **date-of-service edit** — units are summed across the current claim *and prior finalized claims* for that DOS, and if the sum exceeds the value, all lines for that code on that DOS are denied.
- **Versioned quarterly**: four versions a year, effective Jan 1 / Apr 1 / Jul 1 / Oct 1.

Sources: [CMS NCCI](https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits), [NCCI Policy Manual Ch.1 (2026)](https://www.cms.gov/files/document/01-chapter1-ncci-medicare-policy-manual-2026-final.pdf), [CMS NCCI FAQ on MUE/MAI and retroactivity](https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-faq-library), [Noridian NCCI](https://med.noridianmedicare.com/web/jeb/topics/claim-submission/ncci).

**Four structural lessons for us, independent of NCCI's actual content:**

1. **A rule can carry a machine-readable bypass condition** (the modifier indicator). Not "violation / no violation" but "violation *unless* a specific, checkable justification is present." Our Indian analog: "package X and package Y cannot be claimed together **unless** the operative notes document a separate anatomical site."
2. **A rule declares its evaluation scope** (the MAI: line vs date-of-service vs episode). Scope must be a first-class attribute, not implicit in how the code is written.
3. **A rule declares a rationale category**, not just a message. NCCI sorts edits by *edit rationale* and CPT section. Rationale categories are what let you aggregate, report, and teach.
4. **Rules are effective-dated and applied by date of service, and prior finalized claims are not retroactively re-adjudicated.** Payer policy typically gives ~30 days' notice for edits arising from CPT/HCPCS/modifier changes, and applies them to dates of service on/after the effective date. ([Superior HealthPlan code-editing policy CC.PP.011](https://www.superiorhealthplan.com/content/dam/centene/policies/payment-policies/CC.PP.011.pdf), [Horizon BCBSNJ ClaimsXten editing rules](https://www.horizonblue.com/providers/policies-procedures/policies/reimbursement-policies-guidelines/claimsxten-editing-rules))

**Coverage/medical-necessity content** comes from **NCDs** (national, binding on all MACs) and **LCDs** (local, where no NCD exists). An LCD is effectively a machine-usable artifact: it enumerates covered HCPCS codes and the ICD-10 codes that do/don't establish medical necessity. ([Noridian LCD](https://med.noridianmedicare.com/web/jddme/policies/lcd), [HelpAdvisor LCD vs NCD](https://www.helpadvisor.com/medicare/lcd-vs-ncd), [Libman Education](https://libmaneducation.com/medical-necessity-know-your-ncds-and-lcds/)). **Utilization-management criteria** — InterQual (Change/Optum) and MCG — sit above that as first-level clinical screening for whether a level of care is indicated. ([Carelon medical necessity criteria](https://www.carelonbehavioralhealth.com/providers/resources/medical-necessity-criteria), [Commonwealth Care Alliance MNG-045](https://www.commonwealthcarealliance.org/ma/wp-content/uploads/2026/02/Medical-Necessity_MNG-045.pdf))

The India analog of LCD/NCD + InterQual is the **PM-JAY Standard Treatment Guidelines + HBP package master** (§5.4) and each insurer's **policy wording + exclusions + sub-limit schedule**. The critical insight is that in the US this content is *published in a structured, diffable, effective-dated form*, whereas in India it is PDFs and tribal knowledge. **Turning Indian payer policy into structured, effective-dated, citable rule content is the actual moat.**

### 2.2 The vendor layer: how commercial edit engines are built

**Optum Claims Edit System (CES)** — used by 80+ payers. Architecture worth copying:

- Content is aggregated from three distinct channels: **regulatory** (CMS, AMA, state Medicaid), **clinical** (specialty-society guidelines), and **behavioral analytics** (patterns mined from historical claims).
- Rule governance runs through **interdisciplinary committees** — compliance specialists, certified coders, clinicians, data scientists — not engineers alone.
- **Customization is layered, not forked**: payers enable/disable rule *sets*, and parameterize thresholds (dollar limits, error tolerance, severity), plus author their own rules on top for contractual policies. The vendor's base content is never edited in place.
- **Hard vs soft edits**: a per-edit disposition the payer can configure, which is how the same rule base serves payers with different risk appetites.
- **Second Pass** is a distinct product: a second editing pass after the primary adjudication system has run, catching what the core system missed. The two-pass architecture is itself a design pattern.
- **Automated audit trail of the rule base**: every rule change records what changed, the rationale, and which claims are impacted; **regression analysis** identifies conflicts between new and existing rules before deployment.

Sources: [Optum Claims Edit System](https://business.optum.com/en/operations-technology/payment-integrity/claim-editing.html), [CES Second Pass](https://www.optum.com/content/dam/optum3/optum/en/resources/sell-sheet/optum-claims-edit-system-second-pass.pdf), [Real Edit Intelligence](https://business.optum.com/en/operations-technology/payment-integrity/claim-editing/real-edit-intelligence.html), [CES mechanics teardown](https://www.onhealthcare.tech/p/unpacking-the-mechanics-of-claim), [Advanced Claims Editing](https://campaign.optum.com/content/dam/optum/resources/brochures/Advanced_Claims_Editing.pdf).

**Cotiviti Payment Policy Management / Payment Clarity** — the strongest published position on **explainability as a product surface**:

- Policy content is reviewed by medical directors, certified coders and expert panels against **100+ sources** (AMA, national and regional CMS, specialty societies, state Medicaid), and is explicitly described as *defensible*.
- **Payment Clarity** is a transparency suite for the *counterparty*: it explains why a claim was flagged, which policy applied, and the recommended next step — plus provider-inquiry support.
- **AI-assisted rule authoring** is positioned as a content-development accelerator, not as the decision engine.
- Single-ingestion architecture: claims, eligibility, fee schedules and provider contracts are ingested once and reused across all payment-accuracy capabilities.

Sources: [Payment Policy Management](https://www.cotiviti.com/solutions/payment-accuracy/payment-policy-management), [Payment Clarity fact sheet](https://resources.cotiviti.com/payment-accuracy-solutions/cotiviti-payment-clarity), [Cotiviti payment integrity guide](https://info.cotiviti.com/hubfs/assets/white_paper/Cotiviti-Guide-PaymentIntegrity.pdf), [Clinical Chart Validation](https://www.cotiviti.com/solutions/payment-accuracy/clinical-chart-validation).

**Zelis Intelligent Pricing Platform (ZIPP)** — the notable architectural claim is **unifying editing and pricing under a single ingestion point so the two inform each other**, rather than running as sequential silos; modular activation (editing, pricing, itemized bill review) so a customer can adopt one module without a rip-and-replace. AI accelerates ingestion/routing/error detection while human experts validate for "compliance and defensibility." ([ZIPP launch](https://www.zelis.com/news/zelis-intelligent-pricing-platform-launch/), [Zelis claims editing](https://www.zelis.com/solutions/payment-integrity/claims-editing/), [customized edits](https://www.zelis.com/blog/customized-healthcare-claims-edits-through-partnership/))

**Waystar** — the provider-side analog and closest to our product shape. Claim Manager does pre-submission scrubbing, editing and **denial prediction**; the differentiator is **Rule Manager**, a customer-facing rule-authoring surface combining configurable rules with **crowdsourced rules learned across the customer base**. Waystar reports $15.5B in cumulative denials prevented (2025 10-K). ([Waystar Claim Manager](https://www.waystar.com/our-platform/claim-management/claim-manager/), [packages](https://www.waystar.com/packages/))

**Availity / Change Healthcare (Optum)** — multi-payer clearinghouse + provider portal. Availity Essentials Pro spans pre-service (eligibility, prior auth), post-service and post-adjudication, with AI-driven **predictive editing** before submission. Payer connectivity is exposed over X12, SOAP, REST and FHIR APIs. ([Availity Essentials Pro](https://www.availity.com/essentials-pro/), [API guide](https://developer.availity.com/blog/2025/3/25/availity-api-guide), [HIPAA transaction APIs](https://developer.availity.com/blog/2025/3/25/hipaa-transactions))

**Transferable pattern — crowdsourcing.** Waystar's crowdsourced rules and Cotiviti's cross-payer analysis are the same idea: *one hospital cannot learn a TPA's unwritten rules fast enough; a network of hospitals can.* Every query and deduction observed at any customer hospital is a labelled training example for a rule that should exist. Design the deficiency taxonomy (§2.3) so this aggregation is possible from day one.

### 2.3 The denial language: CARC / RARC / CAGC and the CORE 360 rule

Every US denial is expressed in a **shared national vocabulary**, not payer prose:

- **CARC** (Claim Adjustment Reason Code) — *why* the amount adjudicated differs from the amount billed.
- **RARC** (Remittance Advice Remark Code) — supplemental clarification attached to a CARC. One line can carry one CARC and several RARCs.
- **CAGC** (Claim Adjustment Group Code) — *who bears it*: CO (contractual obligation), PR (patient responsibility), OA (other), PI (payer-initiated), CR (correction/reversal).
- These are **externally maintained national code sets** (X12 / CMS), revised three or more times a year — so a code means the same thing regardless of which insurer sent it.

Sources: [X12 RARC list](https://x12.org/codes/remittance-advice-remark-codes), [Mass.gov 835/CARC/RARC](https://www.mass.gov/info-details/835-payment-advice-and-eobcarc-rarc-lists), [Flexbone explainer](https://flexbone.ai/blog/what-are-carc-and-rarc-codes/).

**CAQH CORE 360 "Uniform Use of CARCs and RARCs (835)"** goes one level further and is the most directly copyable artifact in this whole document. Because payers were selecting codes idiosyncratically — defeating auto-posting — CORE defined **four canonical Claim Adjustment/Denial Business Scenarios**, each with a *maximum permitted set* of CARC/RARC/CAGC combinations:

| Scenario | Meaning |
|---|---|
| **#1** | Additional information required — **missing/invalid/incomplete documentation** |
| **#2** | Additional information required — **missing/invalid/incomplete data on the submitted claim** |
| **#3** | **Billed service not covered** by the health plan |
| **#4** | **Benefit for billed service not separately payable** |

Payers may add scenarios for their own needs, but **added scenarios must not conflict** with the four. CORE maintains a companion document of required code combinations and convenes to revise it as X12 revises the underlying code lists three-plus times a year.

Source: [CAQH Phase III CORE 360 Rule v3.0.0](https://www.caqh.org/hubfs/CARCsRARCs_835_Rule.pdf) (§4.1.1).

**This is our deficiency taxonomy, pre-designed.** India has no CARC/RARC. But every TPA query and deduction we will ever see falls into a small number of scenarios, and CORE's four are almost exactly right for the Indian cashless world:

1. **Documentation deficiency** — missing/illegible/unsigned document (the dominant Indian failure mode).
2. **Data deficiency** — internal inconsistency or missing field in the submitted claim (DOA/DOD mismatch, diagnosis-package mismatch, missing UHID).
3. **Not covered** — exclusion, waiting period, moratorium, pre-existing condition, non-empanelled specialty.
4. **Not separately payable** — non-payable consumables, bundled items, proportionate deduction from room-rent category mismatch.

Building our finding model as `{scenario, reason_code, severity, evidence_ref, remedy}` — with the reason-code list closed, versioned, and centrally maintained — buys us aggregation, per-insurer analytics, cross-hospital learning, and a stable API contract. **A free-text findings list buys us none of that.** Note PM-JAY already independently converged on this: its TMS forces adjudicators to pick from **closed dropdowns** of standard query reasons and standard rejection reasons, with "Others" + free text as the escape hatch (§5.4). Copy that shape exactly, including the escape hatch and the requirement to explain when the escape hatch is used.

### 2.4 The provider-side mirror: pre-bill review

The vendors closest to what we are building:

- **Solventum (ex-3M) 360 Encompass Audit Expert System / Outpatient Prebill Review** — AI review of coding and documentation for discrepancies **before the claim is submitted**, integrated with the CAC and CDI stack. ([Audit Expert](https://www.solventum.com/en-us/home/health-information-technology/solutions/360-encompass-audit-expert/), [Outpatient Prebill Review](https://www.solventum.com/en-us/home/health-information-technology/solutions/360-encompass-audit-expert-outpatient-prebill-review/), [360 Encompass platform](https://www.solventum.com/en-us/home/health-information-technology/platforms/solventum-360-encompass-system/))
- **Iodine Software** — `Concurrent` prioritises charts *during the stay* where clinical evidence and documentation disagree; `IodinePreBill` audits post-discharge pre-submission; `Interact` manages physician queries. ([IodineCDI overview](https://intuitionlabs.ai/software/medical-coding-computer-assisted-coding-cac/clinical-documentation-improvement-cdi/iodine-software-iodinecdi))
- **AGS Health** — code auditing during the coding/billing process, surfacing DNFB outliers, missing documents and pending queries. ([AGS code auditing](https://www.agshealth.com/ai-platform/code-auditing/))

Two structural lessons:

- **Concurrent beats retrospective.** Iodine's split is the important one: the highest-value intervention is *during the admission*, when the surgeon is still on the floor and the scar photograph can still be taken. A pre-submission engine that only runs at bill-drop has already lost most of its leverage. For Indian cashless, the analogous split is **at pre-auth, at enhancement, at discharge-request, at final claim** — four distinct gates with four distinct rule sets (§7.1).
- **Query management is a first-class module**, not a side effect. The physician query is the remedial action; it needs its own workflow, SLA and audit trail.

Industry context on pre-bill: coding-related denials rose 26% across professional and hospital-outpatient settings and external payer audit requests rose 30% per customer, which is why pre-bill prevention moved from optional to mandatory. ([Healthcare IT Today](https://www.healthcareittoday.com/2026/05/18/under-pressure-why-pre-bill-prevention-is-now-non-negotiable-in-coding-and-denial-management/), [CapMinds pre-bill denial prevention architecture](https://www.capminds.com/blog/pre-bill-denial-prevention-architecture-rules-across-eligibility-documentation-coding-and-claim-scrubbing/))

### 2.5 DRG groupers: what a *fully deterministic* clinical classifier looks like

MS-DRG and APR-DRG groupers are worth studying as the purest example of high-stakes deterministic clinical logic:

- Input is a **minimum dataset**: principal diagnosis, up to ~24 secondary diagnoses, up to ~25 procedures, age, sex, discharge status.
- Control flow is **governed and ordered**: MDC entry → ordered rule evaluation → surgical vs non-surgical partition (OR/non-OR procedures) → CC/MCC (complication/comorbidity) handling → severity subclass. APR-DRG adds 4 severity-of-illness × 4 risk-of-mortality subclasses per base DRG.
- **Annual versioned updates**; the grouping *logic* is identical for every payer — payers differ only in **configuration options and update schedule**.

Sources: [Solventum APR DRG](https://www.solventum.com/en-us/home/health-information-technology/solutions/apr-drg/), [MS-DRG grouping](https://content.findacode.com/files/tutorials/DRG-Grouper-2019-NEW.pdf), [CMS MS-DRG grouper](https://intuitionlabs.ai/software/medical-coding-computer-assisted-coding-cac/drg-grouper-software/cms-ms-drg-grouper), [Tuva Project APR-DRG](https://thetuvaproject.com/terminology/apr-drg), [AHCCCS grouper selection](https://www.azahcccs.gov/PlansProviders/Downloads/DRGGrouper.pdf).

**Transferable:** *shared logic, per-payer configuration, versioned annually.* This is precisely the right shape for our engine — one rule *mechanism* and one rule *content* base, with insurer-specific behaviour expressed as **configuration over a common core**, not as forked logic. It is also the argument for treating PM-JAY HBP package selection as a grouper-like deterministic function of `{diagnosis, procedure, age, sex, specialty, hospital empanelment}` rather than as a lookup the biller does by hand.

### 2.6 Prior authorization is becoming an API — and India is ahead of the curve here

**CMS-0057-F** (Interoperability and Prior Authorization Final Rule) requires MA organizations, Medicaid/CHIP FFS and managed care, and FFE QHP issuers to stand up HL7 **FHIR** APIs — Patient Access, Provider Access, Payer-to-Payer, and a **Prior Authorization API** that automates determining whether PA is required, what documentation is required, and the exchange of the request and decision. Some provisions from 1 Jan 2026, API requirements largely 1 Jan 2027. CMS granted enforcement discretion so a FHIR PA API need not also use X12 278 — but X12 278 alone does not satisfy the rule.

Sources: [CMS-0057-F](https://www.cms.gov/initiatives/burden-reduction/overview/interoperability/policies-regulations/cms-interoperability-prior-authorization-final-rule-cms-0057-f), [CMS fact sheet](https://www.cms.gov/newsroom/fact-sheets/cms-interoperability-prior-authorization-final-rule-cms-0057-f), [CMS APIs/IGs](https://www.cms.gov/priorities/burden-reduction/overview/interoperability/implementation-guides-standards/application-programming-interfaces-apis-relevant-standards-implementation-guides-igs).

The single most important element for us: **"identify prior authorization information and documentation requirements"** as a *queryable API*, i.e. the payer publishes machine-readable documentation requirements per service (the FHIR **DTR / CRD** pattern). India's NHCX (§5.3) is built on the same FHIR foundation. **Our rule base should be modelled as if it were the payer's documentation-requirements service, because eventually it will be one** — and because that framing forces the right data model: requirements keyed by `{payer, service, context}` rather than a pile of conditionals.

---

## 3. Core insurance platforms: how the big four model rules, stages and decision tables

### 3.1 Guidewire ClaimCenter

Classic multi-tier: PCF presentation layer → Gosu business-logic layer (rules, validation, workflow) → ORM persistence → RDBMS. Rules govern coverage validation, reserve approval thresholds, litigation flags, payment authorization limits, and workflow branching; the rules engine is ClaimCenter's principal differentiator over lighter systems. The cost is that **Gosu is proprietary** — the rules layer requires Guidewire-specific expertise, a real vendor-lock and hiring dependency.

([Guidewire architecture](https://guidewiremasters.in/guidewire-architecture/), [ClaimCenter review](https://www.insuraitools.com/blog/guidewire-claimcenter-review), [ClaimCenter configuration](https://locusit.com/learning/business-applications/guidewire-claimcenter-configuration-claims-management/))

Guidewire's own correction of that mistake is instructive: the new **Guidewire Rules Service** in Olos is **DMN-based** — Decision Requirements Diagrams, decision tables, and FEEL expressions in a low-code designer; decision services are **exposed as APIs**, discoverable immediately on creation; **version-controlled** artifacts; **comprehensive execution logging giving full traceability of which rules applied, when, and with what outcome**; invoked synchronously from ClaimCenter/Autopilot workflows to drive straight-through processing. ([Guidewire Rules Service](https://www.guidewire.com/resources/blog/developers/introducing-guidewire-rules-service-in-olos))

**Read the arc:** the most successful claims platform in P&C started with rules-as-proprietary-code and is migrating to **rules-as-versioned-DMN-artifacts-behind-an-API with a decision trace**. Start where they ended.

### 3.2 Duck Creek

Duck Creek's stated technical philosophy is **externalising the rules that make a business unique from the code of the core platform** — that is the organising principle of the whole product line. Duck Creek Claims ships pre-configured content: 1200+ coverage types, 100+ tasks, **1000+ business rules** including straight-through processing, automated coverage verification, reserving and payments — supporting low-touch/no-touch claims. ([Duck Creek Platform](https://www.duckcreek.com/duck-creek-platform-in-detail/), [Claims](https://www.duckcreek.com/product/claims-management-software/))

**Transferable:** *ship content, not just an engine.* A rules engine with an empty rule base is worthless to a hospital. Our differentiator is a pre-built, curated, maintained Indian rule base — per major insurer/TPA, per specialty, per package — that a hospital inherits on day one and then *configures*. The engine is the commodity; the content is the product.

### 3.3 Sapiens Decision

Sapiens is the commercial home of **The Decision Model (TDM)** and markets itself as *decision automation, not a business rules engine* — decision models authored and owned by **business analysts** with no-code tools, managed as a corporate asset, with same-day rule changes. ([Sapiens Decision Management](https://sapiens.com/us/decision-management/), ["Business rules engines are out, decision automation is in"](https://sapiens.com/resources/blog/its-official-business-rules-engines-are-out-decision-automation-is-in/), [Sapiens Decision](https://sapiensdecision.com/))

### 3.4 FINEOS

Cloud-native platform spanning policy, billing and claims, with a rules engine plus **no-code/low-code configuration**, extended via a **microservice extension architecture** so external calculators, rules and systems can be linked in rather than forked into the core. ([FINEOS platform capabilities](https://www.fineos.com/platform/capabilities/))

**Common thread across all four:** every mature platform converges on (a) rules externalised from application code, (b) authored by non-engineers, (c) versioned and governed as artifacts, (d) invoked as services, (e) with execution traces. Divergence is only in how far along that path each vendor is.

---

## 4. Rules and decision technology

### 4.1 The representation spectrum

| Representation | Best for | Cost |
|---|---|---|
| **Imperative code** | One-off, deeply contextual logic | Opaque; unmaintainable by non-engineers; no trace |
| **Decision table** | Many rules sharing the same conditions and one conclusion | Combinatorial blow-up if conditions are poorly chosen |
| **Decision tree** | Sequential, mutually exclusive branching | Duplicated subtrees; hard to diff |
| **Scorecard** | Weighted accumulation of soft evidence | Not a hard decision; needs a threshold policy |
| **Decision graph (DRD / JDM)** | Composing many small decisions into a big one | Requires discipline about node granularity |
| **Forward-chaining (Rete)** | Facts derived from facts; unknown evaluation order; inference | Hard to explain, hard to bound, easy to write non-terminating rule sets |

### 4.2 DMN — the de facto standard, and the one to align with

**DMN** gives a **DRD** (Decision Requirements Diagram — the graph of decisions and their input data), **decision tables** for each decision node, and **FEEL** (Friendly Enough Expression Language) for expressions. ([Camunda DMN tutorial](https://camunda.com/dmn/), [Create a DMN decision table](https://docs.camunda.org/get-started/dmn/model/))

The **hit policy** is the formal answer to rule conflict resolution — it is table metadata, evaluated by the engine, not an ad-hoc convention:

- **U (Unique)** — rules must not overlap; exactly one matches. The default, and the one to prefer.
- **A (Any)** — several may match but must all produce the same output.
- **F (First)** — output of the first matching rule in table order.
- **P (Priority)** / **O (Output order)** — ordered by output-value priority.
- **C (Collect)** — outputs of *all* matching rules, optionally aggregated (sum/min/max/count).
- **R (Rule order)** — all matches, in rule order.

([Camunda DMN hit policies](https://docs.camunda.org/manual/7.4/reference/dmn11/decision-table/hit-policy/), [choosing the hit policy](https://docs.camunda.io/docs/components/best-practices/modeling/choosing-the-dmn-hit-policy/), [Camunda Academy](https://academy.camunda.com/dmn-hit-policies), [Signavio on hit policy + completeness](https://documentation.signavio.com/suite/en-us/Content/process-manager/userguide/dmn-hit-policy.htm))

DMN also formalises **completeness**: a *complete* table considers every possible input combination; an incomplete one is still valid. Declaring completeness is how a modelling tool can *prove* you have a gap.

**Directly transferable.** Our deficiency engine is fundamentally a **COLLECT** table — we want *every* deficiency, not the first. But individual sub-decisions (which package applies? which room-rent tier? is this insurer's stay-duration rule met?) are **UNIQUE** tables. Being explicit about hit policy per table, and validating uniqueness at authoring time, eliminates an entire class of "two rules fired and we showed a contradiction" bugs. And **completeness checking is our single best defence against false confidence** (§7.6): a table that is incomplete for `insurer = <newly onboarded TPA>` should make the engine emit *unknown*, not *clean*.

### 4.3 The Decision Model (von Halle & Goldberg) — the best available theory of rule structure

TDM is a formal framework that organises business rules into **Rule Families**, each of which has **exactly one conclusion fact type**, zero-to-many condition fact types, and one or more rule patterns. Rule Families are then connected into decision models. There are **15 principles** — structural, declarative and integrity — including **three normal forms**, where e.g. Second Normal Form eliminates illogical column use by ensuring all conditions of a rule are ANDed. TDM insists on the distinction between the **procedural** nature of process and the **declarative** nature of logic.

Sources: [A Primer on The Decision Model (Goldberg & Segal, 2021)](https://sapiensdecision.com/wp-content/uploads/2021/12/A-Primer-on-The-Decision-Model-2021-12-15.pdf), [TDAN: The Decision Model](https://tdan.com/the-decision-model-june-2013/16953), [BPMInstitute: classifying decision model structures](https://www.bpminstitute.org/resources/articles/classifying-decision-model-structures/), [the book](https://www.routledge.com/The-Decision-Model-A-Business-Logic-Framework-Linking-Business-and-Technology/vonHalle-Goldberg/p/book/9781420082814).

**This is the discipline that prevents the rule-base from rotting.** "One conclusion fact type per Rule Family" is the rule that stops the classic disaster where a single table mixes *is the package admissible?*, *is the document present?* and *what is the deduction?* into one unmaintainable sheet. Normalisation of the rule base matters exactly as much as normalisation of the database.

### 4.4 Engines worth knowing

- **Drools** — enhanced Rete (**ReteOO**), forward-chaining by default, backward-chaining for goal-directed queries, rules in DRL or spreadsheet decision tables. Forward chaining suits reactive/streaming derivation; backward chaining suits targeted queries; combining both is often most practical. ([Drools rule engine docs](https://docs.drools.org/5.2.0.M2/drools-expert-docs/html/ch01.html), [Baeldung: forward vs backward chaining](https://www.baeldung.com/java-drools-forward-chaining-vs-backward-chaining), [Wikipedia](https://en.wikipedia.org/wiki/Drools))
- **IBM ODM** — a full BRMS: **Decision Server** (runtime) + **Decision Center** (authoring, governance, versioning, testing). Heavily deployed in healthcare/insurance/finance. ([IBM ODM overview](https://www.business-software.com/blog/ibm-operational-decision-manager-odm-who-needs-it-why/), [IBM's own ODM/FICO/JBoss comparison](https://public.dhe.ibm.com/software/websphere/dm/ODM_Competitive_Review_Oct2012.pdf))
- **FICO Blaze Advisor** — rules expressible through point-and-click templates/formula builders or as **decision tables, decision trees, and scorecards**; standard use cases include eligibility verification and insurance claim processing. Known weak spots per user reviews: deployment, versioning, UX. ([Blaze vs ODM vs Corticon](https://www.peerspot.com/products/comparisons/fico-blaze-advisor_vs_ibm-operational-decision-manager_vs_progress-corticon))
- **GoRules Zen / JDM** — the most interesting design for a modern greenfield system. **JDM (JSON Decision Model)** represents a decision as an **interconnected graph in JSON**: Input node → decision tables / switches / expressions / functions / reusable sub-decisions → Output node, wired left-to-right by edges. Expressions use the **ZEN Expression Language**, designed to be readable by analysts and precise for developers. The engine is **Rust**, with native bindings for Node.js, Python, Go, Java, Kotlin, .NET, iOS and Android; decisions evaluate in microseconds and are **stored as portable JSON**, identical on every platform. ([JDM standard](https://docs.gorules.io/developers/jdm/standard), [JSON decision model](https://gorules.io/docs/developers/bre/json-decision-model), [zen on GitHub](https://github.com/gorules/zen), [@gorules/zen-engine](https://www.npmjs.com/package/@gorules/zen-engine), [intro](https://docs.gorules.io/docs/intro))
- **json-rules-engine / DecisionRules / Nected / ACTICO / Decisions.com** — the lightweight and mid-market tier. ([ACTICO rule & decision modeling](https://www.actico.com/platform/rule-decision-modeling/), [DecisionRules comparison of the top 10](https://www.decisionrules.io/en/articles/top-10-business-rule-engines/))

**Recommendation implicit in the landscape:** for a Node/TypeScript backend, **GoRules Zen + JDM is the closest off-the-shelf fit** — decisions as portable, diffable, version-controllable JSON graphs, deterministic, fast, and language-agnostic. If not adopted directly, **copy JDM's shape**: a rule set is a JSON graph artifact, not code; the engine is a pure function of `(decision_artifact_version, input) → (output, trace)`.

**And a warning:** do not reach for forward-chaining/Rete. Inference engines are wonderful when you don't know the evaluation order, and terrible when you need to explain, bound, and regression-test the result. Regulated adjudication wants **ordered, bounded, traceable evaluation**. Every vendor above that started with inference has been migrating toward decision tables and graphs.

### 4.5 Versioning and effective dating

The non-negotiables, drawn from how NCCI, LCDs, DRG groupers and payer policies all behave:

- Rules are **effective-dated** with a validity interval, and a claim is adjudicated against the rule version in force **on its date of service / date of admission**, not on the date the engine runs.
- Prior finalised decisions are **not retroactively re-adjudicated** when the rule base changes (CMS is explicit about this for MUEs).
- Content updates ship on a **predictable cadence** with notice (NCCI: quarterly; DRG: annual; payer code-editing policy: commonly ~30 days' notice from provider notification).
- The rule base is itself a **versioned artifact**; a decision record stores the artifact version it used.

([CMS NCCI FAQ](https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-faq-library), [Superior HealthPlan CC.PP.011](https://www.superiorhealthplan.com/content/dam/centene/policies/payment-policies/CC.PP.011.pdf))

**Concretely for us:** a claim for an admission in March must be evaluated against March's IRDAI/TPA/HBP rules even if we re-run it in September. This means every rule row carries `effective_from` / `effective_to`, every stored verdict carries `ruleset_version`, and re-running a claim is a *new decision record*, never an overwrite of the old one — which also dovetails with the existing `re-run = from scratch` principle in this codebase.

### 4.6 Governance, authoring and safe deployment

The mature lifecycle, consistent across ACTICO, Decisions.com, Sparkling Logic and IBM Decision Center:

1. **Authoring workspace** where analysts model, review, test, version and publish decisions **without redeploying application code**.
2. **Draft → review → approved → published**, with separation of duties, structured diff, Git-style review and rule-aware pipelines.
3. **Simulation** of a candidate rule set against historical data before release.
4. **Champion/Challenger**: the production strategy (champion) competes against variants (challengers) on real traffic; results compared before promotion.
5. **Shadow deployment**: apply multiple strategies to the same transaction, act on only one, capture decision data for both, and confirm the differences are expected.
6. **Regression analysis** on rule change: does the new rule conflict with existing rules, and which claims does it change? (Optum CES does exactly this.)

Sources: [Sparkling Logic on champion/challenger](https://www.sparklinglogic.com/what-are-champion-challenger-experiments-in-decision-management/), [champion/challenger for rollouts](https://www.sparklinglogic.com/champion-challenger-for-rolling-out-deployments/), [ACTICO](https://www.actico.com/platform/rule-decision-modeling/), [Decisions v10 governance](https://decisions.com/blog/introducing-decisions-v10-where-ai-powered-development-meets-enterprise-governance), [Decision Manager authoring & governance](https://decisionmanager.us/platform/decision-manager).

**Shadow mode is the correct default for any new rule in our system.** Ship it silently, log what it *would* have said, compare against what the TPA actually queried, promote only when precision clears a threshold. (This codebase already has a shadow-only adjudication milestone — that instinct is exactly right and matches industry practice.)

### 4.7 Explainability and the decision trace

Best-in-class engines produce full audit trails showing exactly why each decision was made; policy engines such as OPA, DMN and Cedar record the **rule evaluation path**. Compliance logging that merely records *that* a decision was made is insufficient — a proper **decision trace schema** captures the full context: what data was available, what artifact/model version processed it, what intermediate values were computed, what thresholds applied, and what the outcome was.

([Decision Trace Schema for Governance Evidence, arXiv](https://arxiv.org/pdf/2604.09296), [FINOS AI governance: agent decision audit and explainability](https://air-governance-framework.finos.org/mitigations/mi-21_agent-decision-audit-and-explainability.html), [DecisionRules on audit trails](https://www.decisionrules.io/en/articles/top-10-business-rule-engines/), [Guidewire Rules Service traceability](https://www.guidewire.com/resources/blog/developers/introducing-guidewire-rules-service-in-olos))

Regulatory pressure is converging on this: GDPR Art. 22 (right to an explanation of automated decisions), the EU AI Act's transparency provisions and the NIST AI RMF all require human oversight, traceability and explainability for high-risk automated decisioning — and insurance claims adjudication is squarely classified as high-risk. ([Tungsten on HITL governance](https://www.tungstenautomation.com/blog/human-in-the-loop-ai-enterprise-governance-best-practices))

**Minimum viable trace for us**, per finding:

```
{ claim_id, stage, ruleset_version, rule_id, rule_version,
  inputs_used: [{field, value, source_doc_id, source_page, source_bbox}],
  predicate_result, hit_policy, severity, scenario, reason_code,
  human_explanation, remedy_action, citation_url, evaluated_at }
```

The `inputs_used` array with a **document + page + bounding-box provenance** is the piece almost nobody ships and is our strongest possible differentiator: it converts "the system says the discharge summary is incomplete" into "here is the discharge summary, page 2, and here is the empty field." It also makes the finding *falsifiable* by the biller in five seconds, which is what builds trust.

---

## 5. India specifics

### 5.1 IRDAI Master Circular on Health Insurance Business, 29 May 2024

Reference **IRDAI/HLT/CIR/MISC/77/05/2024**, consolidating 55 earlier circulars into one rulebook, applicable to all general and health insurers in India. Primary source: [IRDAI Master Circular PDF](https://irdai.gov.in/documents/37343/365525/%e0%a4%b8%e0%a5%8d%e0%a4%b5%e0%a4%be%e0%a4%b8%e0%a5%8d%e0%a4%a5%e0%a5%8d%e0%a4%af+%e0%a4%ac%e0%a5%80%e0%a4%ae%e0%a4%be+%e0%a4%b5%e0%a5%8d%e0%a4%af%e0%a4%b5%e0%a4%b8%e0%a4%be%e0%a4%af+%e0%a4%aa%e0%a4%b0+%e0%a4%ae%e0%a4%be%e0%a4%b8%e0%a5%8d%e0%a4%9f%e0%a4%b0+%e0%a4%aa%e0%a4%b0%e0%a4%bf%e0%a4%aa%e0%a4%a4%e0%a5%8d%e0%a4%b0+_+Master+Circular++on+Health++Insurance+Business++29052024.pdf/5e707a91-b5de-1ec1-cf18-b66273a6839d) · [IRDAI health department index](https://irdai.gov.in/health-dept).

The provisions that define our operating envelope (paraphrased from the circular text, clause numbers as in the PDF):

- **¶15 Approval for Cashless facility.** Every insurer shall strive for **100% cashless settlement**, with reimbursement reduced to a bare minimum and only exceptional. The insurer shall decide a cashless authorization request **immediately, and not more than one hour** from receipt; systems and procedures to be in place **not later than 31 July 2024**. Insurers may run **physical help desks at hospitals**, and must provide pre-authorization digitally.
- **¶16 Final authorization for discharge.** Insurer shall grant final authorization **within three hours** of receiving the discharge authorization request from the hospital; **in no case shall the policyholder be made to wait**. Delay beyond three hours → any additional amount charged by the hospital is **borne by the insurer out of the shareholders' fund**. On death during treatment, the insurer must process the claim immediately and get the mortal remains released immediately.
- **¶17 Settlement of Claims.** **No claim shall be repudiated without approval of the PMC or a three-member sub-group of it called the Claims Review Committee (CRC).** Repudiation or partial disallowance must be conveyed to the claimant **with full details referencing the specific policy terms and conditions**. And critically: **"Insurers and TPAs shall collect the required documents from the Hospitals. Policyholder shall not be required to submit the documents."**
- **Moratorium**: after 60 months of continuous coverage, no policy shall be contestable for non-disclosure/misrepresentation except established fraud.
- Insurers must **publish their claim procedures and TATs**, and constitute the CRC to take the final independent decision on every repudiation.
- Ombudsman awards must be honoured within 30 days, with a **₹5,000/day penalty** otherwise.

Commentary and corroboration: [Patient Square on the 1-hour/3-hour rules](https://patientsquare.com/in/blog/irdai-cashless-rules-doctors/), [Oquilia on the master circular](https://www.oquilia.com/news/irdai-health-master-circular-2024-cashless-moratorium-rules), [TeamLease RegTech](https://www.teamleaseregtech.com/updates/article/32220/irdai-issued-master-circular-on-irdai-insurance-products-regulations-2/), [LexComply highlights](https://lexcomply.com/blog/key-highlights-master-circular-on-irdai-insurance-products-regulations-2024-health-insurance/).

**Four product consequences, and they are large:**

1. **The 1-hour and 3-hour clocks convert claim quality into wall-clock money.** A deficient pre-auth doesn't just risk denial — it restarts the clock through a query cycle and blows the TAT. Our engine's latency budget is therefore **seconds, not minutes**: it must run and return before the packet is transmitted. This is a hard architectural constraint and rules out anything that needs a slow multi-model pipeline in the critical path. (It is also the argument for the deterministic core: a rule evaluation is microseconds; an LLM call is not.)
2. **"TPAs shall collect the required documents from the Hospitals"** makes the *hospital* the system of record for claim evidence. The completeness obligation lands on us. This clause is the regulatory justification for our entire product.
3. **Repudiation requires CRC approval plus a specific policy-clause citation.** That means every legitimate denial is, by regulation, *attributable to a named clause*. If the insurer must cite a clause to deny, we can pre-compute against that same clause set — and every observed denial gives us a labelled clause→deficiency mapping. **Harvesting denial letters into rule content is a first-class data pipeline, not an afterthought.**
4. **100% cashless + Cashless Everywhere** means volume of pre-auths at non-empanelled hospitals, where nobody has tribal knowledge of that insurer's quirks — the worst case for manual practice and the best case for a rule engine.

### 5.2 Cashless Everywhere (23 Jan 2024) and TPA workflow reality

The General Insurance Council's **Cashless Everywhere** initiative extends cashless beyond the insurer's network to any registered hospital, subject to conditions commonly cited as: hospital has **≥15 beds**, is registered under the **Clinical Establishments Act**, and the insurer is notified **48 hours before planned** hospitalisation (24–48 hours **after** admission for emergencies).

([NYVO Cashless Everywhere guide](https://nyvo.in/health-insurance/cashless-everywhere-guide), [SMC Insurance](https://www.smcinsurance.com/health-insurance/articles/can-hospitals-refuse-cashless-insurance-india), [InvestKraft](https://www.investkraft.com/blog/irdai-new-cashless-claim-settlement-rules))

The standard TPA pre-auth check is four-dimensional: **active policy status, benefit eligibility, available sum insured, waiting periods/exclusions** — then clinical justification. ([InterPixels on APAC TPA cashless vs reimbursement](https://interpixels.ai/insights/insights-cashless-vs-reimbursement-health-insurance-claims-apac/))

**Observed failure taxonomy in Indian cashless** (this *is* our initial rule backlog):

- Missing or insufficient **clinical documentation** — cited as ~30% of denials.
- **Room-category mismatch** → proportionate deduction — cited as affecting ~25–30% of claims.
- **Waiting period / exclusion / PED** violations.
- **Non-payable items** — registration charges, consumables, food, non-medical items — typically ₹10,000–₹50,000 on a surgery.
- **Co-pay** and sub-limit clauses.
- **Late intimation** — missing the 24–48h retrospective pre-auth window on emergencies.
- Hospital **not empanelled** / scope mismatch.

([AccredReady on TPA denials](https://accredready.in/learn/tpa-insurance-claim-denials), [PolicyBazaar: 11 reasons cashless claims get denied](https://www.policybazaar.com/health-insurance/general-info/articles/situations-when-your-cashless-health-insurance-claim-can-get-denied/), [NYVO cashless claim checklist](https://nyvo.in/resources/claims/cashless-claim-checklist), [PolicyX](https://www.policyx.com/health-insurance/articles/health-insurance-claim-rejection/), [Insurance Samadhan](https://www.insurancesamadhan.com/blog/cashless-denied-reimbursement-delayed-irdai-timelines-your-rights-and-next-steps/))

Note the shape: **room-rent proportionate deduction is a computation, not a document check.** Our engine must do arithmetic on the policy's room-rent cap vs the ward actually occupied, and forecast the deduction *before* discharge — while the patient can still be moved. That is a materially higher-value intervention than flagging a missing PDF, and it is a *pre-discharge* rule, not a pre-submission one (§7.1).

### 5.3 NHCX / ABDM — the emerging rails

**NHCX** (National Health Claims Exchange), built by the **NHA**, went live June 2024 as one of ABDM's three gateways alongside the Health Information Exchange & Consent Manager and UHI. It standardises the claims workflow — eligibility, pre-authorization, claim submission, adjudication, payment, reconciliation — on **HL7 FHIR R4**.

FHIR profiles (primary source: [NRCeS NHCX Profiles, ABDM FHIR IG](https://www.nrces.in/ndhm/fhir/r4/hcx-profile.html), [v7.0.0 preview](https://www.nrces.in/preview/ndhm/fhir/r4/hcx-profile.html)):

- `CoverageEligibilityRequest` / `CoverageEligibilityResponse` — patient + coverage verification
- `Claim` — financial **and supporting clinical** information; used for claim, predetermination and pre-authorization
- `ClaimResponse` — **application-level adjudication outcomes, or an application-level error**
- `Communication` / `CommunicationRequest` — **the document-request / query cycle**, i.e. the TPA asking for more documents
- Collection bundles: `ClaimBundle`, `ClaimResponseBundle`, `CoverageEligibilityRequestBundle/ResponseBundle`, `TaskBundle` (payment notification, reprocessing)

The **HCX protocol** layer adds an error taxonomy returned in headers: `x-hcx-status` set to `response.error` with a code in `x-hcx-errordetails`; categories include recipient-side domain/business errors (`ERR_DOMAIN_PROCESSING`), wrong domain payload for the API called, JWE token validity/decryption errors, malformed `x-hcx-debug_details`, and gateway/infrastructure errors. ([HCX error handling](https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/key-components-building-blocks/error-descriptions), [handling processing errors](https://docs.hcxprotocol.io/hcx-domain-specifications/domain-data-models/handling-processing-errors), [hcx-specs domain data models](https://github.com/hcx-project/hcx-specs/blob/v0.8/hcx-domain-specifications/domain-data-models/README.md))

Context: [NHCX (Wikipedia)](https://en.wikipedia.org/wiki/National_Health_Claims_Exchange), [Nathealth NHCX brief](https://nathealthindia.org/wp-content/uploads/2025/06/National-Health-Claims-Exchange_Latest.pdf), [Caladrius on the ABDM stack](https://caladriushealth.ai/blog/2026/05/15/The-ABDM-Stack/).

**Three design implications:**

1. **Model our internal claim representation on FHIR `Claim` from the start**, even before we transact over NHCX. It is the destination format; anything else becomes a migration. The `Claim` resource's own structure (item/detail/subDetail hierarchy, supportingInfo, careTeam, diagnosis with sequence + type) is a better-designed claim model than anything we would invent.
2. **`Communication` / `CommunicationRequest` is the standardised query loop.** Every TPA query we ever receive can be normalised into that resource — which means historical queries become a *structured* training corpus for rule mining, not a pile of emails.
3. **NHCX raises the floor, not the ceiling.** Structured submission kills format-level (SNIP 1–4 equivalent) deficiencies industry-wide. The deficiencies that remain — and that become *the whole game* — are **clinical-evidence and policy-interpretation** deficiencies at SNIP 5–7 equivalents. Build there.

### 5.4 PM-JAY — the most detailed publicly documented adjudication workflow in India

Primary source: **NHA Claims Adjudication Manual 2.0** ([Kerala SHA mirror](https://sha.kerala.gov.in/wp-content/uploads/2022/08/Claims-Adjudication-Manual-2_0-final.pdf); see also [NHA Operations Manual](https://nha.gov.in/img/resources/Operation%20Manual%20for%20AB%20PM-JAY.pdf) and [pmjay.gov.in documents](https://pmjay.gov.in/resources/documents)). HBP 2022 revised packages to **1,949 procedures across 27 specialities** ([Haryana SHA HBP 2022](https://ayushmanbharat.haryana.gov.in/document/hbp-2022/)).

This document is worth reading in full; it is effectively a free specification for a stage-aware adjudication engine. Key structures:

**Roles and stages (TMS):** `PM-AM / MEDCO` (hospital side) → `PPD` Pre-authorization Processing Doctor → `CEX` Claims Executive (non-technical review) → `CPD` Claims Processing Doctor (clinical review) → `ACO` Accounts Officer → `SHA` (review/revoke authority) → Medical Committee (second opinion) → SAFU/NAFU (anti-fraud) and audit.

**Separation of non-technical and technical review** — CEX validates identity fields, mandatory document presence and the discharge summary; only then does it reach the CPD for clinical merit. This is the §1 layering principle, implemented organisationally.

**Package-level mandatory document lists driven by STGs.** The manual's worked example: *Total Hip Replacement (Cemented)* requires (1) pre- and post-procedure imaging study, (2) pre- and post-procedure clinical photograph, (3) detailed operative notes. **This is rule dimensionality made concrete: `required_documents = f(package)`.** With a notable nuance the manual states explicitly: **non-submission of a mandatory document should not by itself be grounds for rejection unless it is necessary for the CPD's decision** — i.e. *required* and *decision-blocking* are two different severities.

**Closed-vocabulary standard query reasons** (dropdown, multi-select, plus "Others" + free text), grouped by category:
- *Investigation reports* — imaging films/ECG/ABG/CAG with patient name and date; biopsy/HPE/FNAC/PET confirming malignancy
- *Hospitalization records* — vitals charts, treatment plan, progress notes; updated case summary / complete ICP records justifying **enhancement**; clinical photograph of injury/lesion; haemodialysis chart with justification for frequency
- *Clear and legible documents* — re-upload legible copies; clear photo of beneficiary
- *Additional information* — justification for the **selected package**; justification for amount under **Unspecified Surgical Package**; prescription advising hospitalization with diagnosis; government-hospital referral letter; self-declaration with incident narration + MLC/FIR copy

At the **claims** stage the vocabulary shifts: complete discharge/day-care summary (with name, gender, age, complaints, treatment, diagnosis, DOA & DOD); death/LAMA/DAMA summary; surgery/OT/anaesthetic notes; implant/stent/prosthesis/IOL **sticker**; **post-operative scar photo with the patient's face in the same frame**; **photo of patient in ICU with ventilator** for ICU-ventilator cases.

**Closed-vocabulary standard rejection reasons.** Pre-auth: delayed pre-auth intimation; false/fraudulent claim; outside scope of cover; *Package Selection: Government-reserved package*; *Package Selection: Hospital not empanelled for this specialty*; **`Package Selection: Mismatch of package and disease/diagnosis/treatment/gender/age`**. Claims adds: cash bill generated/paid by patient; documentation — delayed or no query reply / delayed or non-submission of claim / incomplete submission after multiple queries / unclear or overwritten documents; **OPD converted into IPD (justification for admission not found)**.

> That single bolded reason — *mismatch of package and disease/diagnosis/treatment/gender/age* — is the canonical statement of our rule dimensionality problem, written by the payer.

**Explicit CPD review checklist** (paraphrased): signs/symptoms/duration align with final diagnosis and treatment; investigation findings support the diagnosis; post-surgery reports confirm the booked surgery was performed; ward category matches the medical documents; system-computed **LOS** validated against the discharge summary and the approved amount; the requested package is in sync with the claim's diagnosis; treating doctor's signature carries registration number and qualification; in death cases, death summary + prognosis notes + consents + information to relatives. Also: **the clinical photograph must not be a stock/Google image.**

**Query discipline:** raise all queries **in one go**; never more than **3 rounds**; if a query response is rejected, the adjudicator **must** record in free text why the response was not accepted.

**Uniform TAT with automatic state transitions** (private EHCP; public EHCP has longer variants):

| Activity | TAT | Automatic action |
|---|---|---|
| Pre-auth initiation after registration | 48 h | Reminder at 24 h; **auto-reject at 48 h** |
| Pre-auth decision by PPD | 6 working hours (TMS threshold) | **Auto-approve after 6 h** |
| Hospital response to PPD query | 24 h | Reminders at 24/48 h; **auto-reject at 72 h** (SHA may revoke) |
| Claim submission after discharge | ≤7 days; 7–21 d needs SHA approval; 21–45 d needs CEO-SHA approval; **>45 d inadmissible** | Auto-reminders on day 1, 3, 5; routing to SHA/CEO buckets |
| Hospital response to CPD query | ≤7 days | Reminders day 1, 3; **auto-reject at day 7** |
| Claim payment | 15 days intra-state, 30 days inter-state (portability) | — |

TAT is computed **excluding the days the claim is pending at the hospital's end** — the manual gives worked arithmetic examples. Claim adjudication **audit** is a separate chapter with a sampled percentage of claims audited, plus a comprehensive audit module, KPIs (performance, audit-related, productivity) and contractual **penalties**.

**What transfers, in order of value:**

1. **Closed vocabularies with a governed escape hatch.** Both queries and rejections are dropdowns. This is the CORE 360 idea, arrived at independently. Our finding taxonomy must be closed and versioned.
2. **`required_documents = f(package/procedure)`**, sourced from a published clinical guideline, with **severity distinguishing "required" from "decision-blocking."**
3. **Auto-transitions on TAT expiry** — auto-approve, auto-reject, auto-escalate, with a **revoke** path. Deadlines are part of the rule model, not the UI.
4. **A rejection reason that names the *dimension* of the mismatch** (disease / diagnosis / treatment / gender / age), which is what makes the finding actionable.
5. **Structural anti-gaming checks** — is the clinical photograph real, is the scar photo in the same frame as the face, does the ICU photo show a ventilator. These are content checks on *evidence authenticity*, a category most rule engines don't have and which maps directly onto this codebase's existing suspicious-document flags.
6. **Audit-of-the-adjudicator as a standing function**, with sampling, KPIs and penalties. Our analog: sample our own verdicts against realised TPA outcomes, continuously.

---

## 6. ML / AI-assisted adjudication: where AI actually sits

The consistent industry position — from Optum, Cotiviti, Zelis and the regulatory frameworks alike — is that **the decision core stays deterministic and AI sits on either side of it**.

**Why the core stays deterministic:**
- Regulated adjudication must be **reproducible**: the same claim must yield the same answer today and at an audit two years from now.
- **Attributability**: IRDAI requires a repudiation to cite specific policy terms and be approved by a named committee. CMS/NCCI edits are published with rationale. GDPR Art. 22 and the EU AI Act's transparency provisions (penalties up to €35M for non-compliant high-risk systems) push the same way; insurance claims adjudication is explicitly classed as high-risk with mandatory human review for consequential decisions. ([Tungsten](https://www.tungstenautomation.com/blog/human-in-the-loop-ai-enterprise-governance-best-practices), [Seekr XAI enterprise guide](https://www.seekr.com/resource/explainable-ai-enterprise-guide/))
- **Contestability**: a deterministic rule can be shown to be wrong and fixed once. A model that is wrong is wrong stochastically.

**Where AI legitimately earns its place:**

| Use | Example | Why it's safe |
|---|---|---|
| **Extraction / structuring** | OCR + vision turning a bill or discharge summary into structured facts | Output is *facts with provenance*, fed into deterministic rules |
| **Classification / routing** | Which document type is this, which specialty, which bucket | Reversible, low-stakes, human-visible |
| **Prioritisation** | Iodine `Concurrent` ranking charts where evidence and documentation likely disagree | Ranks work; does not decide |
| **Evidence assembly** | Pre-assembling the coverage question, the discrepancy, the cited provision for the human | "Clean claims within authority clear automatically; everything else reaches an adjuster with evidence pre-assembled" ([MightyBot](https://mightybot.ai/blog/ai-agents-insurance-claims-evidence-linked/)) |
| **Rule *authoring* assistance** | Cotiviti's AI-assisted policy development; Waystar AltitudeAssist | A human approves the rule; the rule then runs deterministically |
| **Anomaly / FWA detection** | Behavioural analytics feeding Optum CES edit development | Generates *candidates* for human-authored rules |
| **Prediction as a prior** | Waystar denial prediction | Advisory score, not a gate |

The pattern named repeatedly is **evidence-linked, deterministic policy evaluation with an audit trail showing which provision fired on which value from which source** — AI supplies the values and the provenance; the rule supplies the verdict. ([MightyBot](https://mightybot.ai/blog/ai-agents-insurance-claims-evidence-linked/), [Zelis: AI accelerates ingestion/routing/error detection while experts validate for compliance and defensibility](https://www.zelis.com/news/zelis-intelligent-pricing-platform-launch/))

An interesting governance variant from the medical literature: **human-in-the-loop only on appeal** — let the automated system decide at scale and reserve human judgment for contested cases, on the analogy of legal appeal. ([npj Digital Medicine](https://www.nature.com/articles/s41746-023-00906-8)) Worth knowing, but for a *provider-side advisory* system the safer default is the opposite: we advise, the human always acts.

**Benchmarks for context:** payer auto-adjudication best practice is cited at **>80–85%**, leading platforms 80–90% STP on clean claims vs 30–40% on legacy systems, with AI pushing toward 90%; an auto-adjudicated claim costs cents while a manually touched one costs ~$12+. ([HealthEdge](https://healthedge.com/resources/blog/how-improving-auto-adjudication-rates-can-enhance-health-plan-performance), [OpsDog benchmark](https://opsdog.com/products/claims-auto-adjudication-rate), [Mirra](https://mirrahealthcare.com/insights/maximizing-efficiency-and-savings-the-strategic-guide-to-claims-adjudication-software-for-health-plans))

**The hard rule for us:** *an LLM may never be the last thing between a fact and a verdict.* It may produce the fact (with provenance), and it may explain the verdict in prose. The verdict itself must come from a versioned, effective-dated, traceable rule.

---

## 7. Synthesis: what transfers to a hospital-side PRE-submission engine

### 7.1 Rule dimensionality — the model to build

The brief asked specifically about `stage × insurer × disease/procedure × claim type`. Based on everything above, the minimal honest dimensionality is **seven axes**, and rules should be *sparse* over them:

| Axis | Values (illustrative) | Evidence it's needed |
|---|---|---|
| **Stage** | pre-auth · enhancement · pre-discharge · discharge-request · final claim · post-query response · appeal | IRDAI ¶15/¶16 separate 1h and 3h gates; PM-JAY separates PPD/CEX/CPD/ACO; Iodine separates Concurrent/PreBill |
| **Payer** | insurer · TPA · scheme (PMJAY/state/CGHS/ECHS/corporate) · specific policy/product | WEDI SNIP Level 7 exists solely for this; PM-JAY allows state-specific HBP customisation |
| **Claim type** | cashless network · cashless everywhere · reimbursement · planned · emergency · maternity · day-care · daycare-package · death/LAMA/DAMA | Different intimation windows and document sets per type; PM-JAY has separate death/LAMA summaries |
| **Clinical** | specialty · package/procedure · diagnosis (ICD) · implant use · ICU/ventilator | PM-JAY: *mismatch of package and disease/diagnosis/treatment/gender/age*; STG per package |
| **Patient** | age · sex · PED status · policy vintage/waiting period · moratorium status | Same PM-JAY reason; IRDAI moratorium |
| **Financial** | room category vs cap · sum insured remaining · co-pay · sub-limits · non-payables · package rate | Proportionate deduction is ~25–30% of Indian claim leakage |
| **Temporal** | date of admission (for effective-dating) · LOS · intimation window · TAT clocks | NCCI/DRG effective-dating; PM-JAY auto-transitions |

**Do not build a seven-dimensional table.** Build **many small Rule Families (TDM §4.3), each with one conclusion**, composed in a decision graph (JDM/DMN DRD §4.2, §4.4), where each family declares only the axes it actually uses. Typical families:

- `required_documents(stage, package, claim_type) → document_set`
- `document_adequate(document_type, extracted_fields) → adequacy + reasons`
- `package_admissible(package, diagnosis, procedure, age, sex, specialty, empanelment) → verdict`
- `coverage_admissible(payer, policy, diagnosis, date_of_admission, PED, waiting_periods) → verdict`
- `financial_exposure(room_category, policy_cap, bill_lines, non_payable_master) → forecast_deduction`
- `timeliness(stage, event_timestamps, payer_TAT_policy) → verdict + deadline`

Then a top-level **COLLECT** node aggregating all findings. Each family gets its own hit policy, its own completeness declaration, and its own owner.

### 7.2 The layered gate model

Adopt a SNIP-like ladder with an explicit stop rule:

- **L0 Artifact integrity** — file readable, right page count, legible, not a duplicate, not a stock image
- **L1 Extraction confidence** — did we actually read the fields (this is where the tiling/resolution finding from `EXTRACTION_LANDSCAPE_FIX.md` lives: an amount row-shifted onto the wrong line item is an L1 failure masquerading as an L3 one)
- **L2 Internal consistency** — DOA ≤ DOD, LOS matches, totals balance (the SNIP Level 3 idea), IDs match across documents
- **L3 Completeness** — required document set present for `(stage, package, claim_type)`
- **L4 Clinical coherence** — symptoms ↔ diagnosis ↔ procedure ↔ package ↔ investigations ↔ operative notes
- **L5 Policy admissibility** — coverage, exclusions, waiting period, sum insured, empanelment
- **L6 Financial forecast** — room-rent proportionate deduction, non-payables, sub-limits, co-pay
- **L7 Payer-specific** — this TPA's known idiosyncrasies

Do not report L4+ findings on a claim that fails L0/L1: a garbled extraction produces confident nonsense at the clinical layer. That single stop rule prevents most of the "the tool cried wolf" failure mode.

### 7.3 The finding model (the single most important schema)

```
Finding {
  finding_id
  scenario          // CORE-360-style closed set: DOCUMENTATION | DATA | NOT_COVERED | NOT_SEPARATELY_PAYABLE | TIMELINESS | AUTHENTICITY
  reason_code       // closed, versioned vocabulary — our CARC analog
  remark_codes[]    // closed, versioned — our RARC analog
  severity          // BLOCKING | REQUIRED | ADVISORY   (PM-JAY's "required but not decision-blocking")
  confidence        // calibrated; drives whether we assert or hedge
  layer             // L0..L7
  dimensions        // {stage, payer, claim_type, package, ...} that selected this rule
  rule_ref          // {rule_id, rule_version, ruleset_version, effective_from}
  evidence[]        // {field, value, doc_id, page, bbox, extractor_confidence}
  explanation       // human sentence
  remedy            // concrete action: "attach post-op scar photo with face in frame"
  citation          // URL/clause reference: IRDAI ¶, policy clause, STG, HBP package id
  bypass            // optional machine-checkable justification that clears it (NCCI modifier-indicator pattern)
}
```

Every element above is justified by something in §1–§6. The `bypass` field (NCCI's modifier indicator) and the `evidence[]` provenance array are the two most commonly omitted and most valuable.

### 7.4 Rule authoring and maintenance UX

What the mature vendors converged on, translated to our context:

- **Non-engineers author.** Sapiens, FINEOS, Duck Creek, Guidewire Olos and Waystar Rule Manager all made this the headline capability. A clinical-documentation specialist or a senior TPA-desk coordinator must be able to add "Insurer X now wants the anaesthetist's notes for all GA cases" without a deploy.
- **Layered overrides, never forks.** Base content (national/regulatory/STG) → scheme layer → insurer layer → hospital layer. Enable/disable and parameterise; never edit base content in place (Optum CES model).
- **Everything is an artifact.** JDM-style portable JSON, in Git, with structured diff and review (§4.4, §4.6).
- **Draft → simulate → shadow → champion/challenger → publish**, with regression analysis flagging conflicts with existing rules before publish (§4.6).
- **Each rule carries provenance**: who authored it, from which source document/denial letter, effective when, reviewed by whom, when it is due for re-review. Cotiviti's "defensible, 100+ sources" positioning is exactly this discipline productised.
- **A rule without a citation cannot be published.** This is the strongest single governance constraint available and it costs nothing to enforce.
- **Deprecation is a workflow.** Rules that never fire, or that fire and are always overridden by users, must surface for retirement. Rule bases die from accumulation, not from bad individual rules.

### 7.5 Explainability as the product surface, not a log

Cotiviti productised explanation as **Payment Clarity** for the *counterparty*. Our counterparty is the biller and, transitively, the TPA. Concretely:

- Every finding shows **the document, the page, and the highlighted region** it came from (§4.7).
- Every finding shows **the rule text and its citation** — IRDAI clause, policy wording, STG, HBP package definition.
- Every finding shows **the remedy**, phrased as an action a human can take in the next five minutes.
- The claim carries a **decision record** — ruleset version, inputs, every rule evaluated (including those that passed), timestamp — reproducible on demand months later.
- **Show the passes, not just the failures.** A checklist that shows 41 checks passed and 2 failed is credible; a list of 2 red items is not. This also directly answers the false-confidence problem: the user can see what was *not* checked.

### 7.6 How mature systems avoid false confidence — the part to take most seriously

This is the hardest requirement in the brief and the one where most in-house engines fail. The techniques that actually work, each traced to a source above:

1. **Three-valued logic, always.** Every rule returns `PASS / FAIL / UNKNOWN` — never silently `PASS` on missing input. A claim with unknowns is **not** clean; it is *unassessed*. DMN's completeness concept is the formal version of this: an incomplete table must be declared incomplete.
2. **Coverage is a reported metric.** Alongside "2 deficiencies found," report "we evaluated 41 of the 47 checks applicable to this package for this insurer; 6 could not be evaluated because X was unreadable." Never let the absence of findings read as an assertion of cleanliness.
3. **Distinguish "no rule fired" from "no rule exists."** For a newly onboarded TPA with no rule content, the honest output is "we have no specific rules for this payer; only generic checks ran." Vendors do this via per-payer content coverage; we must expose it in the UI.
4. **Calibrate against realised outcomes, per segment.** Track our predicted-clean rate against actual FPY, sliced by insurer × specialty × package × stage. Publish the calibration. A cell where we say "clean" and the TPA queries 30% of the time is a cell where we must stop asserting cleanliness.
5. **Shadow-first for every new rule** (§4.6). No rule reaches a user until it has run silently against real traffic and its precision is measured.
6. **Regression on every rule change** — which past claims would this have changed, and were those changes right? (Optum CES does exactly this.)
7. **Manage the false-positive/abrasion budget explicitly.** Payers learned this the hard way: misfired edits produce a flood of false positives, provider friction and appeals; exclusions applied carefully reduce false positives so edits fire only when clinically and contractually appropriate; hard-vs-soft edit designation is the lever. ([Cotiviti on editing accurately with less abrasion](https://resources.cotiviti.com/payment-integrity/execute-healthcare-claims-editing-more-accurately-with-less-provider-abrasion), [Claritev](https://www.claritev.com/insights/rethinking-payment-integrity/), [Shift Technology](https://www.shift-technology.com/resources/reports-and-insights/three-modernizations-your-claims-editing-system-cant-pass-up)) For us: an ADVISORY severity tier for anything below a precision threshold, and a per-user cap on advisory noise.
8. **Close the loop from actual denials.** Every TPA query and deduction must be captured, normalised into the finding taxonomy, and diffed against what we predicted. Missed deficiencies become rule candidates; over-called ones become precision penalties. Waystar's crowdsourced rules and Cotiviti's cross-payer analysis are this loop at scale.
9. **Never let an LLM assert a clean verdict.** It may extract, it may explain, it may suggest a rule. The clean/not-clean assertion comes from the deterministic layer only (§6).

### 7.7 Anti-patterns, named

- **One giant rule table across all dimensions.** Violates TDM normalisation; unmaintainable within months.
- **Rules in application code.** Every mature platform has migrated away; Guidewire's Gosu→DMN arc is the cautionary tale.
- **Forward-chaining inference for a regulated verdict.** Unbounded, untraceable, un-regression-testable.
- **Free-text findings.** Kills aggregation, cross-hospital learning, per-payer analytics and API stability. The reason CORE 360 and PM-JAY's dropdowns exist.
- **Silent pass on missing data.** The direct cause of false confidence.
- **Auto-repairing clinical content.** Structural repairs only — everything else is fabrication.
- **Optimising CCR instead of FPY.** The industry's own named mistake.
- **Re-adjudicating old claims against today's rules.** Breaks effective-dating and destroys the audit trail.
- **Shipping an engine with an empty rule base.** Duck Creek ships 1000+ rules; the content is the product.
- **Changing a rule without recording why, by whom, from what source, effective when.** Unrecoverable within a year.

---

## 8. Source index

**US content & standards** — [CMS NCCI](https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits) · [NCCI Policy Manual Ch.1 2026](https://www.cms.gov/files/document/01-chapter1-ncci-medicare-policy-manual-2026-final.pdf) · [Medicaid NCCI edit files](https://www.cms.gov/medicare/coding-billing/ncci-medicaid/medicaid-ncci-edit-files) · [X12 RARC](https://x12.org/codes/remittance-advice-remark-codes) · [CAQH CORE 360 rule](https://www.caqh.org/hubfs/CARCsRARCs_835_Rule.pdf) · [WEDI SNIP levels](https://www.rdpcrystal.com/sniplevels/) · [UHC EDI claim edits](https://www.uhcprovider.com/content/dam/provider/docs/public/resources/edi/EDI-HIPAA-Claim-Edits.pdf) · [CMS-0057-F](https://www.cms.gov/initiatives/burden-reduction/overview/interoperability/policies-regulations/cms-interoperability-prior-authorization-final-rule-cms-0057-f)

**Payer / clearinghouse vendors** — [Optum CES](https://business.optum.com/en/operations-technology/payment-integrity/claim-editing.html) · [CES Second Pass](https://www.optum.com/content/dam/optum3/optum/en/resources/sell-sheet/optum-claims-edit-system-second-pass.pdf) · [CES mechanics](https://www.onhealthcare.tech/p/unpacking-the-mechanics-of-claim) · [Cotiviti PPM](https://www.cotiviti.com/solutions/payment-accuracy/payment-policy-management) · [Cotiviti PI guide](https://info.cotiviti.com/hubfs/assets/white_paper/Cotiviti-Guide-PaymentIntegrity.pdf) · [Zelis ZIPP](https://www.zelis.com/news/zelis-intelligent-pricing-platform-launch/) · [Waystar Claim Manager](https://www.waystar.com/our-platform/claim-management/claim-manager/) · [Availity Essentials Pro](https://www.availity.com/essentials-pro/) · [Stedi on edits & repairs](https://www.stedi.com/blog/what-are-claim-edits-and-repairs)

**Provider-side pre-bill** — [Solventum 360 Encompass Audit Expert](https://www.solventum.com/en-us/home/health-information-technology/solutions/360-encompass-audit-expert/) · [Outpatient Prebill Review](https://www.solventum.com/en-us/home/health-information-technology/solutions/360-encompass-audit-expert-outpatient-prebill-review/) · [AGS code auditing](https://www.agshealth.com/ai-platform/code-auditing/) · [Inovalon CCR vs FPY](https://www.inovalon.com/blog/first-pass-yield-vs-clean-claim-rate/) · [OS Healthcare on FPY](https://www.os-healthcare.com/news-and-blog/changing-the-conversation-on-denials-make-your-focus-first-pass-yield-and-not-clean-claim-rate)

**Core platforms** — [Guidewire Rules Service (DMN)](https://www.guidewire.com/resources/blog/developers/introducing-guidewire-rules-service-in-olos) · [Guidewire architecture](https://guidewiremasters.in/guidewire-architecture/) · [Duck Creek Platform](https://www.duckcreek.com/duck-creek-platform-in-detail/) · [Duck Creek Claims](https://www.duckcreek.com/product/claims-management-software/) · [Sapiens Decision](https://sapiens.com/us/decision-management/) · [FINEOS capabilities](https://www.fineos.com/platform/capabilities/)

**Rules technology** — [Camunda DMN](https://camunda.com/dmn/) · [DMN hit policies](https://docs.camunda.org/manual/7.4/reference/dmn11/decision-table/hit-policy/) · [choosing a hit policy](https://docs.camunda.io/docs/components/best-practices/modeling/choosing-the-dmn-hit-policy/) · [TDM primer](https://sapiensdecision.com/wp-content/uploads/2021/12/A-Primer-on-The-Decision-Model-2021-12-15.pdf) · [Drools docs](https://docs.drools.org/5.2.0.M2/drools-expert-docs/html/ch01.html) · [GoRules JDM standard](https://docs.gorules.io/developers/jdm/standard) · [zen engine](https://github.com/gorules/zen) · [Blaze vs ODM vs Corticon](https://www.peerspot.com/products/comparisons/fico-blaze-advisor_vs_ibm-operational-decision-manager_vs_progress-corticon) · [Sparkling Logic champion/challenger](https://www.sparklinglogic.com/what-are-champion-challenger-experiments-in-decision-management/) · [decision trace schema](https://arxiv.org/pdf/2604.09296)

**India** — [IRDAI Master Circular 29 May 2024 (PDF)](https://irdai.gov.in/documents/37343/365525/%e0%a4%b8%e0%a5%8d%e0%a4%b5%e0%a4%be%e0%a4%b8%e0%a5%8d%e0%a4%a5%e0%a5%8d%e0%a4%af+%e0%a4%ac%e0%a5%80%e0%a4%ae%e0%a4%be+%e0%a4%b5%e0%a5%8d%e0%a4%af%e0%a4%b5%e0%a4%b8%e0%a4%be%e0%a4%af+%e0%a4%aa%e0%a4%b0+%e0%a4%ae%e0%a4%be%e0%a4%b8%e0%a5%8d%e0%a4%9f%e0%a4%b0+%e0%a4%aa%e0%a4%b0%e0%a4%bf%e0%a4%aa%e0%a4%a4%e0%a5%8d%e0%a4%b0+_+Master+Circular++on+Health++Insurance+Business++29052024.pdf/5e707a91-b5de-1ec1-cf18-b66273a6839d) · [IRDAI health dept](https://irdai.gov.in/health-dept) · [PM-JAY Claims Adjudication Manual 2.0](https://sha.kerala.gov.in/wp-content/uploads/2022/08/Claims-Adjudication-Manual-2_0-final.pdf) · [PM-JAY Operations Manual](https://nha.gov.in/img/resources/Operation%20Manual%20for%20AB%20PM-JAY.pdf) · [HBP 2022](https://ayushmanbharat.haryana.gov.in/document/hbp-2022/) · [NHCX FHIR profiles (NRCeS)](https://www.nrces.in/ndhm/fhir/r4/hcx-profile.html) · [HCX error handling](https://docs.hcxprotocol.io/hcx-technical-specifications/open-protocol/key-components-building-blocks/error-descriptions) · [NHCX overview](https://en.wikipedia.org/wiki/National_Health_Claims_Exchange) · [Cashless Everywhere](https://nyvo.in/health-insurance/cashless-everywhere-guide) · [TPA denial reasons](https://accredready.in/learn/tpa-insurance-claim-denials)

**AI & governance** — [MightyBot evidence-linked adjudication](https://mightybot.ai/blog/ai-agents-insurance-claims-evidence-linked/) · [Tungsten HITL governance](https://www.tungstenautomation.com/blog/human-in-the-loop-ai-enterprise-governance-best-practices) · [npj Digital Medicine: humans in the loop on appeal](https://www.nature.com/articles/s41746-023-00906-8) · [FINOS agent decision audit](https://air-governance-framework.finos.org/mitigations/mi-21_agent-decision-audit-and-explainability.html) · [HealthEdge auto-adjudication rates](https://healthedge.com/resources/blog/how-improving-auto-adjudication-rates-can-enhance-health-plan-performance)
