# ClaimsOS — Technical Specification

**Owner:** Finclarity-Tech / 24Eleven Healthcare
**Last updated:** 2026-05-13
**Service name in code:** `24eleven-backend`

This document is the single source of truth for how ClaimsOS is built. Pair with `PRODUCT_SPEC.md` (what we're building, for whom) and `TECH_DEBT.md` (what's broken / needs work).

---

## 1. System Overview

```
                          ┌────────────────────────────┐
                          │      Flutter Mobile App    │
                          │   (Field agents, Android)  │
                          └─────────────┬──────────────┘
                                        │  HTTPS (Dio)
                          ┌─────────────┴──────────────┐
                          │       React Webapp         │
                          │  (3 portals + public dir)  │
                          └─────────────┬──────────────┘
                                        │  HTTPS (axios)
                                        ▼
   ┌───────────────────────────────────────────────────────────────┐
   │                  Express 5 Backend (Node 20, ESM)               │
   │  ─────────────────────────────────────────────────────────────  │
   │  Routes ──► Controllers ──► Services ──► DB (pg.Pool)            │
   │     │            │             │                                 │
   │     │            │             ├──► AWS S3 (documents, photos)   │
   │     │            │             ├──► CloudFront (signed delivery) │
   │     │            │             ├──► Ghostscript (PDF compress)   │
   │     │            │             ├──► UltraMsg (WhatsApp)          │
   │     │            │             ├──► Google Sheets webhook        │
   │     │            │             └──► Google Drive (legacy backup) │
   │     │            │                                                │
   │     │            └──► Bull queues (drive backup, notifications)   │
   │     │                  └── Redis                                  │
   │     │                                                              │
   │     └──► Prometheus /metrics                                       │
   └───────────────────────────────┬───────────────────────────────────┘
                                   │
                          ┌────────┴────────┐
                          │   PostgreSQL    │
                          │  (schema=hospital)│
                          └─────────────────┘
```

---

## 2. Backend (`Backend/`)

### 2.1 Stack
- **Runtime:** Node.js, TypeScript (target ES2022), **ESM** (`.js` import suffixes required for relative imports).
- **Framework:** Express 5.
- **DB:** PostgreSQL via `pg.Pool` (single pool in `src/DB/db.ts`). Default schema `hospital` plus `public`.
- **Queues:** Bull (Redis) for drive backup & WhatsApp notifications; custom in-memory FIFO (`uploadQueue.service.ts`) for V1 upload pipeline.
- **Auth:** JWT (access + refresh), refresh tokens bcrypt-hashed in `user_refresh_tokens`.
- **Object Storage:** AWS S3 with CloudFront-signed URLs (1 hr) for delivery.
- **PDF:** Ghostscript (shell-invoked from `Workers/gsCompress.worker.ts`).
- **Images:** `sharp`.
- **Metrics:** `prom-client` at `/metrics`.
- **Health:** `/health/live`, `/health/ready`, `/api/v1/health`, `/api/v1/version`.

### 2.2 Folder Layout
```
src/
  app.ts                     Express + CORS + JSON
  index.ts                   bootstrap, metrics, route mount, worker boot
  DB/db.ts                   pg Pool
  Controllers/               25 files + v2/uploads.controller.ts
  Services/                  27 files
  Routes/                    16 files + v2/uploads.routes.ts
  Middlewares/               auth, multer
  Workers/                   Bull queues + GS compress worker
  Utils/                     tokens, errorHandler, asyncHandler, apiResponse, indianTime
  schema/                    schema.sql + migrations/ (raw SQL files)
  Public/                    multer disk dest
```

### 2.3 Module Conventions
- Controllers are thin: parse + delegate + format response (`apiResponse.util.ts` produces `{ statusCode, data, message, success }`).
- Services hold SQL and business logic.
- Async handlers wrapped with `asyncHandler.util.ts` for unhandled-rejection safety.
- **No global error middleware** — `asyncHandler` returns 500s itself. Should be hardened.

### 2.4 Authentication
- `POST /api/v1/auth/login` returns `{ accessToken, refreshToken, user }`. Frontend stores in localStorage / SecureStorage.
- `POST /api/v1/auth/refreshAccessToken` accepts refresh token in body **and** old access token in Authorization header. Backend `jwt.decode`s (⚠️ not verify) the access token to fetch `userId`, then bcrypt-compares the refresh token against `user_refresh_tokens.token_hash`. On success, rotates both tokens.
- Roles: `superadmin`, `admin`, `hospital`. Doctor user-role planned but **not implemented in auth flow** — doctors registered via `/doctors/register` create `doctors` rows but no logged-in session today.
- Five middleware guards: `checkAuth`, `checkSuperAdmin`, `checkAdmin`, `checkSuperAdminOrAdmin`, `checkHospital`, plus access-checks `checkAdminPermission(perm)`, `checkPatientViewAccess`, `checkPatientEditAccess`, `checkHospitalUserPermission`.

