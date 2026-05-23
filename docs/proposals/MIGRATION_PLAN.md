# ClaimsOS Webapp · UI Migration Plan

**Author:** Engineering
**Date:** 2026-05-13
**Companion:** [`UI_REVAMP.md`](./UI_REVAMP.md) (the strategy), [`ui-revamp/wireframes.html`](./ui-revamp/wireframes.html) (the mockups)
**Status:** Proposal — pending approval to start execution

This is a **visual-only migration plan** to move the existing ClaimsOS webapp from its current chrome to the new design system. Every feature, form, list, and input field in the current app stays exactly as-is. **Nothing new is built. Nothing existing is removed.** Anything the wireframes show that doesn't exist in the real app today is enumerated in §6 — "Deferred to revisit later".

---

## 1. Operating principles

These are the rules every PR in this migration must respect.

| Rule | Why |
|---|---|
| **No new features.** | This is a re-skin, not a product redesign. |
| **No removed features.** | Every page, modal, form, button, column that exists today survives. |
| **No changed input fields.** | Field name, validation, payload shape stays identical. Backend untouched. |
| **No new data fetches.** | If the wireframe shows a field that requires a backend change, that wireframe element is dropped (see §6). |
| **One canonical primitive.** | Replace today's duplicate `Dialog`/`Skeleton`/raw CSS with the new design tokens. |
| **Wireframe → implementation isn't 1:1.** | The wireframe sometimes shows columns or buttons that depend on data we don't have yet. The migration drops those and keeps the bones. |
| **Toast in, alert out.** | Every `window.alert()` becomes a sonner toast as part of this migration. Same message, different chrome. |
| **Same routes.** | Existing URLs (`/superadmin`, `/portal/:id/panels`, etc.) keep working. The Hospital Workspace "unified URL" idea from `UI_REVAMP.md` §4.3 is deferred. |

---

## 2. Scope — what's in this migration

### In
1. New design tokens applied: colour, typography (Inter scale), 4-pt spacing, radius, elevation
2. New shell: top bar + role-aware side rail (in place of the existing sidebars)
3. Dedup pass: Dialog/Skeleton/Toaster consolidation, raw-CSS removal, `alert()` → toast
4. Each existing page re-rendered with the new visual treatment using the wireframes as the visual spec, **minus the deferred elements** in §6
5. Each existing modal re-rendered using the new modal pattern from the gallery, **with the same fields**
6. Light/Dark theme support via the new tokens (implementation level — keep "light only" as the default delivery if the dark-mode work pushes scope)

### Out (deferred — see §6 for the full list)
- IPD status state machine, status pipeline pills, "Move to Approved" transition modal
- Time-in-status / SLA-breach indicators, "Needs attention" feed
- Connectivity probes for panels (RPA Phase F)
- Cross-hospital Doctor roster, Validators screen, Audit log screen
- Reports (cross-hospital and per-hospital)
- Hospital Workspace "Operations / Configuration" mode toggle (visual reorg — defer)
- Saved views, bulk-select export, scheduled exports
- Patient Detail Timeline + Notifications tabs
- "Generate combined PDF" buttons on patient docs

---

## 3. Pre-flight — Phase A · Foundation (1 sprint)

Land the system before touching any page. Everything else depends on this.

