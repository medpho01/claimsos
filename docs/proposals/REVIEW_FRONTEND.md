# ClaimOS Frontend — Senior-Architect Code Review

**Scope:** `webapp/src/` — 141 TS/TSX files, ~38.5K LOC. React 19 + CRA (craco) + TS 4.9 + Tailwind + shadcn/Radix + axios + react-router 7 + react-hook-form + zod + sonner.
**Date:** 2026-05-14
**Reviewer perspective:** Setting direction for the next phase of frontend development — what to fix, what to refactor, what to throw away.

---

## Executive summary

1. **The "UI Revamp" left two architectures coexisting.** The Hospital portal under `/portal/:id` runs a new layout/context (`pages/hospital/Layout`, `HospitalDataContext`) — but it imports its core data hook from `pages/superadmin/HospitalDetailsPage/hooks/useHospitalData.ts`, a "deprecated" page whose own routes redirect away. Dead pages still ship live dependencies. Cleaning up the old `HospitalDetailsPage` tree without first extracting its hooks/components would break production.
2. **Two `CredentialsTab` implementations exist; Node resolves to the wrong one.** `components/DoctorDetailsTabs/CredentialsTab.tsx` (1036 lines, old) AND `CredentialsTab/index.tsx` (305 lines, refactor) both exist. The import `from './CredentialsTab'` resolves to the **file**, not the directory — so the refactor is silently dead code. Either delete the refactor or delete the old file.
3. **Five components hardcode `localhost:8000` for dev base URL** (`pdfGenerator.ts:8`, `Lightbox.tsx:11`, `LazyImage.tsx:31`, `PatientPhotosModal/index.tsx:28`, `HospitalDocsAndDetails.tsx:521`, `DoctorDetailsModal.tsx:151`). The official `services/api.ts` uses port 6001 against `window.location.hostname`. Photos, PDFs, and thumbnails will all 404 in any dev environment that isn't a literal localhost on port 8000. This is a real production bug if anyone serves dev via a tunnel/IP.
4. **JWT lives in localStorage and is read directly by 7+ files outside the API layer.** Token interceptor in `services/api.ts` is correct, but multiple `fetch()` call sites bypass it and re-read `localStorage.getItem('accessToken')` themselves — meaning silent token-refresh and 401 handling don't apply to those calls. Standard XSS-via-localStorage risk amplified by `dangerouslySetInnerHTML` on user-uploaded `.docx` content (see Critical).
5. **The shared `Dialog` component blocks click-outside-to-close globally**, forcing every consumer to fight it. Combined with widespread `alert()` and `window.confirm()`, the dialog UX is inconsistent and not in line with the rest of the design system.
6. **Hospital attributes and panels are managed by two 1.5K-line monolith components** (`AttributesManager.tsx` 1471 lines, `PanelsManager.tsx` 1721 lines) with 22-24 `useState` calls each and full snake_case/camelCase normalization scattered throughout JSX. Both render multiple dialogs, ~12 data shapes, and contain copy-paste of the same upload/download code blocks.
7. **TypeScript safety is essentially off.** `tsconfig.json` has `strict:false`, `noImplicitAny:false`, `strictNullChecks:false`. 251 `: any` annotations and 65 `as any` casts. The build script also sets `DISABLE_ESLINT_PLUGIN=true` and `CI=false` — i.e. type errors and lint errors do not block production builds.
8. **Polling/uploads have two overlapping implementations.** `context/UploadContext.tsx` and `components/modals/PatientPhotosModal/hooks/usePhotoUpload.ts` independently implement upload queues with progress simulation, retry, and URL.revokeObjectURL cleanup. Both have bugs.

---

## Critical (security / data loss)

### C1. XSS via Word-document preview rendering
- **Location:** `src/components/FilePreviewModal.tsx:370` — `<div … dangerouslySetInnerHTML={{ __html: wordHtml }} />`
- **Why:** `wordHtml` comes from `mammoth.convertToHtml({ arrayBuffer })`. Mammoth does not sanitize HTML; a malicious .docx can embed `<img onerror>` / `<script>` / `<iframe srcdoc>` constructs which then execute inside the authenticated origin. Any user who can upload a Word doc to a hospital they have edit on can XSS any other user who previews it. Combined with `localStorage` token storage → token theft.
- **Direction:** Pipe Mammoth output through DOMPurify, or render Word docs to a sandboxed iframe with `sandbox="allow-same-origin"` stripped. Pdf-to-iframe is already the pattern used for PDFs.

### C2. Hardcoded localhost:8000 dev base URLs
- **Locations:**
  - `src/services/pdfGenerator.ts:5-8`
  - `src/components/modals/PatientPhotosModal/index.tsx:28`
  - `src/components/modals/PatientPhotosModal/components/Lightbox.tsx:8-11`
  - `src/components/modals/PatientPhotosModal/components/LazyImage.tsx:31`
  - `src/pages/superadmin/HospitalDetailsPage/components/HospitalDocsAndDetails.tsx:521`
  - `src/pages/superadmin/HospitalDetailsPage/components/DoctorDetailsModal.tsx:151`
- **Why:** Five+ call sites use `process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8000'`. The canonical `services/api.ts:9-13` uses port **6001** against `window.location.hostname`. PR comment in `PatientDocumentsPanel.tsx:36-43` explicitly notes the localhost:8000 pattern is wrong: "Earlier code hardcoded localhost:8000 (the IN-container port) which is not reachable from the browser." That fix didn't propagate.
- **Direction:** Centralize URL resolution in `services/api.ts`, export `getApiV2BaseUrl()`, and have every fetch call site consume it. Then forbid raw fetch in lint/CI.