### 2.5 API Surface (by router)

| Router | Mount | Purpose |
|---|---|---|
| `auth.routes` | `/api/v1/auth` | login, signup (superadmin-gated), refreshAccessToken |
| `patient.routes` | `/api/v1/patient` | IPD CRUD, discharge, toggle-active |
| `user.routes` | `/api/v1/user` | me, list, roles, toggle-status |
| `uploads.routes` (V1) | `/api/v1/uploads` | legacy upload pipeline (multer→queue→S3+WhatsApp) |
| `uploads.routes` (V2) | `/api/v2/uploads` | **current** S3-direct + Bull drive-backup |
| `admin.routes` | `/api/v1/admin` | admin↔hospital assignments, permissions |
| `audit.routes` | `/api/v1/audit-logs` | audit list (⚠️ table missing) |
| `hospital.routes` | `/api/v1/hospitals` | hospital CRUD, panels, users |
| `claim.routes` | `/api/v1/claims` | claim create/update |
| `hospitalDocs.routes` | `/api/v1/hospital-docs` | hospital doc upload/list/delete |
| `hospitalProfile.routes` | `/api/v1` | hospital profile + attributes + documents + verification + share tokens + public access |
| `panelAttribute.routes` | `/api/v1` | panel-level attributes + definitions |
| `attributeDefinition.routes` | `/api/v1` | hospital attribute definitions |
| `panelAttributeDefinition.routes` | `/api/v1` | panel attribute definitions |
| `masterOptions.routes` | `/api/v1/master-options` | dropdown master values (⚠️ no auth) |
| `doctor.routes` | `/api/v1` | doctor registry + attributes + hospital-doctor + share + public |
| `doctors.routes` | (none) | **dead code — imported but never mounted** |

Full endpoint inventory lives in `docs/archive/audits/2026-05-backend-audit.md`.

### 2.6 Services
27 services, all stateless module-level functions wrapping SQL.
- **Core data:** `attribute.service`, `attributeDefinition.service`, `panelAttribute.service`, `panelAttributeDefinition.service`, `panelAttributeDocument.service`, `doctor.service`, `doctorAttribute.service`, `doctorAttributeDefinition.service`, `hospitalDoctor.service`, `hospitalDoctorAttribute.service`, `hospitalProfile.service`, `masterOptions.service`.
- **Verification:** `attributeVerification.service`, `verification.service`, `verificationNotes.service`, `verificationVisit.service`, `validator.service`. (⚠️ overlap — see TECH_DEBT.md.)
- **Files / storage:** `s3.service`, `pdfConverter.service`, `driveUploader.service`, `attachment.service`, `documentExtraction.service`.
- **Pipelines:** `uploadQueue.service` (V1 in-mem queue), `notificationBuffer.service`, `ultraMsg.service`.
- **System:** `audit.service`, `startup.service`.

### 2.7 Database

**Schema strategy:** all domain tables in PG schema `hospital` (search_path set to `hospital, public`). `users`, `user_refresh_tokens`, and a duplicate `doctors` table live in `public`.

**Key tables:**
- *Identity:* `users`, `user_refresh_tokens`.
- *Hospital core:* `hospitals`, `hospital_assignments` (admin↔hospital perms), `hospital_users`.
- *Panels:* `panels` (master), `hospital_panels` (per-hospital empanelment with sheet/WhatsApp metadata), `panel_empanelments`.
- *IPD / Claims:* `ipds`, `claims`, `ipd_doc`, `doctor_doc`, `hospital_doc`.
- *Profile system:* `hospital_profile`, `hospital_key_contacts`, `hospital_certifications`, `hospital_documents`, `hospital_attributes`, `hospital_attribute_documents`.
- *Definitions:* `attribute_definitions` (hospital), `panel_attribute_definitions`, `doctor_attribute_definitions`, `master_options`.
- *Panels:* `panel_attributes`, `panel_attribute_documents`, `panel_documents`.
- *Doctors:* `hospital.doctors`, `doctor_profiles`, `hospital_doctors`, `hospital_doctor_attributes`, `doctor_attributes`, `doctor_attribute_documents`, `doctor_share_tokens`.
- *Verification:* `validator_profiles`, `verification_visits`, `attribute_verifications`, `verification_evidence`, `verification_notes`, `verification_audit_log`, `verification_guidelines`.
- *Public sharing:* `public_share_tokens` (hospital), `doctor_share_tokens` (doctor).
- *Misc:* `document_extractions`, `system_settings`.

