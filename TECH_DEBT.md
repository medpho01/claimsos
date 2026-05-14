# ClaimsOS — Tech Debt Register

**Owner:** Finclarity-Tech / 24Eleven Healthcare
**Last updated:** 2026-05-13
**Source:** Consolidated from May 2026 audits of Backend, Webapp, and Flutter mobile app.

This is a **prioritized**, **actionable** debt register. Every item is concrete enough to file as a ticket — file path, severity, and recommended fix included where known.

Severity scale:
- **P0** — Active bug, security hole, or release blocker. Ship-stopping.
- **P1** — Significant correctness, security, or architectural risk. Needs scheduled work.
- **P2** — Quality / consistency improvements. Do during related feature work.
- **P3** — Nice-to-have.

---

## P0 — Ship-stopping / Active Bugs

### P0-1 — `deletePatient` ownership check uses `userId` as `hospitalId`
- **File:** `Backend/src/Controllers/patient.controller.ts:1011-1014`
- **Detail:** `SELECT id FROM ipds WHERE id = $1 AND hospital_id = $2` binds `[id, userId]`. `hospital_id` will never equal a user UUID, so the route is effectively dead (always returns 404).
- **Fix:** Look up the user's hospital(s) via `hospital_users` / `hospital_assignments` and check membership; or rely on `checkSuperAdmin` middleware and drop the ownership check.

### P0-2 — `jwt.decode()` instead of `jwt.verify()` in token refresh
- **File:** `Backend/src/Controllers/auth.controller.ts:171`
- **Detail:** Refresh path decodes (does **not** verify) the old access token to extract `userId`. Attacker with any compromised refresh token can forge an access token's `id` claim. Bcrypt-compare on `user_refresh_tokens` saves us partially, but access-token integrity is bypassed.
- **Fix:** `jwt.verify(token, ACCESS_TOKEN_SECRET, { ignoreExpiration: true })`.

### P0-3 — `hospital_assignments.is_active` referenced in code but not in schema
- **Files referencing the missing column:**
  - `Backend/src/Controllers/admin.controller.ts:126, 129, 165`
  - `Backend/src/Controllers/patient.controller.ts:1073`
- **Detail:** Queries will throw `column ha.is_active does not exist` at runtime. Either a migration was lost in a `_fixed` shuffle or the column was never added.
- **Fix:** Add column via new migration `010_add_hospital_assignments_is_active.sql` (default `true`), OR remove `ha.is_active = true` predicates everywhere.

### P0-4 — SQL typo in patient query: `hp,sheet_name`
- **File:** `Backend/src/Controllers/patient.controller.ts:941`
- **Detail:** `... hp.sheet_id,hp,sheet_name ...` — the comma instead of dot selects the whole `hp` row plus an unqualified `sheet_name`. Crashes or returns malformed shape.
- **Fix:** `hp.sheet_name`.

### P0-5 — iOS app unshippable: missing Info.plist usage descriptions
- **File:** `Frontend/ios/Runner/Info.plist`
- **Detail:** No `NSCameraUsageDescription`, `NSLocationWhenInUseUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`. App will crash on first permission prompt; App Store will reject.
- **Fix:** Add all four keys with user-facing descriptions matching the actual use ("Capture patient documentation photos for insurance claim records", etc.).

### P0-6 — iOS bundle id still on Flutter template default
- **File:** `Frontend/ios/Runner.xcodeproj/project.pbxproj`
- **Detail:** `PRODUCT_BUNDLE_IDENTIFIER = com.example.hospitalApp`. No `DEVELOPMENT_TEAM` set. Signing unconfigured.
- **Fix:** Set bundle id (e.g., `com.claimsos.app` to match Android), set DEVELOPMENT_TEAM, configure manual or automatic signing with App Store provisioning profile.

### P0-7 — Master Options endpoints have no auth middleware
- **File:** `Backend/src/Routes/masterOptions.routes.ts`
- **Detail:** Full CRUD on `/api/v1/master-options/*` is publicly mutable. Anyone can create/update/delete dropdown values used by attribute definitions.
- **Fix:** Add `checkSuperAdmin` (or at minimum `checkAuth`) to all mutating routes; consider `checkAuth` for reads.

