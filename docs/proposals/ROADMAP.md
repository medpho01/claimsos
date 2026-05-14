# ClaimOS — Next-Phase Roadmap

**Date:** 2026-05-14
**Source documents (read these alongside):**
- [QA_REPORT.md](QA_REPORT.md) — 27-screen browser walkthrough, ~30 findings
- [REVIEW_BACKEND.md](REVIEW_BACKEND.md) — ~103 findings, all with file:line citations
- [REVIEW_FRONTEND.md](REVIEW_FRONTEND.md) — ~90 findings, all with file:line citations

**Reader:** Eng lead / product owner planning the next 4–8 weeks of work.

---

## 1. TL;DR — what we actually have

A working but **half-finished** healthcare claims platform. The recent "UI Revamp" has shipped a strong new shell (brand palette, sidebar, hospital portal layout, semantic tokens, new patient flow) on top of an older codebase that has not been retired. The result is two architectures coexisting in the same repo, with several feature areas duplicating logic across both.

**What's working well:**
- Hospital portal navigation, patient list / detail / edit, document tiles + PDF iframe preview, bulk select / generate-PDF / download, master-options configurator, public hospital share, theme primitives.
- Backend handles 7 hospitals, ~471 patient records, 18 panels, daily real usage by Sadbhawana Nursing Home.

**What is genuinely broken or risky right now:**
- **Cross-tenant data access** is wide open on most new routes — any authenticated user can read/mutate any other hospital's data by changing a URL. **This is the single biggest item on this roadmap.**
- **XSS hole** in Word-doc preview (mammoth → `dangerouslySetInnerHTML`, no sanitization).
- **Hardcoded `localhost:8000` in 6 frontend files** breaks photos/PDFs/thumbnails in any environment that isn't literal localhost. (Patient documents tab on the new portal is fine; older flows are not.)
- **Doctor attribute document upload is broken** — frontend sends multipart, backend route has no multer middleware.
- **Hospital Profile form renders all fields blank** despite data existing in the DB.
- **Schema drift** — two doctor tables, two document systems, an `audit_logs` table the code writes to but no migration creates, dead validator tables, hospital-data exports checked into the migrations folder, no migration runner.
- **Native `window.alert()` (14×) and `window.confirm()` (10×)** for errors and destructive confirms across the app.
- **Theme toggle drops clicks** when used rapidly (state machine bug).

---

## 2. Cross-cutting themes (read these before the sprint plan)

These are the architectural shifts that ought to drive the next 8 weeks. Each shows up dozens of times across the three reviews.

### Theme A — Authorization is the foundation, and it's missing
On the backend, the new doctor/hospital-profile/panel-attribute/public-share/v2-upload routes use only `checkAuth` (any authenticated user). The legacy patient routes have `checkHospitalUserPermission` / `checkPatientEditAccess` — these were not extended to anything written after April. **There is no central authorization policy file**, so the easiest way to ship a tenant leak is to add `checkAuth` to a new route and move on, which is exactly the pattern in `Backend/src/Routes/doctor.routes.ts`, `hospitalProfile.routes.ts`, `panelAttribute.routes.ts`, and `publicShare.routes.ts`.

> **Action:** Build one `requireHospitalAccess(:hospitalId)` and one `requireDoctorAccess(:doctorId)` middleware that resolves the caller's hospital + role memberships and enforces them. Apply across every URL with those params. Document the rule in CONTRIBUTING. Until this lands, treat the system as **internal-trust-only** — do not market or open to external doctor self-registration.

### Theme B — Schema is the second foundation, and it's drifting
The migrations folder has 8+ files in awkward states: `_fixed` and `_rollback` siblings, two parallel doc systems (`hospital_doc` vs `hospital_documents`, `doctor_doc` vs `doctor_attribute_documents`), the `doctors` table exists twice with different shapes (`schema.sql:196` vs migration 005), an `audit_logs` table that code writes to but no migration creates, a `validator_*` family of tables created but never referenced, and `PRODUCTION_CREATE_PRAGATI_HOSPITAL.sql`-style hospital-data exports committed alongside structural migrations.