### C3. Multiple fetch call sites bypass the auth/refresh interceptor
- **Locations:** `FilePreviewModal.tsx:183`, `PatientPhotosModal/index.tsx:187`, `PatientPhotosModal/components/LazyImage.tsx:33`, `PatientPhotosModal/components/Lightbox.tsx:48,394`, `PublicHospitalProfile.tsx:50`, `HospitalDocsAndDetails.tsx:527`, `DoctorDetailsModal.tsx:157`, `PatientDocumentsPanel.tsx:140,470`, `pdfGenerator.ts:68`.
- **Why:** Each does its own `localStorage.getItem('accessToken')` then `fetch(API_V2_BASE_URL + url, { headers })`. If the access token has just expired, the in-axios refresh mutex pattern won't fire for these calls; the user sees a broken image / blank PDF / failed download instead of a transparent refresh. Worst case the user gets logged out a few seconds later when the next axios call 401s.
- **Direction:** Route all binary downloads through the axios instance (`responseType: 'blob'`) — `services/api.ts` already exposes a `get(url, config)` escape hatch. Delete the parallel fetch ladder.

### C4. JWT in localStorage with no httpOnly fallback
- **Locations:** `context/AuthContext.tsx:32-37`, `services/api.ts:59,101-127`, and 7 other call sites reading `accessToken`.
- **Why:** Standard XSS+localStorage risk. The whole-app vector here is C1; secondary vectors include any future bug in a markdown/HTML rendering path. Refresh token is also in localStorage and is sent as a payload over fetch.
- **Direction:** Move to httpOnly secure cookies for refresh (with `SameSite=Lax`) and keep only a short-lived in-memory access token. Out of scope for a single PR but should be on the roadmap.

### C5. `localStorage.clear()` on logout wipes unrelated keys
- **Location:** `src/context/AuthContext.tsx:43`, `src/services/api.ts:126,133`.
- **Why:** Logout also wipes the SuperAdmin tab cache, theme preference (`claimsos.theme`), and any future user setting. Theme flickers to default on next login.
- **Direction:** Replace `localStorage.clear()` with explicit `removeItem('accessToken')` / `removeItem('refreshToken')` / `removeItem('user')`.

### C6. Role-based routing is enforced only client-side
- **Location:** `src/App.tsx:41-56` (`PrivateRoute`), `src/pages/hospital/Layout/index.tsx:180-187` (SuperAdmin vs Hospital sidebar branch).
- **Why:** `PrivateRoute` reads `user.role` from the React context (which was loaded from localStorage). A user can edit localStorage and "become" a superadmin client-side. The server still enforces, but the UI will happily try to load superadmin-only screens and reveal a lot about the routing structure. Not a vulnerability if the backend is correct, but a fingerprinting/lecture surface that's worth shrinking.
- **Direction:** Have the backend return capability flags on `/auth/me` and rely on those, not the role string echoed back from login.

---

## High (bugs that affect users)

### H1. Duplicate `CredentialsTab` — refactor is dead code
- **Location:** `src/components/DoctorDetailsTabs/CredentialsTab.tsx` (1036 lines, old, used) AND `src/components/DoctorDetailsTabs/CredentialsTab/index.tsx` (305 lines, new modular refactor + sibling files `AddCredentialDialog.tsx`, `CredentialsGroupedList.tsx`, `CredentialInputField.tsx`, `DynamicCredentialForm.tsx`).
- **Why:** `DoctorDetailsModal.tsx:23` imports `from './CredentialsTab'`. Node module resolution checks `CredentialsTab.tsx` (the file) **before** `CredentialsTab/index.tsx` (the directory). The refactor is silently never executed. Any bug-fix landed in the new file has no effect.
- **Direction:** Decide which is canonical. If refactor is wanted, delete `CredentialsTab.tsx` (the file). If the old code is intended, delete the whole `CredentialsTab/` folder.

### H2. UploadContext cleanup effect has stale-closure bug
- **Location:** `src/context/UploadContext.tsx:120-128` — `useEffect(() => { return () => { uploadQueue.forEach(...URL.revokeObjectURL...) } }, [])`.
- **Why:** Empty deps array captures the *initial empty* `uploadQueue`. On unmount, nothing is revoked. Object URL leaks throughout the session — every preview image accumulates. Same bug in `PatientPhotosModal/hooks/usePhotoUpload.ts:88-96`.
- **Direction:** Either use a ref to track current queue, or fall back to per-item cleanup on terminal-status transitions.

### H3. Patient list does N+1 fetches across panels
- **Location:** `src/pages/hospital/Patients/index.tsx:103-160`.
- **Why:** The comment at line 30 claims "apiService.getHospitalAllPatients(hospitalId) returns the flat patient list" — but the code below fans out one `getHospitalPanelPatients` call per panel and concatenates. Each is paginated to page=1 (default 50), so a hospital with >50 patients in any panel silently drops the rest. Same anti-pattern on `PatientDetail/index.tsx:85-119` and `PatientEdit/index.tsx:79-110`.
- **Direction:** Either ship the promised `getHospitalAllPatients` endpoint, or page through panels correctly. As-is, patient lists are wrong for any non-trivial hospital.

### H4. `PatientPhotosModal/index.tsx:28` API_V2_BASE_URL is empty in production
- **Location:** Same file, line 28.
- **Why:** `process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8000'`. In production this resolves to `'' + fetchUrl` — only works because `fetchUrl` (`webViewLink` / `proxyLink`) is sometimes absolute. When `webViewLink` is a relative path (e.g. for legacy S3 photos), this concatenates to a relative URL that depends on the current page. Sometimes works, sometimes 404s.
- **Direction:** Always use `getApiV2BaseUrl()` from `services/api.ts`. Don't reinvent.

### H5. `Layout/index.tsx` `refreshData` is a no-op
- **Location:** `src/pages/hospital/Layout/index.tsx:167` — `refreshData: () => { /* Handle refresh */ }`.
- **Why:** `HospitalDataContext` exposes `refreshData` to all child pages, but the provider passes a stub. Any consumer that calls `refreshData()` (currently none, by audit, but the type invites it) silently does nothing.
- **Direction:** Either implement (`refresh: useHospitalData(...).refetch`) or remove from the context type.