### P0-8 — `express.json({ limit: '100mb' })` — DoS surface
- **File:** `Backend/src/app.ts`
- **Detail:** A single request can buffer 100MB of JSON. Default should be ~1–5 MB; file uploads use multer separately.
- **Fix:** Lower to `'5mb'` for `express.json`; keep multer's own size limit for files.

### P0-9 — Doctor self-registration is unauthenticated and unthrottled
- **File:** `Backend/src/Routes/doctor.routes.ts` (`POST /doctors/register`)
- **Detail:** Public POST creates DB rows with no captcha, no rate-limit, no email verification. Sybil/spam risk.
- **Fix:** Add `express-rate-limit` (or similar), email verification flow, optional captcha (hCaptcha/Turnstile). At minimum rate-limit by IP.

### P0-10 — Webapp build script silently disables ESLint
- **File:** `webapp/package.json` build script: `DISABLE_ESLINT_PLUGIN=true SKIP_PREFLIGHT_CHECK=true CI=false craco build`
- **Detail:** Type errors, unused variables, and accessibility warnings are not surfaced in CI. Hides regressions.
- **Fix:** Remove `DISABLE_ESLINT_PLUGIN=true`. Fix the resulting wall of warnings incrementally; gate CI on `tsc --noEmit` at minimum.

---

## P1 — Security & Correctness

### P1-1 — TypeScript `strict: false` in webapp
- **File:** `webapp/tsconfig.json`
- **Detail:** `strict: false`, `noImplicitAny: false`, `strictNullChecks: false`. Combined with 233 `: any` usages, the codebase has effectively no type safety.
- **Fix:** Flip `strict: true` in a branch, run `tsc --noEmit`, fix in batches by feature folder.

### P1-2 — All JWTs in localStorage
- **Files:** `webapp/src/services/api.ts`, `AuthContext.tsx`
- **Detail:** Access + refresh tokens live in `localStorage` — vulnerable to any XSS injection.
- **Fix:** Migrate to HttpOnly + Secure cookies for refresh; keep access token in memory only.

### P1-3 — Mobile signing credentials hardcoded in `build.gradle.kts`
- **File:** `Frontend/android/app/build.gradle.kts:22-28`
- **Detail:** Keystore path is developer-machine-specific (`/Users/maverick/Android/.keystore/...`); keystore password `ClaimsKey@2024` and key password are in plain text in source.
- **Fix:** Move to `~/.gradle/gradle.properties` (or env vars / CI secrets), reference via `findProperty()`. Add to `.gitignore` if not already.

### P1-4 — Mobile applicationId vs namespace mismatch
- **File:** `Frontend/android/app/build.gradle.kts`
- **Detail:** `namespace = "com.twentyfoureleven.claims"` but `applicationId = "com.claimsos.app"`. The in-app force-update flow's Play Store deeplink uses `com.twentyfoureleven.claims` and will open a non-existent listing.
- **Fix:** Align both to the published applicationId. Update `VersionCheckService` deeplinks.

### P1-5 — No global error middleware (backend)
- **File:** `Backend/src/app.ts`
- **Detail:** Relies on `asyncHandler.util.ts` for error catching; no Express 5 `app.use((err, req, res, next) => ...)` registered. Errors thrown outside async handlers leak as default 500 HTML.
- **Fix:** Add a global error-handling middleware that logs structured error + returns `apiResponse`-shaped JSON.

### P1-6 — `audit_logs` table missing; audit endpoints crash
- **Files:** `Backend/src/Controllers/auth.controller.ts:76`, `Backend/src/Routes/audit.routes.ts:10`, `Backend/src/Services/audit.service.ts`
- **Detail:** Code references `audit_logs` table that has no migration. Calling `/api/v1/audit-logs` errors. `audit.service.ts` calls fail silently or crash if invoked.
- **Fix:** Either (a) create migration `011_create_audit_logs.sql` and wire writes throughout, or (b) remove the audit router and stub the service. Decide based on whether superadmin audit-trail is a near-term feature.

### P1-7 — `/api/v1/uploads/proxy/:fileId` has no auth
- **File:** `Backend/src/Routes/uploads.routes.ts:36`
- **Detail:** Lets anyone fetch by file id.
- **Fix:** Add `checkAuth` (or at minimum a signed-token check).