**Migrations:** Raw SQL files under `src/schema/migrations/`. **No migration framework** — applied manually. Multiple "_fixed" siblings (e.g., `002_hospital_profile_fixed.sql`) and hospital-specific data SQL (`007_export_pragati_hospital.sql`, `008_export_ganga_hospital.sql`) sit in the same folder. See `TECH_DEBT.md` for the consolidation plan.

### 2.8 File Upload Pipelines

**V1 (`/api/v1/uploads`) — legacy, still active for some paths:**
1. multer disk storage → `src/public/<file>`.
2. Job enqueued in `uploadQueue.service.ts` (in-memory `UploadJob[]`, persisted to `queue_state.json`).
3. Serial worker (concurrency=1) Ghostscript-compresses PDFs, uploads to S3, optionally to Google Drive (legacy — most paths now disabled).
4. On batch completion, `notificationBuffer.service` triggers a WhatsApp message to the panel group.
5. **Risk:** process exit drops in-flight job; `queue_state.json` recovery handled by `startup.service.recoverDriveBackups`.

**V2 (`/api/v2/uploads`) — current, active for mobile photo uploads:**
1. multer memory storage → controller streams directly to S3.
2. Bull job enqueued for async Google Drive backup (currently no-op if Drive disabled).
3. Backup status tracked on `ipd_doc.drive_backup_status / attempts / error` columns.
4. Bull configured with `enableOfflineQueue: false` → gracefully no-ops if Redis is down.

**Why both exist:** V1 was the original Drive-first pipeline. V2 is the S3-first replacement. Mobile uses V2 (`/api/v2/uploads/photos`); some webapp paths still use V1. Migration not yet complete.

### 2.9 Notifications
- **UltraMsg** (`ultraMsg.service.ts`) — HTTP client to UltraMsg WhatsApp API.
- **`notificationBuffer.service`** — debounces per-group messages so a batch of N photos sends one summary message after a quiet window.
- **`notification.queue` (Bull)** — wraps notification sending for retries.

### 2.10 Public Share Token System
- `public_share_tokens` (hospital) + `hospital.doctor_share_tokens` — random URL-safe token, optional `expires_at`, `max_views`, `view_count`, `is_active`.
- Public routes mounted **without auth**: `/hospitals/share/:token`, `/hospitals/share/:token/documents/:documentId/download`, `/doctors/public/doctor/:token`, plus public directories.
- Document delivery uses S3 presigned URLs gated by token validity.

### 2.11 Observability
- `prom-client` default metrics + custom histogram `app_24eleven_http_requests_total` (named as if it were a counter — convention issue).
- Health probes: `/`, `/health/live`, `/health/ready`, `/api/v1/health`.
- Version probe: `/api/v1/version` (used by mobile force-update check).
- Logging: `console.*` only — no structured logger.

---

## 3. Webapp (`webapp/`)

### 3.1 Stack
- **React 19.2.3** (very recent), **TypeScript 4.9.5** (old), CRA 5 + **CRACO 7**.
- **Tailwind 3.4** + **shadcn/ui** (Radix primitives) + `lucide-react` icons.
- **Routing:** `react-router-dom` 7.11 (BrowserRouter).
- **State:** local `useState` + three Contexts (`AuthContext`, `UploadContext`, `HospitalDataContext`). No Redux/Zustand/React Query.
- **Forms:** `react-hook-form` 7.72 + `zod` 3.25 (only in attribute-definition managers).
- **Toasts:** `sonner` mounted globally in `App.tsx`.
- **Files:** `pdfjs-dist`, `react-pdf`, `mammoth` (docx), `jspdf`, `exceljs`, `xlsx`, `browser-image-compression`.
- **HTTP:** `axios` via singleton `services/api.ts` (1065 lines).

### 3.2 Build Config
- `tsconfig.json`: **`strict: false`**, `noImplicitAny: false`, `strictNullChecks: false`. Target `es5`.
- Build script: `DISABLE_ESLINT_PLUGIN=true SKIP_PREFLIGHT_CHECK=true CI=false craco build` — **lint is disabled in CI**.
- `craco.config.js`: only adds `@/*` → `src/*` alias and sets `postcss.mode = file`.