### H6. `HospitalUserList` optimistic-update revert is broken
- **Location:** `src/pages/superadmin/HospitalDetailsPage/components/HospitalUserList.tsx:71-88`.
- **Why:** On failure, `setLocalUsers(localUsers)` is called — but `localUsers` is the closure value from the previous render, which under React 18 batching is unreliable. Should save the old user list before the optimistic update and restore that, or use functional setState with the inverse delta.
- **Direction:** Save `const previous = localUsers;` at start, restore on catch.

### H7. `RegisterDoctor` fetches specializations but discards the response
- **Location:** `src/pages/auth/RegisterDoctor.tsx:72-94`.
- **Why:** API request to `/admin/doctor-attributes/definitions?category=qualifications` is made, but the response is ignored and a hardcoded 15-item list is set into state. Wasted API call, plus the hardcoded list will drift from the canonical master options.
- **Direction:** Either use the response shape or drop the call. If the API isn't ready, use `useMasterOptions('speciality')` (already exists).

### H8. `AddDoctorForm` does the same hardcoded-fallback pattern
- **Location:** `src/pages/hospital/Profile/components/DoctorsManager.tsx:352-382`.
- **Why:** Identical "fetch, then ignore response on error and fall back to a 15-item hardcoded list" pattern. Two sources of truth for specializations + a third in `RegisterDoctor`.
- **Direction:** Single hook (`useSpecialities()`), shared cache, no per-component fallback.

### H9. Patient page `navigate('/')` is non-deterministic
- **Location:** `src/pages/hospital/Patients/index.tsx:199`, `PatientDetail/index.tsx:176`, `PatientEdit/index.tsx:181`, `Profile/index.tsx:171,73`.
- **Why:** The breadcrumb "Hospitals" link calls `navigate('/')`. The root route then calls `getRedirectPath()` which routes based on role: a hospital user is sent back to `/portal/:hospital_id` — i.e. the user just navigated away from a patient and ends up back at their hospital dashboard. The link does not behave as written. For SuperAdmin it lands on `/superadmin`. So the same breadcrumb has two destinations depending on who's looking.
- **Direction:** Use explicit destinations (`/superadmin` for SA, role-aware label for hospital users). The intent "go to hospital list" doesn't exist for hospital-role users — hide the link or rename it.

### H10. `HospitalDirectory.tsx` uses `window.location.href` for in-app navigation
- **Location:** `src/pages/HospitalDirectory.tsx:264` — `window.location.href = '/hospital/${hospital.id}'`.
- **Why:** Full page reload instead of `navigate(...)`. Worse: `/hospital/:id` is the legacy route that immediately redirects to `/portal/:id`, so the user gets two server hits + a flash of white for every click.
- **Direction:** Use `useNavigate()` and route to `/portal/${id}` directly.

### H11. PanelsManager `fetchData` auto-selects a panel only on first load
- **Location:** `src/pages/hospital/Profile/components/PanelsManager.tsx:216-218`.
- **Why:** `if (!selectedPanel && panelsList.length > 0) setSelectedPanel(panelsList[0])`. If the user deletes the currently-selected panel, `selectedPanel` is stale (points to a deleted record), and the auto-select doesn't refire. Subsequent attribute fetch in the dependent effect targets a panel that no longer exists.
- **Direction:** On refresh after delete, reset `selectedPanel` to `panelsList.find(p => p.id === selectedPanel?.id) ?? panelsList[0] ?? null`.

### H12. PanelsManager attribute load is N+1 for legacy data
- **Location:** `src/pages/hospital/Profile/components/PanelsManager.tsx:245-276` and again at `306-353` (duplicated for `refreshPanelAttributes`).
- **Why:** For each attribute that lacks a `documents` array and has `document_id`, the code does an extra `getDocument` call. With dozens of attributes per panel and a fan-out across multiple panels, you can easily fire 60+ network requests per tab switch. The code path is also fully duplicated — change one, miss the other.
- **Direction:** Extract to one helper; have the backend always return `documents[]` and remove the fallback entirely.

### H13. AttributesManager's `formData` is shared between Add and Edit dialogs
- **Location:** `src/pages/hospital/Profile/components/AttributesManager.tsx:105-118` (single `formData`), used at `905` (add form) and `1135` (edit form).
- **Why:** Both dialogs read and write to the same `formData` state. Open Add, partially type a value, close, open Edit on a different attribute — Add's data leaks in. `setShowAddDialog(false)` does not reset `formData`. Several visible bugs follow from this.
- **Direction:** Separate `addFormData` / `editFormData`, or use react-hook-form per-dialog.

### H14. Mass console.log noise (252 statements) ships in production builds
- **Location:** Throughout. Heavy offenders: `useDocumentUpload.ts` (10+), `PanelsManager.tsx` (10+), `AttributesManager.tsx` (8+).
- **Why:** Includes file names, sizes, doc IDs, and "🚀" / "✅" / "❌" emojis. Slows the main thread on bulk uploads. Some logs include `formData` (which can contain PII). Build doesn't strip them — craco config doesn't add a `babel-plugin-transform-remove-console`.
- **Direction:** Either strip in prod build, or replace with a `logger` shim that no-ops in production.

### H15. `passWord` field name flows from frontend through to the API
- **Location:** `src/services/api.ts:147-152,156`, `AddUserModal.tsx:27,76,170-180`, `RegisterDoctor.tsx:119`.
- **Why:** The internal naming follows the backend's `passWord` / `userName` camel-quirk. Not a bug, but a smell that has leaked into form fields (`name="passWord"`). Password managers and autofill may misbehave with non-standard casing.
- **Direction:** Frontend should normalize to `username` / `password`; map to backend casing only in the API layer.

### H16. `useEffect` deps drop `fetchData` callbacks
- **Locations:** `src/pages/hospital/Profile/index.tsx:71-78` (`// eslint-disable-next-line react-hooks/exhaustive-deps`), `PanelsManager.tsx:144-148`. Both deliberately silence the lint rule.
- **Why:** Hospital profile only refetches on `hospitalId` change. If you delete the profile and someone else updates it, you won't see the change without a full refresh. Acceptable for now but the silence has spread.
- **Direction:** Wrap `fetchProfile` in `useCallback` and include it; or accept the lint warning honestly.

