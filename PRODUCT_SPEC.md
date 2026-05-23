# ClaimsOS — Product Specification

**Owner:** Finclarity-Tech / 24Eleven Healthcare
**Last updated:** 2026-05-13
**Status:** Living document — consolidates April 2026 product doc + May 2026 audit findings.

---

## 1. Vision

ClaimsOS is a **hospital-network operations platform** for India's cashless health-insurance ecosystem (TPAs, PMJAY, ECHS, CGHS, ESIC, etc.). It captures, verifies, and routes the evidence required to process insurance claims — patient documents, doctor credentials, hospital empanelment proofs — and surfaces a verifiable public profile per hospital and per doctor that insurers, regulators, and patients can trust.

**One-line:** *Verify-then-route* — every claim ships with a trust footprint.

## 2. Problem & Why It Matters

- Hospital claim teams spend hours per case shuffling photos, IDs, discharge summaries, and signed forms between WhatsApp groups and shared drives. Documentation is unstructured, undated, and often re-captured because the original isn't found.
- Insurance TPAs reject claims for missing/mistimed evidence, costing hospitals 10–30% in deductions.
- Doctor and hospital credentials (NMC reg, NABH, ISO, fire NOC, biomedical waste) are scattered across PDFs and websites; insurers, validators, and patients can't independently verify them.
- There is no neutral, time-stamped, geo-attested capture of "this discharge happened at this hospital on this day."

ClaimsOS solves four overlapping problems:
1. **Field capture** of claim evidence with GPS + EXIF + watermarks (mobile app for hospital staff).
2. **Structured hospital & doctor profiles** with verifiable, expirable attributes and documents.
3. **Public discoverability** through shareable, token-gated profile links.
4. **Validator workflow** to record independent verification visits and confidence levels.

## 3. Users & Personas

| Role | Description | Primary Surfaces |
|---|---|---|
| **Superadmin** | 24Eleven platform operators. Configures attribute catalogs, master options, validators, and onboards hospitals. | Webapp `/superadmin` |
| **Admin** | 24Eleven-side claims operations. Assigned to one or more hospitals with granular `can_view / can_edit / can_discharge` permissions. | Webapp `/admin`, `/hospital/:id` |
| **Hospital User** | Hospital-side staff (varied internal roles via `hospital_users.role TEXT[]`). Manages own profile, panels, doctors, and patient documents. | Webapp `/portal/:hospitalId` |
| **Doctor** | Independent or hospital-affiliated medical professional. Self-registers, manages credentials, controls public visibility. | Webapp `/doctor/profile`, public `/doctors`, `/public-doctor/:token` |
| **Field Agent** | Captures patient admission/discharge documentation on-site. | Flutter mobile app |
| **Validator** *(role exists, UI in progress)* | Independent verifier of hospital/doctor credentials with on-site visits, confidence levels, photo evidence. | Backend ready; webapp UI partial |
| **Public Viewer** | Anyone with a share-link token (TPA reviewer, regulator, prospective patient). | `/hospitals`, `/doctors`, `/public-profile/:token`, `/hospitals/share/:token`, `/public-doctor/:token` |

## 4. Core Domain Model

```
                            ┌──────────────────┐
                            │   Superadmin     │
                            │   defines        │
                            └────────┬─────────┘
                                     │ configures
                                     ▼
              ┌─────────────────────────────────────────────────┐
              │  Attribute Definitions (catalog)                 │
              │  - hospital_attribute_definitions                │
              │  - panel_attribute_definitions                   │
              │  - doctor_attribute_definitions                  │
              │  - master_options (dropdown values)              │
              └─────────────────────────────────────────────────┘
                                     │ instantiated as
                                     ▼
   ┌──────────────┐         ┌──────────────────┐       ┌──────────────┐
   │   Hospital   │◄────────┤  Hospital Doctor ├──────►│    Doctor    │
   │              │ panels  │  (employment)    │       │ (independent │
   │  - attrs     │         │                  │       │  registry)   │
   │  - docs      │         └──────────────────┘       │  - attrs     │
   │  - share     │                                    │  - docs      │
   │  - panels    │                                    │  - share     │
   └───────┬──────┘                                    └──────────────┘
           │ has
           ▼
   ┌──────────────┐         ┌──────────────────┐       ┌──────────────┐
   │ Hospital     │  has    │  Patient (IPD)   │  has  │    Claim     │
   │ Panel        ├────────►│  - admit/disch   ├──────►│  - amount    │
   │ (insurer)    │         │  - documents     │       │  - status    │
   └──────────────┘         │  - photos        │       │  - settled   │
                            └──────────────────┘       └──────────────┘
                                     │ verified by
                                     ▼
                            ┌──────────────────┐
                            │  Verification    │
                            │  Visit (validator│
                            │  evidence, notes)│
                            └──────────────────┘
```

**Key concepts:**