### 3.3 Folder Layout
```
src/
  App.tsx                    routing + role redirect + global toaster + upload panel
  index.tsx
  components/
    ui/                      shadcn primitives (alert, dialog, table, ...)
    common/Skeleton.tsx      ⚠️ duplicate of ui/skeleton.tsx
    forms/                   SelectField, MultiSelectField
    modals/                  AddHospitalModal, AddPanelModal, AddUserModal, PatientModal, PatientPhotosModal/
    Navbar/                  GlobalNavbar
    DoctorDetailsTabs/       Doctor details modal (⚠️ legacy + new folder side-by-side)
    DocumentUploadManager.tsx
    FilePreviewModal.tsx
  context/                   AuthContext, UploadContext
  features/
    attributeDefinitions/    HospitalAttrDefMgr, PanelAttrDefMgr, DoctorAttrDefMgr (⚠️ ~900 LOC each, near-duplicate)
    dashboard/
    panels/
  hooks/                     useAttributeFormRenderer, useAttributeManager, useDocumentUpload, useMasterOptions
  pages/
    auth/                    LoginPage (raw CSS), RegisterDoctor
    superadmin/              SuperAdminPage, HospitalDetailsPage/, MasterOptionsManager/
    admin/                   AdminDashboardPage
    hospital/                Layout (portal sidebar), Dashboard, Panels, PanelDetails, Users, Profile (5 tabs)
    doctor/                  DoctorProfilePage/, PublicDoctorProfile
    doctors/                 DoctorDirectory
    panels/                  patient-list per panel (legacy)
    HospitalDirectory.tsx
    PublicHospitalProfile.tsx (1027 lines)
  services/api.ts            single God-class for HTTP
  styles/                    Login.css and other CSS files coexisting with Tailwind
  types/                     attributeTypes.ts + ad-hoc
  utils/                     apiTransformers (snake_case ↔ camelCase), attributeValidation
```

### 3.4 Routing & Auth Guards
- `App.tsx` defines `<PrivateRoute roles=[...]>` wrapping protected routes.
- Public routes: `/login`, `/register/doctor`, `/hospitals`, `/doctors`, `/public-profile/:token`, `/hospitals/share/:token`, `/public-doctor/:token`.
- Role-based landing: `/` → superadmin to `/superadmin`, hospital to `/portal/:hospitalId`, otherwise `/dashboard`.
- **Two hospital views coexist:** legacy `/hospital/:hospitalId` (superadmin path) and new `/portal/:hospitalId` (hospital portal). Both reuse `useHospitalData` from the superadmin folder.

### 3.5 API Service Layer
- `services/api.ts` exports a singleton `ApiService` wrapping two axios instances:
  - `this.api` → `/api/v1`
  - `this.apiV2` → `/api/v2`
- Request interceptor: injects `Bearer` from localStorage; strips `Content-Type` for FormData.
- Response interceptor: proper **mutex-based 401 refresh** with subscriber queue — concurrent failures coalesce into one refresh call. Solid implementation.
- On refresh failure: `localStorage.clear()` + `window.location.href = '/login'` (full reload bypasses React Router).
- **Token storage:** localStorage (XSS risk; no HttpOnly cookies).
- **Response shape:** all callers must unwrap `response.data.data` (backend wraps with `apiResponse`).

### 3.6 State Management
- `AuthContext` — user + accessToken; hydrated from localStorage. **`refreshToken` is in localStorage but never in context.**
- `UploadContext` — global upload queue UI panel mounted in `App.tsx` (background uploads survive navigation).
- `HospitalDataContext` — route-scoped, used by `HospitalPortalLayout` and superadmin hospital details.
- Caching: `SuperAdminPage` rolls its own `sessionStorage` cache (`sa_admins`, `sa_hospitals`); other pages refetch on every mount.