### H17. `HospitalPortalLayout` re-fetches everything on every hospital switch
- **Location:** `src/pages/hospital/Layout/index.tsx:22-29` + `hooks/useHospitalData.ts:64-147`.
- **Why:** No request cache. Navigating between portals (e.g. SuperAdmin browsing several hospitals) re-fetches detail+panels+users+doctors each time. With panels-detailed being a heavy join, each visit is multiple hundred-ms.
- **Direction:** Introduce a per-hospital cache (sessionStorage shim already used in `SuperAdminPage` — generalize).

### H18. `PatientPhotosModal.handleBulkDelete` deletes silently without refresh
- **Location:** `src/components/modals/PatientPhotosModal/index.tsx:161-172` and `hooks/usePhotosData.ts:163-180`.
- **Why:** `deleteFiles` is followed by `fetchPhotos(true)` inside the hook. The modal also `setHasChanges(true)`. Fine — but the inner `alert(error.response?.data?.message)` on failure inside the hook (line 176) is the only failure indicator. No optimistic update; user clicks delete on 5 photos, sees them disappear, sees them reappear when the refetch returns success but a 6-second cache window keeps the deleted records around. Race window is real.
- **Direction:** Optimistic remove from state, then revert on error.

### H19. PatientDetail `showPhotos` modal is mounted but never opened
- **Location:** `src/pages/hospital/PatientDetail/index.tsx:83,486-491` — `const [showPhotos, setShowPhotos] = useState(false)` and `{showPhotos && patient && <PatientPhotosModal ...`. `setShowPhotos(true)` is never called.
- **Why:** Dead state from a previous iteration. Adds confusion when debugging the documents tab.
- **Direction:** Remove.

### H20. SuperAdmin nav has no active highlight when used from `/portal/...`
- **Location:** `src/components/SuperAdminSidebar.tsx:73,107`.
- **Why:** `effectiveActive` is `undefined` in stateless mode (i.e. when SA is inside a hospital portal). Author notes "we don't highlight any item." — but most workflows have SA bouncing between Hospitals and a hospital workspace; the rail being permanently unlit makes wayfinding harder.
- **Direction:** When on `/portal/:id`, highlight "Hospitals" as the source-of-truth nav, with a sub-cue showing the current workspace name.

---

## Medium (UX / correctness / consistency)

### M1. Global Dialog override blocks click-outside-to-close
- **Location:** `src/components/ui/dialog.tsx:45-48` — `onPointerDownOutside={(e) => { e.preventDefault(); props.onPointerDownOutside?.(e); }}`.
- **Why:** Applied globally to every Radix Dialog in the app. Forces every dialog to be dismissed only via the explicit close button. Some dialogs (e.g. delete confirmations) want this; most form dialogs do not. Users expect web modal behavior.
- **Direction:** Don't override at the primitive level. Let each consumer opt in via prop.

### M2. Mixed neutral palette: 680 `slate-*` vs 268 `gray-*`
- **Location:** Codebase-wide.
- **Why:** Pages built post-Revamp use `slate-*`; older pages and form components use `gray-*`. Both are visually similar but slightly different. The biggest gray-* offender is `AttributesManager.tsx` (still old palette through and through, despite living inside the new portal).
- **Direction:** Pick `slate-*`. Codemod replace.

### M3. Mixed semantic colors: 184 `red-*` vs 28 `danger-*`
- **Location:** Codebase-wide. tailwind.config defines `danger-50/600/700` semantic tokens, but most error states still use raw `red-*`.
- **Direction:** Move all destructive UI to `danger-*` so future re-skinning is one config change.