### P1-8 — V2 upload path: no 401 refresh logic on mobile
- **File:** `Frontend/lib/services/upload_service.dart`
- **Detail:** A token expiry mid-batch silently fails the upload. `ApiService` has refresh; `UploadService` does not.
- **Fix:** Share the auth interceptor / refresh routine between both Dio instances.

### P1-9 — Mobile: aggressive secure-storage wipe on transient errors
- **File:** `Frontend/lib/services/api_service.dart`
- **Detail:** `_refreshToken()` catch block calls `_storage.deleteAll()`, logging the user out (and wiping all secure storage keys) on a transient network blip.
- **Fix:** Only delete tokens on confirmed 401-from-refresh-endpoint; preserve other keys.

### P1-10 — Schema migration hygiene
- **Folder:** `Backend/src/schema/migrations/`
- **Detail:** Multiple `002_*`, `_fixed`, `b/c` variants. Hospital-specific data SQL (`007_export_pragati_hospital.sql`, `008_export_ganga_hospital.sql`) lives in migrations folder. `PRODUCTION_*` scripts in same folder. No tracking table.
- **Fix:**
  1. Adopt `node-pg-migrate` or `Flyway`. Add a `migrations` tracking table.
  2. Move hospital-specific exports to `Backend/src/schema/seeds/` (gitignored or per-env).
  3. Squash `002_*` variants into a single canonical migration; freeze the new linear history.

### P1-11 — Backend `console.log` debug middleware in production
- **File:** `Backend/src/index.ts:165-168, 191-194`
- **Detail:** Two debug `console.log` middlewares left enabled; logs all request paths to stdout.
- **Fix:** Remove or gate behind `NODE_ENV !== 'production'`.

### P1-12 — Backend log files committed to repo
- **Files:** `Backend/backend.log` (272 KB), `Backend/server.log` (91 KB)
- **Fix:** Add to `.gitignore`, `git rm --cached`.

### P1-13 — `.env` files committed
- **Files:** `Backend/.env`, possibly `Frontend/.env`
- **Fix:** Verify with `git ls-files | grep .env`; if committed, `git rm --cached`, rotate the leaked secrets (UltraMsg token, AWS keys, JWT secrets), and add `.env` to `.gitignore`.