### 3.7 Major Page Areas (page → role → notes)
| Page | Role | Notes |
|---|---|---|
| `LoginPage` | All | Uses raw HTML + `Login.css` (not shadcn) — inconsistent. |
| `RegisterDoctor` | Public | TODO: auto-login broken after registration. |
| `SuperAdminPage` | superadmin | Tabbed dashboard, 9 parallel API calls on mount. |
| `HospitalDetailsPage` | superadmin / admin | Legacy hospital view with full doc/doctor/user mgmt. |
| `MasterOptionsManager` | superadmin | Dropdown master-data CRUD. |
| `HospitalPortalLayout` + nested | hospital | Sidebar-driven portal (Dashboard, Panels, Users, Profile). |
| `Profile/AttributesManager` | hospital | **1470 LOC** — attribute fill + verification UI. |
| `Profile/PanelsManager` | hospital | **1594 LOC** — panel attribute mgmt. |
| `Profile/PublicSharingManager` | hospital | Share token CRUD. |
| `DoctorProfilePage` | doctor | Tabbed self-service: profile, credentials, affiliations, sharing. |
| `PublicHospitalProfile` | public | **1027 LOC** single file, two URL aliases. |
| `PublicDoctorProfile` | public | Token-gated doctor view. |
| `HospitalDirectory` / `DoctorDirectory` | public | Searchable lists of public-enabled records. |

### 3.8 Design System
- **shadcn/ui** + Tailwind is the target design system. Slate base, blue brand gradient.
- **Inconsistencies tracked:** Login uses raw CSS; two dialog systems (`dialog.tsx` and `flexible-dialog.tsx`); two skeleton components; `window.alert()` mixed with sonner toasts; `react-multi-select-component` alongside shadcn `Select`.

---

## 4. Mobile App (`Frontend/` — Flutter)

### 4.1 Stack
- **Flutter SDK** `^3.10.4`, Dart with `flutter_lints` 6.0.
- **HTTP:** `dio ^5.9.0` primary; `http ^1.6.0` (inconsistently used by `version_check.service.dart` and Google Static Maps fetch).
- **Token storage:** `flutter_secure_storage ^9.2.2` (Keychain / Keystore).
- **Camera & media:** `camera ^0.11.3`, `gal ^2.3.2`, `photo_manager ^3.8.3`, `image ^4.7.2` (overlay compositing), `flutter_image_compress`, `exif`.
- **Location:** `geolocator ^14.0.2`, `geocoding ^4.0.0`, Google Static Maps API for thumbnail.
- **Permissions:** `permission_handler ^11.3.0`.
- **PDF:** **two libs coexist** — `flutter_pdfview ^1.3.2` and `pdfx ^2.9.2`.
- **Env:** `envied ^0.5.3` — compile-time obfuscated constants from `.env` (`BASE_ADDRESS`, `GOOGLE_MAP_API_KEY`).
- **State:** none (no Provider/Riverpod/Bloc). Each screen instantiates its own `ApiService()`.

### 4.2 Folder Layout (`lib/`)
```
main.dart                  AuthCheck, ConnectivityWrapper, version check
env/                       envied generated config
models/patients.model.dart only model class — everything else is Map<String,dynamic>
screens/                   14 screens, all StatefulWidgets
services/                  api_service, auth_service, upload_service,
                           location_service, image_processor,
                           version_check.service
widgets/                   empty_state, loading_skeleton, pdf_viewer,
                           upload_progress_dialog
utils/toast_utils.dart
```

### 4.3 Key Flows
- `main.dart` → `AuthCheck` → either `LoginScreen` or `PatientListScreen` based on `accessToken` in secure storage.
- `CameraScreen` (630 LOC) streams `Position`, builds a watermark overlay, stamps it onto each JPEG via `package:image` (CPU-bound, **not** in an isolate).
- `UploadService` is a separate Dio instance with 120 s timeouts; **no 401 refresh logic** here (would silently fail mid-upload on token expiry).