### M4. Multiple "select" implementations
- **Location:** ~20 files use native `<select>` (e.g. `AttributesManager.tsx:908`, `PanelsManager.tsx`, all CredentialsTab files), 3 use `components/ui/select.tsx` (Radix), and `components/forms/SelectField.tsx` / `MultiSelectField.tsx` are custom Tailwind dropdowns. Three different keyboarding behaviors and styling for the same control.
- **Direction:** Pick one (recommend Radix's `Select` for accessibility + portal positioning). Replace forms-MultiSelectField with a Combobox pattern; deprecate native `<select>` in new code.

### M5. `alert()` and `window.confirm()` still in production paths
- **Location:** 14 `alert()` + 10 `window.confirm()`. Toast is wired (`sonner` already imported) but inconsistently used. Examples: `AttributesManager.tsx:1464`, `useHospitalData.ts:80-138` ("Unauthorized or Hospital Not Found"), `HospitalUserList.tsx:86`, etc.
- **Why:** Native browser dialogs block the main thread, are unstyled, and can't be screenshotted in QA tooling. The "Unauthorized" alert in `useHospitalData` runs *before* the navigation, so on slow connections the user sees the alert with no context.
- **Direction:** Replace `alert(...)` with `toast.error(...)` and `window.confirm(...)` with the existing `AlertDialog` component (already used in `DoctorsManager.tsx:268-301`).

### M6. Two duplicate upload-queue stacks
- **Location:** `src/context/UploadContext.tsx` (global) and `src/components/modals/PatientPhotosModal/hooks/usePhotoUpload.ts` (per-modal). Both implement progress simulation with `setInterval`, retry/cancel, validation, preview URLs.
- **Direction:** The global UploadContext is the better home. Delete the modal-local hook and have the modal dispatch to context.

### M7. SuperAdmin tab cache stored in two stores
- **Location:** `src/pages/superadmin/SuperAdminPage.tsx:39-42` uses `sessionStorage` for hospital/admin lists; line 46 uses `localStorage` for the active tab. `SuperAdminSidebar.tsx:81` also writes to `localStorage` for the same key.
- **Why:** Mixing storage scopes is confusing. `localStorage` survives logout/login (because `localStorage.clear()` happens — see C5 — but theme also gets wiped). `sessionStorage` doesn't survive a tab close.
- **Direction:** Pick one. Prefer sessionStorage for transient caches.

### M8. Dialog headers don't have `DialogDescription`
- **Locations:** `LoginPage.tsx`, `AddUserModal.tsx`, many form modals.
- **Why:** Radix Dialog requires either a description or `aria-describedby`. Without one, screen readers announce only the title, missing context. Radix logs a warning in dev — usually silenced in production.
- **Direction:** Add `DialogDescription` (visually hidden if not visible) to every Dialog.

### M9. Tabs lose their state on navigation
- **Location:** `src/pages/hospital/Profile/index.tsx:54-59` reads `?tab=` from URL but doesn't write back.
- **Why:** Switching tabs via the underline UI does not update the URL. Browser back button can't navigate between tabs.
- **Direction:** Use `setSearchParams({ tab: key })` on tab click.

### M10. Dashboard KPIs all hardcoded to 0
- **Location:** `src/pages/hospital/Dashboard/index.tsx:53-68` — `kpis = { admitted, inPreAuth: 0, settledWeekRupees: 0, doctors: 0 }; pipeline = { ..., submitted: 0, queried: 0, settledWeek: 0 }`.
- **Why:** Wireframe-driven layout shipped with placeholder values labeled `TODO(workspace-stats)`. The dashboard looks 80% empty for any user who lands on it. Critically misleads stakeholders.
- **Direction:** Either hide stats until backend is ready, or ship the API first.

### M11. Patient detail page maps statuses with regex
- **Location:** `src/pages/hospital/PatientDetail/index.tsx:35-42` and `Patients/index.tsx:61-71`.
- **Why:** `match: (s) => /pre.?auth/i.test(s || '')` etc. Status string canonicalization done with regex in two places. Drift risk: if backend adds a new status, you have to update the regex array in multiple files.
- **Direction:** Centralize as enum + map. Or have backend return a canonical group code alongside the display label.

### M12. AttributesManager edit dialog uses single shared formData with snake_case-camelCase juggling
- **Location:** `src/pages/hospital/Profile/components/AttributesManager.tsx:856-867`, `1305-1310`. Every read does `attr.expiresAt || attr.expires_at`, `attr.issueDate || attr.issued_at`, etc.
- **Why:** Backend response is sometimes camel, sometimes snake. Frontend types declare both fields optional. JSX is full of `||` chains.
- **Direction:** Add a server response transformer (`utils/apiTransformers.ts` already exists!) and normalize once.

### M13. `apiTransformers.ts` exists but isn't wired in
- **Location:** `src/utils/apiTransformers.ts` (utility file, presumably the intended boundary).
- **Direction:** Either use it everywhere — preferably in the axios `response` interceptor — or delete it.

### M14. PanelsManager / AttributesManager / CredentialsTab are 1.5K-line god components
- **Lines:** `PanelsManager.tsx` 1721, `AttributesManager.tsx` 1471, `CredentialsTab.tsx` 1036, `PublicHospitalProfile.tsx` 1026.
- **Why:** Each renders 3-5 dialogs, has 20+ state variables, mixes data fetch + transform + validation + JSX. Onboarding cost is high; bug-fix risk is high.
- **Direction:** Each dialog → own component. Form state → react-hook-form (already in deps). The refactor for CredentialsTab was started (see H1) and abandoned; finish it as the template.

### M15. Dashboard panel breadcrumb "Hospitals" link uses role-dependent navigation
- **Location:** `src/pages/hospital/Dashboard/index.tsx:92-96`.
- **Why:** Same issue as H9 — hospital-role users get sent back to the same dashboard.
- **Direction:** Hide "Hospitals" link for hospital-role users; only SA/admin see it.

### M16. `HospitalDirectory` and `PublicHospitalProfile` are public routes with no error boundaries
- **Location:** `src/App.tsx:139-153,190-195`.
- **Why:** A render error in `PublicHospitalProfile.tsx` (1026 lines, many `??` paths) crashes the route. No `ErrorBoundary` in the app at all.
- **Direction:** Add a top-level ErrorBoundary plus public-route boundaries that show a friendly fallback.

### M17. `App.tsx:139-152` has two routes for the same public profile
- **Location:** `App.tsx:139` (`/public-profile/:token`) and `:147` (`/hospitals/share/:token`). Both render `PublicHospitalProfile`.
- **Why:** Probably for legacy link compatibility. Add a `<Navigate>` redirect from one to the other to keep canonical URLs.

### M18. `RegisterDoctor` password regex doesn't match common policies
- **Location:** `src/pages/auth/RegisterDoctor.tsx:27-32`.
- **Why:** Requires `[!@#$%^&*]` — i.e. a 6-character whitelist. A user typing a perfectly secure 20-char passphrase with `_` or `-` is told it's invalid. Common UX papercut.
- **Direction:** Use `/[^a-zA-Z0-9]/` (any non-alphanumeric) or drop the special-char rule entirely in favor of length.

### M19. `GlobalNavbar` accepts unused props
- **Location:** `src/components/Navbar/GlobalNavbar.tsx:15-18,35` — `hospitalName` and `showHospitalContext` declared but never used in the body.
- **Why:** Probably wireframe scaffolding. Multiple callers (`HospitalPortalLayout`, `SuperAdminPage`, etc.) pass these values expecting display.
- **Direction:** Either implement (display hospital name as a breadcrumb in the navbar) or delete the prop type.

### M20. `Patients/index.tsx` "Export" button is decoration
- **Location:** Line 258-260. `<button>Export</button>` with no `onClick`.
- **Direction:** Either implement or hide.

### M21. Master options fetched per-component, no shared cache
- **Location:** `src/hooks/useMasterOptions.ts:38-83`.
- **Why:** Each consumer mounts the hook → fires a request. ProfileForm uses two master categories; a page with N forms would make N requests for the same data.
- **Direction:** Wrap in a context, or use `react-query`/SWR (not currently in deps but a natural next step given the request density).

### M22. `usePhotosData` cache key is `patientId` only, ignores admissionType
- **Location:** `src/components/modals/PatientPhotosModal/hooks/usePhotosData.ts:6-7,108`.
- **Why:** If a patient's admission_type changes (e.g. conservative → surgical), the cached category groupings won't update. Cache key should include `admissionType`.
- **Direction:** `cacheKey = ${patientId}:${admissionType ?? 'unknown'}`.

### M23. PDF preview uses native `<iframe>` instead of react-pdf
- **Location:** `src/components/FilePreviewModal.tsx:262-275`.
- **Why:** Comment says "Avoids worker-bootstrap issues on http://localhost". The Lightbox component (`PatientPhotosModal/components/Lightbox.tsx:7`) still uses react-pdf. Two PDF rendering paths to maintain.
- **Direction:** Pick one. iframe is faster and simpler; react-pdf has pagination control.

### M24. Avatar fallback colors derived from "first char of name modulo 8 colors"
- **Location:** `src/pages/PublicHospitalProfile.tsx:20-34`.
- **Why:** Includes "bg-purple-600" / "bg-amber-600" — neither is in the new design system (brand/danger/warn/info/ok). Avatar palette will look out of place against the rest of the app once the new palette is consistent.
- **Direction:** Use brand-* / muted-* shades only.

### M25. PatientDocumentsPanel's `downloadOne` doesn't revoke object URL on error path
- **Location:** `src/pages/hospital/PatientDetail/PatientDocumentsPanel.tsx:133-173`.
- **Why:** If `imageCompression` throws after `URL.createObjectURL`, the URL leaks.
- **Direction:** try/finally with revoke.

### M26. `daysSince` in patient pages returns 0 when admittedAt is missing
- **Location:** `src/pages/hospital/Patients/index.tsx:42-46`.
- **Why:** Returns `null` on missing, but the consuming code at line 374-376 only conditionals on `admittedDays !== null`. Fine — but the function name implies a number; consider `daysSinceOrNull`.

### M27. SuperAdminPage `getCached` swallows JSON parse errors silently
- **Location:** `src/pages/superadmin/SuperAdminPage.tsx:30-35`.
- **Why:** `JSON.parse(sessionStorage.getItem(key))` in a `try/catch{return fallback}`. If the cached blob got corrupted, the user sees an empty list with no indicator.
- **Direction:** Log + invalidate the broken cache entry on parse failure.

### M28. `HospitalPortalLayout` shows "Hospital not found or access denied" without retry
- **Location:** `src/pages/hospital/Layout/index.tsx:145-151`.
- **Why:** Plain centered text, no actions. A real authorization failure dead-ends the user.
- **Direction:** Provide "Back to login" / "Switch hospital" actions.

### M29. Lightbox image fallback fetches but doesn't revoke when navigating
- **Location:** `src/components/modals/PatientPhotosModal/components/Lightbox.tsx:44-55`.
- **Why:** `setSrc(URL.createObjectURL(blob))` on photo change — but no `URL.revokeObjectURL` when the photo changes. Memory leak on rapid next/prev.
- **Direction:** `useEffect` cleanup that revokes the previous src.

### M30. AddUserModal's "Roles" UI loads even when `panels === null`
- **Location:** `src/components/modals/AddUserModal.tsx:209` — `{role === "hospital" && panels != null && (...)}`. Fine. But the prop type says `panels: HospitalPanel[] | null` — and the caller in `SuperAdminPage.tsx:582` passes `panels={null}`. So for the global "Add Admin" / "Add Hospital User" use case, no panels are pickable, even though hospital users always need panel access.
- **Direction:** When creating a hospital user from the global SA add-user flow, prompt for hospital first, then load that hospital's panels.

### M31. `PatientPhotosModal/index.tsx` saves details by reading both `react-hook-form` AND the patient object
- **Location:** Lines 277-294.
- **Why:** `firstName: patient.first_name` — i.e. name fields come from the prop, not the form. Editing them in the form has no effect.
- **Direction:** Drive everything through the form, or remove the unused fields from the form schema.

### M32. Hospital Layout's `users` route just redirects
- **Location:** `src/App.tsx:250` — `<Route path="users" element={<Navigate to="../profile?tab=users" replace />} />`.
- **Why:** `pages/hospital/Users/index.tsx` exists but is unreachable. Dead file.
- **Direction:** Delete `pages/hospital/Users/` directory.

### M33. `DocumentUploadManager` imports a no-longer-used `useState`
- **Location:** `src/components/DocumentUploadManager.tsx:1` — generic component, 538 lines, only referenced from where?
- **Direction:** Check usage; appears to be orphaned post-Revamp.

### M34. `formData.specialties` parsed from string-or-array on every load
- **Location:** `src/pages/hospital/Profile/components/ProfileForm.tsx:62-74`.
- **Why:** Backward-compat with a legacy string format. Should be normalized server-side once and the frontend can assume array.

### M35. `Profile/ProfileForm.tsx:112` references `beds` and `total` fields that don't exist on formData
- **Location:** `name.includes('beds') || name.includes('total') ? parseInt(value) || 0 : value`.
- **Why:** Dead branch. Form has no field named beds or total.
- **Direction:** Delete.

### M36. Reading `(hospital as any).city` and `(p as any).panel_id` throughout
- **Locations:** `Dashboard/index.tsx:113`, `Patients/index.tsx:112,124,139,235`, etc.
- **Why:** Types are defined; pages just bypass them. Cumulatively erodes the value of having types.
- **Direction:** Fix the type once, drop the casts. `HospitalPanel.panel_id` is already `string`.

### M37. Photos modal disables click-outside via inline override
- **Location:** `src/components/modals/PatientPhotosModal/index.tsx:323-325` — `onPointerDownOutside={(e) => { e.preventDefault(); }}`.
- **Why:** Already blocked at the Dialog level (M1). Belt-and-suspenders that highlights the global override smell.

### M38. `PatientPhotosModal/index.tsx:299-302` falls back to `alert("Failed to save details")` after a toast-enabled session
- **Why:** Same file already uses `toast` elsewhere. Mixing notification surfaces.

### M39. Patient list, detail and edit do the same fan-out logic three times
- **Locations:** `pages/hospital/Patients/index.tsx:103-160`, `PatientDetail/index.tsx:85-119`, `PatientEdit/index.tsx:79-110`.
- **Direction:** Extract a `useAllHospitalPatients(hospitalId)` hook.

### M40. `PublicHospitalProfile.tsx` is 1026 lines with inline avatars, downloads, copy-to-clipboard, etc.
- **Direction:** Split into logical sections.

### M41. No skeletons on Dashboard/Patient list — only "Loading…" text
- **Location:** `pages/hospital/Patients/index.tsx:316` etc.
- **Why:** Other parts of the app (HospitalPortalLayout skeleton, SuperAdmin admin table skeleton) use proper skeletons. New pages regressed.

### M42. `Skeleton` exists in both `components/common/Skeleton.tsx` and `components/ui/skeleton.tsx`
- **Direction:** Pick one.

### M43. `HospitalDataContext` exposes setter functions that get called from across the tree
- **Location:** `pages/hospital/Profile/index.tsx:97-103,247-249`, `Layout/index.tsx:160-168`.
- **Why:** Children mutate parent state via `setHospitalUsers` setter passed through context. Action-creator pattern would be cleaner: have a single `refreshUsers()` exposed from context.
- **Direction:** Encapsulate.

### M44. `ApiService` exposes `get/post/put/patch/delete` generic methods
- **Location:** `src/services/api.ts:1040-1062`.
- **Why:** Half the call sites use the typed methods (`getDoctorAttributeDefinitionsGrouped`), the other half use the generic `apiService.get('/master-options/categories/list')`. The typed surface is thus aspirational only.
- **Direction:** Either commit to a typed API client (codegen from OpenAPI?) or accept the generic-only pattern. Mixed is the worst of both.

### M45. axios refresh-token call is unauthenticated but sends old token in `Authorization` header
- **Location:** `src/services/api.ts:104-113`.
- **Why:** Backend probably requires the old access token to authorize a refresh — fine, but the comment doesn't explain why. Subtle.

### M46. Logout in 3 places calls `localStorage.clear()` *or* `logout()`
- **Locations:** `services/api.ts:126,133` (clear), `AuthContext.tsx:43` (clear), various components call `logout()` from auth context. The interceptor's `localStorage.clear()` doesn't go through `setUser(null)`, so React state still says "authenticated" after a hard-fail refresh.
- **Direction:** Single path: interceptor dispatches a logout event that `AuthContext` listens to.

---

## Low (cleanup, conventions)

### L1. Two `Skeleton` components (see M42).
### L2. `pages/admin/` has just `AdminDashboardPage.tsx`; the route is mounted but the directory has no index.
### L3. `pages/panels/` is dead code (file + components). Remove.
### L4. `pages/superadmin/HospitalDetailsPage/` is dead — but its hooks and components are live deps. Move them to `pages/hospital/...` or `components/...` first, then delete.
### L5. `App.tsx:9-12` carries a stale comment about HospitalDetailsPage. Replace with actual deprecation timeline.
### L6. `tsconfig.json` has `target: "es5"` despite React 19 and modern axios. Modern browsers don't need ES5.
### L7. CRA + craco is on a deprecation path. Vite migration is a multi-PR but should be on the roadmap.
### L8. `package.json: "build": "DISABLE_ESLINT_PLUGIN=true SKIP_PREFLIGHT_CHECK=true CI=false"` — disabling all the type and lint guard rails. Tighten progressively.
### L9. No `.env.example` for new contributors. URL config lives in source code.
### L10. `src/index.css:90-98` adds `@apply` rules for native `<select>` to "fix all of them in one place" — implicit admission of M4.
### L11. `react-app-env.d.ts` is auto-generated CRA cruft.
### L12. `App.test.tsx` is the default CRA test; no real tests exist.
### L13. No prop type for `motion.div`'s `initial`/`animate` — fine, but framer-motion is imported in many places where a simple `<div>` would do.
### L14. `lib/animations.ts` exports animation presets; not all consumers use them.
### L15. `eslintConfig` extends `react-app` only — no shared eslint config across teams.
### L16. `services/api.ts` is 1065 lines and exports a default singleton instance. Hard to test.
### L17. `pdfGenerator.ts` and `FilePreviewModal.tsx` both configure `pdfjs.GlobalWorkerOptions` at module load — racing initialization order can matter.
### L18. `package.json` has `"react-multi-select-component"` (line 40 of package.json) — not referenced in source. Dead dep.
### L19. `pdfjs-dist@3.11.x` plus `react-pdf@10.3.x` — version mismatch between pdf.js used by pdfjs-dist and what react-pdf expects has bitten Safari historically.
### L20. Many `console.log('🚀 ...')` / `'✅ ...'` emojis in production code (see H14).
### L21. `:any` annotations: 251 — most can be typed quickly (Hospital, Patient, Doctor are already defined).
### L22. `as any` casts: 65.
### L23. `// TODO(` annotations: present without owners or dates.
### L24. `Lightbox.tsx` Worker URL is loaded from unpkg CDN: `//unpkg.com/pdfjs-dist@${pdfjs.version}/...` — unpkg outages will break PDF previews. Self-host or use jsdelivr fallback.
### L25. `FilePreviewModal.tsx:23-27` uses different worker source between http/https (CDN vs local). Confusing.
### L26. `Patients/index.tsx:189` `if (!hospital) return null` swallows render — but loading state above already covers most cases.
### L27. `Hospital.id.slice(0, 8) + "-" + hospital.id.slice(9, 13)` in `Dashboard/index.tsx:122-123` to mock up an ID format — should be backend-provided.
### L28. `LoginPage.tsx:32` `navigate("/dashboard")` for non-superadmin/non-hospital users — but `/dashboard` is admin-only and that's the only role it handles. A `doctor` falling through hits Unauthorized.

---

## Design-system observations

The team kicked off a "UI Revamp" pass — there's clear evidence in tailwind.config (`brand-*`, `ok-*`, `warn-*`, `danger-*`, `info-*`), index.css (`--primary` bound to brand-600), shadcn `motion.tsx`, `GlobalNavbar`, `SuperAdminSidebar`, the new Hospital Dashboard layout, and breadcrumb patterns. The intent is good: a semantic-token-driven theme with brand + status colors and consistent typography (Inter + JetBrains Mono).

The execution is partial. Three issues compound: (1) the older pages (`AttributesManager`, `PanelsManager`, the entire `superadmin/HospitalDetailsPage` subtree, `CredentialsTab.tsx`, `DocumentUploadManager`) were not migrated and still use `gray-*` / `red-*` / hardcoded HSL colors; (2) the new pages use `slate-*` / `brand-*` / `danger-*`, but inconsistently — sometimes inside the same file you'll see `text-red-600` and `text-danger-700` two lines apart; (3) the shared primitives in `components/ui/` are configured against the `--primary` HSL token (correct), but consumers ignore the primitive and hand-roll the same buttons/badges/pills with explicit `bg-brand-600 hover:bg-brand-700` markup. The end result is that ~30% of the UI already responds to a `--primary` color change, while ~70% would need a code edit.

Recommendation for the next phase: pick one of two paths. **A)** "All-in on shadcn primitives": every button is `<Button variant="...">`, every dialog uses `components/ui/dialog`, every form select uses `components/ui/select` — and the tailwind brand-* utilities are reserved for one-off marketing surfaces. **B)** "All-in on utility classes against new palette": deprecate the shadcn variant API (or override it), commit fully to `bg-brand-600` / `bg-danger-600` style, codemod-replace all `red/gray/blue` references. The current "both" state is a tax on every PR. Path A is less work and is what the architecture is already optimized for.