There is **no migration runner** — operators apply SQL by hand. Schema prefixing is inconsistent (`hospital.foo` vs `foo` depending on the file) and only works because `search_path=hospital` is set in `DB/db.ts`. Multiple `LIKE/ANY` queries cast `'admin'` to `uuid[]` and will crash on certain hospital_user role values.

> **Action:** Introduce Knex/Prisma/Atlas as the migration runner. Make the next migration consolidate to a single schema prefix (vote: keep `hospital.` everywhere). Audit and pick one document table per entity. Move data exports out of the migrations folder.

### Theme C — Two frontend architectures still coexist
The UI Revamp shipped `pages/hospital/{Layout,Dashboard,Patients,PatientDetail,PatientEdit,Profile,Panels,PanelDetails}` plus `pages/superadmin` with the new sidebar. The old `pages/superadmin/HospitalDetailsPage/` is officially deprecated — but its hook (`useHospitalData`) and components are live dependencies of the new pages. Killing the old tree without first relocating its survivors would break production. Meanwhile `pages/panels/` and `pages/hospital/Users/` are completely dead code (no inbound routes) but still in the build.

In components: `CredentialsTab.tsx` (1036 lines, old) and `CredentialsTab/index.tsx` (305 lines, refactor) both exist; Node resolves the file before the directory, so the refactor is dead code. `Skeleton` exists in two places. Three dropdown implementations coexist. The shadcn primitives are configured against `--primary` but ~70% of buttons hand-roll `bg-brand-600 hover:bg-brand-700` instead.

> **Action:** A short cleanup sprint to (1) relocate `useHospitalData` + its components out of the deprecated tree, (2) delete the dead `pages/panels/` and `pages/hospital/Users/`, (3) pick one of the two `CredentialsTab`s, (4) consolidate Select / Skeleton / Dialog primitives, (5) decide design-system path A (commit to shadcn primitives) vs path B (commit to utility classes). Recommended: **Path A**.

### Theme D — No central data layer
Every page does its own `useEffect → fetch → useState` lifecycle. Three separate hospital sub-pages fan-out across panels to build a patient list (N+1 fetches, page-1 only). The `HospitalDataContext` is a partial solution; its `refreshData` is a no-op stub. Master options are fetched per-component with no shared cache. Many fetch call sites bypass the axios refresh-token interceptor.

The bigger problem is **multiple sources of truth for the same entity**. Patients are loaded by 5 different pages, each with its own normalization. Editing a patient updates only the screen that did the edit; navigating elsewhere shows stale data.

> **Action:** Adopt TanStack Query (react-query) or SWR. Centralize URL+token at `services/api.ts` exports. Wire the existing-but-unused `apiTransformers.ts` into the axios response interceptor so snake↔camel is normalized at the boundary, not in JSX.

