# ClaimOS — Product Document

> **Version:** 2.0 — April 2026 (updated with Hospital Profile Management feature)
> **Purpose:** Understand what has been built, who uses it, and what the product does end-to-end.

---

## Table of Contents
1. [Product Vision](#1-product-vision)
2. [User Personas](#2-user-personas)
3. [Feature Inventory — What's Built](#3-feature-inventory--whats-built)
4. [User Journeys](#4-user-journeys)
5. [Platform Coverage](#5-platform-coverage)
6. [Notifications & Integrations](#6-notifications--integrations)
7. [Data Model (Product Perspective)](#7-data-model-product-perspective)
8. [Feature Gaps & Product Backlog](#8-feature-gaps--product-backlog)
9. [Known Limitations](#9-known-limitations)

---

## 1. Product Vision

**ClaimOS** is an insurance claims operations platform built for the Indian healthcare ecosystem. It bridges hospital bedside staff, field claims administrators, and insurance panel operations.

The platform digitizes the end-to-end flow of an IPD (in-patient) insurance claim:
- Patient is admitted → basic details registered
- Medical documents captured (discharge slips, OT notes, investigation reports, etc.)
- Claim submitted, tracked, and settled
- All data synced to the insurance panel's Google Sheet and WhatsApp coordination group

**The core value:** Replace paper-based, WhatsApp-manual, and spreadsheet-driven claim coordination with a structured, auditable, multi-role platform — accessible from a phone (for hospital staff) and a browser (for administrators).

---

## 2. User Personas

### Persona 1: Superadmin (System Operator / Finclarity Staff)
- Onboards hospitals into the system
- Creates and manages insurance panels (PMJAY, ESI, CGHS, etc.)
- Links panels to hospitals with configuration (WhatsApp group, Google Sheet, Drive folder)
- Creates admin accounts and assigns them to hospitals
- Views system-wide dashboard (total hospitals, patients, admins, recent activity)
- Views all hospital docs, doctors, and patient records

### Persona 2: Admin (Field Claims Officer)
- Assigned to one or more hospitals (can_view / can_edit / can_discharge permissions)
- Views all patients across their assigned hospitals
- Updates patient details and claim information
- Uploads and views documents for any patient in their hospitals
- Manages claim data (amounts, status, approval, deductions)
- Accesses hospital dashboard with panel breakdown

### Persona 3: Hospital User (Hospital Staff — Nurse / TPA Coordinator)
- Belongs to a specific hospital
- Has access to one or more insurance panels within that hospital
- Admits new patients, updates basic details
- Captures and uploads documents using the mobile camera or gallery
- Views uploaded photos for their patients
- Discharges patients with date recording

---

## 3. Feature Inventory — What's Built

### 3.1 Authentication & User Management

| Feature | Status | Notes |
|---|---|---|
| Username + password login | ✅ Built | Returns JWT access + refresh tokens |
| Token auto-refresh | ✅ Built | 30-day refresh token, hashed in DB |
| Create superadmin accounts | ✅ Built | Via `/auth/signup` with superadmin role |
| Create admin accounts | ✅ Built | Via `/auth/signup` with admin role |
| Create hospital staff accounts | ✅ Built | Linked to hospital at creation time |
| View all users | ✅ Built | Superadmin-only via `/user/all` |
| Toggle user active status | ✅ Built | Enable/disable user accounts |
| Password reset | ❌ Not built | No forgot-password or OTP flow |
| Multi-device sessions | ❌ Not built | One refresh token per user |

### 3.2 Hospital Management

| Feature | Status | Notes |
|---|---|---|
| Add new hospital | ✅ Built | Creates Google Drive folder + DB record |
| View all hospitals | ✅ Built | List with city, details |
| Edit hospital details | ✅ Built | Validated via Zod schema |
| Hospital rich details | ✅ Built | JSONB: address, HFR ID, Rohini ID, PAN, TPA details, CMO info, beds, specialities |
| View hospital by ID | ✅ Built | |
| View hospital docs | ✅ Built | Upload + view official documents per hospital/panel |
| Hospital drill-down (webapp) | ✅ Built | Panels, doctors, patients, users all in one view |

### 3.3 Insurance Panel Management

| Feature | Status | Notes |
|---|---|---|
| Create master panel (e.g., PMJAY, ESI) | ✅ Built | Global panel type registry |
| View all master panels | ✅ Built | |
| Link panel to hospital | ✅ Built | Creates Drive subfolder, stores WhatsApp group + Sheet config |
| View hospital's linked panels | ✅ Built | With active patient counts |
| Panel-level WhatsApp group | ✅ Built | Notifications sent to group on upload |
| Panel-level Google Sheet | ✅ Built | Patient add/update/discharge synced as rows |
| Panel-level contact | ✅ Built | TPA contact number stored |

### 3.4 Patient (IPD) Management

| Feature | Status | Notes |
|---|---|---|
| Add patient (admission) | ✅ Built | Name, phone, panel, admission type, date |
| Admission types | ✅ Built | Conservative, Surgical |
| Beneficiary ID (PMJAY case number) | ✅ Built | `beneficiary_id` field |
| View all patients | ✅ Built | Role-scoped (superadmin sees all, admin sees assigned hospitals, hospital sees own panels) |
| Paginated patient list | ✅ Built | 20 per page, sorted by updated_at |
| Filter by status | ✅ Built | All / Active / Admitted (no discharge date) / Discharged / Deactivated |
| Search patients | ✅ Built | By first name, last name, or phone |
| Tab counts per status | ✅ Built | Efficient single-query counts |
| Edit patient details | ✅ Built | Name, phone, admission date, type, beneficiary ID |
| Discharge patient | ✅ Built | Sets discharged_at date, syncs to Sheet |
| Deactivate / activate patient | ✅ Built | Soft delete via `is_active` flag (admin/superadmin only) |
| Delete patient | ⚠️ Broken | Ownership check has a critical bug |
| Sheet sync on all actions | ✅ Built | Add / update / discharge webhook |

### 3.5 Insurance Claims

| Feature | Status | Notes |
|---|---|---|
| Upsert claim per patient | ✅ Built | Creates if not exists, updates if exists |
| Treatment plan / procedure | ✅ Built | Free-text `treatment_plan` field |
| Claim status | ✅ Built | Free-text `latest_status` (no enum/workflow) |
| Claim amount | ✅ Built | |
| Approved amount | ✅ Built | |
| Incentive | ✅ Built | |
| Deduction + reason | ✅ Built | |
| Settled amount + date | ✅ Built | |
| Claims inline in patient update | ✅ Built | Patient PATCH endpoint can upsert claims |
| Claims Sheet sync | ✅ Built | treatment_plan, latest_status, claim_amount pushed on update |
| Claim reporting / analytics | ❌ Not built | No aggregate reports |
| Claim status workflow | ❌ Not built | No state machine (PENDING → SUBMITTED → etc.) |
| Claim notifications | ❌ Not built | No alert when claim status changes |

### 3.6 Document Uploads (Patient)

| Feature | Status | Notes |
|---|---|---|
| Upload admission photos (mobile) | ✅ Built | Camera + gallery multiselect |
| Upload discharge documents (mobile) | ✅ Built | Per-category (Conservative / Surgical types) |
| Conservative doc categories | ✅ Built | Discharge Slip, Investigations, Treatment, ICPs, Others |
| Surgical doc categories | ✅ Built | Surgical Discharge Slip, OT Notes & Photos, Post-Op Photos, Post-Op Reports, Implant Invoice |
| Upload via webapp (drag & drop) | ✅ Built | PatientPhotosModal with upload queue UI |
| Custom file naming | ✅ Built | Admin can set custom name prefix for uploaded files |
| File compression (PDF) | ✅ Built | Ghostscript pre-upload compression |
| Image conversion (WebP) | ✅ Built | CloudFront Lambda@Edge handles webp conversion |
| S3 storage with encryption | ✅ Built | AES256 server-side encryption |
| CloudFront CDN delivery | ✅ Built | Signed URLs (1hr expiry) for all file access |
| File counts per category | ✅ Built | API endpoint for category breakdowns |
| View photos in webapp | ✅ Built | Lightbox + lazy loading in PatientPhotosModal |
| Photo grid by category | ✅ Built | Organized into category tabs |
| Batch delete photos | ✅ Built | S3 + DB cleanup |
| Rename files | ✅ Built | Update file_name in DB |
| PDF generation (stitch images) | ✅ Built | Admin-only, generates PDF from Drive photos |
| File metadata endpoint | ✅ Built | Instant metadata without URL generation |
| WhatsApp notification on upload | ✅ Built | Batch-debounced, sent after all files in session |
| Google Drive backup | ⚠️ Disabled | Infrastructure exists, disabled in code |

### 3.7 Hospital Documents

| Feature | Status | Notes |
|---|---|---|
| Upload official hospital docs | ✅ Built | S3 upload, categorized |
| Panel-specific hospital docs | ✅ Built | Documents can be tied to a specific panel |
| View hospital docs | ✅ Built | With signed URLs |
| Filter by category / panel | ✅ Built | |
| Delete hospital doc | ✅ Built | S3 + DB cleanup |
| S3 proxy route | ✅ Built | Bypass CORS for in-browser viewing |

### 3.8 Doctors Management

| Feature | Status | Notes |
|---|---|---|
| Add doctor to hospital | ✅ Built | Name, speciality, age, phone, years of experience |
| Edit doctor details | ✅ Built | |
| Delete doctor | ✅ Built | Also deletes S3 documents |
| Upload doctor credentials | ✅ Built | Custom name per document, S3 storage |
| View doctor documents | ✅ Built | With presigned URLs |
| Delete doctor document | ✅ Built | S3 + DB cleanup |
| Doctor-patient linkage | ❌ Not built | Doctors and IPDs not related |

### 3.9 Admin Assignment & Permissions

| Feature | Status | Notes |
|---|---|---|
| Assign admin to hospital | ✅ Built | Superadmin only |
| Granular permissions | ✅ Built | can_view, can_edit, can_discharge per assignment |
| Remove admin assignment | ✅ Built | |
| Update admin permissions | ✅ Built | Superadmin only |
| View admins for a hospital | ✅ Built | |
| View hospitals for an admin | ✅ Built | |

### 3.10 Hospital User (Staff) Management

| Feature | Status | Notes |
|---|---|---|
| Create hospital user | ✅ Built | Linked to hospital at signup |
| Update user's panel access | ✅ Built | Array of panel IDs + optional 'admin' role |
| View hospital staff list | ✅ Built | |
| Role-based panel filtering | ✅ Built | Staff only sees panels they're assigned to |
| Hospital admin role | ✅ Built | 'admin' in role array = sees all panels |

### 3.11 Dashboards & Analytics

| Feature | Status | Notes |
|---|---|---|
| Superadmin stats | ✅ Built | Total hospitals, patients, active patients, admins, recent activity |
| Recent activity feed | ✅ Built | Last 5 admissions + updates |
| Hospital panel summary | ✅ Built | Active/admitted breakdown per panel |
| Panel patient counts | ✅ Built | Shown on panel cards |
| Admin dashboard | ✅ Built | Shows assigned hospitals + their panels |
| Hospital portal dashboard | ✅ Built | Panel cards with patient counts |
| Report generation | ❌ Not built | No PDF/Excel export of claim data |
| Settlement analytics | ❌ Not built | No claim amount aggregations or trend charts |

### 3.12 System Health & Operations

| Feature | Status | Notes |
|---|---|---|
| Liveness probe `/health/live` | ✅ Built | Kubernetes-ready |
| Readiness probe `/health/ready` | ✅ Built | Checks DB connection |
| Full health endpoint | ✅ Built | CPU, memory, uptime, DB status |
| Prometheus metrics | ✅ Built | HTTP request histogram, default Node metrics |
| Version endpoint | ✅ Built | Returns `APP_VERSION` env var |
| Drive backup recovery on startup | ✅ Built | Retries failed Drive backups (legacy) |
| Audit logging | ❌ Not built | AuditService exists but table + calls disabled |

---

## 4. User Journeys

### Journey 1: Onboarding a New Hospital (Superadmin)

```
1. Superadmin logs into webapp → /superadmin
2. Clicks "Add Hospital" → fills name, city, and optional details (HFR ID, beds, etc.)
3. System creates Google Drive root folder for hospital
4. Hospital appears in the hospitals list
5. Superadmin opens hospital → clicks "Link Panel"
6. Selects a master panel (e.g., PMJAY) → enters WhatsApp group ID, Google Sheet ID + tab name
7. System creates a panel-level Drive subfolder inside hospital folder
8. Superadmin creates hospital staff account → sets hospital + role (panel access)
9. Staff can now log in on mobile and see their panel
```

### Journey 2: Admitting a Patient (Hospital Staff — Mobile)

```
1. Hospital staff opens Flutter app → taps "+" to add patient
2. Enters first name, phone, selects insurance panel, sets admission date
3. Selects admission type (Conservative / Surgical)
4. Taps "Save" → backend creates IPD record + Drive subfolder + Sheet row
5. Patient appears in the list with status "Admitted"
```

### Journey 3: Capturing Documents (Hospital Staff — Mobile)

```
1. Staff opens patient from list → taps "Upload Documents"
2. For admission photos: opens camera or gallery → selects files → uploads
3. For discharge docs (conservative): navigates to Discharge section → selects category
   (Discharge Slip / Investigations / Treatment / ICPs / Others)
4. For surgical: different set of categories (OT Notes, Implant Invoice, etc.)
5. Files compress → upload to S3 → WhatsApp notification sent to panel group
   (batched: notification fires after ALL files for that patient upload)
```

### Journey 4: Viewing and Managing Patient Documents (Admin — Webapp)

```
1. Admin logs into webapp → /dashboard → opens hospital
2. Navigates to a panel → sees patient list with filters
3. Clicks patient → PatientPhotosModal opens
4. Photos organized by category tabs (Discharge Slip, Investigations, etc.)
5. Admin can upload additional files via drag & drop
6. Admin can set custom file name prefix before upload
7. Can delete selected photos
8. Can open lightbox for full-screen view
9. Can update claim fields (treatment plan, claim amount, status, etc.) inline
```

### Journey 5: Processing an Insurance Claim (Admin)

```
1. Admin opens patient in PatientPhotosModal
2. Sees "Claims" section alongside photo view
3. Fills: Treatment Plan/Procedure, Latest Status, Claim Amount
4. Saves → claim upserted in DB + synced to Panel's Google Sheet
5. As claim progresses:
   - Approved Amount filled when panel approves
   - Deduction + Reason if partial rejection
   - Settled Amount + Date when payment received
```

### Journey 6: Discharging a Patient (Hospital Staff)

```
1. Staff opens patient on mobile
2. Taps "Discharge" → selects discharge date
3. Backend updates discharged_at → syncs discharge date to Sheet
4. Patient still visible in "Discharged" filter tab
5. Deactivation (admin only) needed to fully remove from active list
```

### Journey 7: Hospital Onboarding Documents (Admin/Superadmin)

```
1. Open hospital detail page in webapp → Hospital Docs section
2. Upload TPA agreements, accreditation certificates, panel-specific empanelment letters
3. Can tag to specific panel or keep as general hospital docs
4. Docs stored on S3, viewable with signed URLs
```

### Journey 8: Doctor Management (Admin/Superadmin)

```
1. Open hospital → Doctors tab
2. Add doctor: name, speciality, age, experience
3. Upload credentials: medical degree, registration certificate (with custom labels)
4. Docs stored on S3, retrievable with signed URLs
```

---

## 5. Platform Coverage

### Mobile App (Flutter)
**Primary users:** Hospital staff (bedside nurses, TPA coordinators)
**Primary flows:** Patient admission, document capture, discharge

| Screen | Purpose |
|---|---|
| Login | Username/password auth |
| Patient List | All patients for user's panels, searchable |
| Patient Details | View patient info + quick actions |
| Patient Form | Add or edit patient |
| Camera | Capture photos directly with location |
| Gallery | Select existing photos |
| Image Preview | Review before upload |
| Category Uploads | Upload to specific discharge category |
| Discharge Conservative | Manage conservative discharge doc categories |
| Discharge Surgical | Manage surgical discharge doc categories |
| View Photos | See uploaded admission photos |
| View Discharge Docs | See uploaded discharge category docs |
| Connectivity Wrapper | Graceful offline handling |
| Offline Screen | Network-unavailable state |

**Supported platforms:** Android (primary), iOS (configured), macOS, Linux, Windows, Web (Flutter targets — not all tested)

### Webapp (React)
**Primary users:** Admins, Superadmin
**Primary flows:** Hospital management, patient oversight, claims management

| Page | Roles | Purpose |
|---|---|---|
| Login | All | Authentication |
| SuperAdmin Dashboard | superadmin | All hospitals overview |
| Hospital Detail | superadmin, admin | Panels, doctors, patients, users |
| Admin Dashboard | admin | Assigned hospitals + their panel patients |
| Hospital Portal | hospital, admin, superadmin | Hospital-scoped panel/user management |
| Hospital Dashboard (portal) | hospital | Panel summary with counts |
| Hospital Panels (portal) | hospital | List of linked panels |
| Hospital Users (portal) | hospital admin | Staff + panel access management |
| Hospital Panel Details (portal) | hospital | Full patient list for a panel |
| Panel Patients Page | all | Patient table with photo modal |

---

## 6. Notifications & Integrations

### WhatsApp (UltraMsg)
- **Trigger:** After a document upload session completes
- **Target:** The hospital-panel's WhatsApp group
- **Content:** Summary of uploaded files for a patient (names, types)
- **Mechanism:** NotificationBuffer batches uploads per patient per session, then enqueues to Redis Bull queue → UltraMsg API

### Google Sheets
- **Trigger:** Patient added, patient updated, patient discharged, claim updated
- **Target:** The panel's configured Google Sheet (specific tab/sheet name)
- **Data synced:** name, phone, admission date, discharge date, treatment procedure, claim status, claim amount, beneficiary ID
- **Mechanism:** Direct HTTP POST to a Google Apps Script webhook URL

### Google Drive (Legacy — Disabled)
- Originally used as primary file storage
- Now disabled throughout codebase (commented out)
- Drive backup system (`driveBackup.queue`) exists but no jobs enqueued
- `drive_folder_id` still created on hospital/panel/patient creation (API call still made)

### AWS S3 + CloudFront
- **Primary file storage** for all document types
- Files delivered via CloudFront CDN with 1-hour signed URLs
- Lambda@Edge on CloudFront converts uploaded images to WebP format
- Server-side AES256 encryption at rest

### Prometheus + Grafana (inferred)
- Prometheus metrics endpoint exposed at `/metrics`
- HTTP request duration histogram (`app_24eleven_http_requests_total`)
- Standard Node.js metrics (CPU, memory, GC)

---

## 7. Data Model (Product Perspective)

### Core Entities
```
Hospital
  ├── has many Panels (via hospital_panels)
  │     └── each panel has: WhatsApp group, Google Sheet, Drive folder
  ├── has many Doctors
  │     └── each doctor has: Credentials (docs)
  ├── has many Users (staff)
  │     └── each user has: Panel access list
  ├── has many Patients (IPDs)
  │     ├── each patient has: Documents (by category)
  │     └── each patient has: Claim (1:1)
  └── has many Hospital Documents

Admin
  └── assigned to many Hospitals (via hospital_assignments)
        └── with permissions: can_view, can_edit, can_discharge
```

### Patient Lifecycle
```
ADMITTED (is_active=true, discharged_at=null)
    ↓ [Hospital staff captures docs, admin updates claims]
DISCHARGED (is_active=true, discharged_at=<date>)
    ↓ [Admin optionally deactivates]
DEACTIVATED (is_active=false)
```

### Document Categories
**Conservative Admission:**
- `admission` — General admission photos
- `discharge_slip` — Discharge summary
- `investigations` — Lab reports, imaging
- `treatment` — Treatment charts, prescriptions
- `icps` — ICU charts, progress notes
- `others` — Miscellaneous

**Surgical Admission:**
- `admission` — General admission photos
- `surgical_discharge_slip` — Surgical discharge summary
- `ot_notes_and_photos` — Operation theatre documentation
- `post_op_photo` — Post-operative photos
- `post_op_reports` — Post-op investigation reports
- `implant_invoice` — Implant bills and invoices

---

## 8. Feature Gaps & Product Backlog

### P0 — Must Fix (Bugs/Broken)

| ID | Feature | Description |
|---|---|---|
| FIX-1 | Delete Patient | Ownership check broken — uses user ID instead of hospital ID |
| FIX-2 | Toggle Patient Active | References `hospital_assignments.is_active` which doesn't exist |
| FIX-3 | Get Hospital Admins | Same broken column reference |

### P1 — High Priority

| ID | Feature | User Story |
|---|---|---|
| BP-1 | Claim Status Workflow | As an admin, I want a structured claim lifecycle (Pending → Submitted → Approved → Settled) so I can track where each claim stands without free-text |
| BP-2 | Audit Trail | As a superadmin, I need to see who changed what and when for compliance |
| BP-3 | Password Reset | As any user, I want to reset my password via OTP/email when I forget it |
| BP-4 | Claim Report Export | As an admin, I want to export a panel's claims to Excel/PDF for monthly reporting |
| BP-5 | Drive Dependency Removal | As an operator, I want patient creation to not fail when Drive is unavailable |

### P2 — Medium Priority

| ID | Feature | User Story |
|---|---|---|
| BP-6 | Claim Analytics Dashboard | As a superadmin/admin, I want to see claim amounts, approval rates, and settlement trends per panel and period |
| BP-7 | Doctor-Patient Linkage | As an admin, I want to record which doctor treated a patient to link docs to doctor registry |
| BP-8 | WhatsApp Notification Control | As an admin, I want to enable/disable WhatsApp notifications per panel without changing code |
| BP-9 | Document AI / OCR | As an admin, I want to auto-extract claim data from uploaded discharge slips |
| BP-10 | Superadmin Patient Search | As a superadmin, I want to search and filter the global patient list |
| BP-11 | User Invitation Flow | As a superadmin, I want to invite users via email with a one-time setup link instead of sharing passwords |
| BP-12 | Offline Upload Queue (Mobile) | As hospital staff with poor connectivity, I want uploads to queue locally and retry automatically |
| BP-13 | Push Notifications | As hospital staff, I want to receive push notifications when a claim status changes |

### P3 — Nice to Have

| ID | Feature | User Story |
|---|---|---|
| BP-14 | Bulk Patient Import | As a superadmin, I want to import patients from a CSV/Excel sheet |
| BP-15 | Document Templates | As an admin, I want to use pre-filled PDF templates for common discharge forms |
| BP-16 | Patient Portal / Sharing | As a patient, I want to access a read-only summary of my claim status |
| BP-17 | Multi-hospital Staff | As an admin, I want to assign a single hospital user to multiple hospitals |
| BP-18 | Attachment Notes | As an admin, I want to add notes and summaries to individual uploaded documents |
| BP-19 | Claim Comparison | As an admin, I want to compare claimed vs approved amounts across panels to identify patterns |
| BP-20 | API Documentation | As a developer integrating with ClaimOS, I want OpenAPI/Swagger docs |

---

## 9. Known Limitations

| Limitation | Impact |
|---|---|
| One refresh token per user (last login wins) | Staff using multiple devices will be logged out on the other device |
| Hospital patient creation requires Google Drive | If Drive API is down, no patients can be admitted even in S3 mode |
| No audit trail | Compliance risk — no record of who changed claim data or deleted records |
| Free-text claim status | Inconsistent status values across different users / no workflow enforcement |
| WhatsApp batch flush can delay up to 60 seconds | In edge cases, staff may think upload failed if no notification arrives quickly |
| Drive backup disabled but code not removed | Confusion for new developers about system state |
| No hard enforcement of admission_type values | Any string can be stored; only 'conservative' and 'surgical' are expected |
| No email notifications | All notifications via WhatsApp only — users without WhatsApp get no alerts |
| Superadmin can see all files | No data isolation between hospitals at the infrastructure level |
| PDF generation uses Drive photos | If a patient has no Drive folder (post-migration), PDF generation will fail |
| Google Sheet sync is fire-and-forget | Sheet may go out of sync silently if webhook fails |

---

## 10. Hospital Profile Management (v2.0 Feature)

> Full technical spec in [`HOSPITAL_PROFILE_FEATURE.md`](./HOSPITAL_PROFILE_FEATURE.md)

### 10.1 Feature Summary

Hospital Profile Management transforms ClaimOS from a claims-tracking tool into a comprehensive hospital operations platform. It enables:

- **Structured hospital profiles** replacing the unstructured `details` JSONB blob
- **Multi-panel empanelment management** with portal credentials, POC contacts, and contract data
- **Public shareable profiles** with verified badges (for insurers, referrals, abroad integrations)
- **Cashless Everywhere** — active by default for all hospitals with a Rohini ID
- **Document extraction** — contracts/MoUs with key fields surfaced in the UI

### 10.2 New User Journeys

#### Journey: Hospital Onboarding (Enhanced)
1. Superadmin creates hospital → blank `hospital_profile` created automatically
2. Hospital user logs in → sees "Profile Completion" indicator (0%)
3. Hospital fills profile section by section (Identity → Infrastructure → Contacts → Banking)
4. Uploads registration certificate, NABH/CGHS certs
5. Submits for Finclarity verification
6. Finclarity admin reviews, approves — verified badge issued
7. Hospital enables public profile and shares URL with insurers

#### Journey: Panel Empanelment Setup
1. Admin adds hospital to a panel (existing flow)
2. System creates empty `panel_empanelments` record
3. Admin fills in: empanelment dates, provider ID, hospital POC, insurer POC
4. Admin adds portal credentials (username + password, encrypted)
5. Configures 2FA: which contact receives the OTP
6. Uploads contract PDF
7. Admin (or AI) extracts key fields: room rents, package rates, payment terms
8. Rate cards visible in claim creation flow to pre-fill amounts

#### Journey: Public Profile Sharing (Abroad Insurer)
1. Hospital enables public profile, sets sections visible
2. Copies profile link: `https://app.finclarity.in/h/pragati-medcity-bhopal`
3. Shares with abroad insurer for credentialing
4. Insurer views: accreditations, specialties, bed counts, verified badge
5. Insurer submits empanelment request via the profile page CTA

#### Journey: Cashless Everywhere Claim
1. Patient admitted → staff selects "Cashless Everywhere" as claim network
2. System routes pre-auth via CE gateway using hospital's CE code
3. CE pre-auth approved → claim proceeds like standard cashless
4. Discharge → CE settlement tracked in ClaimOS

### 10.3 Updated Feature Inventory

| Feature | Status | Notes |
|---------|--------|-------|
| Hospital profile (structured) | ❌ Planned | Currently: flat JSONB only |
| Accreditation management | ❌ Planned | Currently: no certifications table |
| Panel empanelment metadata | ❌ Planned | Currently: no portal/POC data |
| Portal credential management | ❌ Planned | New feature |
| Contract/MoU upload | ❌ Planned | Currently: hospital_doc has no panel linkage |
| Contract field extraction | ❌ Planned | Phase 4 — AI-assisted |
| Public hospital profile | ❌ Planned | New feature |
| Shareable profile links | ❌ Planned | New feature |
| Patient data sharing (token) | ❌ Planned | New feature |
| Verified badge system | ❌ Planned | New feature |
| Cashless Everywhere | ❌ Planned | New feature |
| Renewal alerts (WhatsApp) | ❌ Planned | Phase 4 |

### 10.4 New Data Objects

| Object | Table | Key Fields |
|--------|-------|-----------|
| Hospital Profile | `hospital_profile` | 14 structured sections, verification level, public slug |
| Accreditations | `hospital_certifications` | cert_type, issuing_body, expiry_date, document_id |
| Key Contacts | `hospital_key_contacts` | contact_type, name, email, phone, is_public |
| Panel Empanelment | `panel_empanelments` | portal credentials, POC contacts, 2FA config, contract fields |
| Panel Documents | `panel_documents` | doc_type, effective_date, extracted_fields |
| Share Tokens | `public_share_tokens` | token, resource_type, resource_id, expires_at |

### 10.5 Impact on Existing Modules

| Module | Impact |
|--------|--------|
| Hospital creation | Must also create `hospital_profile` + CE empanelment |
| `drive_folder_id` | Made nullable — removes Drive hard-dependency |
| Patient creation | Drive folder creation must not block if Drive is down |
| Upload pipeline | Extended to accept panel doc uploads |
| Auth middleware | New public routes; credential access restricted to admin |
| Notifications | New types: empanelment expiry, CE activation, verification status |