## State management observations

There's no centralized data layer. Each page does its own `useEffect → fetch → useState` lifecycle, often with a sessionStorage cache patch (`SuperAdminPage.tsx:30-35`), an in-memory cache (`PanelDetails/index.tsx` ref-based, `usePhotosData.ts` module-level Map), or no cache at all. Three hospital sub-pages independently fan out across panels to assemble a patient list. The `HospitalDataContext` is a partial solution but only covers `hospital`, `hospitalUsers`, `hospitalPanels` — not doctors, not patients, not attributes, not documents. The `refreshData` it exposes is a no-op stub.

The bigger problem is multiple **sources of truth** for the same entities. Patients are loaded by `Patients/index.tsx`, `PatientDetail/index.tsx`, `PatientEdit/index.tsx`, `PanelDetails/index.tsx`, and `pages/panels/index.tsx` (dead) — each with its own fetch logic, cache (or not), and snake_case ↔ camelCase normalization. After a patient is edited, only the screen that did the edit knows about the change; navigating to another tab shows stale data until you refresh.

Recommendation: introduce TanStack Query (react-query) or SWR. The existing patterns (cache-key by endpoint, stale-while-revalidate, optimistic updates, retry/refresh) are exactly what these libraries solve. Even a thin shared `useResource(key, fetcher)` would eliminate ~half the bug surface called out above (race conditions, stale data after mutation, N+1 refetches, missing error states). Combined with the `apiTransformers.ts` (currently unused) at the response-interceptor level, snake/camel inconsistencies disappear.

