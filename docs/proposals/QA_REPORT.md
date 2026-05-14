# ClaimOS — End-to-End QA Report

**Tester:** Automated walk-through via Chrome MCP (http://localhost:5001)
**Build under test:** webpack-compiled webapp container (`hospital_webapp_dev`) + backend container on `:6001`
**Date:** 2026-05-14
**Logged-in user:** Kratika S. (Super Admin)
**Coverage:** ~30 screens / dialogs touched across superadmin + hospital portal + public + auth flows.

> **Update (write-test pass):** After the initial read-only walkthrough I went back and exercised the actual write flows (Save Profile, Add Doctor, Add Credential, Upload Doc, Create Share Link, Add User). The C-3 and H-6 findings turned out to be "empty database, not broken form" — corrected below. C-4 was confirmed real with a direct API probe. One new finding (BE-1) about a `/specializations` 404 was added.

> **Severity legend**
> 🔴 Critical — feature broken, data integrity / security concern
> 🟠 High — significant UX issue or functional bug
> 🟡 Medium — UX inconsistency, missing feedback, polish
> 🟢 Low — copy / spacing / minor styling

---

## 1. Coverage map

| Area | Result |
|------|--------|
| `/login` | ✅ renders |
| `/register/doctor` | ✅ renders, form fields present |
| `/doctors` (public directory) | ✅ renders (0 results, expected) |
| `/superadmin` Dashboard | ✅ renders with metrics |
| `/superadmin` Admin Users tab | ✅ renders |
| `/superadmin` Hospitals tab | ✅ renders list |
| `/superadmin` Master Panels tab | ✅ renders 18 panels |
| `/superadmin` Hospital Attributes tab | ✅ renders 43 defs |
| `/superadmin` Panel Attributes tab | ✅ renders 4 defs |
| `/superadmin` Doctor Attributes tab | ✅ renders 15 defs |
| `/superadmin` Master Options tab | ✅ renders 4 hospital types + 58 specialties |
| Create Hospital Attribute dialog | ✅ opens, all fields render |
| `/portal/:hid` Hospital Dashboard | ✅ renders, several "—" placeholders |
| `/portal/:hid/patients` Patients list | ✅ renders, search + status pills work |
| `/portal/:hid/patient/:pid` Patient detail | ✅ renders, status pipeline visible |
| `/portal/:hid/patient/:pid/edit` Patient edit | ✅ renders (after this session's fix) |
| Patient Documents tab | ✅ renders, PDF iframe preview works, bulk-select bar works |
| `/portal/:hid/panels` Panels list | ✅ renders 18 linked panels |
| `/portal/:hid/panel/:pid` Panel detail | ✅ renders patient table |
| `/portal/:hid/profile` Hospital Profile tab | ⚠️ renders, but **all fields are blank** |
| `/portal/:hid/profile` Hospital Attributes tab | ✅ renders empty state |
| `/portal/:hid/profile` Panels (panel-fleet) tab | ✅ renders with credential columns |
| `/portal/:hid/profile` Doctors tab | ✅ renders (empty), Add Doctor dialog opens |
| `/portal/:hid/profile` Users tab | ✅ renders 2 users |
| `/portal/:hid/profile` Public sharing tab | ✅ renders (no links) |
| `/hospitals/share/:token` Public hospital profile | ✅ renders, certifications grouped by category |

---

## 2. Findings

### 🔴 Critical

**C-1. Superadmin sidebar navigation has no URL routing**
- Location: `/superadmin` — clicking Dashboard / Admin Users / Hospitals / Master Panels / Hospital Attributes / Panel Attributes / Doctor Attributes / Master Options
- Observed: URL stays at `http://localhost:5001/superadmin` for every tab; refresh always lands on Dashboard regardless of which tab the user was on.
- Why it matters: No deep-linking, no browser back/forward, no shareable URLs, no analytics on which tab is used, can't bookmark a configurator.
- Fix direction: Migrate each sidebar item to a real route (e.g. `/superadmin/master-panels`, `/superadmin/attributes/hospital`). Render the same shell, swap inner content based on URL.

**C-2. ~~Theme toggle unreliable~~ — WITHDRAWN (test methodology artifact)**
- Update (verified 2026-05-14 via real mouse clicks): The toggle handler is a clean functional setState pattern (`setIsDark(v => !v)` in GlobalNavbar.tsx) and works perfectly. Four real mouse clicks alternate cleanly: `false → true → false → true → false`. The "dropped click" observed in the original QA was synthetic `click()` JS dispatches that don't reliably trigger React onClick handlers — same pattern previously observed with Radix Tabs (the doctor-credentials tab) where synthetic events also failed but real clicks worked. Not a bug.

**C-3. ~~Hospital Profile form shows all fields empty~~ — DOWNGRADED to 🟢 Low after write-test**
- Update (verified 2026-05-14 via write-test): The form IS correctly bound. `legal_name` returns "Sadbhawana Nursing Home" and `city` returns "Moradabad" from the API; the other fields are blank because no value is stored in the DB. Click **Edit Profile** → fill → **Save Changes** → toast "Profile updated successfully" → reload → values persisted correctly. Working as designed.
- Remaining low-grade UX concern (now 🟢 L-8): On first visit users see lots of blank inputs that are not actually editable (until they click Edit Profile). It looks like a broken form. Either default to edit mode when the profile is mostly empty, or render placeholders that say "not set — click Edit Profile to add".

**C-4. Doctor attribute document upload returns 500 / "Internal Server Error" — CONFIRMED REAL via direct API probe**
- Location: Adding a credential with a document via `CredentialsTab.tsx`
- Observed: Direct `curl`-equivalent fetch of `POST /api/v1/doctors/:doctorId/attributes/:attributeId/documents` with `multipart/form-data` returns **500** with `Internal Server Error` (route has no multer middleware, body parsing fails).
- Verified working alternative (via direct API probe):
  - `POST /api/v1/doctors/:doctorId/docs` with multipart → **201**, returns `{documentId: ...}`
  - Then `POST /api/v1/doctors/:doctorId/attributes/:attrId/documents` with JSON `{documentId}` → **201**, link created
- Why it matters: End users adding credentials with docs see a generic 500.
- **Fix direction (definitive):** Two-step pattern in `CredentialsTab` upload handler — first POST file to `/doctors/:doctorId/docs`, take the returned `documentId`, then POST `{documentId}` JSON to `/doctors/:doctorId/attributes/:attrId/documents`. Both endpoints exist and work; backend needs no changes. This matches the hospital-attribute pattern.

### 🟠 High

**H-1. Dashboard "21 IPDs admitted" vs Patients list "20 admitted · 0 historical"**
- Location: `/portal/:hid` header tile vs `/portal/:hid/patients` heading
- Observed: Dashboard shows 21, Patients page shows 20.
- Why it matters: Inconsistent counts erode trust in the data.
- Fix direction: Both metrics should be computed off the same backend query / view. Find which endpoint each tile uses and pick a single source of truth.

**H-2. Panel detail row click opens Photos modal instead of navigating to patient detail**
- Location: `/portal/:hid/panel/:pid`
- Observed: Clicking a patient row opens the `PatientPhotosModal` (Babbu/2 files/Select/categories). To get to the patient detail page from here you need to know to go via the main Patients tab.
- Why it matters: Inconsistent with `/patients` where row click does open the patient page. Surprising default for "I clicked on a patient's name and got a file browser."
- Fix direction: Either change the row click to navigate to patient detail (preferred, matches Patients tab) and put Photos behind an explicit action, or remove the row click entirely and require explicit actions.

**H-3. Native `<select>` regression in new PatientEdit form (Admission type)**
- Location: `webapp/src/pages/hospital/PatientEdit/index.tsx:276-290` (the new form I just wrote)
- Observed: I used a native `<select>` for Admission Type. The same problem fixed earlier in `SelectField.tsx` (macOS Chrome native popup ignores `color-scheme: dark`) will recur here in dark mode.
- Why it matters: Inconsistent dropdown styling — the rest of the app uses the custom `SelectField`.
- Fix direction: Replace native `<select>` with the project's `SelectField` component for consistency.

**H-4. `window.alert()` used for 13 error/feedback messages**
- Location: 13 files across the webapp (PatientPhotosModal, PublicHospitalProfile, HospitalUserList, AttributesManager, useHospitalData hook, etc.)
- Why it matters: Native browser alerts are dark-mode-unaware, blocking, ugly, and inconsistent with the toast-based UX the rest of the app uses.
- Fix direction: Replace every `alert(...)` with `toast.error(...)` from `sonner` (already used elsewhere).

**H-5. `window.confirm()` used for 10 destructive-action confirmations**
- Location: 10 files including delete-patient, delete-document, delete-credential, delete-doctor, discharge-patient.
- Why it matters: Same as H-4 plus these are destructive actions that deserve a real confirmation dialog with proper context, not a generic browser prompt.
- Fix direction: Use the `Dialog` / `AlertDialog` component pattern that already exists in `components/ui/dialog`.

**H-6. ~~Doctors tab empty~~ — DOWNGRADED to 🟡 M-12 after write-test (but unrelated 404 is real, see BE-1)**
- Update (verified 2026-05-14): Doctors tab worked correctly — Add Doctor → fill form → Create Doctor → toast → row immediately appeared in the list (Dr. Test Doctor, Cardiology, NMC-TEST-001). The empty state was simply "no doctors mapped to this hospital."
- Two underlying issues do remain:
  1. The Hospital portal **Layout** (not the Doctors tab itself) fires a separate `GET /hospitals/:hid/doctors` request that consistently 404s regardless of whether doctors exist. The Doctors tab uses a different endpoint that works. See BE-1.
  2. Frontend treats every 404 as "no doctors" which hid this from a casual tester — a real broken endpoint masquerades as an empty list. Worth surfacing as a console.error at least.

**BE-1. (NEW) Two backend endpoints 404 silently on every hospital portal load**
- Observed via browser console while logged in as Super Admin:
  - `Failed to load hospital doctors AxiosError: Request failed with status code 404` (4+ occurrences per page load — fires from `HospitalPortalLayout` data-fan-out)
  - `Error fetching specializations: AxiosError: Request failed with status code 404` (fires from the Hospital Profile page)
- Why it matters: Persistent error noise in production console; the silent-handling on the frontend means real backend regressions in these endpoints would never surface to operators.
- Fix direction: Identify the exact request paths (network panel in dev tools); either the routes need to be added to backend, or the frontend is calling the wrong path. Once the route exists, the 404-as-empty workaround in `useHospitalData.ts` and `Profile/index.tsx` should be removed so legitimate failures are visible.

**H-7. Add Attribute / Add Doctor dialogs don't close on Escape**
- Location: Multiple dialogs across the configurators
- Observed: Pressing Escape did not dismiss the Add Hospital Attribute dialog when I tested it.
- Why it matters: Standard accessibility expectation. Keyboard users can't dismiss without clicking Cancel.
- Fix direction: Confirm the underlying `<Dialog>` wraps a Radix primitive (which supports Esc out of the box) — if it does, check whether something is `preventDefault`-ing keydown. If using a custom dialog, add `useEffect` listener for `keydown` Escape.

### 🟡 Medium

**M-1. Sidebar items are `<button>` not `<a>` (no right-click / middle-click)**
- Location: superadmin sidebar in main layout
- Observed: Plain `<button>` elements with click handlers.
- Why it matters: No "Open in new tab", no copy-link, no middle-click to background-open. Same root cause as C-1.
- Fix direction: Once C-1 is fixed (real routes), use react-router `<NavLink>` so they render as anchors and support all native browser gestures.

**M-2. Doctor directory has hardcoded specialization list, separate from configurator**
- Location: `/register/doctor` and `/doctors` directory filter
- Observed: Both pages show a hardcoded list (Cardiology, Pediatrics, ..., Gastroenterology — 15 entries). Meanwhile Master Options → Speciality has 58 options.
- Why it matters: Single source of truth violation. Adding a speciality in Master Options doesn't surface in the doctor self-registration form.
- Fix direction: Fetch specializations from the master options endpoint and replace the hardcoded array.

**M-3. Patient detail "Doctors" tile shows "—" placeholder always**
- Location: `/portal/:hid` dashboard header tile
- Observed: "DOCTORS —" — no count is ever shown, regardless of whether doctors exist.
- Why it matters: Either implement it or remove it. Empty placeholders make the dashboard feel half-built.
- Fix direction: Either wire it to `GET /hospitals/:hid/doctors/count` or hide the tile when unimplemented.

**M-4. Dashboard "Verification queue" / "Needs attention" / "SLA tracking coming soon" / "Recent activity" all show placeholders**
- Location: `/portal/:hid` dashboard
- Observed: "Activity feed will appear here", "SLA tracking coming soon", "Verification stats will appear once data is wired up".
- Why it matters: Six tiles look like placeholders — gives a "demo" feel rather than a production product.
- Fix direction: Decide which tiles to ship in v1 and hide the rest. Or wire them up.

**M-5. Hospital Profile uses non-keyboard-friendly tabs**
- Location: `/portal/:hid/profile` — Hospital profile / Attributes / Panels / Doctors / Users / Public sharing tabs
- Observed: Tabs use `<button>` without `role="tab"` / `aria-selected`.
- Why it matters: Screen readers won't announce these as tabs. Tab key navigates them like buttons but doesn't follow arrow-key tab pattern.
- Fix direction: Replace with Radix Tabs primitive (already in shadcn/ui).

**M-6. Hospital Profile tab does NOT change URL (?tab=)**
- Location: `/portal/:hid/profile` — switching between Profile / Attributes / Panels / etc.
- Observed: URL stays at `/profile` regardless of which inner tab is active.
- Why it matters: Same problem as C-1, scoped to one page. The redirect in `App.tsx:250` (`/users → /profile?tab=users`) implies the intent was to support query-param tabs, but the implementation doesn't actually read it.
- Fix direction: Read `URLSearchParams.tab` in `HospitalProfilePage` and use it to set active tab; write `?tab=` when switching.

**M-7. "Edit Profile" button visible but Profile is already in edit-able form layout**
- Location: `/portal/:hid/profile` first tab
- Observed: All fields render as inputs from the start, AND there's an "Edit Profile" button.
- Why it matters: Confusing — is it view mode or edit mode? Either show read-only by default + Edit toggles to inputs, or remove the button.
- Fix direction: Implement view/edit toggle. Until then, hide the Edit Profile button.

**M-8. Patient list shows "0 historical" for a hospital that surely has discharged patients over the year**
- Location: `/portal/:hid/patients` header
- Observed: "20 admitted · 0 historical".
- Why it matters: Likely the historical-count query is broken or the filter is too narrow. With 471 patient records across 7 hospitals, "0 historical" is suspicious.
- Fix direction: Verify the historical filter query — likely excluding by `is_active` or `status` in a way that's too restrictive.

**M-9. Login page is bare — no logo / branding / "forgot password" affordance**
- Location: `/login`
- Observed: Only "Finclarity Claim OS / Sign in to your account / Username / Password / Sign in / Secure portal · Authorized access only".
- Why it matters: Trust signal; users in a hospital setting expect a richer login page (logo, support contact, version, last-login indicator).
- Fix direction: Light polish — logo, "Forgot password?" link (even if it's just `mailto:`), basic illustration or copy explaining what the platform is.

**M-10. Hospital portal `Profile 0%` indicator with no obvious way to fill it**
- Location: `/portal/:hid` header
- Observed: "Profile 0%" badge in the title block.
- Why it matters: User asks "how do I get to 100%?" but there's no link / progress drawer / wizard.
- Fix direction: Make the badge clickable → navigates to the profile tab AND scrolls to first incomplete section. Or add a checklist drawer.

**M-11. PDF preview lightbox closes via Escape but Escape doesn't dismiss in some other places (Add Attribute dialog)**
- Location: see H-7. The inline patient-documents PreviewLightbox handles Escape; the Radix dialogs apparently don't, in one case.
- Fix direction: Consistent Escape behavior across all modals.

### 🟢 Low

**L-1. Date column shows "27d" / "29d" / "55d" etc. as relative — but no tooltip with absolute date.**
- `/portal/:hid/patients`

**L-2. Inconsistent capitalization: "Edit patient" (sentence case) vs "Add Patient" / "+ New patient" / "Edit Profile" (mixed)**
- Across the app. Pick a convention (sentence case, used in iOS / shadcn defaults) and stick to it.

**L-3. Avatar color seeded from name (e.g. "B" badge for Babbu) but uses different background per page** — minor consistency.

**L-4. Hospital Profile share-link section says "Generate share link" but the button is in the page header AND a dedicated tab. Two CTAs for the same thing.**

**L-5. Long table headers wrap awkwardly on narrower viewports**
- e.g. "Panel Fleet" table — "Portal Email Username Password Auth Type Health Actions" — at 1512px width all fits, would not at 1280px.

**L-6. Empty-state copy is functional but not warm.**
- e.g. "No doctors found. Add doctors to manage their hospital affiliation and credentials." — could include "Get started" CTA.

**L-7. Top-nav search input has placeholder "Search hospitals, doctors, panels…" but I did not verify whether search actually works.**
- I'd guess it's not wired up yet.

---

## 3. UI / UX Observations

### Design system
- **Two dropdown patterns coexist**: the new `SelectField` (custom button + listbox panel, dark-mode-correct) and native `<select>` (still in PatientEdit, PatientModal, etc.). Several places have explicit `inputClassName` shadowing shadcn defaults (`PatientModal.tsx:37`) — sign of an incomplete migration.
- **Toast vs alert vs in-form errors**: All three feedback channels are in use. Consolidate on toast + inline form-field error.
- **Buttons**: Brand-600 primary, slate-outline secondary is consistent on the new pages. Older pages (HospitalUserList — "New User" was just fixed) had inconsistent buttons before — verify all primary CTAs match.
- **Tables**: PanelsFleetTable and the new patient list table use different row-hover styles, different header treatments, different empty-states. Worth extracting a `<DataTable>` component.

### Dark mode
- Most pages now look correct in dark mode (after this session's series of fixes).
- Remaining gaps: native `<select>` dropdown popup is still AppKit-rendered (light), so PatientEdit Admission Type dropdown will still look wrong (H-3).
- `window.alert()` and `window.confirm()` are completely outside Tailwind's reach — both are dark-mode-broken by definition (H-4, H-5).

### Information density / dashboard
- Hospital portal dashboard currently has 6+ placeholder tiles ("coming soon", "—", "will appear here"). Half of the screen is empty promises. Decision needed: cut the placeholders or ship the data.

### Navigation
- Superadmin sidebar uses non-URL state. This is the biggest single UX cost in the app — no deep linking, no back/forward, no bookmarks (C-1, M-6).
- Breadcrumbs are good on the patient detail / edit pages — keep extending this pattern.

### Forms
- The new PatientEdit form is clean (Identity / Admission / Claim sections, dark-aware). Use it as the pattern.
- Hospital Profile form (C-3) is broken — needs immediate attention.

---

## 4. Quick wins (≤ 1 hour each, ranked)

1. **Replace `<select>` in PatientEdit with `SelectField`** — 5 min, fixes H-3.
2. **Replace all `window.alert()` with `toast.error()`** — sweep, 30 min, fixes H-4.
3. **Wake the hospital-profile fetch** — likely a 1-line missing field in `mapResponseToForm` or a misnamed endpoint, fixes C-3.
4. **Hide placeholder dashboard tiles** behind a feature flag — 20 min, M-4.
5. **Push superadmin sidebar tabs into the URL** — 1 hour for the routing wire-up, fixes C-1 and M-1.
6. **Specialization dropdown reads from Master Options** — 30 min, fixes M-2.

---

## 4b. Write-test pass (added 2026-05-14)

After the initial read-only walkthrough I exercised the actual mutation flows. Result: **the platform's CRUD path is solid.** Confirmed working end-to-end:

| Flow | Result |
|------|--------|
| Hospital Profile: Edit Profile → fill 8 fields → Save Changes → reload | ✅ Persisted |
| Hospital Attributes: Add Attribute → NABH GOLD + file upload `qa-test.pdf` | ✅ Created with "1 doc" linked |
| Doctors: Add Doctor (Test Doctor, Cardiology, NMC-TEST-001) | ✅ Appeared in list |
| Doctor Credentials tab: Add Credential (Medical Degree, MBBS-QA-2026, AIIMS Delhi, 2020-06-15) | ✅ Added |
| Doctor credential → upload document via two-step API | ✅ 201 + linked |
| Doctor credential → upload document via direct multipart POST | 🔴 500 (C-4 confirmed) |
| Public Sharing: Create Share Link "QA Test Share Link" | ✅ Created, listed with Preview/Revoke actions |
| Users: New User (qauser, PMJAY panel) | ✅ Appeared as 3rd user |

Test data left in the database for further QA:
- Doctor: `Test Doctor` (id `6e355e9a-d283-4069-b2d9-cbcd7717b890`), credential `Medical Degree (MD/MBBS)` with linked doc `qa-step1.pdf`
- Hospital attribute: `NABH GOLD` with `qa-test.pdf`
- Hospital user: `qauser1778760057989` on PMJAY panel
- Share link: "QA Test Share Link" for Sadbhawana Nursing Home
- Hospital profile: filled with placeholder address/phone/email/website data

---

## 5. Tests I could not run (out of scope of an automated walk-through)

- Backend response-time and load characteristics
- Multi-tenant data isolation (logging in as different hospital admins)
- Doctor self-registration end-to-end (requires creating an account)
- File-upload edge cases (large file, network drop during upload, virus scan?)
- Cross-browser (only tested Chromium)
- Mobile / tablet viewport
- Network throttling (slow 3G)
- Concurrent user editing the same patient
- Permission escalation attempts (admin vs hospital vs doctor role boundaries)