- **Attribute Definition** — a typed slot (text / date / boolean / document / textarea / select-from-master) in a configurable catalog. Owns metadata: required, has_expiry, requires_document, requires_validator_verification, auto_verifiable, verification_url_pattern.
- **Attribute Instance** — a value bound to a hospital, panel, or doctor against one definition. Carries verification status, expiry, issued/expires dates, certificate number, issuing authority.
- **Document** — a file (S3-backed) attached to one or more attributes via a junction table.
- **Verification** — a status on each attribute (`unverified | pending_review | verified | rejected | expired`) plus a verification record with method (document, image, online_lookup, manual, automated), validator, confidence level, evidence.
- **Share Token** — a time-bound, optionally view-counted URL that grants public read access to a hospital or doctor's profile.

## 5. Feature Inventory

### 5.1 Mobile App (Flutter — `Frontend/`)

- **Login** with JWT + auto-refresh.
- **Patient list** with search, status filter (`all | admitted | discharged`), sort.
- **Patient create / edit** form (basic demographics, PMJAY case number).
- **Camera capture** with live geolocation, reverse-geocoded address, GPS coords, Google Static-Maps thumbnail, and timestamp **stamped onto each photo** as a watermark — the core evidentiary feature.
- **Category-keyed uploads** to admission and discharge buckets (conservative vs surgical).
- **PDF picker** for prepared documents.
- **Multipart upload** to V2 S3-direct endpoint with progress UI.
- **View galleries** of previously uploaded photos and discharge docs per patient.
- **Connectivity gate** + offline screen.
- **Force-update** flow via `/version` endpoint.

### 5.2 Webapp — Superadmin

- Manage admins (create, assign to hospitals with permissions).
- Manage hospitals (create, view, link panels, view docs).
- Manage master panels (insurers) and per-hospital empanelments.
- **Attribute Definition Configurators** — three independent catalogs (hospital, panel, doctor), each grouped by category, with data-type-driven form rendering.
- **Master Options Manager** — scalable dropdown management used by attribute definitions.
- Verify/suspend independent doctors.

### 5.3 Webapp — Hospital Portal (`/portal/:hospitalId`)

- **Dashboard** with operations summary.
- **Profile** (5 tabs):
  1. *Profile* — banking, contact, certifications, key contacts.
  2. *Attributes* — fill the configured attribute catalog with values, documents, expiry tracking, verification status badges.
  3. *Panels* — link master panels, fill panel-level attributes (sheet ids, WhatsApp groups, fee schedules).
  4. *Doctors* — add/remove doctors, set employment type, department, dates; manage per-hospital doctor credentials.
  5. *Public Sharing* — generate / list / revoke time-bound share tokens, toggle profile visibility, view counters.
- **Panels** page — list of hospital's empanelled panels; click into panel details with patient list.
- **Panel Details** — patient table per panel with status filters and modal-based edits.
- **Users** — hospital-side user management with role arrays.
- **Verification Dashboard** — checklist of unverified attributes, progress %, expired/expiring banners.

### 5.4 Webapp — Doctor (Self-Service)

- **Self-registration** at `/register/doctor` (no email verification gate).
- **Doctor Profile dashboard** (`/doctor/profile`) — tabs:
  - Profile (basic info, public visibility toggle).
  - Credentials (Licenses, Qualifications, Compliance, Experience — grouped by category).
  - Hospital Affiliations (view-only list of `hospital_doctors` records).
  - Public Sharing (generate/revoke share tokens).

### 5.5 Webapp — Public Surface

- `/hospitals` — searchable hospital directory (hospitals with public profile enabled).
- `/doctors` — searchable doctor directory.
- `/hospitals/share/:token` and `/public-profile/:token` — public hospital profile with verified attributes, documents (token-gated download/preview), key contacts.
- `/public-doctor/:token` — public doctor profile.
- Finclarity branding in nav, with back-links to marketing site.

### 5.6 Verification Subsystem

- **Verification Visits** — superadmin/validator schedules a visit, attaches evidence (photos, notes, confidence levels, discrepancy flags).
- **Per-attribute verification status** — auto-rolled to `verified_by_doc`, `verified_by_image`, `verified_by_online`, `verified_manual`, `auto_verified` based on method.
- **Expiry watchers** — `/attributes/expiring`, `/attributes/expired` endpoints for proactive renewal nudges.
- **Document extraction** — backend pipeline (`documentExtraction.service.ts`) to OCR/extract structured fields (e.g., NMC number) from uploaded PDFs for auto-fill suggestions.

### 5.7 Notifications & Integrations

- **WhatsApp** via UltraMsg — buffered group messages on upload completion per patient.
- **Google Sheets webhook** — claims/patient events posted to per-panel sheet IDs.
- **Google Drive** — legacy backup target, partially disabled; S3 is the primary store.

## 6. User Journeys (Top 5)