### A1. Design tokens
- Replace ad-hoc Tailwind classes with the tokens from `UI_REVAMP.md` §3 (brand-600/700, surface-0/1/2, border, text-1/2/3, status colours).
- Implement via `tailwind.config.js` `theme.extend.colors` + CSS variables in `index.css` so dark mode flips at the root.
- Type scale: Inter, 7 sizes (display/h1/h2/h3/body/body-sm/caption + mono). Removes the ad-hoc `text-lg/xl/2xl/3xl` mixing.
- Spacing: 4-pt grid (Tailwind's defaults are fine; ban off-grid `p-3.5`, `gap-2.5`).

### A2. Dedup duplicate primitives
- Pick one **Dialog** (`@/components/ui/dialog.tsx`). Delete `flexible-dialog.tsx`. Codemod all imports.
- Pick one **Skeleton** (`@/components/ui/skeleton.tsx`). Delete `@/components/common/Skeleton.tsx`. Codemod all imports.
- Replace every `window.alert(...)` with `toast.error|success(...)` (7 known call sites; full list in [`TECH_DEBT.md`](../TECH_DEBT.md) P2-10).
- Replace `react-multi-select-component` with shadcn `Select` + multi-select pattern (only one consumer — modal AddUserModal — easy to migrate).

### A3. New shell
- New top bar (logo · "Super Admin" / role badge · global ⌘K search · notifications bell · avatar with menu · theme toggle).
- New side rail per role:
  - **Super Admin:** Dashboard · Hospitals · Admin Users · *(Configurators)* Master Panels · Hospital Attributes · Panel Attributes · Doctor Attributes · Master Options · *(bottom)* Log out
  - **Admin (24Eleven ops):** Dashboard · Hospitals (filtered to their assignments) · *(bottom)* Log out
  - **Hospital User:** Dashboard · Panels · Users · Profile · *(bottom)* Log out
  - **Doctor:** My profile · *(bottom)* Log out
- Side rail items map 1:1 to existing routes. **No new routes added.**
- The "Inside a hospital" / Workspace IA from the wireframes is **deferred** — Phase D uses the existing routes (`/portal/:id/dashboard`, `/portal/:id/panels`, etc.) under the new shell.

### A4. Login page
- Migrate `LoginPage.tsx` from raw CSS (`styles/Login.css`) to shadcn `<Card>`, `<Input>`, `<Button>`. Wireframe screen `login` is the visual reference.
- Same two fields, same `/auth/login` call, same role-based redirect.
- Delete `styles/Login.css`.

### Acceptance criteria for Phase A
- [ ] Toggling `class="dark"` on `<html>` flips the whole app between light + dark
- [ ] Every page in the app boots without referencing the deleted `flexible-dialog`, `common/Skeleton`, or `Login.css`
- [ ] No `window.alert` remains in source
- [ ] Login page renders with the new card; sign-in works; redirects unchanged
- [ ] All existing roles see their new side rail and can reach every existing route

---

## 4. Page-by-page mapping (Phases B–E)

For each existing page: its current code path, the wireframe screen that replaces it visually, what stays unchanged, and what wireframe additions are explicitly skipped.

### B. Public surfaces — Phase B (lowest risk, no auth gate)

#### B1. `pages/auth/LoginPage.tsx` → wireframe `login`
Covered in Phase A above. Listed here for completeness.

#### B2. `pages/auth/RegisterDoctor.tsx` → wireframe `dr-register`
- **Keep:** First/Last name, Email, Phone, NMC registration, State registration, Primary specialty (dropdown from master options), Password, Terms checkbox. `POST /auth/signup` with `role=doctor` + `POST /doctors/register` payload as today.
- **Visual:** Card-on-slate-50, two-column grid, shadcn inputs.
- **Skip:** Auto-login on submit (`TODO` at line 142 stays — backend-side concern, defer to TECH_DEBT P0-9 work).

#### B3. `pages/HospitalDirectory.tsx` → wireframe `public-directory` (Hospitals tab)
- **Keep:** Search by name/city, filter chips for City + Hospital type, paginated card grid (12/page), filter to `is_public_profile_enabled = true`. `GET /api/v1/doctors/search` (no, that's wrong — for hospitals it's the public directory endpoint per `apiService.getPublicHospitals` or equivalent).
- **Visual:** Wireframe's directory cards (avatar · name · city · type · "Verified ✓" pill).
- **Skip:** Toggle to Doctor tab — defer (see B4 — that exists as `pages/doctors/DoctorDirectory.tsx`, ship them as separate routes for now, **not** the unified toggle in the wireframe).

#### B4. `pages/doctors/DoctorDirectory.tsx` → wireframe `public-directory` (visual treatment, separate route)
- **Keep:** Search by name/NMC/specialization, filter dropdowns (specialization, status), 12/page pagination, only show `is_public_profile_enabled = true` doctors. Same API as today.
- **Visual:** Same card grid as B3.
- **Skip:** Unified entity-toggle with Hospitals — keep them as two separate routes (no IA change in this migration).

#### B5. `pages/PublicHospitalProfile.tsx` → wireframe `public-hospital`
- **Keep:** Every section currently rendered (1027 LOC today — accreditation, infrastructure, panels, contacts, certifications, banking when section visible). All token-gated section visibility logic from the share-token endpoint stays.
- **Visual:** Wireframe's two-column layout (left: section cards; right: trust footprint + meta).
- **Skip:** "Download profile PDF" button on the wireframe — `jspdf` is in the bundle today but no real PDF generation route exists. Defer.
- **Skip:** "Verification report" link in the trust footprint — backend has `verification_visits` but no public-facing report. Defer.

#### B6. `pages/doctor/PublicDoctorProfile.tsx` → wireframe `public-doctor`
- **Keep:** Doctor profile, verified credentials, hospital affiliations, token-gated section visibility.
- **Skip:** "Download as PDF" button (same reason as B5).

### C. Superadmin portal — Phase C

The SA portal is the highest-traffic surface and the most reused pattern (tables + modals). One pass migrates the existing `SuperAdminPage.tsx` (603 LOC) + the three Attribute Definition managers (890/946/788 LOC).

#### C1. `pages/superadmin/SuperAdminPage.tsx` — Dashboard tab → wireframe `sa-dashboard` (simplified)
- **Keep:** Existing 4 KPI cards from `DashboardOverview.tsx` (Total Hospitals, Total Patients, Active Patients, Total Admins) + Recent Activity feed + System Health card. Same `/api/v1/admin/stats` + `/api/v1/health` payloads.
- **Visual:** Wireframe's KPI tiles row + recent activity card.
- **Skip:** Secondary KPI row (Pending Verification / Expiring <30d / Settled this week) — requires aggregations we don't compute today. Defer.
- **Skip:** "Hospital health" rollup table on the wireframe — requires the new "panels_count + patients_count + expiring + verification status" rollup. The first three exist (we shipped them); verification status across attributes is per-attribute today, not rolled up. **Drop the table for migration**; users still drill into a hospital via the Hospitals tab.
- **Skip:** "Needs attention" feed — requires a new aggregation endpoint. Defer.
- **Skip:** "Quick actions" panel — overlap with existing top-right buttons. Defer.

#### C2. SuperAdminPage — Hospitals tab → wireframe `sa-hospitals`
- **Keep:** Existing columns: Hospital, City, Panels, Patients (we shipped these last week). Same `/hospitals/getAllHospitals` payload. Row click → `/hospital/:id`.
- **Visual:** Wireframe's row layout (avatar · name · city · panels · patients).
- **Skip:** Profile %, Admitted, Patients (wk), Health (Verified/Pending/etc.), Public column — every one of these requires either a new aggregation or rollup that doesn't exist today. Defer all of them.
- **Skip:** Saved views toolbar — no saved-views feature.

#### C3. SuperAdminPage — Admin Users tab → wireframe `sa-admins`
- **Keep:** Admin list with first/last name, username, email, role. Click row → opens AssignmentModal (existing). + Invite admin button → AddUserModal (existing, role=admin).
- **Visual:** Wireframe's table layout (avatar · name+username · email/phone · hospital chips · permission chips · last seen · status toggle).
- **Skip:** "Last seen" column — `users.last_login` exists in the schema but isn't surfaced in the API today. Defer (or quick-add the field to the existing endpoint if cheap — call it).
- **Skip:** Status toggle's "Invited" pending state — backend doesn't support an invite flow today; user creation is direct. Defer.

#### C4. SuperAdminPage — Master Panels tab → wireframe `sa-master-panels` (visual treatment, columns trimmed)
- **Keep:** Panel name list. `/hospitals/panel/all` payload.
- **Visual:** Wireframe row layout.
- **Skip:** Type pill (Govt / Insurer / Network), Hospitals linked count, Active patients, Settled rate columns — none of these are computed today. Defer.
- **Outcome for migration:** Just the panel name list with the new visual treatment + the existing AddPanelModal.

#### C5. SuperAdminPage — Hospital / Panel / Doctor Attributes tabs → wireframe `sa-attributes` (one screen, entity switcher) — *visual only*
- **Keep:** The three managers stay as **three distinct components** (no consolidation in this migration). Each lists attribute definitions with their fields exactly as today (key, label, category, data_type, is_required, has_expiry, requires_document, sort_order, is_active). Same CRUD endpoints.
- **Visual:** Wireframe's table layout per manager; the chip-row replaces the existing category rail.
- **Skip:** The entity switcher pattern from the wireframes (Hospital / Panel / Doctor pills) — that requires unifying 3 components into 1, which is a refactor, not a migration. Defer to a later phase (see [TECH_DEBT P2-2](../TECH_DEBT.md)).
- **Outcome:** Three side-rail items, three pages, but visually they all look like the wireframe's `sa-attributes` screen.

#### C6. SuperAdminPage — Master Options tab → wireframe `sa-master-options`
- **Keep:** Categories (Speciality, Hospital Type today), options list per category, CreateOptionModal / EditOptionModal / DeleteConfirmModal. Same endpoints.
- **Visual:** Wireframe's chip-row for category + table.
- **Skip:** "Drag rows to reorder" interaction — `sort_order` is stored but the existing UI uses a number input, not drag. Defer drag affordance.

#### C7. `pages/superadmin/HospitalDetailsPage/index.tsx` → folded into the **same routes as today**, not the wireframe's "Hospital Workspace"
- **Keep:** Two tabs as today: "Linked Panels" (PanelsList + PanelCard… now PanelsFleetTable we shipped) and "Users" (HospitalUserList). Same `/hospitals/:id/panels` + `/hospitals/:id/users` endpoints.
- **Visual:** New top header card (hospital name, city, stats pills), then existing 2-tab strip.
- **Skip:** "Operations / Configuration" mode toggle from the wireframe — that's a new IA. Defer to a later phase.
- **Skip:** "Hospital Profile / Attributes / Panel / Doctors / Users / Public Sharing" 6-tab Configuration strip from the wireframe — the existing legacy `HospitalDetailsPage` doesn't have these, and the new `/portal` does (see C8 below). **Migration keeps the existing 2-tab page intact**.

#### C8. `pages/hospital/Profile/index.tsx` (hospital portal's Profile page, 5 sub-tabs) → wireframe `hw-hospital-profile`, `hw-profile` (attributes), `hw-panels`, `hw-doctors`, `hw-sharing`
- **Keep all five existing sub-tabs verbatim:**
  - **Profile** (`ProfileForm.tsx`, 577 LOC) — every field as-is.
  - **Attributes** (`AttributesManager.tsx`, 1470 LOC) — every category, attribute, value, document.
  - **Panels** (`PanelsManager.tsx`, 1594 LOC) — uses the `PanelsFleetTable` we shipped + Configure sub-tab.
  - **Doctors** (`DoctorsManager.tsx`, 633 LOC).
  - **Sharing** (`PublicSharingManager.tsx`, 391 LOC).
- **Visual treatment per sub-tab:** wireframes `hw-hospital-profile`, `hw-profile`, `hw-panels`, `hw-doctors`, `hw-sharing`.
- **Skip:** "Users" tab inside Profile — `/portal/:id/users` stays a separate route (it is today). The wireframe shows it inside the workspace tab strip; **defer that IA change**.
- **Skip:** Mode toggle.
- **Skip:** "Documents" tab — doesn't exist in today's Profile page (documents attach to attributes). Wireframe's `hw-documents` was already pruned.

### D. Hospital portal — Phase D

#### D1. `pages/hospital/Layout/index.tsx` → unchanged structure, new shell
- **Keep:** Sidebar navigation between `dashboard`, `panels`, `users`, `profile`. Same routing.
- **Visual:** New shell from Phase A (the layout's inner sidebar may now look redundant — discuss; for migration, keep both but render the inner sidebar with the new tokens).

#### D2. `pages/hospital/Dashboard/index.tsx` → simplified wireframe `hw-overview` (no pipeline visual)
- **Keep:** `HospitalOperationsCard.tsx` content (whatever it shows today).
- **Visual:** Wireframe's KPI tile row + recent activity card.
- **Skip:** "Patient pipeline" 5-stage visual (Pre-auth → Settled) — depends on `claims.latest_status`, currently unused.
- **Skip:** "Needs attention" feed — new aggregation.
- **Skip:** Top panels by volume table — new aggregation.

#### D3. `pages/hospital/Panels/index.tsx` → wireframe `hw-panels` (already shipped: Overview / Configure subtabs + PanelsFleetTable)
- Already migrated last week. Keep as-is.
- **Skip:** "Last probe" column + real connectivity probe Health values — Phase F future.

#### D4. `pages/hospital/PanelDetails/index.tsx` (per-panel patient list, `/portal/:id/panel/:panelId`) → wireframe `hw-patients` (visual treatment, columns trimmed)
- **Keep:** Patient table for that panel: name, IPD #, admit date, discharge date, claim amount. Same `PatientTable.tsx` columns. Click row → opens existing `PatientModal` for edit.
- **Visual:** Wireframe's patient row layout.
- **Skip:** Status pill column — no `claims.latest_status` value yet. Defer.
- **Skip:** "Docs" count column — would require a new aggregate. Defer.
- **Skip:** "Last action" column — no audit/activity log. Defer.
- **Skip:** Status filter pills row at top — no status field. Defer.
- **Skip:** "Save view" link — no saved-views feature.
- **Skip:** Bulk-select export / re-assign / send reminder — no bulk-action feature.
- **Skip:** Workspace tab strip (Overview / Patients / Reports) — there's only one tab today (patients). Defer the Reports / Overview tabs.

#### D5. `pages/hospital/Users/index.tsx` → wireframe `hw-users`
- **Keep:** Existing columns (user · contact · panel access · status). AddUserModal (existing).
- **Visual:** Wireframe's row layout with panel chips.
- **Skip:** "Last sign-in" column — `users.last_login` exists; surface only if the API trivially exposes it.
- **Skip:** "Role flags" pills (admin, edit, discharge) — these flags exist on `hospital_assignments`, not on `hospital_users`. The flag concept here is fuzzy; for migration just show what today's `UserRow.tsx` shows.

#### D6. Patient detail — **NOT a new page** for migration
- **Today there is no patient-detail page.** Patient editing happens entirely through `PatientModal` (a centred modal in `components/modals/PatientModal.tsx`).
- **Migration outcome:** Keep `PatientModal` as the only patient-edit surface; visually upgrade it to the new modal pattern (use wireframe M9 as the spec).
- **Skip:** All of `hw-patient-detail` (Overview, Documents, Claim, Timeline, Notifications tabs) — this is a new surface in the wireframes. **Defer the whole patient-detail page**.
- **What about photos?** Keep the existing `PatientPhotosModal` (a separate modal triggered from the patient row). It already does the category-bucket view (admission / discharge conservative / discharge surgical). Visual upgrade in place.

#### D7. `pages/panels/index.tsx` (legacy SA path: `/hospital/:id/panel/:id`) → same as D4
- Same `PatientTable.tsx` rendering. One visual update covers both.

### E. Doctor self-service — Phase E

#### E1. `pages/doctor/DoctorProfilePage/index.tsx` → wireframe `dr-profile`
- **Keep:** Four existing sub-tabs: Profile, Credentials, Hospital Affiliations, Public Sharing. Components `ProfileForm.tsx`, `CredentialsManager.tsx`, `HospitalAffiliations.tsx`, `PublicSharingManager.tsx` (the doctor's, not the hospital's). Same CRUD endpoints.
- **Visual:** Wireframe's row-tables grouped by category, with chip filters.
- **Skip:** Cross-hospital roster integration ("Doctor cross-hospital affiliations show here too") — already in the codebase, just rendered in the new visual.
- **Skip:** Public-profile view counter ("Public profile · 18 views (30d)") — `doctor_share_tokens.view_count` exists; surface only if the existing API method returns it (verify before assuming).

#### E2. `components/DoctorDetailsTabs/` (admin-editing-a-doctor modal) → kept as-is, visual upgrade only
- **Today:** `DoctorDetailsModal.tsx` (admin path) + the new `CredentialsTab/` folder + the legacy `CredentialsTab.tsx` (1036 LOC).
- **Migration scope:**
  - Delete the legacy `CredentialsTab.tsx` (confirmed unused per [TECH_DEBT P1-16](../TECH_DEBT.md)).
  - Visual upgrade for the surviving DoctorDetailsModal + CredentialsTab folder.
- **Skip:** The "consolidate three credential UIs into one" rewrite from `TECH_DEBT P2-5` — that's a refactor, not a migration. Defer.

---

## 5. Modal-by-modal mapping

Each existing modal: keep all fields, swap to the new modal-shell pattern (see wireframe M1–M26).

| Existing modal | Wireframe spec | Migration notes |
|---|---|---|
| `LoginPage` (page, not modal) | `login` | New card-on-gradient; same fields. |
| `AddHospitalModal` | M5 | Hospital name, City, Hospital type, Google Drive folder ID. All existing fields. |
| `AddPanelModal` | M6 | Panel name. **Skip** Type, Short code on the wireframe — those columns don't exist in `panels` schema today. |
| `LinkPanelModal` | M7 | Panel multi-select with search. Same selection payload. |
| `AddUserModal` (role=admin) | M1 | First, Last, Username, Password, Email, Phone. Same payload. |
| `AddUserModal` (role=hospital) | M2 | + Roles (panels multi-select) — already shipped last week. |
| `AssignmentModal` | M3 | Hospital select + can_view / can_edit / can_discharge checkboxes. |
| `PatientModal` (create) | M9 | First, Last, Age, Gender, Phone, Admitted at, Panel, Beneficiary ID, Bed type, Treating doctor, Notes. **Skip** the "Pre-auth case number" field on the wireframe if not in current form. |
| `PatientModal` (edit) | same M9 (edit mode) | Pre-fills with existing patient. **Skip** the side-drawer pattern from wireframe `hw-patient-edit` — keep as a centred modal. |
| `PatientPhotosModal` | M12 (lightbox visual) | Existing category navigation + grid + per-photo actions stays. Geo-stamp display is **kept** (it's already present on captured photos via the mobile app). |
| `AddDoctorModal` | M19 | First, Last, NMC, Email, Phone, Primary specialty, Employment type, Department. **Skip** the "Lookup by NMC first" affordance shown in the wireframe — if the existing modal doesn't have it, defer. |
| `DoctorDetailsModal` | (no dedicated modal mock; this is a full inline modal) | Three tabs: Personal Info, Hospital Assignment, Credentials. Visual upgrade only. |
| `DoctorDocsModal` | M21 | File list with view/download/delete. |
| `AddCredentialDialog` | M20 | Credential type, issued, expires, issuing institution, certificate file. |
| `CreateOptionModal` (master options) | M17 | Code, Label, Description, Sort order. |
| `EditOptionModal` | M18 | Same fields, edit mode. + Active toggle. |
| `DeleteConfirmModal` (master options) | M25 (destructive confirm pattern) | Re-use across other delete actions in the migration. |
| `FilePreviewModal` | M23 | PDF/image viewer with paginator + zoom + download. |
| **PublicSharingManager → Generate share link** | M22 | Audience label, Expires, Max views, Sections visible checkboxes, Auto-enable toggle. |

**Confirm before migrating each:** read the current modal source to verify the field list. Don't trust the wireframe alone — the wireframe shows the *intended* form, but the migration must preserve the *actual* form.

---

## 6. Deferred wireframe elements — explicit revisit list

Every visual element in the wireframes that is **NOT** going into this migration. Each one is a future ticket, not lost work.

### 6A. Status state machine (whole category)
| Wireframe element | Why deferred | Reopens with |
|---|---|---|
| Patient list status pills (All / Pre-auth / Approved / Admitted / Submitted / Queried / Settled / Rejected) | `claims.latest_status` enum unused; no UI today | Phase C (IPD status pipeline) of `UI_REVAMP.md` |
| "Status" column on every patient row | same | same |
| "Move to Approved →" status pipeline button on patient detail | same | same |
| Status transition modal (M11) | same | same |
| Time-in-stage indicators ("SLA breach 58h", "9 days", etc.) | requires `claim_status_history` table — not built | same |
| "Last action" column on patient list | requires audit/activity log | needs new event log table |

### 6B. Aggregations & rollups (Dashboard chrome)
| Wireframe element | Why deferred | Reopens with |
|---|---|---|
| "Pending verification" KPI | requires verification status rollup across attributes | new aggregation endpoint |
| "Expiring <30d" KPI | requires expiring docs rollup | same |
| "Settled this week" KPI | requires settlement aggregation | needs claim status data first |
| "Hospital health" rollup table on Dashboard | mix of profile %, expiring, verification — none aggregated today | block on the above |
| "Needs attention" feed | requires multi-source aggregation | block on the above |
| "Quick actions" panel | overlap with existing top-right buttons | low priority |

### 6C. New surfaces (whole pages)
| Wireframe element | Why deferred | Reopens with |
|---|---|---|
| `hw-patient-detail` (full patient detail page with Overview/Docs/Claim/Timeline/Notifications) | doesn't exist today; current flow is modal-only | Phase C of `UI_REVAMP.md` (state machine + patient page combined) |
| `hw-patient-edit` (side drawer) | same — keep PatientModal | same |
| Cross-hospital Doctor roster (the wireframe's old `sa-doctors`) | no equivalent SA page today; doctors managed per-hospital | new SA-doctors route + endpoint |
| Validators screen | backend ready (`validator_profiles`, `verification_visits`), no UI | Phase E of `UI_REVAMP.md` |
| Audit log screen | `audit_logs` table doesn't exist (TECH_DEBT P1-6) | needs P1-6 first |
| Reports landing + 6 standard reports | bundle has `xlsx/jspdf/exceljs` but no Reports route | Phase E of `UI_REVAMP.md` |
| Scheduled exports | no scheduler; no recipient model | block on reports |

### 6D. IA reorganisations
| Wireframe element | Why deferred | Reopens with |
|---|---|---|
| Hospital Workspace "Operations / Configuration" mode toggle | new IA; today's IA uses separate routes | Phase B of `UI_REVAMP.md` |
| Workspace unified URL `/admin/hospitals/:id` replacing legacy + portal | route refactor, not a re-skin | same |
| Public Directory toggle between Hospitals + Doctors | unifies two existing routes; pure IA change | low priority |
| 6-tab Configuration strip (Hospital profile · Hospital attributes · Panel · Doctors · Users · Public sharing) | adds Users into Profile page; today Users is a separate `/portal/:id/users` route | re-evaluate after migration |

### 6E. Connectivity / probes
| Wireframe element | Why deferred | Reopens with |
|---|---|---|
| Panel "Health" column with real probe ("200 OK · 412ms") | no probe service today; current Health is completeness-only | Phase F of `UI_REVAMP.md` |
| "Last probe" column | same | same |
| "Refresh probes" button | same | same |

### 6F. Doc actions
| Wireframe element | Why deferred | Reopens with |
|---|---|---|
| "Generate combined PDF" on patient docs | `jspdf` in bundle, no integration | small ticket later |
| "Build combined packet PDF" | same | same |
| "Download profile PDF" on public hospital profile | same | same |

### 6G. Power-user features
| Wireframe element | Why deferred | Reopens with |
|---|---|---|
| ⌘K global search | no search backend | future |
| Saved views | no persistence backend | future |
| Bulk-select on patient list + export/re-assign/send-reminder | no bulk-action API | future |
| Drag-to-reorder on Master Options | sort_order exists, but no drag UI | small ticket |

### 6H. Cosmetic-only deferrals
- **Inter font** — fine to ship in Phase A.
- **Dark mode** — ship the tokens + a working toggle; if QA pushes back on dark mode coverage, ship light-only and dark mode lands in a follow-up sprint.
- **Tabular numerics** — apply to all numeric columns; low risk.

---

## 7. Phasing — recommended order

| Phase | What | Duration estimate | Why this order |
|---|---|---:|---|
| **A** | Foundation: tokens, shell, dedup, login | 1 sprint | Everything else needs these. |
| **B** | Public surfaces (Login, RegisterDoctor, HospitalDirectory, DoctorDirectory, PublicHospitalProfile, PublicDoctorProfile) | 1 sprint | Lowest risk: no auth, read-mostly, low traffic. Battle-tests the new components. |
| **C** | Superadmin portal (SuperAdminPage all 8 tabs + HospitalDetailsPage + MasterOptionsManager) | 2 sprints | High user value; the SA team is internal so easier to coordinate rollout. |
| **D** | Hospital portal (HospitalPortalLayout + Dashboard + Panels + PanelDetails + Users + Profile 5 sub-tabs) | 2 sprints | Highest user count; coordinate with hospital users; do during a low-claim-volume window. |
| **E** | Doctor self-service (DoctorProfilePage 4 sub-tabs + DoctorDetailsModal + AddCredentialDialog) | 1 sprint | Smallest surface, lowest user count. |

**Total: ~7 sprints.**

Within each phase, sequence is: read existing source → confirm field list → render new visual → swap → smoke test → ship behind a route-level feature flag → roll out gradually.

---

## 8. Acceptance checklist (per phase)

Every PR in this migration is mergeable only if:
- [ ] No new API endpoint, no schema change.
- [ ] No new form field added or removed.
- [ ] Every action that worked before works (CRUD on the relevant entity verified manually).
- [ ] `window.alert` replaced with toast where touched.
- [ ] Components used: only from `@/components/ui/*`. No raw HTML inputs except where wrapped.
- [ ] Lint passes (TECH_DEBT P0-10 fixed in Phase A).
- [ ] Type-check passes (`tsc --noEmit`).
- [ ] Sonner toaster reachable from the migrated surface.
- [ ] Visual diff against the wireframe screen is "close enough" — not pixel-perfect, but the layout shape, colour usage, and density should match.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Migration touches every page → high blast radius | Route-level feature flag per phase. Roll out per role / per hospital. |
| ESLint disabled today (TECH_DEBT P0-10) hides regressions | Fix in Phase A before any other migration work. |
| `tsconfig` `strict:false` means type regressions silent (P1-1) | Don't tighten in this migration. Leave for a separate cleanup. |
| Inline business logic in 1500-LOC managers makes visual swaps fragile | Migration is "edit in place" per file, not a rewrite. Don't split components in this pass. |
| `flexible-dialog` vs `dialog.tsx` codemod could miss edge cases | Run a `git grep` audit after the codemod; manual smoke test of each affected modal. |
| Dark mode QA misses surfaces (we have no a11y testing today) | Ship Phase A with a "Dark mode beta" disclaimer on the toggle if needed. |
| Hospital users notice missing features that wireframes show ("where's the status pipeline?") | Don't ship the wireframes as-is. Communicate clearly: visual upgrade now, status pipeline later. |

---

## 10. What this plan does **not** include

- Backend changes of any kind (no new endpoints, no migrations, no new columns).
- Mobile app work — separate proposal.
- New tests — keep existing test coverage (which is approximately none); a separate testing initiative.
- Accessibility audit — separate work; design tokens make it easier when we get there.
- Performance optimisation — separate work.

---

## 11. Sign-off

Before any PR opens for this migration, sign-off needed on:
1. The deferred list in §6 is complete and acceptable (i.e., you agree no real-app feature is being lost).
2. The phasing in §7 fits the team's calendar.
3. The acceptance checklist in §8 is what reviewers will enforce.

Once signed off, this doc becomes the source of truth for migration PRs. Anything outside §3–§5 is out of scope; anything in §6 explicitly stays out unless re-prioritised in a follow-up.