The auth context is fine for what it is but should not be the only context. `UploadContext` is a good model. Don't grow `HospitalDataContext` further; it's already a god-context.

---

## Quick wins (≤1 hour each, ranked)

1. **Delete `pages/panels/`** (dead code, no inbound routes). Caveat: first move `panels/components/PatientTable.tsx` to where `PanelDetails/index.tsx` can keep importing it. (~30 min)
2. **Delete `pages/hospital/Users/`** (route is a redirect; the page is unreachable). (~5 min)
3. **Delete the wrong-half of `CredentialsTab`** — pick the working file or the refactor, delete the other. (~10 min)
4. **Centralize `API_V2_BASE_URL` export** in `services/api.ts` and replace the six hardcoded `localhost:8000` constants. (~30 min)
5. **Remove `localStorage.clear()` in 3 places**, replace with explicit `removeItem` for accessToken/refreshToken/user. (~10 min)
6. **Remove the global `onPointerDownOutside={preventDefault}` override** in `components/ui/dialog.tsx`. (~5 min, but verify no critical-dismiss dialogs regress)
7. **Strip console.* in production build** — add `babel-plugin-transform-remove-console` to craco config. (~15 min)
8. **Replace native `alert()` and `window.confirm()` with toast and AlertDialog** in the top 5 worst offenders (`useHospitalData.ts`, `HospitalUserList.tsx`, `AttributesManager.tsx`, `PatientPhotosModal/index.tsx`, `PublicHospitalProfile.tsx`). (~45 min)
9. **Wire `apiTransformers.ts` into the axios response interceptor** to normalize snake↔camel at the boundary. (~45 min; cleanup of `||` chains comes later)
10. **Remove unused `react-multi-select-component` dep**. (~2 min)
11. **Add `DialogDescription` to all dialogs missing it** (a11y warning silencer). (~30 min)
12. **Fix `HospitalUserList.tsx:85` optimistic-update revert** to save original before update. (~10 min)
13. **Remove the dead `parseInt('beds')` branch in `ProfileForm.tsx:112`**. (~2 min)
14. **Remove `useState showPhotos` dead state in `PatientDetail/index.tsx:83,486-491`**. (~3 min)
15. **Replace `window.location.href = '/hospital/${id}'` in `HospitalDirectory.tsx:264`** with `navigate('/portal/${id}')`. (~3 min)
16. **Fix `refreshData` no-op in `Layout/index.tsx:167`** — wire to `refetch` from `useHospitalData`. (~10 min)
17. **Delete unused `hospitalName` / `showHospitalContext` props from `GlobalNavbar`** (M19). (~10 min)
18. **Add a missing route**: a top-level `<ErrorBoundary>` around `<Routes>` in `App.tsx`. (~30 min)
19. **Delete the duplicate `pdfjs.GlobalWorkerOptions` config in `PatientDocumentsPanel.tsx`** — `Lightbox.tsx` already sets it. (~5 min)
20. **Bump `tsconfig.target` to `es2020`** to match runtime. (~5 min)