### Theme E — Browser-native dialogs and inline data fetches betray the UX system
14 `window.alert()` + 10 `window.confirm()` + a global Dialog override that blocks click-outside-to-close. The app has `sonner` toasts and shadcn `AlertDialog` already wired in but inconsistently used. The result: errors look ugly in dark mode (native popups don't respect `color-scheme: dark`), destructive actions get hidden behind a single browser prompt, and click-outside-to-close behavior doesn't work in form modals.

> **Action:** Codemod sweep — alert → toast.error, confirm → AlertDialog. Remove the global `onPointerDownOutside={preventDefault}` override.

### Theme F — TypeScript safety is essentially off
Frontend: `strict:false`, `noImplicitAny:false`, `strictNullChecks:false`, build script sets `DISABLE_ESLINT_PLUGIN=true SKIP_PREFLIGHT_CHECK=true CI=false`. 251 `: any`, 65 `as any`. Backend: `strict:false`, same anti-patterns plus ESLint isn't installed. Many of the bugs caught by review (null dereferences, missing-field returns, response-shape mismatches) would have been caught by `strict:true`.

> **Action:** Turn on `strict` incrementally. Re-enable `CI=true` and lint in the build. Use `// @ts-expect-error` to track known-bad spots while migrating.

### Theme G — Observability is missing
Backend: `console.log` everywhere with PII in log messages, no request IDs, no log levels, no rotation. `[DEBUG] Route ...` middleware adds noise on every request. Frontend: 252 `console.log` statements ship to production with emojis and `formData` payloads.

> **Action:** Pino (backend) + log redaction. Strip `console.*` in production builds (`babel-plugin-transform-remove-console`). Add a top-level frontend ErrorBoundary. Restrict the `/metrics` endpoint to internal.

---

## 3. Prioritized punch list

Severity reflects business risk × likelihood. Effort is rough person-hours.

### Sprint 0 — Stop the bleed (this week, ≤ 30 person-hours total)

These are surgical fixes for things that are leaking data, returning wrong results, or visibly broken.

| # | Item | Severity | Effort | Source |
|---|------|----------|--------|--------|
| 0.1 | Add `requireHospitalAccess(:hospitalId)` middleware and apply to **all** `/hospitals/:hospitalId/*` mutating routes (profile, attributes, documents, share-links). Same for `/doctors/:doctorId/*`. | 🔴 Critical | 6h | BE C1, C2, C3, H16, M31 |
| 0.2 | Sanitize Mammoth HTML output through DOMPurify before `dangerouslySetInnerHTML` in `FilePreviewModal.tsx:370`, OR move to sandboxed iframe. | 🔴 Critical | 1h | FE C1 |
| 0.3 | Fix doctor attribute document upload: choose two-step pattern (upload to `/doctors/:id/docs` → link by documentId) or add multer to existing route. Update frontend to match. | 🔴 Critical | 2h | QA C-4, BE C5 |
| 0.4 | Centralize `getApiV2BaseUrl()` in `services/api.ts`; replace 6 hardcoded `localhost:8000` constants. | 🔴 Critical | 1h | FE C2 |
| 0.5 | Fix `dischargePatient` SQL typo `hp,sheet_name` → `hp.sheet_name` in `patient.controller.ts:941`. | 🟠 High | 5m | BE H2 |
| 0.6 | Investigate the Hospital Profile blank-form bug — likely a snake/camel mapping issue in `pages/hospital/Profile/components/ProfileForm.tsx` or the GET endpoint isn't being called. | 🟠 High | 2h | QA C-3 |
| 0.7 | Cap `express.json()` body limit at 1–2 MB (currently 100 MB) in `app.ts:28`. | 🟠 High | 5m | BE quick-win |
| 0.8 | Remove `localStorage.clear()` on logout — use explicit `removeItem` for `accessToken` / `refreshToken` / `user` only. Stops theme + cache wipe. | 🟠 High | 15m | FE C5 |
| 0.9 | Replace inline `multer({ memoryStorage, 100MB })` in `doctor.routes.ts:12` and `hospitalProfile.routes.ts:12` with the central `multer.middleware.ts` (has MIME allowlist and lower size cap). | 🟠 High | 30m | BE C5 |
| 0.10 | Add `helmet()` middleware to backend. | 🟠 High | 5m | BE quick-win |
| 0.11 | Delete the v1 no-op `deletePhoto` / `deletePhotoForAdmin` in `uploads.controller.ts:419-461`, or redirect routes to v2. | 🟠 High | 30m | BE H8 |
| 0.12 | Fix the panel boolean coercion bug `value_boolean || null` → `value_boolean ?? null` in `panelAttribute.service.ts:486-488`. | 🟠 High | 5m | BE H11 |
| 0.13 | Add `if (result.rowCount === 0) throw new apiError(403)` guards in `auth.middleware.ts:332` and `patient.controller.ts:716` before dereferencing `row[0]`. | 🟠 High | 10m | BE C8 |
| 0.14 | Theme-toggle reliability: investigate the dropped-click bug in the top-nav toggle. | 🟠 High | 1h | QA C-2 |
| 0.15 | Replace native `<select>` for Admission Type in `pages/hospital/PatientEdit/index.tsx:276-290` with `SelectField`. | 🟠 High | 5m | QA H-3 |

**Outcome:** No new features. No more "your hospital's docs are downloadable by anyone with an account." No more silent data corruption. Theme works. Edit Patient is dark-mode-correct.

---

### Sprint 1 — Foundation (1–2 weeks)

Set the rails for the next quarter.

**1A. Auth & tenant isolation (continued from 0.1)**
- Build a single role + capability gate. Backend returns `/auth/me` with capability flags; frontend uses those, not the role string. (BE M3 + FE C6)
- Per-device refresh-token rotation. (BE M19)
- Server-side env-var validation with zod at boot, fail fast on missing JWT secret. (BE C9)
- Add `checkSuperAdminOrAdmin` to `verifyAttribute` / `setVerificationLevel` routes. (BE M31)
- Lock down `/metrics` endpoint. (BE L19)

**1B. Schema cleanup**
- Adopt Knex/Prisma migrations runner.
- Consolidate to one schema prefix (`hospital.`).
- Pick one document table per entity (delete `doctor_doc`, keep `doctor_attribute_documents` joining `hospital_documents`).
- Delete the dead `doctors` table from `schema.sql:196`; keep the migration-005 version.
- Delete the unused `validator_*` tables OR implement the validator feature.
- Decide: implement `audit_logs` OR remove `audit.controller.ts`/`audit.service.ts`. (BE M18, M28, M29)
- Move `PRODUCTION_CREATE_*.sql` exports out of `migrations/`.
- Add `UNIQUE(hospital_id, panel_id)` to `hospital_panels`.
- Replace `CHAR(10)` phone with `VARCHAR(20)`.

**1C. Transactions**
- Wrap multi-step writes (`signUp`, `addPatient`, `addPanel`, `addHospital`, `setMultipleAttributes`) in real `pool.connect() + BEGIN/COMMIT`. (BE H4, H5, H12, M12)
- Drive folder + Postgres write: either create row first and back-fill folder, or wrap with rollback.

**1D. Migration to a data layer**
- Add TanStack Query (or SWR).
- Wire `apiTransformers.ts` into the axios response interceptor.
- Extract a single `useAllHospitalPatients(hospitalId)` hook; replace the three duplicate fan-outs in `Patients`, `PatientDetail`, `PatientEdit`. (FE H3, M39)
- Replace direct `fetch()` call sites with axios so refresh-token interceptor applies. (FE C3)
- Wire `HospitalDataContext.refreshData` to the actual refetch. (FE H5)

**1E. Quick wins from each review (ship as one PR per category)**
- 15 backend quick-wins from REVIEW_BACKEND.md §"Quick wins"
- 20 frontend quick-wins from REVIEW_FRONTEND.md §"Quick wins"

**Outcome at end of Sprint 1:** Authn/authz is consistent. Database schema is single-source-of-truth and runner-managed. Frontend has one place for fetching, one place for type normalization, no more N+1.

---

### Sprint 2 — Architecture consolidation (2–3 weeks)

Finish the UI Revamp; retire the old code.

**2A. Kill the dead code**
- Delete `pages/panels/` (after moving `PatientTable.tsx` to where it's used).
- Delete `pages/hospital/Users/` (route is a redirect).
- Pick one of the two `CredentialsTab` implementations and delete the other.
- Audit and remove `pages/superadmin/HospitalDetailsPage/` after extracting its live deps.
- Delete the stub `uploadDoctorDocuments` and `getDoctorDocuments` in `doctor.controller.ts` (they return mock IDs / empty arrays).

**2B. Split the god components**
- `PanelsManager.tsx` (1721 lines), `AttributesManager.tsx` (1471), `PublicHospitalProfile.tsx` (1026), `CredentialsTab.tsx` (1036). Each renders 3–5 dialogs, has 20+ state vars.
- Pattern: extract each dialog into its own component; move form state to `react-hook-form` (already in deps). The CredentialsTab refactor (currently dead) is a usable template.

**2C. Design-system consolidation (recommend Path A from REVIEW_FRONTEND.md §"Design-system observations")**
- Every primary action → `<Button variant="default">` (shadcn primitive).
- Every dialog → `components/ui/dialog`.
- Every dropdown → `components/ui/select` (Radix).
- Codemod-replace `gray-*` → `slate-*`, `red-*` → `danger-*`.
- Remove the global Dialog `onPointerDownOutside={preventDefault}` override; opt in per-consumer.

**2D. URL routing fixes**
- Superadmin sidebar: real routes (`/superadmin/master-panels`, `/superadmin/attributes/hospital`, etc.). Use react-router `<NavLink>` so right-click / middle-click work. (QA C-1)
- Hospital Profile tabs: write `?tab=` to URL on switch; read on mount. (QA M-6, FE M9)
- Replace `window.location.href = '/hospital/${id}'` in `HospitalDirectory.tsx:264` with `navigate('/portal/${id}')`. (FE H10)

**2E. Replace native browser dialogs sitewide**
- Sweep: 14 `alert()` → `toast.error(...)`. 10 `confirm()` → `AlertDialog`. (FE M5)

**Outcome at end of Sprint 2:** One architecture in the repo. Half the LOC of the largest components. Shareable URLs. Consistent dialog UX in dark mode.

---

### Sprint 3 — UX polish + observability (3–4 weeks)

**3A. Dashboard reality check**
- Hospital portal dashboard has 6+ placeholder tiles ("coming soon", "—"). Either ship the data or hide them. (QA M-3, M-4; FE M10)
- Fix the dashboard "21 IPDs" vs Patients-page "20 admitted" count mismatch — pick a single source of truth. (QA H-1)
- Replace "Patients · 0 historical" with the right query (it's almost certainly broken). (QA M-8)

**3B. Single source of truth for specializations**
- `RegisterDoctor` and `AddDoctorForm` both fetch specializations then ignore the response and use a 15-item hardcoded list. Meanwhile Master Options has 58. Wire to backend; remove the hardcoded fallback. (FE H7, H8; QA M-2)

**3C. Doctor management end-to-end**
- The Doctors tab silently 404s in the console. Fix the route or the call. (QA H-6)
- Test the full create-doctor-with-credentials-and-document flow once 0.3 is in.
- Decide on doctor self-registration's launch readiness (currently public, registration_status='active', no admin gate).

**3D. Observability**
- Backend: Pino logger with redaction (`firstName`, `lastName`, `phone`, `email`, etc.). Request IDs.
- Frontend: strip `console.*` in prod build; add top-level `ErrorBoundary`. Set `Sentry` or similar. (FE H14)
- Backend: structured error responses (one envelope). Document the format.

**3E. PDF generation off the request path**
- Bull queue for PDF generation (`uploads.controller.ts:463-508`); return 202 + job ID; expose `/jobs/:id` polling endpoint. (BE H20)
- Sheet webhook calls also move to Bull. (BE M5)

**3F. Login & onboarding polish**
- Login page is bare; add logo, forgot-password link, supporting copy. (QA M-9)
- Public hospital share + public doctor profile pages need ErrorBoundary. (FE M16)

**Outcome at end of Sprint 3:** No misleading placeholder tiles. Doctors module works end-to-end. Production-grade logging and error reporting.

---

### Sprint 4+ — Longer-term initiatives (parallel to the above)

These are bigger lifts that we should be planning in parallel, not blocking on.

**Type safety**
- Turn on TypeScript `strict: true` incrementally — backend first (smaller surface), frontend after.
- Re-enable `CI=true` + ESLint in build script. Pick a typescript-eslint preset.
- ESLint rules: `no-floating-promises`, `no-misused-promises`, custom rule to ban template-literal SQL.

**Auth: httpOnly cookies for refresh token**
- Move refresh token to httpOnly secure cookie (`SameSite=Lax`). Keep access token in memory only. (FE C4)
- This is a real lift — touches login, refresh, logout, and the API base URL config. Plan as its own sprint when other foundations are stable.

**Build & tooling**
- Migrate webapp from CRA + craco to Vite. Faster dev server, lower-risk type checks, modern bundler. (FE L7)
- Replace `npm install` with `npm ci --omit=dev` in Dockerfile. (BE L16)
- Run backend container as non-root user. (BE L15)
- Add Postgres service to dev docker-compose; document prod is managed DB. (BE L17)
- Graceful shutdown (SIGTERM trap → drain queues → close pool). (BE L18)

**Soft-delete + audit trail**
- Either implement `audit_logs` table + service or delete the audit feature. (BE M29)
- Convert hard `DELETE /patient/:id` to soft-delete (`is_active=false` or `deleted_at`). (BE C11) — required for healthcare compliance.

**Performance**
- CloudFront presigned URLs are RSA-signed in the request path per photo. For 200-photo patients this is seconds of CPU per request. Either cache signed cookies for a path prefix, or sign in parallel. (BE M11)
- Search needs trigram index (`pg_trgm`) or full-text search; ILIKE doesn't scale. (BE M39)
- Cache the attribute-definition catalog in-process (5-min TTL); admin-only invalidation. (BE M16)

**Verification system**
- The validator visit / verification feature has tables and stubs but no live wiring. Either complete or remove. (BE M28; QA dashboard "verification queue" placeholder)

**Accessibility**
- Add `DialogDescription` to every Dialog (Radix requires it). (FE M8)
- Make Hospital Profile tabs use `role="tab"` + arrow-key navigation. (QA M-5)
- Ensure Escape dismisses every modal. (QA H-7)

**Mobile / responsive**
- Untested. Long tables in Panel Fleet wrap awkwardly at < 1280px. (QA L-5)

---

## 4. Risks and decisions needed

These can't be decided by engineering alone — please align on them before sprint planning.

1. **Is doctor self-registration actually launching?** If yes, sprint 0.1 (tenant isolation) and 3.3 (doctor module hardening) are blockers and need to come first. If no, we can deprioritize.
2. **Hard delete patients** — sprint-4 soft-delete migration: regulatory deadline?
3. **Drive integration** — comments say it's disabled, but `getImageCounts` still calls Drive APIs and hospital-data exports reference Drive folder IDs. Is Drive permanently gone or coming back?
4. **Sheets webhook** — every patient mutation awaits a Google Apps Script call. Is the Sheet sync a hard requirement, or can it run asynchronously?
5. **Validator feature** — full DB tables exist (`validator_profiles`, `verification_visits`, `attribute_verifications`) but no live wiring. Ship or remove?
6. **TypeScript strictness** — we'll find 200+ implicit-any errors when we turn on `strict: true`. Worth a dedicated sprint?
7. **Vite migration** — pays off in dev velocity but is a 1-week project. Worth doing before scaling the team?

---

## 5. Suggested team allocation (for context)

If you have 3 engineers for the next 6 weeks:

- **Eng A — Backend / auth**: Sprint 0.1 + 0.5 + 0.6 + 0.7, then 1A (auth) + 1C (transactions) + parts of 3D (logging).
- **Eng B — Backend / schema**: Sprint 0.3 + 0.9 + 0.11, then 1B (schema cleanup with migration runner). Continues into 3E (queues).
- **Eng C — Frontend / data layer + cleanup**: Sprint 0.2 + 0.4 + 0.8 + 0.14 + 0.15, then 1D (TanStack Query + transformers). Then 2A + 2B + 2C in series.

If 2 engineers, halve the surface — drop Sprint 3 polish, defer Sprint 4 entirely, keep Sprints 0/1/2 only.

---

## 6. What "done" looks like at week 8

- ✅ Any authenticated user trying to touch another tenant's data hits 403.
- ✅ No `dangerouslySetInnerHTML` of untrusted content.
- ✅ One source of truth for hospital, patient, doctor, master-options data — frontend pages share a cache.
- ✅ One source of truth for the database schema (single prefix, single doc table per entity, migration runner).
- ✅ Doctor module end-to-end (create doctor + credential + document upload + verification) works.
- ✅ Dashboard tiles show real data or are hidden.
- ✅ `pages/panels/`, `pages/hospital/Users/`, `pages/superadmin/HospitalDetailsPage/` deleted. One `CredentialsTab`. One `Skeleton`. One Select primitive.
- ✅ Native `alert()`/`confirm()` gone.
- ✅ Superadmin sidebar links are real URLs with right-click support.
- ✅ Console clean in production (logs stripped). Pino structured logs on backend with PII redaction.
- ✅ Theme toggle reliable. PatientEdit form dark-mode-correct.
- ✅ Test coverage on new auth middleware + new data hooks (minimum: tenant-isolation regression tests).

What is explicitly **not** in scope for week 8: TypeScript `strict: true` migration, Vite, httpOnly cookies, validator system, soft-delete migration. Those are sprint-5+ items.

---

*See companion documents for the source findings:*
- *[QA_REPORT.md](QA_REPORT.md) — what is broken in the browser*
- *[REVIEW_BACKEND.md](REVIEW_BACKEND.md) — what is broken or risky in `Backend/src/`*
- *[REVIEW_FRONTEND.md](REVIEW_FRONTEND.md) — what is broken or risky in `webapp/src/`*