### 4.4 Build / Release
- **Android:**
  - `applicationId = com.claimsos.app` (May 2026 change).
  - `namespace = com.twentyfoureleven.claims` (stale, doesn't match applicationId).
  - Release signing config hardcoded in `android/app/build.gradle.kts` with **keystore password in plain text**: `ClaimsKey@2024`. Keystore path is developer-machine-specific.
  - `isMinifyEnabled = false`, `isShrinkResources = false`.
- **iOS:**
  - `PRODUCT_BUNDLE_IDENTIFIER = com.example.hospitalApp` — **still on Flutter template default**.
  - `Info.plist` **missing all permission usage descriptions** — app will crash on iOS permission requests; App Store will reject.
  - No `DEVELOPMENT_TEAM` set, signing unconfigured.
- **CI/CD:** none. No `.github/workflows`, no Fastlane.

### 4.5 Mobile ↔ Backend Contract
- Login: `POST /api/v1/auth/login` with `userName` / `passWord` (note non-idiomatic field names).
- Patients: `GET /api/v1/patient/getActivePatients`.
- Photo upload: `POST /api/v2/uploads/photos` (multipart with `patientId`, `category`, N file parts).
- Version check: `GET /api/v1/version`.

---

## 5. Deployment & Environments

### 5.1 Docker
- `Backend/Dockerfile` + `Backend/Dockerfile.dev` — production multi-stage and dev variants.
- `webapp/Dockerfile` + `Dockerfile.dev` + `nginx.conf` — built artifact served by nginx in prod.
- Dynamic API base URL in webapp for Docker dev environment.

### 5.2 Environments
- **Local dev** — backend on `:6001`, webapp on `:3000` (or `:9001` per CORS whitelist), Postgres + Redis via docker-compose (assumed; not committed).
- **Production** — hosted at `claims.24elevenhealthcare.com` (mobile uses `https://claims.24elevenhealthcare.com/api/v1` as `BASE_ADDRESS`).
- No staging environment evident.

### 5.3 Secrets
- Backend reads from `.env` (committed at repo root ⚠️). Key env vars include `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, DB connection, AWS keys, UltraMsg instance/token, Google Sheets webhook, CORS origin.
- Mobile reads from `.env` (also committed?) and uses `envied` to bake obfuscated constants into the binary.
- Webapp reads `REACT_APP_*` vars at build time.

---

## 6. Operational Concerns

### 6.1 Backups
- PostgreSQL: assumed manual snapshots (no automation in repo).
- S3: versioning posture unknown; lifecycle policy unknown.
- Google Drive: legacy backup target, drive backup status tracked on `ipd_doc` but Drive uploader is partially disabled.

### 6.2 Monitoring
- Prometheus metrics scraped from `/metrics` (consumer not in repo — Grafana/Prometheus assumed external).
- No application logging aggregation (Loki/Datadog/Sentry) configured.
- `backend.log` and `server.log` written to repo root (should be gitignored — currently 272KB / 91KB committed).

### 6.3 Rate Limiting
- None. No `express-rate-limit` or equivalent.

### 6.4 CORS
- Hardcoded localhost ports (`3000`, `5001`, `9001`) plus comma-separated `CORS_ORIGIN` env. `credentials: true`.

---

## 7. Extending the System (Cookbook)

### 7.1 Add a new hospital attribute type
1. Superadmin → Hospital Attribute Configurator → "Add Attribute".
2. Pick category (existing or new), data type, required/has_expiry/requires_document flags.
3. (Optional) link a `master_options` category for `select` data type.
4. Save. New attribute appears in `AttributesManager` for every hospital automatically.

### 7.2 Add a new API endpoint
1. Add route in `src/Routes/<resource>.routes.ts` with appropriate middleware.
2. Add controller in `src/Controllers/<resource>.controller.ts` using `asyncHandler` wrapper + `apiResponse`.
3. Add service method in `src/Services/<resource>.service.ts` with parameterized SQL.
4. Mount router in `src/index.ts` if new file. **Beware route ordering** — `/api/v1/hospitals/:hospitalId` is a catch-all; specific paths must come before it.

### 7.3 Add a new webapp page
1. Add route in `App.tsx` inside `<PrivateRoute roles=[...]>`.
2. Place page under `pages/<role>/<feature>/index.tsx`.
3. Use shadcn primitives + Tailwind. Pull data via `apiService.<method>` from `services/api.ts`.
4. For forms: prefer `react-hook-form` + `zod`. For toasts: `sonner`. Do **not** use `window.alert()`.

### 7.4 Database migration
1. Create `src/schema/migrations/<NNN>_<short_name>.sql`.
2. Use `IF NOT EXISTS` defensively but track applied state externally (we have no migration framework yet).
3. **Never** put hospital-specific data SQL in this folder — use a `seeds/` directory instead.
4. Update `src/schema/schema.sql` to reflect canonical state.

---

## 8. Known Risks (high-level)

See `TECH_DEBT.md` for the full prioritized list. Top-of-mind for any new work:

- **Schema drift:** `hospital_assignments.is_active` referenced in code but not in schema.
- **Auth bug:** `jwt.decode` instead of `verify` in refresh path.
- **Dead route bug:** `deletePatient` ownership check uses userId as hospitalId.
- **iOS unshippable** until Info.plist + bundle id fixed.
- **Lint disabled in webapp CI** — type/lint errors are hidden.
- **Three near-duplicate attribute configurators** (~900 LOC each) waiting to be unified.

---

*Source audits are archived at `docs/archive/audits/`. For product context see `PRODUCT_SPEC.md`. For prioritized cleanup see `TECH_DEBT.md`.*