### P1-14 — Prometheus metric naming + cardinality
- **File:** `Backend/src/index.ts`
- **Detail:** Custom histogram named `app_24eleven_http_requests_total` — `_total` suffix is reserved for counters. Route label falls back to `req.path` for unmatched routes — unbounded cardinality.
- **Fix:** Rename to `_seconds` (it's a duration histogram). Drop unmatched-route requests from metrics, or label them `route = "unmatched"`.

### P1-15 — Dead routes / dead files
- **Files to delete:**
  - `Backend/src/Routes/doctors.routes.ts` (imported in `index.ts:19` but never mounted)
  - `Backend/src/Controllers/doctors.controller.ts` (companion)
- **Detail:** Pure dead code creating duplicate `doctor` vs `doctors` namespace confusion.
- **Fix:** Delete both files and the import.

### P1-16 — Webapp legacy `CredentialsTab.tsx` superseded but kept
- **File:** `webapp/src/components/DoctorDetailsTabs/CredentialsTab.tsx` (1036 LOC)
- **Detail:** New refactored version at `webapp/src/components/DoctorDetailsTabs/CredentialsTab/` (folder). Likely dead; pick one.
- **Fix:** Confirm no imports of the file; delete; rename the folder's `index.tsx` to be the canonical export.

### P1-17a — `panel_attributes.value_encrypted` is plaintext, not encrypted
- **Files:**
  - Schema: `Backend/src/schema/migrations/005_add_panel_attributes_system.sql`
  - Service: `Backend/src/Services/panelAttribute.service.ts` — stores `input.value_encrypted` directly
  - Frontend: `webapp/src/pages/hospital/Profile/components/PanelsManager.tsx:651-652` — sends plaintext as `value_encrypted`
- **Detail:** The column name `value_encrypted` implies at-rest encryption but no transform is applied at any layer. Frontend uses `<Input type="password">` for entry (visual obscurity only). Backend stores the value as-is. On read the legacy panel attributes view shows `'***encrypted***'` which masks display but data sits in plaintext in Postgres.
- **Impact:** Anyone with DB read access (Postgres user, leaked backup, query log) sees portal credentials. The new fleet table (May 2026) intentionally exposes these to the ops team for RPA workflows — making the lack of real encryption more visible.
- **Fix options (in increasing rigor):**
  1. *Minimum:* rename the column / add a column comment so future devs aren't misled.
  2. *Symmetric encryption at rest:* `pgcrypto` `pgp_sym_encrypt` with a master key from `KMS`/env. Insert/update wrapped; SELECT decrypts only for authorised callers.
  3. *Per-secret KMS envelope:* AWS KMS data-key per attribute. Auditable decrypt events. Best for ops/RPA model where access is service-account-scoped.
- **Adjacent decisions to make alongside this:**
  - Should every read go through the API (audited) or can RPA scripts read the DB directly? If API-only, an `attribute-access` audit log row per decrypt is cheap insurance.
  - Rotate the seed credentials added on 2026-05-13 once this is fixed.

### P1-17 — Mobile: no input validation, `print(patientData)` logs PII
- **File:** `Frontend/lib/screens/patient_form.screen.dart:135`
- **Fix:** Remove `print`. Enable `avoid_print` lint in `analysis_options.yaml`.

---

## P2 — Architectural Cleanup

### P2-1 — `services/api.ts` is a 1065-line God class
- **File:** `webapp/src/services/api.ts`
- **Detail:** All HTTP grouped under one singleton. Methods grouped by comment banners. Has both typed methods and generic `get/post/put/delete` wrappers — a parallel API surface is forming.
- **Fix:** Split by resource (`services/hospitalApi.ts`, `services/doctorApi.ts`, etc.). Move axios setup to `services/http.ts`.

### P2-2 — Three near-duplicate attribute-definition managers (~900 LOC each)
- **Files:**
  - `webapp/src/features/attributeDefinitions/HospitalAttributeDefinitionsManager.tsx` (890)
  - `webapp/src/features/attributeDefinitions/PanelAttributeDefinitionsManager.tsx` (946)
  - `webapp/src/features/attributeDefinitions/DoctorAttributeDefinitionsManager.tsx` (788)
- **Fix:** Build one generic `<AttributeDefinitionManager kind="hospital|panel|doctor" />` parameterized on API endpoints + category list. Saves ~1500 LOC.

### P2-3 — Hospital profile managers are 1500+ LOC each
- **Files:**
  - `webapp/src/pages/hospital/Profile/components/AttributesManager.tsx` (1470)
  - `webapp/src/pages/hospital/Profile/components/PanelsManager.tsx` (1594)
  - `webapp/src/pages/PublicHospitalProfile.tsx` (1027)
- **Fix:** Split into list view + add/edit dialog + row component. Extract attribute-rendering logic into a hook (already partially done in `useAttributeFormRenderer.tsx`).

### P2-4 — No error boundaries anywhere in webapp
- **Detail:** A render-time exception in any large manager white-screens the whole portal.
- **Fix:** Add a top-level `<ErrorBoundary>` in `App.tsx` plus a per-route boundary around `<Outlet>`. Use a lightweight component (no library needed).

### P2-5 — Three credential UIs coexist
- **Files:**
  - `webapp/src/components/DoctorDetailsTabs/CredentialsTab.tsx` (legacy)
  - `webapp/src/components/DoctorDetailsTabs/CredentialsTab/` (new folder)
  - `webapp/src/pages/doctor/DoctorProfilePage/components/CredentialsManager.tsx` (self-service)
- **Fix:** One credential editor used in two contexts (admin-editing-doctor, doctor-editing-self) via props.

### P2-6 — Two `PublicSharingManager`s, two `ProfileForm`s
- **Files:**
  - `webapp/src/pages/hospital/Profile/components/PublicSharingManager.tsx` (391)
  - `webapp/src/pages/doctor/DoctorProfilePage/components/PublicSharingManager.tsx` (314)
- **Fix:** Single `<PublicSharingManager kind="hospital"|"doctor" />` with config object.

### P2-7 — Two dialog systems
- **Files:** `webapp/src/components/ui/dialog.tsx` (shadcn) + `webapp/src/components/ui/flexible-dialog.tsx` (custom).
- **Fix:** Pick shadcn. Migrate all `flexible-dialog` consumers, delete the custom one.

### P2-8 — Two skeleton components
- **Files:** `webapp/src/components/ui/skeleton.tsx` + `webapp/src/components/common/Skeleton.tsx`.
- **Fix:** Delete `common/Skeleton.tsx`, codemod imports.

### P2-9 — Two hospital views (legacy `/hospital/:id` vs new `/portal/:id`)
- **Detail:** Both reuse `useHospitalData` from `pages/superadmin/HospitalDetailsPage/hooks/` — cross-area coupling.
- **Fix:** Decide canonical route; remove the other. If both are needed (admin-view vs hospital-view), split data hooks.

### P2-10 — `window.alert()` mixed with sonner toasts
- **Files:**
  - `webapp/src/components/modals/PatientPhotosModal/...`
  - `webapp/src/pages/PublicHospitalProfile.tsx`
  - `webapp/src/pages/superadmin/HospitalDetailsPage/components/HospitalUserList.tsx`
  - `webapp/src/pages/superadmin/HospitalDetailsPage/hooks/usePatientActions.ts`
  - `webapp/src/pages/superadmin/HospitalDetailsPage/hooks/useHospitalData.ts`
  - `webapp/src/pages/hospital/Profile/components/AttributesManager.tsx`
- **Fix:** Codemod `alert(` → `toast.error(` / `toast.success(`.

### P2-11 — Verification services overlap
- **Files:** `attributeVerification.service.ts`, `verification.service.ts`, `verificationNotes.service.ts`, `verificationVisit.service.ts`, `validator.service.ts`.
- **Detail:** Responsibilities partially duplicated. Migration `004_create_validator_verification_system.sql` collides on number with `004_add_attribute_documents_junction.sql`.
- **Fix:** Domain redesign — one Verification module, sub-services under it.

### P2-12 — Snake_case ↔ camelCase mixing across API boundary
- **Files:** `webapp/src/utils/apiTransformers.ts` is the band-aid; not used everywhere.
- **Detail:** Backend returns snake_case for most resources (`first_name`, `is_active`, `hospital_id`) but camelCase for attribute endpoints. Components defensively read both (`cred.verificationStatus || cred.verification_status`).
- **Fix:** Standardize backend response shape (camelCase at the API boundary). Add a response middleware that converts on the way out. Use `apiTransformers.ts` consistently until backend is fixed.

### P2-13 — V1 vs V2 upload coexistence
- **Backend:** `/api/v1/uploads/*` and `/api/v2/uploads/*` both mounted.
- **Fix:** Migrate remaining V1 callers to V2; remove V1 controller/route/service.

### P2-14 — Mobile: two PDF libraries
- **Files:** `pubspec.yaml` includes `flutter_pdfview ^1.3.2` and `pdfx ^2.9.2`.
- **Fix:** Pick one based on actual usage; remove the other.

### P2-15 — Mobile: no state management library
- **Detail:** Every screen instantiates its own `ApiService()`. Multiple Dio instances per session.
- **Fix:** Adopt Riverpod (or simpler: Provider) with a singleton `ApiService`.

### P2-16 — Mobile: 39 `catch(e)` blocks swallow errors
- **Detail:** No structured error type; no Crashlytics/Sentry.
- **Fix:** Add Sentry/Crashlytics, replace bare strings with typed exceptions.

### P2-17 — No tests, anywhere
- **Backend:** `npm test` script is `echo "Error: no test specified" && exit 1`.
- **Webapp:** Only `src/App.test.tsx` (CRA default).
- **Mobile:** No `test/` directory.
- **Fix:** Add at least one happy-path integration test per layer to gate CI. Backend: supertest against `app.ts`. Webapp: a smoke test of the login → portal flow. Mobile: a widget test of login screen.

---

## P3 — Quality / Consistency

### P3-1 — Webapp: 251 `console.*` calls (123 `console.log`)
- **Fix:** Codemod to a dev-only logger that no-ops in production.

### P3-2 — Webapp: 233 `: any` usages
- **Fix:** Tackle in tandem with P1-1 (`strict: true`).

### P3-3 — Webapp: `LoginPage` uses raw CSS instead of shadcn
- **File:** `webapp/src/pages/auth/LoginPage.tsx` + `src/styles/Login.css`.
- **Fix:** Rebuild with shadcn `<Card>`, `<Input>`, `<Button>`, `<Label>`; delete `Login.css`.

### P3-4 — Webapp: CSS files coexist with Tailwind
- **Files:** `App.css`, `Login.css`, `HospitalDetailsPage.css`, `HospitalProfilePage.css`, `HospitalDocsAndDetails.css`.
- **Fix:** Audit each. Most are likely dead since Tailwind purge won't see them.

### P3-5 — Webapp: missing accessibility on icon-only buttons
- **Fix:** Add `aria-label` codemod for `<Button>` containing only an icon. Run axe-core scan in dev.

### P3-6 — Webapp: heavy bundles, no lazy-loading for superadmin
- **Detail:** Only public/doctor/hospital portal pages use `React.lazy`. Heavy libs (`pdfjs-dist`, `mammoth`, `xlsx`, `exceljs`, `framer-motion`) loaded eagerly in some routes.
- **Fix:** Lazy-load superadmin pages; dynamic-import the doc parsers only where needed.

### P3-7 — Mobile: file naming inconsistent
- **Examples:** `imagePreview.screen.dart` (camelCase) vs `patient_list.screen.dart` (snake) vs `version_check.service.dart` (dot).
- **Fix:** Lock to `snake_case.<kind>.dart`. Rename in one PR.

### P3-8 — Mobile: 42 unpinned outdated packages
- **Fix:** Run `flutter pub outdated`, upgrade in batches (start with `envied` 0.5 → 1.x, `package_info_plus` 8 → 10).

### P3-9 — Mobile: deprecated `desiredAccuracy:` in `LocationService`
- **Fix:** Migrate to `LocationSettings(accuracy: ...)` per `geolocator` 14 API.

### P3-10 — Mobile: `ImageProcessor.stampImage` not run in isolate
- **Detail:** CPU-bound `package:image` work blocks UI thread despite the function being shaped for `compute()`.
- **Fix:** Call via `compute()` from `CameraScreen`.

### P3-11 — Backend: non-idiomatic API field names
- **Examples:** `userName` / `passWord` in login body. `dishargePhotos` typo in route path. `hospitalContoller.ts` filename typo.
- **Fix:** Migrate to standard names with a deprecation window for clients (mobile + webapp).

### P3-12 — Backend: no request-id / correlation-id middleware
- **Fix:** Add `express-request-id` or similar; emit in logs and Prometheus labels.

### P3-13 — Backend: no rate limiting
- **Fix:** Add `express-rate-limit` on auth, registration, and public endpoints at minimum.

### P3-14 — Backend: pagination missing on list endpoints
- **Endpoints:** `/getAllPatients`, `/getAllHospitals`, `/user/all`, `/master-options/` etc.
- **Fix:** Add `limit` / `offset` + total-count pattern. Update webapp to use it.

### P3-15 — Backend: no connection-pool tuning
- **File:** `Backend/src/DB/db.ts`
- **Fix:** Configure `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` based on observed concurrency.

### P3-16 — Backend: zod is a dependency but unused
- **Fix:** Add input-validation schemas on high-risk routes (auth signup, attribute mutations, share-token operations).

---

## Recommended Sprint Plan

### Sprint 1 — Stop the bleeding
Address all P0 items plus P1-1, P1-3, P1-4 (mobile blockers), P1-12, P1-13.

### Sprint 2 — Tighten security & migration hygiene
P1-2, P1-5 through P1-11. Adopt migration framework. Consolidate `_fixed` SQL files.

### Sprint 3 — Architecture cleanup (background work alongside features)
P2-1, P2-2, P2-3, P2-4 (error boundaries), P2-5, P2-6, P2-7, P2-8. Reduces webapp by ~3000 LOC.

### Sprint 4 — Quality & polish
P2 remainder + P3 highlights. Test coverage scaffolding.

---

*Original audits (full text with file:line citations) archived at `docs/archive/audits/2026-05-backend-audit.md`, `docs/archive/audits/2026-05-webapp-audit.md`, `docs/archive/audits/2026-05-mobile-audit.md`.*
