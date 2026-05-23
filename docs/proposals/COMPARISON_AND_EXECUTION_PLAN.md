# ClaimsOS Webapp · Deep-Dive Comparison & Execution Plan

**Date:** 2026-05-13
**Method:** Four parallel agents read every relevant source file end-to-end, including the 1500+ LOC managers. This document compares each surface field-by-field, calls out every delta, and translates them into PR-sized work items.

**Companion docs:** [`UI_REVAMP.md`](./UI_REVAMP.md) (strategy) · [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) (high-level migration) · [`ui-revamp/wireframes.html`](./ui-revamp/wireframes.html) (visual spec)

---

## 0. How to read this document

- **§1** explains what we found that changes the migration shape — read this first.
- **§2** is the surface-by-surface comparison table. For each existing page/modal we list: (a) what exists today, (b) what the wireframe shows, (c) the **delta** (what's missing or extra in each direction), (d) the migration decision.
- **§3** lists the duplicate / dead-code surfaces that need resolution **before** Phase A starts.
- **§4** is the PR-by-PR execution plan. Each PR has a fixed file list, an acceptance checklist, and clear "do not change" guards.
- **§5** is the explicit "do NOT add" list — every wireframe element that **does not exist in the real app** and must be cut from the migration target.

---

## 1. Findings that change the migration shape

### 1.1 Three credential editors coexist — one is probably dead but unverified

| File | LOC | What it does | Live? |
|---|---|---|---|
| `components/DoctorDetailsTabs/CredentialsTab.tsx` | 1036 | Full-featured (data-type branches: text/date/boolean/textarea/document; document linking; edit-mode delete; cat filter pills) | **Likely live** — TS/webpack prefers `CredentialsTab.tsx` over `CredentialsTab/index.tsx` when both exist at the same level |
| `components/DoctorDetailsTabs/CredentialsTab/index.tsx` | 305 | New wrapper around `AddCredentialDialog` + `DynamicCredentialForm` + `CredentialInputField` + `CredentialsGroupedList` | Probably dead but cannot confirm without runtime trace |
| `pages/doctor/DoctorProfilePage/components/CredentialsManager.tsx` | 428 | Simplest of the three — no `data_type` branching, single flat form. Doctor-facing. | **Live** — used in `/doctor/profile` |

**Implication:** Phase A must include a `git grep -r "from './CredentialsTab'" src/` audit to confirm which file resolves first. The migration target's data-type matrix depends on which legacy survives. Recommended pre-flight: **delete the loser** before any visual work.

### 1.2 Two parallel `DoctorDetailsModal` files

| File | Used from | Tabs |
|---|---|---|
| `components/DoctorDetailsTabs/DoctorDetailsModal.tsx` | Hospital Profile → Doctors tab → "View Details" | Personal Info · Hospital Assignment · Credentials |
| `pages/superadmin/HospitalDetailsPage/components/DoctorDetailsModal.tsx` | Super-admin Hospital Details page → doctor row click | Details · Documents |

**Both are live** — different paths trigger different modals. The migration must visually upgrade **both**, OR consolidate first. Recommended: keep both for migration, treat consolidation as a follow-up (TECH_DEBT P2-5).

### 1.3 Two parallel `AddDoctor` flows

| File | Fields | Backend call |
|---|---|---|
| `pages/superadmin/HospitalDetailsPage/components/AddDoctorModal.tsx` | `firstName, lastName, age, phone, speciality, yearsOfExp` | parent's `onSubmit` |
| `pages/hospital/Profile/components/DoctorsManager.tsx` → inline `AddDoctorForm` | Search mode OR Create mode (first/last/email/phone/primary_specialization/nmc_registration_number) | `POST /hospitals/:id/doctors` (link existing) or `POST /hospitals/:id/doctors/create` |

The field sets are **incompatible**. Migration cannot use one shared modal. Both surfaces stay distinct.

### 1.4 Two parallel `AddPatient` flows

| File | Fields | Notes |
|---|---|---|
| `components/modals/PatientModal.tsx` | hospital (admin-conditional select), firstName, lastName, phone (non-hospital conditional), admittedAt | Used inside hospital portal, panel-details page |
| `pages/superadmin/HospitalDetailsPage/components/AddPatientModal.tsx` | firstName, lastName, **admissionType** (conservative/surgical), admittedAt | Thin wrapper — phone field absent here despite present in state |

Two completely different field sets. Migration target: each preserves its current shape exactly.

### 1.5 `PatientPhotosModal` is actually a 3-tab modal — wireframes only show 1 tab

Today the modal has **three tabs**: Files (photos + categories), **IPD Details** (read-only patient meta), **Claims** (8 financial fields with edit). The Claims tab is the **only place** in the app where these claim fields are editable:

- `treatmentPlan` (textarea), `latestStatus` (text), `claimAmount`, `claimApproved`, `incentive`, `deduction`, `deductionReason` (text), `claimSettled`, `claimSettledDate`

**The wireframes' Patient Detail page proposed a separate Claim tab page** — that's a new surface. **Reality: claim editing happens in this modal.** Migration must preserve this 3-tab modal exactly. Wireframe's Patient Detail page is deferred.

### 1.6 `PublicHospitalProfile` is structured as TWO TABS — wireframe is single-page

Today: `Profile Details` tab + `Certifications & Documents` tab. Plus a sticky action bar with **Copy JSON** and **Download JSON** (not PDF — there is no PDF generator). Plus a verified-badge hero banner. Plus a Banking Details section. Plus a Key Contacts section.

Wireframe shows none of these as tabs and proposed "Download profile PDF". **Re-target the wireframe to match the real two-tab structure.**

### 1.7 `PublicSharingManager` (hospital) has a 2-field create dialog

Wireframe M22 shows audience-label + expiry + max-views + 6-section-visibility-checkboxes + auto-enable toggle. **Real form has 2 fields**: `description` + `expiresAt`. Migration must cut M22 to those 2 fields.

### 1.8 `HospitalProfile / Attributes` has FIVE dialogs, not three

- Add
- Edit
- **Verify** (method enum: manual/document/image/automated + notes textarea)
- Delete
- FilePreview

Wireframes show Add+Edit only. **Verify dialog must be preserved** — it's the path that flips an attribute from pending → verified.

### 1.9 `HospitalAttributeDefinitions` has more fields than I mocked

Beyond `key/label/category/data_type/description/sort_order/is_active`, real definitions carry:

- `unit` (text — used as suffix for `integer` data type)
- `is_mandatory_basic`, `is_mandatory_empanelment` (checkboxes)
- `can_verify_by_image` (checkbox)
- `expected_issuing_authority` (text)
- `image_guidance` (textarea — conditional on `can_verify_by_image`)
- `requires_document`, `has_expiry` (checkboxes — already in wireframe)

Plus: **async key uniqueness validation** via `POST /admin/attribute-definitions/validate-key`, and **status badge is click-to-toggle** (not a separate button). DELETE returns 422 with a hint to use deactivate.

### 1.10 `PanelAttributeDefinitions` has 12 data types

Real list: `text`, `textarea`, `email`, `phone`, `url`, `date`, `boolean`, `single_select` (with `options` Record), `multi_select`, `file`, `json`, `encrypted_text`. Plus `validation_regex`, `validation_min_length`, `validation_max_length`, `is_unique`, `default_value`. My wireframe assumed 7. Migration target: preserve all 12 data_types and all validation fields.

### 1.11 `PanelDetails` (per-panel patient page) uses **patient-status** filters, NOT claim-status

Tabs: All / **Active** (default) / Admitted / Discharged / Deactivated. Counts come from `getTabCounts(hospitalId, panelId, search)`. These filter by `patient.is_active` and `patient.discharged_at`, **not** by `claims.latest_status`.

Wireframe shows 8-pill claim-status filter. **Wrong target.** Migration must keep the 5-tab patient-status filter.

### 1.12 `HospitalDashboard` (portal) has 3 stat cards + 2 operations cards — wireframe shows pipeline visual

Real layout:
- 3 stat cards: Total Panels, Total Patients (sum), Hospital Users
- HospitalOperationsCard (2 sub-cards):
  - **Profile Management** card: verification status, attribute count, document count, "Manage Profile" + "View Docs" buttons
  - **Public Sharing** card: active_shares, total_views, last_viewed, "Manage Shares" + "Directory" buttons

No pipeline visual. No "Needs attention" feed. **Migration target = the 3 cards + 2 ops cards.**

### 1.13 `RegisterDoctor` has 11 fields, dual POST, 2-second redirect

Fields: `first_name, last_name, email, phone, primary_specialization (15-option select), nmc_registration_number, state_registration_number, username, password, confirmPassword, agreeToTerms`.

Password regex: 8+ chars, uppercase, lowercase, digit, special. Submit fires `POST /auth/signup` **then** `POST /doctors`, then 2-second delay before navigating to `/doctor/profile`. Plus a fetch to `/admin/doctor-attributes/definitions?category=qualifications` whose result is discarded — dead code worth removing.

Wireframe has 8 fields. **Re-target wireframe.**

### 1.14 Hidden routing bug to fix during migration

`pages/doctors/DoctorDirectory.tsx:149` — doctor card click navigates to `/public-profile/<token>` (the **hospital** share route). Should be `/public-doctor/<token>`. This bug exists today. Fix as part of the directory PR.

### 1.15 Dead code in the Profile tabs

`DocumentsManager.tsx` (455 LOC) and `VerificationDashboard.tsx` (337 LOC) exist in `pages/hospital/Profile/components/` but are **not mounted** in the Profile page's `<Tabs>` strip. The Profile page renders only the 5 tabs: Profile, Attributes, Panels, Doctors, Sharing.

`HospitalOperationsCard` has a "View Docs" button that navigates to `/portal/:hospitalId/profile?tab=documents` but the receiving page **never reads `searchParams`** — so that link is silently dead.

**Decision required before migration:** delete both files (with the `?tab=documents` query support) OR wire them in. Recommend **delete** — they don't exist in the real-app UX today.

### 1.16 `MasterPanelManagement` Details button is dead

Each row in master panels has a "Details" button with **no `onClick` handler**. Click does nothing. Migration target: remove the button (it's not a feature) OR wire it to a panel-detail screen. Recommend **remove** — there's no panel-detail page.

---

## 2. Surface-by-surface comparison

Format per surface: **Current** column lists every field/column/action found in the source. **Wireframe target** lists what the wireframe shows (`ui-revamp/wireframes.html`). **Δ** lists explicit deltas in either direction. **Migration call** is the final spec for the PR.

### 2.1 `LoginPage.tsx` (110 LOC)

| Aspect | Current | Wireframe (`screen-login`) | Δ | Migration call |
|---|---|---|---|---|
| Route | `/login` | same | — | — |
| Fields | username (req), password (req) | same + "Forgot?" link | wireframe adds a Forgot link that has no backend | **Drop the Forgot link** |
| Submit | `apiService.login` → role-based redirect | same | — | preserve as-is |
| Doctor link | none | "Doctor? Self-register" footer link | wireframe adds | Add the link — it's a real path |
| Styling | raw `Login.css` | shadcn Card | — | Delete `styles/Login.css` |

**PR scope:** Single-file swap. ~80 lines. No backend touch.

### 2.2 `RegisterDoctor.tsx` (~445 LOC)

| Aspect | Current | Wireframe (`dr-register`) | Δ | Migration call |
|---|---|---|---|---|
| Route | `/register/doctor` | same | — | — |
| Fields | 11: first_name, last_name, email, phone (optional), primary_specialization (15 hardcoded options), nmc_registration_number, state_registration_number, username, password, confirmPassword, agreeToTerms | 8 fields | wireframe **missing: confirmPassword, agreeToTerms, state_registration, username** | **Re-target wireframe** to all 11 |
| Password rules | 8+ chars, uppercase+lowercase+digit+special | not visible | wireframe missing helper text | Add inline hint under password field |
| Specialization options | hardcoded 15 (Cardiology…Gastroenterology) | hardcoded subset in wireframe | match casing exactly | use the 15-item array verbatim |
| Submit | dual POST: `/auth/signup` then `/doctors`, 2-sec delay → `/doctor/profile` | same flow | — | preserve. Remove the dead `GET /admin/doctor-attributes/definitions?category=qualifications` call (whose result is discarded) |
| Sign-in link | yes | yes | — | preserve |
| Back to Home | yes (`/`) | not in wireframe | wireframe missing | Add small "Back" link |

**PR scope:** Single-file rewrite. Strict field preservation. ~445 → ~250 lines.

### 2.3 `SuperAdminPage.tsx` (603 LOC) — Dashboard tab

| Aspect | Current | Wireframe (`sa-dashboard`) | Δ | Migration call |
|---|---|---|---|---|
| KPI cards | 4: Total Hospitals, Total Patients, Active Patients, Total Admins | same 4 + 3 "secondary" KPIs (Pending verification, Expiring <30d, Settled this week) | wireframe adds 3 KPIs needing aggregations that don't exist | **Drop secondary KPIs** — keep only the 4 |
| Recent Activity | exists, real-data from `stats.recentActivity` | same | — | preserve |
| System Health card | 4 metrics (Database, Uptime, Memory, CPU) | replaced with "Hospital health" rollup table | wireframe adds hospital-health rollup that needs aggregation; drops system health | **Keep System Health, drop the hospital-health rollup** |
| "Needs attention" feed | absent | present | wireframe-only | **Drop** |
| "Quick actions" panel | "Add Hospital" + "Add Admin" buttons inside System Health card | replaced with quick-action panel | overlap | **Keep current 2 buttons inline; drop separate panel** |

### 2.4 `SuperAdminPage.tsx` — Admin Users tab

| Aspect | Current | Wireframe (`sa-admins`) | Δ | Migration call |
|---|---|---|---|---|
| Columns | User (first_name+last_name+email), Username (Badge), Contact (phone), Actions | User, Contact, Hospitals assigned (chips), Permissions (chips), Last seen, Status, Actions | wireframe adds: hospitals-assigned chips, permission chips, last-seen, status | **Drop**: hospitals chips, permission chips, last-seen, status. Real columns: User + Username + Contact + Actions only |
| Row click | opens AssignmentModal | same | — | preserve |
| Toolbar | search ("Search admins..."), Add Admin button | same | — | preserve |
| Empty state | "No results found." | "Invited" pending state in wireframe | invited state isn't real | **Drop invited state** |

### 2.5 `SuperAdminPage.tsx` — Hospitals tab

| Aspect | Current | Wireframe (`sa-hospitals`) | Δ | Migration call |
|---|---|---|---|---|
| Columns | Hospital (avatar + name), City, **Panels** (sortable, we shipped), **Patients** (sortable, we shipped), Actions | Hospital, City, Profile %, Panels, Admitted, Patients (wk), Health, Public | wireframe adds 4 columns needing aggregations | **Drop Profile %, Admitted, Patients (wk), Health, Public**. Keep 4 real columns. |
| Row click | navigate `/hospital/:id` with state | same | — | preserve |
| Toolbar | search, Add Hospital button | same + "Export CSV" | export not in current | **Drop Export CSV** |
| Saved views | absent | present | not in current | **Drop** |

### 2.6 `SuperAdminPage.tsx` — Master Panels tab → `MasterPanelManagement.tsx`

| Aspect | Current | Wireframe (`sa-master-panels`) | Δ | Migration call |
|---|---|---|---|---|
| Columns | Panel Name (avatar + name), Created Date, Action ("Details" button — **dead, no onClick**) | Panel, Type, Hospitals linked, Active patients, Settled rate | wireframe adds 4 metric columns | **Drop all 4 metric columns**. Real: name + created date only |
| Action button | "Details" — dead | "⋯" | "Details" is dead | **Remove the Details button entirely** (or make it open the master-panel edit dialog if we want — but there isn't one today) |
| Toolbar | search inherited from parent (no buttons) | search + Type filter dropdown + "Add Master Panel" button | type filter doesn't exist; Add button is in SuperAdminPage parent already | **Drop Type filter**. Keep parent's existing Add button. |

### 2.7 `SuperAdminPage.tsx` — Hospital/Panel/Doctor Attributes tabs (3 distinct managers)

**Hospital Attribute Definitions** (`HospitalAttributeDefinitionsManager.tsx`)

| Aspect | Current | Wireframe (`sa-attributes` entity=hospital) | Δ | Migration call |
|---|---|---|---|---|
| List columns | Key (mono), Label, Category, Data Type, Status (clickable badge), Actions | Key, Label, Data type, Required, Expires, Doc?, Status, Actions | wireframe missing: Category. wireframe adds: Required/Expires/Doc as separate columns (these are flags in current that affect form, not list columns) | **Drop the 3 flag columns from wireframe.** Real columns: Key + Label + Category + Data Type + Status + Actions |
| Filters | Category select + Data Type select | chip row | — | replace chip row with 2 selects (matches current) |
| Add/Edit dialog fields | key (regex `^[a-z0-9_]+\.[a-z0-9_]+(\.[a-z0-9_]+)?$`, async-unique, disabled-on-edit), label, category (dynamic select), **data_type (5 options: boolean/integer/text/date/document)**, description (textarea), **unit, requires_document, has_expiry, can_verify_by_image, expected_issuing_authority, image_guidance (textarea, conditional), is_mandatory_basic, is_mandatory_empanelment**, sort_order, is_active | key, label, description (textarea), category, data_type (7 in wireframe), required, has_expiry, requires_document, auto_verifiable, sort_order | wireframe **missing: unit, can_verify_by_image, expected_issuing_authority, image_guidance, is_mandatory_basic, is_mandatory_empanelment**. wireframe **extra: auto_verifiable** (which is a doctor-attribute flag, not hospital) | **Add 6 missing fields to wireframe. Drop auto_verifiable from hospital target.** Re-target data_type options to 5: boolean/integer/text/date/document |
| Status toggle | click the Status badge directly | requires separate action | UX divergence | **Keep status as a click-to-toggle badge** (existing pattern) |
| Delete behaviour | DELETE returns 422 with "use deactivate" hint | wireframe shows simple confirm | — | Preserve toast handling of 422 |
| API calls | `validate-key`, full CRUD, `/activate`, `/deactivate` | wireframe doesn't show these | — | preserve |

**Panel Attribute Definitions** (`PanelAttributeDefinitionsManager.tsx`)

| Aspect | Current | Wireframe | Δ | Migration call |
|---|---|---|---|---|
| Add/Edit dialog fields | key (regex `^[a-z0-9_]+$`, no dots, async-unique), label, category (5: portal/credential/contact/document/operational), **data_type (12: text, textarea, email, phone, url, date, boolean, single_select, multi_select, file, json, encrypted_text)**, description, **options (key/label pairs for select types)**, **validation_regex, validation_min_length, validation_max_length, is_required, is_unique, default_value**, sort_order, is_active | same form as hospital — wireframe doesn't differentiate | **Major delta**: 12 data types, options builder, 3 validation fields, is_unique, default_value | **Implement all 12 data types + options builder + validation fields. Wireframe must be re-spec'd.** |
| Activation toggle | click badge | — | — | preserve |

**Doctor Attribute Definitions** (`DoctorAttributeDefinitionsManager.tsx`)

| Aspect | Current | Wireframe | Δ | Migration call |
|---|---|---|---|---|
| Add/Edit dialog fields | key (regex), label, category (5: qualifications/licenses/registrations/compliance/experience), description (**single-line Input, NOT textarea**), data_type (4: text/date/boolean/document), is_required, **has_expiry, requires_document, can_verify_by_document, requires_validator_verification, auto_verifiable, verification_url_pattern (conditional)**, sort_order, **category_sort_order** | wireframe shows generic attr form | wireframe missing 6 doctor-specific fields | **Add 6 missing fields**. Description stays single-line Input. |
| List columns | Key, Label, Category, Data Type, **Config** (3 mini-badges: Expiry/Doc/Verify), Status, Actions | same minus Config | **Preserve Config column** |
| Delete | semantically a "deactivate" via DELETE endpoint | wireframe doesn't reflect | — | preserve |

### 2.8 `MasterOptionsManager` (3 modals: Create/Edit/Delete)

| Surface | Current | Wireframe (M17, M18) | Δ | Migration call |
|---|---|---|---|---|
| Top page | Category selector (dynamic) + Search input + "Create Option" button | chip row + search + Add | — | replace category select with chip row (matches wireframe) |
| List columns | Label, Code (Badge), Description (truncated), Order, Status, Actions | same | — | preserve |
| Create form | code (regex `^[a-z0-9_]+$`, helper, placeholder), label, description (textarea), sort_order (default 999, min 0 max 9999) | same | — | preserve |
| Edit form | code (read-only), label, description, sort_order, **is_active** checkbox, **Created/Updated dates display block** | wireframe missing dates display | **Add dates display** |
| Delete dialog | shows Label, Code, Category, Description + warning banner about re-creating | wireframe shows simple confirm | wireframe under-specified | **Preserve full info display** |

### 2.9 `HospitalDetailsPage.tsx` (legacy SA view)

| Aspect | Current | Wireframe | Δ | Migration call |
|---|---|---|---|---|
| Route | `/hospital/:hospitalId` | wireframe doesn't have a direct equivalent; this is part of legacy that wireframe defers | — | **Keep route intact**. Re-skin the existing 2-tab page with new tokens. |
| Tabs | **Linked Panels** + **Users** (only 2) | wireframe Configuration mode has 6 tabs | wireframe IA reorg is deferred | **Migration target: keep 2 tabs**. Use `screen-sa-hospitals` row pattern for the embedded panels list, `hw-users` pattern for the users list |
| "Hospital Profile Configuration" button | navigates `/portal/:hospitalId/profile` | wireframe doesn't show | — | **Preserve the button** — it's a real cross-link |
| Breadcrumb | yes | yes | — | preserve |

### 2.10 `HospitalPortalLayout.tsx` (the new portal shell)

| Aspect | Current | Wireframe | Δ | Migration call |
|---|---|---|---|---|
| Sidebar items | Dashboard, Select Panel, Users (admin-only), Sign out | wireframe has different items per role | — | preserve current 4 items |
| Sidebar visibility | hidden on `/panel/` and `/profile` routes | wireframe always shows | — | preserve hide-behaviour |
| Mobile menu | `Sheet` imported but no trigger rendered | wireframe shows hamburger | dead code | **Keep dead code dead** — don't add a mobile trigger as part of this migration |

### 2.11 `HospitalDashboard.tsx` (portal index)

| Aspect | Current | Wireframe (`hw-overview`) | Δ | Migration call |
|---|---|---|---|---|
| Stat cards | 3: Total Panels (clickable), Total Patients (sum, not clickable), Hospital Users (admin-only, clickable) | 4 KPI cards (Admitted, In pre-auth, Settled wk, Doctors) + Patient pipeline visual + Needs attention + Top panels | massive mismatch — wireframe assumed status pipeline | **Re-target wireframe to the 3 real cards** |
| Operations card | Profile Management sub-card + Public Sharing sub-card with concrete metrics | not in wireframe | — | **Add to wireframe target** |
| Patient pipeline | none | 5-stage horizontal visual | not real | **Drop** |
| Needs attention | none | feed | not real | **Drop** |
| Top panels by volume | none | table | not real | **Drop** |

### 2.12 `pages/hospital/Panels/index.tsx`

| Aspect | Current | Wireframe (`hw-panels`) | Δ | Migration call |
|---|---|---|---|---|
| Renders | `PanelsList` (SA component reused) | same | — | preserve |
| Action | onPanelSelect → navigate `/portal/:id/panel/:panelId` | same | — | preserve |
| Link panel button | passed but no-op | wireframe shows working "Link panel" | the hospital portal can't link panels today | **Drop "Link panel" button from the portal version of this page** |

### 2.13 `pages/hospital/PanelDetails/index.tsx`

| Aspect | Current | Wireframe (`hw-patients`) | Δ | Migration call |
|---|---|---|---|---|
| Route | `/portal/:hospitalId/panel/:panelId` | wireframe is hospital-wide patients | wireframe assumed unified hospital-wide list; reality is per-panel | **Migration target: per-panel list (preserve route)** |
| Header | back arrow + panel name + "Patient Management" subtitle | wireframe has tabs + KPIs | — | replace with simple header |
| Toolbar | search ("Search patients..."), Refresh, "Add Patient" (admin permission gated) | same | — | preserve |
| Status filter tabs | All / **Active (default)** / Admitted / Discharged / Deactivated — these are **patient-status**, NOT claim-status | wireframe shows claim-status pills | wrong target | **Use the 5-tab patient-status filter** |
| Patient table | `PatientTable` with hideActions=true, hideGeneratePdf=true | wireframe has Status column, Docs column, Last action column | — | **Drop wireframe's extra columns**. Real columns: Patient (via PatientRow), Last Updated, Admitted On, Type, Status |
| Patient row click | opens `PatientPhotosModal` | wireframe goes to detail page | wrong target | **Keep modal-open behaviour** — no detail page exists |
| Inline modals | PatientModal, PatientPhotosModal | — | — | preserve |

### 2.14 `pages/hospital/Users/index.tsx` + `HospitalUserList.tsx`

| Aspect | Current | Wireframe (`hw-users`) | Δ | Migration call |
|---|---|---|---|---|
| Columns | User (width 300px), Contact, Username, Role, Status (managers only) | User, Contact, Panel access chips, Role flags, Last sign-in, Status toggle | wireframe adds: panel-access chips, role flags, last sign-in | **Drop**: panel chips column (the role IS the panel list — already shown), role flags column, last sign-in column. **Real columns**: User + Contact + Username + Role + Status |
| Search | yes | yes | — | preserve |
| Refresh | yes | not in wireframe | — | add to wireframe |
| Add New User | role-gated (`canAddPatient` — name is misleading, it's the same permission) | yes | — | preserve |
| Edit Roles dialog | **exclusive "Admin" switch** that clears panel checkboxes, search input, scrollable panel list, Select All | wireframe matches | — | preserve exclusivity logic exactly |
| Status toggle | calls `toggleUserStatus` | toggle switch | — | preserve |

### 2.15 `pages/hospital/Profile/index.tsx` — 5 sub-tabs

**Profile sub-tab** → `ProfileForm.tsx` (577 LOC)

| Aspect | Current | Wireframe (`hw-hospital-profile`) | Δ | Migration call |
|---|---|---|---|---|
| Sections | 6: Basic / Address / Contact / Registration / Specialties / Banking | 4: Identity / Location / Primary contacts / Banking | wireframe missing: Registration & Govt IDs section + Specialties section | **Add the 2 missing sections** |
| Fields | 21 total, listed in §1 above | ~12 in wireframe | wireframe missing 9 fields | **Add all 9 missing fields**: `rohini_id, hfr_id, pan_number, gst_number, established_year, specialties (multi-select), district, cheque_payable_name, bank_address, pan_name` |
| Account type | native select with 3 options (savings/current/nri) | text input in wireframe | wrong | **Use native select with 3 options** |
| ifsc_code | maxLength 11 | not enforced in wireframe | — | preserve |
| micr_code | maxLength 9 | not in wireframe | — | preserve |
| Edit mode | "Edit Profile" toggle button, all fields disabled until edit | wireframe shows always-editable | divergence | **Preserve the view-then-edit pattern** |
| Numeric coercion | `'beds'`/`'total'` fields parsed as int | not in wireframe | — | preserve |
| Save / Cancel | shows success card 3s + spinner | — | preserve |

**Attributes sub-tab** → `AttributesManager.tsx` (1470 LOC)

| Aspect | Current | Wireframe (`hw-profile`) | Δ | Migration call |
|---|---|---|---|---|
| Layout | "Add Attribute" + dynamic category filter buttons + per-attribute cards | chip row + table | structural divergence | **Keep cards, NOT table** — the current per-card layout is information-dense and works; converting to table would lose document grids and certificate details |
| Per-attribute display | Heading, description, status badge (verified/rejected/pending), value (renderAttributeValue), Certificate Details sub-section, Documents sub-section, Verification metadata | table row | wireframe oversimplified | **Preserve full card layout** |
| Add dialog | dynamic input by data_type (boolean select / integer with unit / date / document upload with cert#+issued+expires+issuing authority) + document multi-upload + image guidance banner (conditional) | wireframe shows generic form | — | **Preserve all data-type branches** |
| Edit dialog | same as Add + existing documents list with per-doc remove (trash + confirm) | not in wireframe | — | preserve |
| **Verify dialog** | method enum select (manual/document/image/automated) + notes textarea | **MISSING** | wireframe missing entirely | **Add Verify dialog** |
| Delete dialog | simple confirm | M25 destructive confirm pattern | — | preserve |
| File preview | FilePreviewModal | M23 | — | preserve |
| Categories | dynamic from `definitions.map(d.category)` | hardcoded chip set in wireframe | dynamic is correct | **Use dynamic categories** |

**Panels sub-tab** → `PanelsManager.tsx` (1689 LOC)

| Aspect | Current | Wireframe (`hw-panels`) | Δ | Migration call |
|---|---|---|---|---|
| Sub-tabs | Overview + Configure (already shipped) | same | — | preserve |
| Configure: panel selector | native `<select>` of linked panels | wireframe says dropdown | — | preserve |
| Configure: category filter | dynamic chip row | dynamic chip row | — | preserve |
| Add dialog: data_type input branches | 12 types: text, textarea, email, phone, url, date, boolean, single_select (with options from definition), file (multi-upload), encrypted_text (password input + helper "will be encrypted"), json, default | wireframe shows simpler form | wireframe missing 7 branches | **Implement all 12 branches** |
| Edit dialog: docs management | per-doc Star/preview/delete with `deletedDocumentIds` local state | wireframe doesn't show | — | preserve |
| Delete dialog | simple confirm | M25 | — | preserve |
| File preview | FilePreviewModal | M23 | — | preserve |
| `value_encrypted` | stored as plaintext in `value_encrypted` column (TECH_DEBT P1-17a) | wireframe shows masked + reveal + copy | — | **Preserve current behaviour** — DON'T change storage. Wireframe shows the future state, but in migration just render password input as today. |

**Doctors sub-tab** → `DoctorsManager.tsx` (633 LOC)

| Aspect | Current | Wireframe (`hw-doctors`) | Δ | Migration call |
|---|---|---|---|---|
| List | per-doctor cards (avatar, name, email, employment_type, department, designation, status, start_date, hospital_email, primary_specialization badge) | wireframe shows table with expand-row | structural divergence | **Decision: keep cards** (information density is high — table forces truncation) OR convert to table. **Recommend: keep cards for migration**, convert later. |
| Actions | View Details (opens `DoctorDetailsModal` — new tabbed one) + Remove (AlertDialog) | wireframe matches | — | preserve |
| Add doctor dialog | **Search Existing** mode + **Create New** mode (toggle button at top) | wireframe shows "Lookup by NMC #" affordance | semantics close, fields different | **Implement the 2-mode toggle exactly as today** |
| Create New fields | first_name, last_name, email, phone, primary_specialization (15-option dropdown with API fallback to hardcoded), nmc_registration_number | wireframe matches | — | preserve |
| Specializations | fetched from `/specializations` with hardcoded fallback | hardcoded in wireframe | — | preserve fetch + fallback |

**Sharing sub-tab** → `PublicSharingManager.tsx` (391 LOC)

| Aspect | Current | Wireframe (`hw-sharing`) | Δ | Migration call |
|---|---|---|---|---|
| Header | "Create Share Link" button | "+ Generate share link" | — | preserve |
| Per-share-link card | URL Input (read-only) + Copy, Created, Views (Eye icon), Expiration status chip (gray/yellow/red based on days), Last viewed, Preview, Revoke | wireframe shows table | structural divergence | **Keep cards** — more informative for a small list |
| Create dialog | **2 fields**: `description`, `expiresAt` + info banner | wireframe M22 has audience, max views, sections-visible checkboxes, auto-enable toggle | wireframe massively over-specified | **Cut M22 to 2 fields exactly** |
| Revoke dialog | AlertDialog | M25 pattern | — | preserve |
| Expiration computation | `getExpirationStatus` helper | not specced | — | preserve |
| Empty state | "No share links created yet" | — | preserve |
| No visibility toggle | — | wireframe shows toggle | **doctor's** sharing manager has a visibility toggle, hospital's doesn't | **Drop visibility toggle from hospital sharing wireframe** |
| KPI tiles (Total views 30d, Last viewed) | not present | wireframe shows them | new aggregation | **Drop** |

### 2.16 `pages/doctor/DoctorProfilePage/index.tsx` — 4 sub-tabs

**Profile** → `ProfileForm.tsx` (229 LOC)
| Fields | first_name, last_name, email, phone, primary_specialization (text Input, NOT select), nmc_registration_number, state_registration_number |
| Δ vs wireframe | wireframe shows specialization as select; **real is plain text input** for the doctor's own profile form |
| Migration call | preserve as plain text input |

**Credentials** → `CredentialsManager.tsx` (428 LOC)
| Add dialog fields | attribute_key (select), value_text, certificate_number, issuing_authority, issued_at, expires_at — **no data_type branching** |
| List grouping | by category (capitalized title) |
| Status badge mapping | `verified|verified_by_doc|auto_verified` → green; `pending_review` → yellow; `expired` → orange; `rejected` → red |
| Delete | AlertDialog |
| Migration call | preserve flat form. Status mapping must be preserved exactly. |

**Hospitals** → `HospitalAffiliations.tsx` (189 LOC)
| Fields displayed | hospital name, location, status, designation, department, specialization, employment_type, since (start_date), until (end_date conditional) |
| **Read-only** | yes |
| Migration call | preserve. Cards layout in wireframe is acceptable. |

**Public Profile** → `PublicSharingManager.tsx` (315 LOC)
| Sections | Visibility (toggle) + Share Links (generate/list with Copy/Revoke) + Privacy notice |
| Visibility toggle backend | `PUT /doctors/:id` with `is_public_profile_enabled` |
| Generate dialog | uses `POST /doctors/:id/share-links` with `{ expiresInDays: null }` (no input dialog — direct generate) |
| Migration call | wireframe needs **no generate dialog** for doctor (just an instant "Generate" button) + visibility toggle. Match the current behaviour. |

### 2.17 Modals — exhaustive field-by-field

#### M1 / M2 — `AddUserModal` (~295 LOC)

| Field | Real | Wireframe | Δ |
|---|---|---|---|
| firstName | text, required | ✓ | — |
| lastName | text, optional | ✓ | — |
| userName | text, required | ✓ | — |
| passWord | password, required | ✓ | — |
| email | email, optional | ✓ | — |
| phone | tel, **required** | tel | ✓ |
| userRole (panels) | conditional on `role === 'hospital'`; checkbox list with search + select-all/clear (shipped) | ✓ | — |

**Title:** "Add New Admin" or "Add New Hospital User" — preserve dynamic title.

#### M3 — `AssignmentModal` (157 LOC)

| Aspect | Real | Wireframe | Δ |
|---|---|---|---|
| UI | hospital cards, click-to-toggle (multi-select) | dropdown select + permission checkboxes | **completely different UI** |
| Default permissions on assign | canView=true, canEdit=true, canDischarge=true (no UI for them!) | shows the 3 checkboxes | **Real has no permission UI — defaults all to true** |
| API | `assignHospitalToAdmin` per added, `removeHospitalAssignment` per removed | — | preserve |

**Migration call:** Replace M3 entirely with the card-toggle UI from the current modal. **Drop the 3 permission checkboxes** — they're not a feature today (defaults are hardcoded). If the team wants those checkboxes, that's a new feature → defer.

#### M5 — `AddHospitalModal` (110 LOC)

| Field | Real | Wireframe | Δ |
|---|---|---|---|
| name | text, required | ✓ | — |
| city | text, optional | ✓ | — |
| driveFolderId | text, optional, with helper "Leave empty to auto-create" | ✓ | — |
| state | — | wireframe adds | **Drop** |
| Hospital type | — | wireframe adds (select) | **Drop** |
| Tagline | — | wireframe adds | **Drop** |

**Migration call:** 3 fields only.

#### M6 — `AddPanelModal` (84 LOC)

| Field | Real | Wireframe | Δ |
|---|---|---|---|
| panelName | text, required, autofocus | ✓ | — |
| Type | — | wireframe adds | **Drop** |
| Short code | — | wireframe adds | **Drop** |

**Migration call:** 1 field only.

#### M7 — `LinkPanelModal` (250 LOC)

| Field | Real | Wireframe | Δ |
|---|---|---|---|
| selectedPanelId | native select, required | wireframe shows multi-select checkbox list | wrong |
| Inline "Create new panel" toggle | yes | not in wireframe | — |
| newPanelName | text, conditional | not in wireframe | — |
| contact | tel, maxLength 10 | not in wireframe | — |
| sheetId | text | not in wireframe | — |
| sheetName | text | not in wireframe | — |
| whatsAppGroupId | text | not in wireframe | — |

**Migration call:** Re-target M7 entirely — it's **single-panel select + inline create + 4 optional config fields**, not a multi-select list as wireframe shows.

#### M9 — `PatientModal` (204 LOC)

| Field | Real | Wireframe | Δ |
|---|---|---|---|
| hospital | conditional select (admin + creating new) | not in wireframe | **Add** |
| firstName | text, required | ✓ | — |
| lastName | text, optional | ✓ | — |
| phone | tel, required (non-hospital only) | ✓ | — |
| admittedAt | date, default today | ✓ | — |
| age, gender, panel, beneficiaryId, bedType, treating doctor, notes | — | all in wireframe | **Drop all 7** |

**Migration call:** PatientModal has only 5 fields (hospital conditional, first, last, phone conditional, admittedAt). Drop everything else from M9.

#### M9-alt — `AddPatientModal` (SA path, 102 LOC)

| Field | Real | Δ vs M9 | Notes |
|---|---|---|---|
| firstName | required | shared | — |
| lastName | optional | shared | — |
| admissionType | select (conservative/surgical) | **only in this modal** | preserve |
| admittedAt | date | shared | — |
| phone | exists in state but not rendered | — | dead state field — leave for cleanup later |

**Migration call:** This modal exists as a separate variant. Preserve.

#### M12 — `PatientPhotosModal/index.tsx` (584 LOC) — **3-TAB MODAL**

| Tab | Surface | Fields |
|---|---|---|
| Files (default) | photo grid + categories + select-mode actions (Select All / Deselect / Delete / Download / Generate PDF) + upload FAB | `accept="image/*,application/pdf"` multiple |
| IPD Details | RHF + zod form | phone, beneficiaryId, admissionType, admitted_at (disabled), discharged_at (disabled), is_active (disabled), panel_name (disabled) |
| Claims | RHF + zod form | treatmentPlan (textarea), latestStatus (text), claimAmount (number), claimApproved (number), incentive (number), deduction (number), deductionReason (text), claimSettled (number), claimSettledDate (date) |

**Tabs only render if `onUpdate` prop is provided.**

**Migration call:** **Critical — preserve all 3 tabs**. Wireframe shows only the lightbox + grid (Files tab). Add IPD Details and Claims tabs as-spec'd. Use `FlexibleDialogContent`.

#### Lightbox (503 LOC)

| Feature | Real | Migration |
|---|---|---|
| Keyboard nav | Arrow keys, +/-/0, Escape | preserve |
| Wheel pinch zoom | yes (range 1-3, step 0.25) | preserve |
| Drag to pan | when zoomed | preserve |
| PDF rendering | react-pdf with proxy auth Bearer header | preserve |
| Top right | Open original, Download, Close | preserve |
| Bottom controls | Page indicator (PDF), Zoom -/Reset/+ | preserve |

#### M19 — Doctor add — TWO DIFFERENT MODALS

**Path A:** `AddDoctorModal.tsx` (SA legacy) — fields: firstName, lastName, age, phone (10-digit), speciality (text!), yearsOfExp
**Path B:** `DoctorsManager.tsx` inline form (hospital portal) — fields: first_name, last_name, email, phone, primary_specialization (15-option select), nmc_registration_number — with **Search Existing** mode too

**Migration call:** **Treat as two separate modals**. Don't try to merge. Each preserves its own fields exactly.

#### M20 — Add Credential (THREE implementations exist)

| Implementation | Used from | data_type branching | Cert fields |
|---|---|---|---|
| Legacy `CredentialsTab.tsx` (1036 LOC) | DoctorDetailsModal (via `./CredentialsTab` import) — **likely live** | text/date/boolean (radio)/textarea/document | conditional on lowercase `category === 'licenses' \|\| 'qualifications'` |
| New `CredentialsTab/` folder (DynamicCredentialForm) | imported but probably not resolved | text/date/boolean (radio)/textarea (no document branch — handled by parent) | conditional on capitalized `['Licenses', 'Qualifications', 'Registrations']` |
| Doctor's own `CredentialsManager.tsx` | `/doctor/profile` Credentials tab | **none** — flat form always | always shown |

**Migration call:** **Pre-flight gate** — resolve which legacy is live (grep, test) **before** Phase A. Wireframe M20 must match whichever survives. Recommend: keep legacy `CredentialsTab.tsx`, **delete the folder**.

`single_select` and `encrypted_text` data types are **NOT supported** in any credential form. The migration **must not add support** — log as TECH_DEBT.

#### M21 — `DoctorDocsModal` (132 LOC)

| Aspect | Real | Wireframe | Δ |
|---|---|---|---|
| Pickers | hidden file input + Browse Files button | drag-drop zone | wireframe more elaborate |
| Per-file row | filename + size KB (FileText) + remove (X) + **rename field** (Document Name / Type — defaults to filename) | wireframe shows simpler list | wireframe missing rename |
| API | parent's `onUpload(files, customNames)` → `uploadDoctorDocs` | — | preserve |

**Migration call:** Preserve rename-per-file affordance.

#### M22 — Generate share link (hospital)

Already covered in §2.15 Sharing sub-tab. Cut to 2 fields.

#### M23 — File preview (`FilePreviewModal.tsx`, 507 LOC)

| Type | Real | Notes |
|---|---|---|
| PDF | react-pdf with paging | preserve |
| Image | `<img>` object-contain | preserve |
| Text | UTF-8 / ISO-8859-1 fallback (internal `TextFileContent`) | preserve |
| Excel | ExcelJS parse → table view with sheet pager | preserve |
| Word | mammoth → HTML via `dangerouslySetInnerHTML` | preserve |
| Footer | Download + Close | preserve |

**Migration call:** Visual upgrade only. **Preserve all 5 type renderers** — wireframe shows only PDF.

#### M17 / M18 / M25 (Master Options + destructive confirm)

Already covered in §2.8. Preserve.

#### M24 — Document Upload (`DocumentUploadManager.tsx`, 538 LOC)

| Field | Real | Wireframe | Δ |
|---|---|---|---|
| file | accept .pdf,.doc,.docx,.jpg,.jpeg,.png; max 100MB | accept JPG,PNG,PDF,DOCX up to 25MB | **wrong limits** |
| documentName | text, required | implicit | preserve |
| documentCategory | select with 7 options (certifications/licenses/registrations/accreditations/insurance/compliance/other) | "Category: Admission" placeholder | wrong — those are patient-doc categories |
| documentType | text | not in wireframe | preserve |
| issueDate | date | not in wireframe | preserve |
| expiryDate | date | not in wireframe | preserve |

**Migration call:** Re-target M24 entirely — 6 fields, 7-option category list, 100MB limit, specific accept list.

### 2.18 Public surfaces

**HospitalDirectory** — already covered in §1: real has a 3-state verification filter button group; wireframe missing it. Real has 12/page pagination.

**DoctorDirectory** — real has search by name/NMC/email + Specialization select (15 options) + Status select (active default). Wireframe has filters as dropdowns. Match.

**PublicHospitalProfile** — already covered. Two tabs, Copy/Download JSON (not PDF), banking section, key contacts conditional.

**PublicDoctorProfile** — accordion-style credential groups (qualifications open by default), Share Profile + Export Profile (JSON) buttons. Hospital affiliations cards. Wireframe shows flat table — restructure.

---

## 3. Pre-flight gates (must resolve BEFORE Phase A starts)

### G1. Resolve the `CredentialsTab.tsx` vs `CredentialsTab/index.tsx` conflict

**Action:** Add a one-line `console.log` in each file's render, build, open the DoctorDetailsModal, observe which logs. Then **delete the dead one**. If `CredentialsTab.tsx` (legacy 1036 LOC) wins, also delete the `CredentialsTab/` folder. If the folder wins, delete `CredentialsTab.tsx`.

**Why first:** the surviving file dictates the wireframe spec for credential editing (data-type branches, category check casing).

### G2. Delete `pages/hospital/Profile/components/DocumentsManager.tsx` and `VerificationDashboard.tsx`

Neither is mounted. Both are dead. Removing them simplifies the migration and clarifies scope.

**Side action:** remove the `?tab=documents` query-string reference in `HospitalOperationsCard.tsx` ("View Docs" button) — make it a no-op or remove.

### G3. Remove dead button in `MasterPanelManagement.tsx`

The per-row "Details" button has no `onClick`. Remove it. No replacement.

### G4. Fix the routing bug in `DoctorDirectory.tsx:149`

Change `navigate('/public-profile/<token>')` → `navigate('/public-doctor/<token>')`. This is a 1-line fix.

### G5. Remove dead code: `GET /admin/doctor-attributes/definitions?category=qualifications` in `RegisterDoctor.tsx`

Result is discarded. Specializations are hardcoded. Delete the fetch.

### G6. Decide on the `flexible-dialog.tsx` codemod path

`PatientPhotosModal` and `pages/superadmin/HospitalDetailsPage/components/DoctorDetailsModal` use `FlexibleDialogContent` (custom close-button positioning). The strategy doc said "delete flexible-dialog". The migration must either:
- Keep `flexible-dialog` for those 2 surfaces, OR
- Migrate them to standard `Dialog` and accept the close-button positioning change.

**Recommend:** keep `flexible-dialog` for the 2 surfaces; codemod everywhere else. Document the keep.

### G7. Enable ESLint in the build (TECH_DEBT P0-10)

Remove `DISABLE_ESLINT_PLUGIN=true SKIP_PREFLIGHT_CHECK=true CI=false` from the build script. Fix the resulting wave of warnings before any migration PR opens. This **must** be the first PR.

### G8. Confirm the migration plan deferred list

Re-read [`MIGRATION_PLAN.md`](./MIGRATION_PLAN.md) §6 against the deltas in §5 of this document. Sign off explicitly.

---

## 4. PR-by-PR execution plan

26 PRs total. Each PR is bounded by a single file or a small file cluster, has a clear scope, and a hard acceptance criterion.

### Phase 0 — Pre-flight (must merge first)

| # | Title | Files | Scope | Acceptance |
|---|---|---|---|---|
| 0.1 | **chore: enable eslint + tsc in CI** | `package.json` | Remove `DISABLE_ESLINT_PLUGIN=true` flag; fix the warnings | `npm run build` passes with eslint on |
| 0.2 | **chore: resolve credential-tab duplicate** | `components/DoctorDetailsTabs/CredentialsTab.tsx` OR `CredentialsTab/` (whichever loses) | Verify which is live, delete the dead one | Build still passes; DoctorDetailsModal Credentials tab still renders |
| 0.3 | **chore: delete dead Profile-tab components** | Delete `DocumentsManager.tsx`, `VerificationDashboard.tsx`, fix `HospitalOperationsCard.tsx` "View Docs" link | — | No broken links; build passes |
| 0.4 | **fix: remove dead Details button on master panels** | `features/panels/MasterPanelManagement.tsx` | Delete the button + its column | — |
| 0.5 | **fix: doctor directory routes to wrong public path** | `pages/doctors/DoctorDirectory.tsx:149` | One-line fix | Clicking a doctor card opens `/public-doctor/<token>` |
| 0.6 | **chore: remove unused GET in RegisterDoctor** | `pages/auth/RegisterDoctor.tsx` | Delete the discarded fetch | — |

### Phase A — Foundation

| # | Title | Files | Scope | Acceptance |
|---|---|---|---|---|
| A.1 | **design: tokens + tailwind theme** | `tailwind.config.js`, `index.css`, `globals.css` | Brand/surface/text/status colour tokens, Inter font, 4-pt spacing, two-shadow scale, two-radius scale, dark-mode class strategy | Toggle `class="dark"` on `<html>` flips colors site-wide |
| A.2 | **chore: dedup Dialog primitives** | All files importing `flexible-dialog.tsx` except `PatientPhotosModal` and SA `DoctorDetailsModal` | Codemod to standard `@/components/ui/dialog` | No regressions in any dialog. `flexible-dialog.tsx` kept for the 2 noted files |
| A.3 | **chore: dedup Skeleton primitive** | All `components/common/Skeleton` imports | Codemod to `@/components/ui/skeleton`; delete `components/common/Skeleton.tsx` | All skeletons render |
| A.4 | **chore: replace window.alert with sonner toast** | 7 known sites (see TECH_DEBT P2-10) | Codemod | No `alert(` in source; toasts fire |
| A.5 | **feat: new shell — top bar + role-aware side rail** | New `components/shell/AppShell.tsx`, wire into route layouts | Top bar (logo, role badge, search disabled, notifications, avatar, theme toggle); side rail per role | Side rail renders correct items per role; theme toggle works |
| A.6 | **feat: migrate LoginPage to shadcn** | `pages/auth/LoginPage.tsx`; delete `styles/Login.css` | Card + Input + Button + role-based redirect (preserve); add doctor-self-register footer link | Sign-in still routes correctly per role |

### Phase B — Public surfaces

| # | Title | Files | Scope | Acceptance |
|---|---|---|---|---|
| B.1 | **feat: RegisterDoctor revamp** | `pages/auth/RegisterDoctor.tsx` | Preserve all 11 fields, password regex, dual POST flow, 2-sec redirect; new visual treatment | All existing validation passes; doctor created end-to-end |
| B.2 | **feat: HospitalDirectory revamp** | `pages/HospitalDirectory.tsx` | Preserve verification filter buttons (3 states), 12/page pagination, card fields exactly | Filters work; pagination works; click navigates correctly |
| B.3 | **feat: DoctorDirectory revamp** | `pages/doctors/DoctorDirectory.tsx` | Preserve search + Specialization (15 options) + Status (active default) selects; 12/page; NMC masking | All filters work; navigation goes to `/public-doctor/<token>` (fixed in 0.5) |
| B.4 | **feat: PublicHospitalProfile revamp** | `pages/PublicHospitalProfile.tsx` | Preserve 2 tabs (Profile Details + Certifications & Documents), sticky action bar (Copy JSON + Download JSON), verification banner, Banking section, Key Contacts conditional, attribute category filter, doc preview/download | Token-gated rendering still works; both tabs preserve content |
| B.5 | **feat: PublicDoctorProfile revamp** | `pages/doctor/PublicDoctorProfile.tsx` | Preserve accordion (qualifications open by default), Share Profile + Export Profile (JSON) buttons, hospital-affiliation cards | All sections render conditionally as before |

### Phase C — Super Admin portal

| # | Title | Files | Scope | Acceptance |
|---|---|---|---|---|
| C.1 | **feat: SuperAdminPage shell + Dashboard tab** | `pages/superadmin/SuperAdminPage.tsx`, `features/dashboard/DashboardOverview.tsx` | Preserve 8-tab nav, page header search, role-based actions. Dashboard: 4 KPI cards + Recent Activity + System Health + 2 quick-action buttons (Add Hospital, Add Admin) | All 8 tabs reachable; KPIs render |
| C.2 | **feat: Admins tab revamp** | (within SuperAdminPage) | Preserve columns: User, Username, Contact, Actions. Row click opens AssignmentModal. + Invite admin button | Click row → modal opens; create admin works |
| C.3 | **feat: Hospitals tab revamp** | (within SuperAdminPage) | Preserve columns: Hospital, City, Panels (sortable), Patients (sortable), Actions. Sort behavior preserved. | Sorts work; click navigates |
| C.4 | **feat: Master Panels tab revamp** | `features/panels/MasterPanelManagement.tsx` | Preserve 2 columns (Panel Name, Created Date); no Details button | Renders with new tokens |
| C.5 | **feat: Hospital Attribute Definitions revamp** | `features/attributeDefinitions/HospitalAttributeDefinitionsManager.tsx` | Preserve all 11 form fields including unit/can_verify_by_image/expected_issuing_authority/image_guidance/is_mandatory_basic/is_mandatory_empanelment; 5 data types; async key validation; click-to-toggle status badge; 422-deactivate hint | All flows including activate/deactivate work |
| C.6 | **feat: Panel Attribute Definitions revamp** | `features/attributeDefinitions/PanelAttributeDefinitionsManager.tsx` | Preserve all 12 data types, options builder, 3 validation fields, is_unique, default_value | All branches functional |
| C.7 | **feat: Doctor Attribute Definitions revamp** | `features/attributeDefinitions/DoctorAttributeDefinitionsManager.tsx` | Preserve 4 data types, 9 form fields (has_expiry/requires_document/can_verify_by_document/etc.), Config column | All flows work |
| C.8 | **feat: Master Options revamp** | `pages/superadmin/MasterOptionsManager/` (index + 3 modals) | Preserve category selector + search; 4-field create dialog; edit-with-active-toggle + dates display; delete-with-info confirm | All flows work |
| C.9 | **feat: HospitalDetailsPage (legacy SA) revamp** | `pages/superadmin/HospitalDetailsPage/index.tsx`, `components/HospitalUserList.tsx`, `PanelsList.tsx`, `HospitalHeader.tsx` | Preserve 2 tabs (Linked Panels + Users), breadcrumb, Hospital Profile Configuration button | Tabs work; cross-link to portal works |

### Phase D — Hospital portal

| # | Title | Files | Scope | Acceptance |
|---|---|---|---|---|
| D.1 | **feat: HospitalPortalLayout shell** | `pages/hospital/Layout/index.tsx` | Preserve 4 sidebar items, hide-on-panel/profile behavior, sign-out | Sidebar items work; sign out works |
| D.2 | **feat: HospitalDashboard revamp** | `pages/hospital/Dashboard/index.tsx`, `components/HospitalOperationsCard.tsx` | Preserve 3 stat cards + 2 operations cards (Profile Management, Public Sharing) with all metrics (active_shares, total_views, last_viewed, attribute counts, document counts, verification status) | All metrics load; click navigation works |
| D.3 | **feat: hospital/Panels revamp** | `pages/hospital/Panels/index.tsx` | Renders shipped PanelsFleetTable; preserve hide-Link-Panel button | List renders |
| D.4 | **feat: hospital/PanelDetails revamp** | `pages/hospital/PanelDetails/index.tsx`, `pages/panels/components/PatientTable.tsx`, `pages/panels/index.tsx` (legacy SA path) | Preserve 5 patient-status tabs (All/Active/Admitted/Discharged/Deactivated), search, Refresh, Add Patient (admin-gated). PatientTable: 5+2 hideable columns. | Tab filter works; search debounced; Add Patient flow works |
| D.5 | **feat: hospital/Users revamp** | `pages/hospital/Users/index.tsx`, `pages/superadmin/HospitalDetailsPage/components/HospitalUserList.tsx` | Preserve 5 columns + admin-only Status; Refresh button; New User; Edit-Roles dialog with exclusive Admin switch + Select All + search | Edit Roles preserves exclusivity logic |
| D.6 | **feat: Profile/ProfileForm revamp** | `pages/hospital/Profile/components/ProfileForm.tsx` | Preserve all 21 fields in 6 sections (Basic/Address/Contact/Registration/Specialties/Banking), edit-then-save pattern, Account Type 3-option select, ifsc maxLength 11, micr maxLength 9, beds-int-coercion | All fields save correctly |
| D.7 | **feat: Profile/AttributesManager revamp** | `pages/hospital/Profile/components/AttributesManager.tsx` | Preserve per-attribute cards (NOT table), 4 dialogs (Add/Edit/**Verify**/Delete), dynamic-input by data_type (boolean/integer/text/date/document), document upload + cert# + issuing authority + has_expiry conditional, image_guidance banner conditional, certificate details + documents + verification metadata sub-sections | All flows functional |
| D.8 | **feat: Profile/PanelsManager revamp** | `pages/hospital/Profile/components/PanelsManager.tsx`, `PanelsFleetTable.tsx` | Preserve Overview + Configure sub-tabs; Configure: panel select + category filter + per-attribute cards; Add/Edit dialogs with **all 12 data_type input branches**; Linked Documents in Edit with delete-tracking | All 12 branches functional |
| D.9 | **feat: Profile/DoctorsManager revamp** | `pages/hospital/Profile/components/DoctorsManager.tsx` | Preserve doctor cards (NOT table) + Add Doctor dialog 2-mode toggle (Search Existing + Create New); Create-New fields: first_name/last_name/email/phone/primary_specialization (with API fetch + fallback)/nmc_registration_number; Remove confirm | Both modes work end-to-end |
| D.10 | **feat: Profile/PublicSharingManager (hospital) revamp** | `pages/hospital/Profile/components/PublicSharingManager.tsx` | Preserve per-share-link cards, 2-field create dialog (description + expiresAt), Revoke confirm, expiration status helper | All flows work |
| D.11 | **feat: Profile/index.tsx shell** | `pages/hospital/Profile/index.tsx` | Preserve 5 tabs strictly (Profile/Attributes/Panels/Doctors/Sharing); new breadcrumb + header avatar | All 5 tabs render |

### Phase E — Doctor self-service + modals + shared

| # | Title | Files | Scope | Acceptance |
|---|---|---|---|---|
| E.1 | **feat: DoctorProfilePage shell** | `pages/doctor/DoctorProfilePage/index.tsx` | Preserve 4 tabs (Profile/Credentials/Hospitals/Public Profile) + header + logout | All tabs render |
| E.2 | **feat: Doctor ProfileForm revamp** | `pages/doctor/DoctorProfilePage/components/ProfileForm.tsx` | Preserve 7 fields (first/last/email/phone/primary_specialization as text Input/nmc/state) | Save works |
| E.3 | **feat: Doctor CredentialsManager revamp** | `pages/doctor/DoctorProfilePage/components/CredentialsManager.tsx` | Preserve flat form (NO data_type branching), category grouping, status badge mapping, delete confirm | Add/delete credential works |
| E.4 | **feat: Doctor HospitalAffiliations revamp** | `pages/doctor/DoctorProfilePage/components/HospitalAffiliations.tsx` | Read-only cards: hospital name, location, status, designation, department, specialization, employment_type, dates | Cards render conditionally |
| E.5 | **feat: Doctor PublicSharingManager revamp** | `pages/doctor/DoctorProfilePage/components/PublicSharingManager.tsx` | Preserve visibility toggle + share links list (no generate dialog — direct generate with null expiry) | Toggle + generate + revoke + copy work |
| E.6 | **feat: DoctorDetailsModal (new tabbed, admin path)** | `components/DoctorDetailsTabs/DoctorDetailsModal.tsx`, `PersonalInfoTab.tsx`, `HospitalAssignmentTab.tsx`, `CredentialsTab.tsx` (whichever won) | Preserve 3 tabs, view-then-edit pattern, all fields per zod schemas. CredentialsTab preserves whatever data_type branches the surviving file has. | Edit flows save correctly |
| E.7 | **feat: SA DoctorDetailsModal (legacy)** | `pages/superadmin/HospitalDetailsPage/components/DoctorDetailsModal.tsx` + `AddDoctorModal.tsx` + `DoctorDocsModal.tsx` | Preserve simple Details + Documents tabs, dark slate banner, Documents grid with Lightbox + Trash hover + FAB upload. AddDoctorModal: 6 fields (firstName/lastName/age/phone/speciality/yearsOfExp). DoctorDocsModal: file picker + rename per file. | All flows work |
| E.8 | **feat: PatientModal revamp** | `components/modals/PatientModal.tsx` | Preserve 5 conditional fields (hospital admin+new, firstName, lastName, phone non-hospital, admittedAt) | Both add + edit modes work |
| E.9 | **feat: AddPatientModal (SA path) revamp** | `pages/superadmin/HospitalDetailsPage/components/AddPatientModal.tsx` | Preserve 4 fields (firstName, lastName, admissionType, admittedAt) | Save works |
| E.10 | **feat: PatientPhotosModal (3-tab) revamp** | `components/modals/PatientPhotosModal/index.tsx`, `Lightbox.tsx`, `IPDFields.tsx`, `ClaimsFields.tsx` | **Preserve all 3 tabs**: Files (upload + categories + select-mode actions + PDF), IPD Details (7 fields, most disabled), Claims (9 fields). Lightbox: keyboard nav, wheel zoom, drag pan, react-pdf | All 3 tabs functional |
| E.11 | **feat: AddHospitalModal revamp** | `components/modals/AddHospitalModal.tsx` | 3 fields only: name, city, driveFolderId | Save works |
| E.12 | **feat: AddPanelModal revamp** | `components/modals/AddPanelModal.tsx` | 1 field: panelName | Save works |
| E.13 | **feat: AddUserModal revamp** | `components/modals/AddUserModal.tsx` | Already partly shipped (roles list). Visual polish only. | Roles selector preserved |
| E.14 | **feat: AssignmentModal revamp** | `components/modals/AssignmentModal.tsx` | **Preserve click-to-toggle hospital cards UI** (NOT dropdown). No permission UI (defaults all true). | Assign + remove flows work |
| E.15 | **feat: LinkPanelModal revamp** | `components/modals/LinkPanelModal.tsx` | Preserve single-panel select + inline create + 4 optional config fields (contact/sheetId/sheetName/whatsAppGroupId) | All flows work |
| E.16 | **feat: FilePreviewModal revamp** | `components/FilePreviewModal.tsx` | **Preserve all 5 type renderers**: PDF (paged), Image, Text (encoding fallback), Excel (ExcelJS + sheet pager), Word (mammoth). Download + Close. | All 5 file types render |
| E.17 | **feat: DocumentUploadManager revamp** | `components/DocumentUploadManager.tsx` | Preserve all 6 fields (file 100MB accept-list, documentName, documentCategory 7 options, documentType, issueDate, expiryDate), document list with Set Primary action | All flows work |

---

## 5. Explicit anti-list — DO NOT add these from the wireframes

Every wireframe element that **does not exist in the real app**. If a reviewer sees any of these in a PR, the PR fails review.

### Patient & claim state machine (entire category — defer to Phase C of UI_REVAMP)
- Status pipeline pills (Pre-auth/Approved/Submitted/Queried/Settled/Rejected/Admitted) on any patient list
- "Status" column on any patient row that comes from a `claims.latest_status` enum
- "Move to Approved →" status pipeline button on patient detail
- Status transition modal (M11 — was added in wireframes; defer entirely)
- Time-in-stage / SLA-breach indicators
- "Last action" column on patient list
- IPD status state machine — patient status comes from existing `is_active` + `discharged_at`, **not** a new enum
- Hospital Workspace "Operations / Configuration" mode toggle — pure IA reorg
- Workspace unified URL `/admin/hospitals/:id` — defer

### Aggregations & rollups (don't compute these)
- Dashboard secondary KPIs: Pending verification, Expiring <30d, Settled this week
- "Hospital health" rollup table on SA Dashboard
- "Needs attention" feed (anywhere)
- "Top panels by volume" rollup
- Patient detail's "Time-in-status" stats
- KPI tiles on Public Sharing (Total views 30d, Last viewed)
- Per-row aggregations on SA Hospitals: Profile %, Admitted, Patients (wk), Health, Public

### New surfaces (don't build)
- `hw-patient-detail` (the whole multi-tab patient page) — patient edit stays in PatientModal/PatientPhotosModal
- `hw-patient-edit` side drawer — patient edit stays modal
- Cross-hospital Doctor roster (SA-level Doctors page)
- Validators screen
- Audit log screen
- Reports landing page or any per-hospital Reports tab
- Scheduled exports
- Doctor cross-hospital affiliations editor — only the existing read-only HospitalAffiliations exists
- Operations vs Configuration mode toggle
- Hospital workspace 6-tab configuration strip
- 3-state attribute configurator entity toggle (Hospital/Panel/Doctor) — keep them as 3 separate components

### Connectivity / probes
- Panel "Health" column with real probe ("200 OK · 412ms")
- "Last probe" column on panels
- "Refresh probes" button
- Per-row connectivity status

### Doc actions that don't exist
- "Generate combined PDF" on patient docs
- "Build combined packet PDF"
- "Download profile PDF" on public profiles (real has Copy/Download **JSON**, not PDF)

### Power-user features
- ⌘K global search
- Saved views
- Bulk-select on patient list + export/re-assign/send-reminder
- Drag-to-reorder on Master Options
- Activity filter combinations beyond what exists today
- "Auto-enable public profile" checkbox in hospital share-link modal
- Audience-label / max-views / sections-visible fields in hospital share-link modal

### Modals — wireframe over-specs that must be cut
- M5 AddHospital: drop state/type/tagline → keep name/city/driveFolderId
- M6 AddPanel: drop type/short-code → keep panelName only
- M7 LinkPanel: drop multi-select list → use single-panel select + inline create + 4 config fields
- M9 PatientModal: drop age/gender/panel/beneficiaryId/bedType/treating-doctor/notes
- M22 ShareLink: drop audience/max-views/sections-visible/auto-enable → keep description + expiresAt
- M3 Assignment: drop permission checkboxes; keep card-toggle UI
- M19/M20: don't merge AddDoctor and AddCredential flows
- M24 DocumentUpload: re-target to 6-field document upload (not the patient-doc upload wireframe shows)

### Routing
- Don't add a sign-up link to login (that would be a new feature — registration is doctor-only)
- Don't change route shapes — preserve `/portal/:id/*` and `/hospital/:id` as-is

---

## 6. What this plan does NOT cover

- **Backend changes.** Zero. Every PR is webapp-only.
- **Mobile app.** Separate proposal.
- **Storybook / Chromatic.** Not yet — could be a follow-up.
- **Component refactors** (split 1500-LOC managers into smaller files). Migration is **edit in place**.
- **Accessibility audit.** Separate work; tokens make it easier when we get there.
- **Performance work.** Separate.

---

## 7. Sign-off

Before any migration PR opens, sign off on:
1. The pre-flight gates in §3 are all merged.
2. The PR plan in §4 is the source of truth — reviewers reject anything outside it.
3. The anti-list in §5 is enforced as a review checklist.

After sign-off this doc + `MIGRATION_PLAN.md` together become the migration's spec.

---

## Appendix A — Source-file → wireframe matrix

| Source file | Wireframe target | PR # |
|---|---|---|
| `pages/auth/LoginPage.tsx` | `screen-login` | A.6 |
| `pages/auth/RegisterDoctor.tsx` | `screen-dr-register` (re-targeted) | B.1 |
| `pages/HospitalDirectory.tsx` | `screen-public-directory` (Hospitals tab) | B.2 |
| `pages/doctors/DoctorDirectory.tsx` | `screen-public-directory` (Doctors tab) | B.3 |
| `pages/PublicHospitalProfile.tsx` | `screen-public-hospital` (re-targeted to 2 tabs) | B.4 |
| `pages/doctor/PublicDoctorProfile.tsx` | `screen-public-doctor` (re-targeted accordion) | B.5 |
| `pages/superadmin/SuperAdminPage.tsx` | `screen-sa-dashboard` + tab routing | C.1-C.3 |
| `features/dashboard/DashboardOverview.tsx` | dashboard portion | C.1 |
| `features/panels/MasterPanelManagement.tsx` | `screen-sa-master-panels` | C.4 |
| `features/attributeDefinitions/HospitalAttributeDefinitionsManager.tsx` | `screen-sa-attributes` (entity=hospital) | C.5 |
| `features/attributeDefinitions/PanelAttributeDefinitionsManager.tsx` | `screen-sa-attributes` (entity=panel) | C.6 |
| `features/attributeDefinitions/DoctorAttributeDefinitionsManager.tsx` | `screen-sa-attributes` (entity=doctor) | C.7 |
| `pages/superadmin/MasterOptionsManager/*` | `screen-sa-master-options` + M17/M18/M25 | C.8 |
| `pages/superadmin/HospitalDetailsPage/*` | (legacy view, re-skin only) | C.9 |
| `pages/hospital/Layout/index.tsx` | new shell | D.1 |
| `pages/hospital/Dashboard/index.tsx` | re-target dashboard | D.2 |
| `pages/hospital/Panels/index.tsx` | uses PanelsFleetTable | D.3 |
| `pages/hospital/PanelDetails/index.tsx` | re-target patients view | D.4 |
| `pages/hospital/Users/index.tsx` | `screen-hw-users` | D.5 |
| `pages/hospital/Profile/components/ProfileForm.tsx` | `screen-hw-hospital-profile` (re-targeted) | D.6 |
| `pages/hospital/Profile/components/AttributesManager.tsx` | re-target (cards, not table) | D.7 |
| `pages/hospital/Profile/components/PanelsManager.tsx` | `screen-hw-panels` (shipped pattern) | D.8 |
| `pages/hospital/Profile/components/DoctorsManager.tsx` | `screen-hw-doctors` (cards) | D.9 |
| `pages/hospital/Profile/components/PublicSharingManager.tsx` | `screen-hw-sharing` (re-targeted) | D.10 |
| `pages/hospital/Profile/index.tsx` | shell for 5 tabs | D.11 |
| `pages/doctor/DoctorProfilePage/*` | `screen-dr-profile` | E.1-E.5 |
| `components/DoctorDetailsTabs/*` | new tabbed modal | E.6 |
| `pages/superadmin/HospitalDetailsPage/components/DoctorDetailsModal.tsx` + sibs | SA legacy modal | E.7 |
| `components/modals/PatientModal.tsx` | M9 (re-targeted) | E.8 |
| `pages/superadmin/HospitalDetailsPage/components/AddPatientModal.tsx` | separate variant | E.9 |
| `components/modals/PatientPhotosModal/*` | M12 + 3-tab modal | E.10 |
| `components/modals/AddHospitalModal.tsx` | M5 (cut to 3 fields) | E.11 |
| `components/modals/AddPanelModal.tsx` | M6 (cut to 1 field) | E.12 |
| `components/modals/AddUserModal.tsx` | M1/M2 | E.13 |
| `components/modals/AssignmentModal.tsx` | M3 (cards, no perms) | E.14 |
| `components/modals/LinkPanelModal.tsx` | M7 (re-targeted) | E.15 |
| `components/FilePreviewModal.tsx` | M23 | E.16 |
| `components/DocumentUploadManager.tsx` | M24 (re-targeted) | E.17 |

**Total: 26 PRs in 5 phases.** Approximate cadence: Phase 0 = 1 sprint, Phases A–E ≈ 1-2 sprints each. ~7 sprints end-to-end.