### J1 — Field Agent captures admission docs
1. Opens mobile app at hospital reception, logs in.
2. Creates patient or selects existing admitted patient.
3. Taps "Camera" → grants permissions on first run → live GPS + address overlay appears.
4. Captures front of Aadhaar / health card / referral letter — each photo gets a watermark with hospital address, lat/lng, timestamp, and a small map thumbnail.
5. Reviews thumbnails in gallery → multi-selects → uploads to backend.
6. Upload completes → WhatsApp notification fires to the panel's group with the new files.
7. Photos visible in webapp under Patient → Panel Details → Photos modal.

### J2 — Hospital admin completes a profile
1. Logs into webapp → lands on `/portal/:hospitalId`.
2. Goes to Profile → Attributes tab.
3. Sees attribute catalog grouped by category (Banking, Certifications, Empanelment, Fire/Safety, Biomedical Waste, etc.).
4. Fills text values, dates, booleans; uploads documents for `requires_document` attributes.
5. Sees verification badges turn from grey (unverified) to yellow (pending) when documents attach.
6. Goes to Public Sharing → enables public profile → generates a share link with 30-day expiry → copies and sends to TPA.

### J3 — Doctor self-registers and shares profile
1. Visits `/register/doctor`, fills form with name, specialization, NMC number, password.
2. Lands in `/doctor/profile` after auto-login.
3. Adds qualifications (MD, fellowship), uploads certificate PDFs.
4. Adds licenses (NMC reg, state reg) with expiry dates.
5. Toggles public profile on → generates share link → shares with hospital recruiters.

### J4 — Superadmin onboards a new hospital
1. Logs into `/superadmin` → Hospitals tab → "Add Hospital".
2. Fills basics, creates an Admin user, assigns admin to the hospital with `can_view / can_edit / can_discharge`.
3. Goes to attribute definitions → confirms required attributes are set.
4. Sends admin login credentials.

### J5 — Public viewer verifies a hospital
1. Receives share link `/hospitals/share/<token>`.
2. Sees hospital name, city, certifications, key contacts.
3. Sees attribute badges (Verified ✓ for NABH, Verified ✓ for Fire NOC, Pending for new ISO cert).
4. Downloads NABH certificate PDF (counts a view in `share_tokens`).
5. Link expires after 30 days; access revoked.

## 7. Roadmap — Planned (Next 2 Quarters)

### Near-term (high confidence)
1. **iOS mobile release** — fix Info.plist usage descriptions, bundle id, signing.
2. **Mobile applicationId / Play Store alignment** — unify `com.claimsos.app` everywhere or revert.
3. **Doctor user-role wiring** — actually log doctors in as `doctor` role and route them to `/doctor/profile` automatically.
4. **Validator UI** — page for validators to record visits, upload evidence, set confidence levels.
5. **Public directory polish** — pagination, specialization filters, search debouncing.

### Mid-term
6. **Claims workflow** — first-class claim state machine (submitted → queried → settled → paid), not just status text.
7. **Document extraction (OCR)** — surface extracted fields in UI for one-click acceptance into attributes.
8. **Notifications inbox** — in-app notifications complementing WhatsApp.
9. **Audit log** — actually wire `audit_logs` table and surface a Superadmin audit-trail viewer.
10. **Doctor mobile** — allow doctors to manage their profile from a stripped-down mobile experience.

### Aspirational
11. **TPA integrations** — direct API submission of claim packets to major TPAs.
12. **Insurance-network analytics** — claim cycle time, deduction reasons, doctor productivity.
13. **Patient-facing portal** — patients see their own claim status with public-token access.

## 8. Non-functional Requirements

- **Availability:** 99% (target). Single backend node currently; no HA.
- **Security:** All PII at rest in PostgreSQL; documents in S3 with presigned-URL delivery (1 hr expiry) via CloudFront signing.
- **Compliance posture:** HIPAA-like principles followed (no real US compliance binding); Indian DPDP applicable but not formally audited.
- **Performance:** Webapp interactive < 3s on broadband; mobile capture-to-upload < 30s per photo on 4G.
- **Mobile:** Android 5.0+ (min SDK 21), iOS 13+ (target after release).

## 9. Out of Scope (Today)

- Real-time chat / messaging between hospital and TPA.
- Patient billing or invoicing.
- Tele-consultation or appointment booking.
- Native desktop apps.
- Multi-tenant white-labeling beyond Finclarity branding.

## 10. Success Metrics (Proposed)

- **Field capture:** time from patient creation to first uploaded document < 10 minutes.
- **Profile completeness:** % of required attributes filled per active hospital ≥ 80% within 30 days of onboarding.
- **Verification coverage:** ≥ 60% of attributes marked verified within 60 days.
- **Public engagement:** ≥ 5 share-link views per active hospital per month.
- **Doctor self-service:** ≥ 30% of independent doctors complete profile within 7 days of registration.

---

*Source audits behind this document are archived in `docs/archive/audits/`. See also `TECHNICAL_SPEC.md` for how this is built and `TECH_DEBT.md` for known issues blocking delivery.*
