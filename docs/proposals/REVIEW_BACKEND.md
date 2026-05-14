# ClaimOS Backend — Senior Architecture Review

> Date: 2026-05-14
> Scope: `Backend/src/**`, root-level `Dockerfile`, `docker-compose*.yml`, `tsconfig.json`, `package.json`, and `Backend/src/schema/migrations/*.sql`.
> Intent: candid pre-flight assessment to inform the next development phase. Not a code rewrite — a punch list.

---

## Executive Summary

1. **Authn/Authz is patchwork.** A solid generic `checkAuth` exists, but a huge surface area of doctor, hospital-profile, panel-attribute, public-share, hospital-docs, and v2-uploads routes use only `checkAuth` (any logged-in user, any tenant) with **no tenant isolation in the controller**. A hospital user from Hospital A can edit attributes, upload docs, generate public share links, and download arbitrary documents belonging to Hospital B by just calling the URLs.
2. **Tenant isolation is the most serious systemic risk.** There is no consistent "does this user belong to this hospitalId/doctorId" gate. The few middlewares that do this (`checkHospitalUserPermission`, `checkPatientEditAccess`) are only wired up on the legacy `/patient`, `/uploads`, and `/claims` routes. Everything written after Apr 19 effectively bypasses tenant checks.
3. **Schema drift is real.** Two parallel hospital-doc systems (`hospital_doc` + `hospital_documents`), two doctor-doc systems (`doctor_doc` + `doctor_attribute_documents` joining `hospital_documents`), seven `002_*` and `002b/002c_*` migrations with `_fixed` siblings, plus production export SQL files in the migrations folder. There is no migration runner — these are hand-applied.
4. **SQL is hand-rolled everywhere with no transactions around multi-step writes.** Signup creates a `users` row, then a `hospital_users` row; if the second insert fails the manual rollback (`DELETE FROM users`) leaves a window where a duplicate username will fail subsequent attempts. The same pattern repeats in `createAndAddDoctorToHospital` (doctor created, hospital link not in a transaction).
5. **Polymorphic value columns (`value_text`/`value_date`/`value_boolean`) are not enforced at write time.** A `boolean` attribute can be saved with a `value_text` and nothing complains. The "data type matches" check in `attribute.service.ts` only zero-fills the wrong slots — it does not reject.
6. **Error responses leak internals.** `asyncHandler` JSON-stringifies the raw `err` to stdout and, in development mode, returns stack traces; several controllers swallow errors with `catch (err) { /* ignore */ }`. PostgreSQL errors propagate untranslated through `apiError(500, error.message)` in document upload paths, revealing table names.
7. **No request IDs, no structured logging, no rate limit, no helmet, no body sanitization.** CORS is allowlist-only but `credentials: true` plus a long-lived JWT bearer-in-header design makes the credentials flag inert. The 100 MB JSON body limit is excessive for an app whose largest legitimate JSON payload is a few KB.
8. **The known "doctor attribute documents upload broken" bug is one symptom of a broader controller duplication problem.** There are **three** doctor-upload code paths (`doctors.controller.ts:uploadDoc` via `/api/v1/doctors/:id/docs`, `doctor.controller.ts:uploadDoc` via `/api/v1/doctors/:doctorId/docs`, and the placeholder `doctor.controller.ts:uploadDoctorDocuments` returning mock IDs). Two are real, one is a stub. The routing tree mounts both at the same path prefix and only the first-matched wins.

---

## Critical (security, data integrity, data loss)

### C1. Tenant isolation bypass: doctor routes accept arbitrary `:doctorId`
**Location:** `Backend/src/Routes/doctor.routes.ts:80-134`, all routes guarded only by `AuthMiddleware.checkAuth`.
```ts
router.get('/doctors/:doctorId/attributes', AuthMiddleware.checkAuth, DoctorAttributeController.getDoctorAttributes);
router.post('/doctors/:doctorId/attributes/:attributeKey', AuthMiddleware.checkAuth, DoctorAttributeController.setAttribute);
router.delete('/doctors/:doctorId/attributes/:attributeId', AuthMiddleware.checkAuth, DoctorAttributeController.deleteAttribute);
```
**Why:** Any authenticated user (even an unrelated hospital user) can read, mutate, or delete attributes for any doctor in the system. The service layer never re-checks ownership.
**Fix direction:** Introduce a `checkDoctorAccess(doctorId)` middleware (or in-controller guard) that verifies the caller has at least one `hospital_doctors` link to the requested doctor, or is a superadmin/admin. Same pattern needed for `hospitals/:hospitalId/doctors/*`.

### C2. Hospital profile + attribute routes have no tenant gate
**Location:** `Backend/src/Routes/hospitalProfile.routes.ts:19-185`.
```ts
router.put('/hospitals/:hospitalId/profile', AuthMiddleware.checkAuth, HospitalProfileController.updateProfile);
router.post('/hospitals/:hospitalId/attributes/:attributeKey', AuthMiddleware.checkAuth, AttributeController.setAttribute);
router.post('/hospitals/:hospitalId/documents/upload', AuthMiddleware.checkAuth, upload.single('file'), DocumentController.uploadDocument);
```
**Why:** A hospital user belonging to Hospital A can `PUT` Hospital B's profile, upload documents to B, and mark attributes verified. `HospitalProfileService.updateProfile` writes blindly to the `hospital_id` in the URL.
**Fix direction:** Add a `checkHospitalAccess(:hospitalId)` middleware enforcing `superadmin || (admin in hospital_assignments) || (hospital user in hospital_users)` with `can_edit` for mutating routes.

### C3. Public share endpoints expose hospital documents with no verification of `is_public` flag
**Location:** `Backend/src/Controllers/publicShare.controller.ts:344-413` (`downloadDocumentByToken`).
```ts
const docRes = await pool.query(
  `SELECT hd.* FROM hospital.hospital_documents hd
   JOIN hospital.hospital_attribute_documents had ON hd.id = had.document_id
   JOIN hospital.hospital_attributes ha ON had.hospital_attribute_id = ha.id
   WHERE hd.id = $1 AND ha.hospital_id = $2`, [documentId, share.resource_id]);
```
**Why:** Once a share token exists for a hospital, ANY document linked to ANY attribute of that hospital is downloadable, including internal-only ones (`is_public = false`). `visible_sections.attributes` filtering only controls the JSON response; the document-download endpoint does not honour it.
**Fix direction:** Filter on `hd.is_public = true` and only allow document IDs whose attribute is in `share.visible_sections`. Better: store a `share_documents` allow-list at token creation.

### C4. Doctor attribute documents junction uses cross-schema reference `hospital.doctor_attribute_documents`
**Location:** `Backend/src/Services/doctorAttribute.service.ts:160-179`.
```ts
await pool.query(
  `UPDATE hospital.doctor_attribute_documents SET is_primary = FALSE WHERE doctor_attribute_id = $1`, ...);
await pool.query(
  `INSERT INTO hospital.doctor_attribute_documents (doctor_attribute_id, document_id, is_primary) VALUES ...`);
```
Yet the foreign key in `005_create_doctor_configuration_system.sql:150` is `REFERENCES doctor_doc(id)` (the bare table, no schema prefix), and `getAttribute` at `doctorAttribute.service.ts:207` joins `LEFT JOIN hospital.hospital_documents hd ON dad.document_id = hd.id` — i.e. joins the wrong document table.
**Why:** This is a real correctness bug. `getAttribute` returns null document metadata even when docs are linked, because the join goes to the wrong table. `getDoctorAttributes` at line 256-262 correctly joins `doctor_doc`, but the single-attribute endpoint is broken.
**Fix direction:** Standardize on one document table per entity. Audit every reference and resolve the schema-prefix vs no-prefix inconsistency.

### C5. Doctor doc upload bypasses `multer.middleware.ts` MIME allow-list and size limits
**Location:** `Backend/src/Routes/doctor.routes.ts:12` declares a per-file 100 MB inline multer with **no fileFilter**.
```ts
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
...
router.post('/doctors/:doctorId/docs', AuthMiddleware.checkAuth, upload.any(), DoctorController.uploadDoc);
```
**Why:** Bypasses the centralised MIME validation in `Middlewares/multer.middleware.ts:19-41`. Anyone authenticated can upload arbitrary file types (executables, HTML with embedded payloads served back via S3 proxy) of up to 100 MB into the `doctors/{id}/` S3 prefix. The same pattern is in `Routes/hospitalProfile.routes.ts:12`.
**Fix direction:** Use a single shared multer instance with the existing MIME allow-list and a tighter (≤ 25 MB) per-file limit. If memory storage truly is needed, gate it behind the same filter.

### C6. SQL injection-adjacent: untrusted query parameter inlined as INTERVAL literal
**Location:** `Backend/src/Services/doctorAttribute.service.ts:360`.
```ts
AND da.expires_at <= NOW() + INTERVAL '${daysThreshold} days'
```
And `Backend/src/Services/panelAttributeDocument.service.ts:275` does the same: `INTERVAL '${withinDays} days'`. `daysThreshold` originates from a `req.query.days` query string parsed with `parseInt`, so an `NaN` is possible but the more relevant issue is that **string interpolation into SQL is the pattern**, which means the next contributor will copy/paste this and inject something attacker-controlled.
**Fix direction:** Use parameterized `INTERVAL` (`NOW() + ($N || ' days')::interval` or just `NOW() + make_interval(days => $N)`). Adopt an ESLint rule banning template-literal SQL.

### C7. `addPanel` mutates `hospital_users.role` array based on URL body, allowing privilege escalation
**Location:** `Backend/src/Controllers/hospitalContoller.ts:206-213`.
```ts
await pool.query(
  `UPDATE hospital_users SET role = array_append(role, $1)
   WHERE user_id = $2 AND hospital_id = $3 AND NOT ($1 = ANY(role))`,
  [panelId, userId, resolvedHospitalId])
```
**Why:** A hospital user can call `POST /hospitals/addPanel` with an existing `panelId` and gain access to that panel by self-granting. `role` is the array used everywhere for panel access (`patient.controller.ts:200`: `p.panel_id = ANY(hu.role::uuid[])`). There is no superadmin/admin gate on hospital-user-initiated `addPanel` — it explicitly self-grants on the hospital-user code path.
**Fix direction:** Require superadmin/admin to add panels; hospital users should only be able to *request* access. Or at minimum, ensure the panel is already linked AND the hospital user already has any role in that panel.

### C8. `checkPatientEditAccess` / `checkHospitalUserPermission` query `hospital_users` once and then trusts `role[0]`
**Location:** `Backend/src/Middlewares/auth.middleware.ts:329-336`.
```ts
const result = await pool.query(
  'SELECT hu.role, hu.hospital_id, hu.user_id, p.panel_id FROM hospital_users hu INNER JOIN ipds p ON hu.hospital_id = p.hospital_id WHERE hu.user_id = $1 AND p.id = $2', ...)
if (result.rows[0].role?.includes(result.rows[0].panel_id)) { next(); return; }
throw new apiError(403, 'Forbidden');
```
**Why:** If `result.rowCount === 0` the next line throws `Cannot read properties of undefined`. The `JOIN` will return 0 rows if the hospital user is not in the same hospital as the patient and the route will 500, not 403. Same pattern at `patient.controller.ts:716-719` accessing `hospitalRes.rows[0].role.includes(...)` without a length check.
**Fix direction:** Guard `if (result.rowCount === 0) throw new apiError(403, 'Forbidden')` before dereferencing row[0].

### C9. JWT secret falsy-check is `!` instead of presence check at startup
**Location:** `Backend/src/Middlewares/auth.middleware.ts:31`, `93`, `123`, `159`, etc.
```ts
const decoded = jwt.verify(oldAccessToken, process.env.ACCESS_TOKEN_SECRET!) as DecodedToken
```
**Why:** `!` is a TypeScript "trust me" non-null assertion. If `ACCESS_TOKEN_SECRET` is empty, `jwt.verify` accepts unsigned tokens / throws cryptic errors. There is no fail-fast check on boot. Similarly `process.env.POSTGRES_PORT || " "` at `DB/db.ts:13` produces `NaN` when unset.
**Fix direction:** Require all critical env vars at boot (`zod` env schema, exit non-zero on missing). The team already uses zod for `hospitalDetailsSchema`.

### C10. CORS allowlist + `credentials: true` accepts any null `Origin`
**Location:** `Backend/src/app.ts:16-22`.
```ts
origin: function (origin, callback) {
  if (!origin || whitelist.indexOf(origin) !== -1) { callback(null, true); }
  else { callback(new Error('Not allowed by CORS')); }
}
```
**Why:** `!origin` is true for non-browser requests (Postman, server-to-server), but more importantly it's true for `null`-origin browsers (sandboxed iframes, file:// pages, certain redirected requests). Combined with `credentials: true`, this is a known CSRF vector if any authenticated state lives in cookies. Auth is bearer-token-only today, so risk is contained, but the misconfiguration will hurt the day someone moves auth to cookies.
**Fix direction:** Drop the `!origin` allow path or restrict it to a clearly intentional internal-tools origin.

### C11. Hard delete of patients via `DELETE /patient/:id`
**Location:** `Backend/src/Controllers/patient.controller.ts:1003-1027` and route `Backend/src/Routes/patient.routes.ts:22`.
```ts
await pool.query('DELETE FROM ipds WHERE id = $1', [id])
```
**Why:** CASCADE will hard-delete the patient, all `ipd_doc` rows, `claims` rows, and (depending on FKs) `hospital_assignments`. There is no soft-delete column on `ipds` (`is_active` is present but `DELETE` ignores it). The "hard delete - consider soft delete in production" comment is still there. This is a healthcare app — losing patient history is a regulatory risk.
**Fix direction:** Either remove the route or convert it to setting `is_active = false`. Add a `deleted_at` column for true soft-delete with audit trail.

### C12. Public doctor share endpoint mounted under `/api/v1/doctors/public/doctor/:token` but service queries `hospital.doctor_share_tokens` while the migration places the table without schema prefix
**Location:** `Backend/src/Services/doctor.service.ts:464` writes to `hospital.doctor_share_tokens`; migration `005_create_doctor_configuration_system.sql:302` creates the table in `hospital` schema only when the search_path is set, but the table is referenced both as `doctor_share_tokens` and `hospital.doctor_share_tokens` in different files.
**Why:** Inconsistent schema prefixing. The DB pool sets `search_path=hospital` (`DB/db.ts:13`), so unprefixed names work; but production migrations like `PRODUCTION_NEW_TABLES_SCRIPT.sql` may not. Any environment without that search_path setting (e.g. ad-hoc psql session) will silently use `public.doctor_share_tokens` or fail.
**Fix direction:** Standardize: either always prefix `hospital.` everywhere, or remove the prefix everywhere and rely on `search_path`. Mixed prefixing is the worst of both worlds.

### C13. Sheet webhook receives plaintext `SECRET_TOKEN` in JSON body to public-ish Google Apps Script endpoint
**Location:** `Backend/src/Controllers/patient.controller.ts:120`, `:737`, `:896`, `:969`; `Backend/src/Controllers/claims.controller.ts:81`.
```ts
secret: SECRET_TOKEN,
```
**Why:** The secret is sent in the body to `GOOGLE_SHEET_WEBHOOK_URL`; if that URL is logged, intercepted, or the Apps Script ever echoes request bodies in error pages, the secret leaks. There is also no signature/HMAC.
**Fix direction:** HMAC-sign the payload with the secret; or rotate to a server-to-server OAuth flow.

---

## High (bugs that affect users in production)

### H1. `setAttribute` polymorphic value coercion silently writes the wrong column
**Location:** `Backend/src/Services/attribute.service.ts:467-495`.
```ts
private extractValue(input: AttributeValue, dataType: string): AttributeValue {
  const value: AttributeValue = { valueBoolean: null, valueInteger: null, valueText: null, valueDate: null };
  switch (dataType) {
    case 'boolean': value.valueBoolean = input.valueBoolean ?? false; break;
    ...
  }
}
```
**Why:** If a client sends `{ valueText: "yes" }` for a boolean attribute, the function nulls out the text and writes `false` to `value_boolean` — silently losing the user's input. Worse, since `attribute.controller.ts:setAttribute` accepts a generic `value` and stuffs it into all three typed slots based on JS `typeof`, a `value: "true"` for a boolean ends up in `value_text` and gets discarded server-side.
**Fix direction:** Validate the input matches `data_type` at the controller boundary with zod, reject mismatches with 400.

### H2. `dischargePatient` SQL has a comma typo that returns the wrong column
**Location:** `Backend/src/Controllers/patient.controller.ts:941`.
```ts
'select p.panel_id,p.hospital_id,p.hospital_panel_id,hp.sheet_id,hp,sheet_name from ipds as p join hospital_panels as hp ...'
```
**Why:** `hp,sheet_name` — the comma after `hp` makes Postgres interpret `hp` as an alias for the row (returning whole `hp` row as a record) and `sheet_name` as a separate column. The result rows have unexpected shape; `patientRes.rows[0].sheet_name` will be undefined and the sheet sync is silently skipped.
**Fix direction:** Fix to `hp.sheet_name`. This is a one-character typo that's been live since April.

### H3. `updatePatientDetails` hospital-user branch returns early without checking middleware permission
**Location:** `Backend/src/Controllers/patient.controller.ts:709-761`.
```ts
if (userRole === 'hospital') {
  const hospitalRes = await pool.query('select hospital_id,role from hospital_users where user_id = $1', [userId])
  if (patientRes.rows[0].hospital_id == hospitalRes.rows[0].hospital_id &&
      hospitalRes.rows[0].role.includes(patientRes.rows[0].panel_id)) {
    const updatedPatient = await pool.query(`UPDATE ipds SET first_name = $1, last_name = $2, ...`, ...)
    ...
    return
  }
}
```
**Why:** This path only updates `first_name`, `last_name`, `admitted_at` — silently dropping `phone`, `admission_type`, `beneficiary_id`, and **all claims fields** the user sent. There's no error or warning. The full update path below this branch handles claims, but hospital users never reach it. The route also uses `checkPatientEditAccess` middleware which already verified access — this redoes the check inline.
**Fix direction:** Merge both branches. Have one update statement parameterized by role-permission rather than two divergent UPDATEs.

### H4. `addPatient` accepts no transaction, leaks Drive folders on DB failure
**Location:** `Backend/src/Controllers/patient.controller.ts:86-106`.
```ts
const folder = await DriveHandler.createFolder(...)
console.log('[ADD PATIENT] Drive folder created:', folder.fileId)
const patient = await pool.query('INSERT INTO IPDS ...', ...)
if (patient.rowCount == 0) throw new apiError(500, ...)
```
**Why:** If the INSERT fails (FK violation, duplicate), the Drive folder is already created and orphaned. No cleanup. Same anti-pattern in `hospitalContoller.ts:addHospital` (folder created before INSERT) and `addPanel`.
**Fix direction:** Wrap in `pool.connect()` + `BEGIN`/`COMMIT`. Roll back the Drive folder on failure (delete it). Or create the row first with `null` folder, then create folder + update.

### H5. `signUp` non-transactional rollback can fail mid-stream
**Location:** `Backend/src/Controllers/auth.controller.ts:132-144`.
```ts
const userRes = await pool.query('insert into users ... returning id', ...)
const id = userRes.rows[0].id;
const hospitalUserRes = await pool.query("insert into hospital_users ...", [hospitalId, id, userRole]);
if (hospitalUserRes.rowCount == 0) {
  await pool.query("delete from users where id = $1", [id]);
  throw new apiError(500, ...);
}
```
**Why:** `hospital_users` insert can throw (FK violation on hospitalId, NOT NULL on role) before reaching `rowCount`, in which case the catch in `asyncHandler` returns 500 and the orphaned user remains. The "rollback" is best-effort.
**Fix direction:** Real `BEGIN`/`COMMIT` transaction.

### H6. Pagination cap missing on `getAllPatients`, `getActivePatients`, `getAllAdmins`, `getAllHospitals`, `getHospitalUsers`
**Location:** `Backend/src/Controllers/patient.controller.ts:148-215`, `:593-667`; `Backend/src/Controllers/admin.controller.ts:9-23`; `Backend/src/Controllers/hospitalContoller.ts:89-124`.
**Why:** No `LIMIT` or page parameter. As the database grows, these queries will return all rows in a single response. The superadmin dashboard already calls `getAllPatients` which can return tens of thousands of rows with `LEFT JOIN claims`, blowing up memory and the response payload.
**Fix direction:** Add a hard server-side cap (e.g. `LIMIT 500`) plus optional pagination. Prefer the paginated endpoints already in the same file.

### H7. Hospital-user upload route uses `checkHospitalUserPermission` which assumes `patientId` is in params but route reads it from body
**Location:** `Backend/src/Routes/uploads.routes.ts:20`.
```ts
router.route("/admin/upload").post(AuthMiddleware.checkHospital, upload.array("files", 50), UploadsController.uploadForAdmin);
```
**Why:** `checkHospital` only verifies the role — it does not check tenant access. The controller (`uploads.controller.ts:530-546`) does an explicit tenant check, so this works, but the inconsistency means future routes will copy the wrong pattern. Several routes (`/admin/photos/:patientId`, `/admin/file/:fileId`) use `checkPatientViewAccess`/`checkSuperAdminOrAdmin` with no patient-level check on the file ID.
**Fix direction:** Standardize: every patient-scoped route either receives `:patientId` in params and goes through `checkHospitalUserPermission`, or receives it in body and the controller is required to do the check. Document the rule.

### H8. `deletePhoto` and `deletePhotoForAdmin` in v1 uploads silently no-op
**Location:** `Backend/src/Controllers/uploads.controller.ts:419-461`.
```ts
console.log(`[DELETE PHOTO] Deleting file: ${fileId}`)
// --- Drive delete disabled — 
// await DriveHandler.deleteFile(fileId)
console.log(`[DELETE PHOTO] File deleted successfully (Drive skip)`)
res.status(200).json(new apiResponse(200, null, 'Photo deleted successfully'))
```
**Why:** Returns 200 success but does nothing. Frontend will think the photo was deleted; DB row and S3 file remain. Real delete logic is in v2 (`v2/uploads.controller.ts:323-379`). The v1 endpoint should be removed or fixed.
**Fix direction:** Either redirect to v2, or have the v1 controller delete from `ipd_doc` and S3 explicitly.

### H9. `uploadDoc` (hospital doctor docs v2) reads `req.body.customNames` which is JSON-stringified by some clients and not others
**Location:** `Backend/src/Controllers/doctors.controller.ts:233-246`.
**Why:** Inconsistent handling — `Array.isArray(customNamesRaw) || typeof === 'string'` plus a try/catch around `JSON.parse`. Frontend currently uses two different forms (multipart appended individually vs JSON-stringified), so name-to-file mapping is fragile. Mismatched lengths silently use `originalname`.
**Fix direction:** Document the wire format and validate it with zod. Reject misshapen requests with 400.

### H10. `setAttribute` in doctor flow writes to `hospital.doctor_attribute_documents` but `addDocumentToAttribute` does a non-junction query first
**Location:** `Backend/src/Services/doctorAttribute.service.ts:129-181`.
```ts
const attrRes = await pool.query(
  `SELECT id FROM doctor_attributes WHERE id = $1 AND doctor_id = $2`, [doctorAttributeId, doctorId]);
const docRes = await pool.query(
  `SELECT id FROM doctor_doc WHERE id = $1 AND doctor_id = $2`, [documentId, doctorId]);
```
**Why:** Mixes `doctor_attributes` (unprefixed = `hospital.doctor_attributes` via search_path) and `doctor_doc` (no schema), then inserts to `hospital.doctor_attribute_documents` (prefixed). If `search_path` is ever wrong or the table doesn't exist in `public`, the upsert succeeds but the join in `getAttribute` fails. The earlier C4 finding compounds.
**Fix direction:** Single source of truth on schema prefixing.

### H11. `setAttributeValue` on panels updates `value_boolean` to `null` instead of `false` when input is the literal `false`
**Location:** `Backend/src/Services/panelAttribute.service.ts:486-488`.
```ts
if (attributeInput.value_boolean !== undefined) {
  updates.push(`value_boolean = $${paramIndex++}`);
  values.push(attributeInput.value_boolean || null);
}
```
**Why:** `false || null` → `null`. Setting a boolean attribute to `false` is impossible; it round-trips as `null`. The non-atomic version at `:299-302` does `values.push(input.value_boolean)` correctly, so the two paths diverge.
**Fix direction:** Use explicit `=== undefined ? null : value`. Add a unit test for "set to false".

### H12. `setMultipleAttributes` opens a transaction but invokes `setAttributeValue` which uses the pool directly
**Location:** `Backend/src/Services/panelAttribute.service.ts:387-413`.
```ts
const client = await pool.connect();
await client.query('BEGIN');
for (const attr of attributes) {
  const result = await this.setAttributeValue(hospitalPanelId, hospitalId, panelId, attr, userId);
  // setAttributeValue uses pool.query, not client.query!
}
await client.query('COMMIT');
```
**Why:** The "transaction" is fake — the inner writes go through the pool and are independent of the `BEGIN`/`COMMIT`. A `ROLLBACK` rolls back nothing. Same bug in the docs-link section if it ever lands.
**Fix direction:** Pass `client` (or `Queryable` interface) into helpers, or refactor setAttributeValue to accept a client.

### H13. `verifyAttribute` mutates `value_*` columns to "null the others" without rejecting mismatched types
**Location:** `Backend/src/Services/documentExtraction.service.ts:233-266`.
```ts
INSERT INTO hospital.hospital_attributes (..., value_boolean, value_integer, value_text, value_date, ...) VALUES (...,
  CASE WHEN $3::text = 'boolean' THEN $4::boolean ELSE NULL END,
  CASE WHEN $3::text = 'integer' THEN $4::integer ELSE NULL END,
  ...
```
**Why:** Casting `$4` to `boolean` when `value` was extracted from arbitrary AI output may throw — and the controlled boundary upstream (`parseBoolean`, `parseDate`) doesn't actually run for `text` types. If Claude returns `null` it casts to `null`, but if it returns `"yes"` for an integer field the cast throws, transaction-free.
**Fix direction:** Validate before INSERT; reject malformed extractions with a "needs review" status.

### H14. `rejectAttribute` overwrites `verification_notes` with the rejection reason, losing any prior note
**Location:** `Backend/src/Services/attribute.service.ts:325-344`.
```ts
SET verification_status = 'rejected', verification_notes = $3, ...
```
**Why:** No append, no history. The verification dashboard's "verification_notes" column is single-valued and gets clobbered. If admin had previously left guidance ("upload clearer photo"), rejecting wipes it.
**Fix direction:** Append/timestamp notes, or maintain a separate `attribute_verification_history` table (which the schema actually has via `attribute_verifications` from migration 004, but it's unused).

### H15. `proxyPhoto` in v2 uploads silently leaks file content with no auth check on the photo's tenant
**Location:** `Backend/src/Controllers/v2/uploads.controller.ts:481-529`.
```ts
proxyPhoto = asyncHandler(async (req, res) => {
  const { fileId } = req.params;
  const result = await pool.query(`SELECT s3_key, ... FROM ipd_doc WHERE id = $1`, [fileId]);
  ...
  res.send(buffer);
});
```
**Why:** Route `/api/v2/uploads/proxy/:fileId` uses only `checkAuth`. Any authenticated user can fetch any patient's documents by guessing or harvesting `ipd_doc.id` UUIDs. The hospital-doctor proxy at `doctors.controller.ts:456` has the same shape.
**Fix direction:** Join to `ipds` and verify the caller has access to the patient's hospital_id/panel_id.

### H16. Public share `getShareLinks` returns tokens for any hospital to any authenticated user
**Location:** `Backend/src/Controllers/publicShare.controller.ts:150-178`.
```ts
const result = await pool.query(`SELECT id, token, ... FROM hospital.public_share_tokens
   WHERE resource_type = 'hospital_profile' AND resource_id = $1 ...`, [hospitalId]);
```
**Why:** Route uses `checkAuth` only. A hospital user from Hospital A calls `GET /hospitals/{HospitalB}/shares` and gets all of Hospital B's active share tokens (including the secret token strings), then can access B's documents without auth.
**Fix direction:** Add tenant gate. Tokens are bearer credentials and listing them must be scoped.

### H17. `getPublicProfile` returns documents even when `is_public_profile_enabled = false` (404 race)
**Location:** `Backend/src/Services/hospitalProfile.service.ts:272-367`.
**Why:** Query filters `WHERE is_public_profile_enabled = true`, but `accessPublicProfile` in `publicShare.controller.ts:90-144` independently calls `getPublicProfile(share.resource_id)`. If the hospital toggles "unpublish" between token creation and access, the read still passes (the share token is the gate). But the share token endpoint doesn't double-check the public flag; if the design intent was "share survives unpublishing", then `getPublicProfile`'s 404 in this case will surface as a confusing user-facing error.
**Fix direction:** Decide the policy. Either token always overrides public flag (and the WHERE clause should be dropped on the token-access path), or unpublishing revokes tokens automatically.

### H18. `uploadDoctorDocuments` in `doctor.controller.ts` is a stub that returns mock IDs
**Location:** `Backend/src/Controllers/doctor.controller.ts:332-358`.
```ts
const documents = files.map((file, index) => ({
  id: `doc_${Date.now()}_${index}`,
  fileName: customNames[index] || file.originalname,
  ...
}));
res.status(201).json(new apiResponse(201, { documents }, 'Documents uploaded successfully'));
```
**Why:** Returns success with fake IDs. Files are never saved. If the frontend ever calls this endpoint (it's not mounted, but the function exists), it will appear to succeed and the IDs will be unusable downstream. Also: `getDoctorDocuments` (at line 364) returns `{ documents: [] }` constant — same pattern.
**Fix direction:** Delete the dead stubs, or finish them. Make absolutely sure no frontend path reaches them.

### H19. `uploadDoc` (the real one, `doctor.controller.ts:381-495`) violates the route prefix expected by the controller
**Location:** Route declared at `Backend/src/Routes/doctor.routes.ts:271`:
```ts
router.post('/doctors/:doctorId/docs', AuthMiddleware.checkAuth, upload.any(), DoctorController.uploadDoc);
```
But the original-routing `doctors.routes.ts:58` declares:
```ts
router.post('/:id/docs', authMiddleware.checkAuth, upload.array('files', 20), controller.uploadDoc);
```
**Why:** Two routers register `POST :id/docs` and `POST /doctors/:doctorId/docs`. Both are mounted under `/api/v1`. Depending on the order in `index.ts`, one shadows the other. `index.ts:188` mounts `doctorRouter` BEFORE `hospitalRouter` so `/api/v1/doctors/:doctorId/docs` resolves first — meaning the `doctors.routes.ts` legacy router (mounted nowhere now? confirm) silently never receives traffic. This is fragile and undocumented.
**Fix direction:** Pick one. Delete the other. Document the public surface.

### H20. `generatePDFs` blocks the HTTP request until a worker thread completes
**Location:** `Backend/src/Controllers/uploads.controller.ts:463-508`.
**Why:** Spins up a worker thread per request and awaits via a Promise — the HTTP request is open for the entire PDF generation (potentially minutes for a large patient). No client-side timeout will save you here. Also, the worker uses `ts-node/esm` at runtime (`execArgv: ['--loader', 'ts-node/esm']`), which is heavy and fails when the build is `dist/`.
**Fix direction:** Enqueue to Bull (Redis queue exists), return 202 with a job ID, expose a polling endpoint.

---

## Medium (correctness, consistency, design smell)

### M1. Response shape inconsistency: success/data/message vs apiResponse wrapper
**Location:** `Backend/src/Controllers/panelAttribute.controller.ts:8-24` (uses ad-hoc `{success, data, message}`); `Backend/src/Controllers/masterOptions.controller.ts:21-30` (`{message, data, pagination}`); vs everywhere else using `apiResponse` class. Also `apiResponse.data` is typed `null` even though objects are stored there.
**Why:** Frontend has to handle two shapes. `apiResponse.data: null` is a type bug (it's any in practice but TS lies about it).
**Fix direction:** Standardize on one envelope. Fix the type.

### M2. Logging is `console.log` only, with PII in messages
**Location:** `Backend/src/Controllers/patient.controller.ts:59-66` logs `firstName, lastName, phone`. `Backend/src/Controllers/auth.controller.ts:137` logs `userRes.rows` (includes hashed password). `Backend/src/Middlewares/auth.middleware.ts` is silent which is good, but the routes logging at `index.ts:166-167` adds `[DEBUG] Route ... checking request path` for every request.
**Why:** PII in logs, no log level control, no rotation. Healthcare data is being printed to stdout indiscriminately.
**Fix direction:** Use a real logger (pino/winston), redact PII, set log levels per environment.

### M3. Auth middleware methods are duplicated 5 times — token verification is repeated in 6 handlers
**Location:** `Backend/src/Middlewares/auth.middleware.ts:23-184`. Each of `checkAuth`, `checkHospital`, `checkSuperAdmin`, `checkAdmin`, `checkSuperAdminOrAdmin`, `checkPatientViewAccess` re-implements the token-extraction-and-decode dance.
**Why:** Hard to maintain. A change to JWT verification (rotation, kid headers, audience claim) requires 6 edits.
**Fix direction:** Extract a single `authenticate()` that runs first and sets `req.user`, then `requireRole(['hospital','admin'])` after it.

### M4. `tsconfig.json` has `strict: false`, `strictNullChecks: false`, `noImplicitAny: false`
**Location:** `Backend/tsconfig.json:28-29, 40`.
**Why:** TypeScript is providing almost no safety. Many bugs in this report (null deref, wrong typing of `req.user`, `apiResponse.data: null`) would be caught by `strict: true`.
**Fix direction:** Turn on `strict` and fix the fallout incrementally (use `// @ts-expect-error` for known-bad spots so they're tracked).

### M5. Sheet webhook calls are awaited in request path, blocking response on 3rd-party latency
**Location:** `Backend/src/Controllers/patient.controller.ts:125-132`, `:742-749`, `:903-910`, `:975-982`; `Backend/src/Controllers/claims.controller.ts:86-93`.
**Why:** `await fetch(sheetURL)` on Google Apps Script — that endpoint can take 5+ seconds. Every patient create/update/discharge waits for Google. No timeout, no retry, no queue.
**Fix direction:** Fire-and-forget pattern through a Bull queue. Patient update doesn't need to wait on a Sheets sync to succeed.

### M6. `notification.queue.ts` registers `process.on('unhandledRejection')` globally to swallow Redis errors
**Location:** `Backend/src/Workers/notification.queue.ts:67-71`.
```ts
process.on('unhandledRejection', (reason: any) => {
  if (reason?.code === 'ECONNREFUSED' || reason?.message?.includes('ECONNREFUSED')) return;
  console.error('[UnhandledRejection]', reason);
});
```
**Why:** This is a module-side-effect that swallows ALL Redis-related unhandled rejections from the entire process, not just from this queue. Suppresses legitimate errors. Also: each module that imports this gets the side effect on first import.
**Fix direction:** Catch rejections at the queue creation site, not via global hook. If Redis is optional, no-op the queue when unavailable instead of using process-wide handlers.

### M7. Bull queue uses `enableOfflineQueue: false` + custom retry strategy that gives up after 1 attempt
**Location:** `Backend/src/Workers/notification.queue.ts:30-34`, `Backend/src/Workers/driveBackup.queue.ts:28-31`.
**Why:** Redis flap = jobs dropped forever. The buffer service then queues to a queue that won't accept the job, eats the error in the catch, and returns success.
**Fix direction:** Allow some retry. Persist enqueue failures.

### M8. `uploadQueue.service.ts` is a single-process in-memory queue persisted via `queue_state.json` on disk
**Location:** `Backend/src/Services/uploadQueue.service.ts:1-233`. Module-singleton `UploadQueue`.
**Why:** Will not survive a container restart cleanly (file may exist; jobs may have already been processed). Multiple instances of the backend will each process the same on-disk file. Not horizontally scalable; not transactional; race condition on `saveState` (sync write while another tick is pushing).
**Fix direction:** Move to Bull. The Bull queue infra is already wired in for notifications and Drive backup.

### M9. Multer disk storage + reading from disk again + uploading + unlink
**Location:** `Backend/src/Controllers/v2/uploads.controller.ts:89-100`; `Backend/src/Services/uploadQueue.service.ts:124-129`; `Backend/src/Controllers/doctors.controller.ts:293`.
**Why:** Multer writes to disk, the controller reads the file back into memory with `fs.readFileSync`, uploads to S3, then `fs.unlink`. Triple I/O for what could be a memory-stored upload (or, better, a direct stream from multer's stream to S3 `Upload`). For large PDFs this is wasted IO and disk pressure.
**Fix direction:** Use multer.memoryStorage() everywhere and stream directly to S3, or use `S3 multipart upload` for true streaming.

### M10. `S3Service` reuses one `S3Client` per process and stores credentials in instance vars from env at construction
**Location:** `Backend/src/Services/s3.service.ts:23-36`.
**Why:** Mostly fine, but: credentials are fixed at constructor time. AWS IAM rotation requires a process restart. `process.env.AWS_REGION` is read three times (in constructor and in `s3Url` construction) with no fallback consistency (one place uses 'ap-south-1', another reads `AWS_REGION` direct).
**Fix direction:** Use AWS SDK credential provider chain (let it handle rotation). Single source of truth for region/bucket.

### M11. `S3Service.getPresignedUrl` is **synchronous CloudFront signer** but the method has been called inline in N+1 patterns
**Location:** `Backend/src/Controllers/uploads.controller.ts:643-672` (`getThumbnail`), `Backend/src/Controllers/v2/uploads.controller.ts:247-272` (`getPhotos`), `Backend/src/Controllers/hospitalDocs.controller.ts:168-178`.
**Why:** Each photo gets its presigned URL signed during the response — that's RSA signing per photo per request. For a patient with 200 photos, this is 200 RSA signings on the request thread. Each sign is ~5-10ms. Adds up to seconds. The `getPhotosMeta` endpoint exists specifically to skip this — but it's not used everywhere.
**Fix direction:** Either cache signed URLs (CloudFront cookies for signed cookies on a path prefix), or paginate, or generate URLs in parallel with a worker.

### M12. Hospital docs `getDocs` query has condition order bug for `panelId = ''` vs unspecified
**Location:** `Backend/src/Controllers/hospitalDocs.controller.ts:156-163`.
```ts
if (panelId) { params.push(panelId); query += ` AND panel_id = $${...}`; }
else if (req.query.panelId !== undefined) { query += ` AND panel_id IS NULL`; }
```
**Why:** If caller passes `panelId=` (empty string), `panelId` is falsy AND `req.query.panelId !== undefined` is true → IS NULL filter. Intent might be "general docs only", but the API contract is undocumented and brittle.
**Fix direction:** Explicit `general=true` query param or split routes.

### M13. `formatAttributeOutput.getFormattedValue` returns the first non-null typed value, which silently truncates multi-typed rows
**Location:** `Backend/src/Services/attribute.service.ts:533-539`.
```ts
private getFormattedValue(row: any) {
  if (row.value_boolean !== null) return row.value_boolean;
  if (row.value_integer !== null) return row.value_integer;
  ...
}
```
**Why:** If a misbehaving write sets both `value_boolean` and `value_text`, the consumer sees only the boolean. There's no integrity check that exactly one is set, and no audit logging when both are.
**Fix direction:** Make the schema enforce "exactly one of the typed columns is non-null" with a CHECK constraint, or pivot to a single `value JSONB` column with type tagged.

### M14. `formatAttributeOutput` is referenced before declaration (private method TypeScript hoisting issue)
**Location:** `Backend/src/Services/attribute.service.ts:206-218`.
**Why:** TS handles this, but the result is a service file where the request `getHospitalAttributes` has `await Promise.all(rows.map(async row => formatAttributeOutput(...)))` and each map awaits a sub-query. Classic N+1: one query per attribute to fetch documents.
**Fix direction:** Single query with `json_agg` aggregation, similar to `panelAttribute.service.ts:21-67` `getFleetForHospital` — already a good template.

### M15. `getDoctorAttributes` fires one query per attribute (N+1)
**Location:** `Backend/src/Services/doctorAttribute.service.ts:254-263`.
```ts
const attributesWithDocs = await Promise.all(
  result.rows.map(async (attr) => {
    const docsRes = await pool.query(`SELECT ... FROM doctor_attribute_documents dad ... WHERE dad.doctor_attribute_id = $1`, [attr.id]);
    ...
  })
);
```
**Why:** For a doctor with 30 attributes, that's 31 queries. The fleet view (panels) does this with one query.
**Fix direction:** Use `json_agg(documents)` like the panel-fleet query.

### M16. `getAllDefinitions` lacks caching for what is an admin-managed, read-mostly catalog
**Location:** `Backend/src/Services/attribute.service.ts:52-65`; same for `doctorAttributeDefinition.service.ts`, `panelAttributeDefinition.service.ts`.
**Why:** Definitions change rarely (admin-only) but are queried on every attribute load page. Easy to cache in-process for a few minutes.
**Fix direction:** In-process cache with TTL of 5 minutes plus an admin "bust cache" endpoint.

### M17. `getAllPatients` includes claims fields in every row even when the caller wanted just admission info
**Location:** `Backend/src/Controllers/patient.controller.ts:158-203`. Always `LEFT JOIN claims c ON p.id = c.ipd_id`.
**Why:** Wide rows for every list view. Some pages need only the admission summary; others need full claims. Currently every list returns everything.
**Fix direction:** Split or add a `fields=...` query param.

### M18. `dischargePatient` and `addPatient` don't increment any audit log
**Location:** `Backend/src/Controllers/patient.controller.ts`. Audit is `// TODO: Re-enable when audit_logs table is created` in auth.controller.ts but the migration `004_create_validator_verification_system.sql:187` creates `verification_audit_log`. `audit.controller.ts` queries `hospital.audit_logs` which doesn't appear in any visible migration.
**Why:** Auditing exists in the routing and service files, but the supporting table is missing/never created. Calls to `/api/v1/audit-logs` will throw "relation does not exist".
**Fix direction:** Either create the table and turn auditing on, or remove the dead controller/route/service.

### M19. Refresh token storage hashes the raw token then keeps both client and DB copies — but rotation is missing
**Location:** `Backend/src/Controllers/auth.controller.ts:50-67`.
**Why:** On refresh (`:164-215`), the same refresh token is returned to the client. No rotation. If a refresh token leaks, attacker keeps refreshing forever until expiry. Also: only one refresh-token row per user (`update set token_hash` on conflict), so logging in from a second device invalidates the first device silently. That's surprising UX.
**Fix direction:** Per-device refresh tokens with rotation on use; mark old tokens revoked.

### M20. `dischargePatient` accepts `dischargedAt` from request body without validation
**Location:** `Backend/src/Controllers/patient.controller.ts:925-960`.
**Why:** Client can pass any date string. No bounds check (e.g. "before admitted_at" or "in the future").
**Fix direction:** zod schema with `min(admittedAt)`.

### M21. Migration files include `PRODUCTION_*.sql` exports that aren't part of the schema lifecycle
**Location:** `Backend/src/schema/migrations/PRODUCTION_CREATE_PRAGATI_HOSPITAL.sql`, etc.
**Why:** Hospital-data exports are checked into the migration folder. Hospital names and migration status reports are version-controlled. PII risk if the repo is ever shared externally.
**Fix direction:** Move to a separate `data-migrations/` folder, gitignore if it contains real data, or strip PII.

### M22. `attribute_definitions.key` PRIMARY KEY is `TEXT` — long arbitrary keys flow through every reference
**Location:** `Backend/src/schema/migrations/002_core_new_tables_v2.sql:21`.
**Why:** Using a human-readable key as PK means `attribute_key` (TEXT) propagates into every `hospital_attributes` row. Renaming a definition key forces a cascade migration. UUIDs would decouple.
**Fix direction:** Use UUID PK plus a UNIQUE `key` column. Existing usage can stay mostly unchanged.

### M23. `hospital_panels.contact CHAR(10)` is left-padded — INDIA phone numbers vary in form (e.g. with country code)
**Location:** `Backend/src/schema/schema.sql:70`. `ipds.phone CHAR(10)`.
**Why:** `CHAR(10)` left-pads with spaces. Anything other than exactly 10 chars breaks. International numbers are silently rejected.
**Fix direction:** Use `VARCHAR(20)` or `TEXT`.

### M24. No UNIQUE constraint on `hospital_panels(hospital_id, panel_id)` despite the controller relying on uniqueness
**Location:** `Backend/src/schema/schema.sql:62-71`. The controller `addPanel` (`hospitalContoller.ts:200-204`) checks for duplicates with a SELECT — race window with concurrent calls.
**Fix direction:** `UNIQUE (hospital_id, panel_id)` constraint.

### M25. `hospital_assignments` PRIMARY KEY is `(hospital_id, admin_id)` — fine, but `is_active` is referenced and never created
**Location:** `Backend/src/Controllers/admin.controller.ts:130`: `WHERE ha.hospital_id = $1 AND ha.is_active = true` — but the table in `schema.sql:75-85` has no `is_active` column. Migration 002 doesn't add it. The query will fail on a fresh install.
**Fix direction:** Add the column or drop the predicate.

### M26. The `doctors` table appears twice with different shapes
**Location:** `Backend/src/schema/schema.sql:196-207` defines `doctors(id, hospital_id, first_name, ..., age, speciality, phone, years_of_exp)`. Migration `005_create_doctor_configuration_system.sql:9-42` defines `hospital.doctors(id, first_name, last_name, email NOT NULL UNIQUE, nmc_registration_number, primary_specialization, registration_status, ...)`.
**Why:** Two competing schemas for the same domain. Code uses the migration-005 version. The schema.sql one is dead but still ships in fresh DB initializations.
**Fix direction:** Remove the dead table definition; consolidate to migration-005 schema.

### M27. `doctor_doc` foreign key is `doctor_id UUID REFERENCES doctors(id)` (no schema prefix)
**Location:** `Backend/src/schema/schema.sql:211`.
**Why:** When `search_path=hospital` is set the FK works; without it, the FK references `public.doctors` which doesn't exist. Migration ordering surprises will haunt deployments.
**Fix direction:** Always-prefix or always-not.

### M28. `validator_*` tables created but no controllers/services reference them
**Location:** Migration `004_create_validator_verification_system.sql`. Search results: zero hits for `validator_profiles` in `src/Services/`. Dead schema.
**Fix direction:** Remove or implement; don't leave half-baked tables in prod.

### M29. `audit_logs` table absent from migrations; service writes to it on login
**Location:** `Backend/src/Controllers/auth.controller.ts:79-86` (commented out due to missing table), `Backend/src/Services/audit.service.ts:24-29` (writes will fail), `Backend/src/Controllers/audit.controller.ts:13-17` (reads will fail).
**Fix direction:** Decide: add `audit_logs` table or remove the audit feature.

### M30. `ipds.beneficiary_id` is `VARCHAR(255)` but `getAllPatients` returns it as `beneficiary_id` (snake_case) while the request body uses `beneficiaryId` (camelCase). The same patient sees their PMJAY ID appear/disappear depending on which endpoint they call.
**Fix direction:** Standardize response casing (camelCase preferred for REST + JS clients).

### M31. `verifyAttribute` allows arbitrary `method` values from request body without role check
**Location:** `Backend/src/Controllers/doctorAttribute.controller.ts:139-163`.
```ts
verifyAttribute = asyncHandler(async (req, res) => {
  const { method, notes } = req.body;
  const verifiedBy = req.user?.id;
  if (!['document', 'image', 'online_lookup', 'manual', 'automated'].includes(method))
    throw new apiError(400, 'Invalid verification method');
  ...
});
```
**Why:** Only `checkAuth` on the route, so any authenticated user can mark any doctor's attribute as `verified_by_doc`. The next attribute reader has no way to tell that wasn't a real admin verification.
**Fix direction:** `checkSuperAdminOrAdmin` middleware here; tenant gate too.

### M32. `getPanelPatientsPaginated` has duplicated query bodies for superadmin/admin/hospital — easy to introduce divergent bugs
**Location:** `Backend/src/Controllers/patient.controller.ts:321-527`. Three near-identical branches.
**Why:** The pattern is bound to drift. Already, the hospital branch hard-codes "active patients only" while admin/superadmin allow all.
**Fix direction:** Build the WHERE clause once with role-driven conditions, run one query.

### M33. `panelAttribute.service.ts:setMultipleAttributes` calls `setAttributeValue` which itself calls `updateAttributeValue` and never short-circuits on a definition that doesn't exist
**Location:** `Backend/src/Services/panelAttribute.service.ts:217-283`.
**Why:** When `panel_attribute_definition_id` is invalid, the function builds an empty `updates` set and silently succeeds with no actual change. The controller returns 201.
**Fix direction:** Throw on invalid attribute key/def. Validate inputs at the boundary.

### M34. File rename uses string-split heuristics
**Location:** `Backend/src/Controllers/uploads.controller.ts:707-715`.
```ts
const parts = file.fileName?.split("_") as Array<string>;
const last = parts.pop() as string;
const Slast = parts.pop() as string;
parts.push(customName, Slast, last);
const newName = parts.join("_").replaceAll(" ", "_");
```
**Why:** If the file name doesn't conform to the expected `<...>_<timestamp>_<ext>` pattern, this corrupts the name. There's no validation. Also, this only updates the DB `file_name`; the actual S3 key is unchanged so the user-visible name no longer matches the S3 path. Future migrations and tooling will be confused.
**Fix direction:** Rename should mean either DB-only "display name" or S3 copy+delete to preserve the underlying object name. Pick one.

### M35. `getCounts`, `getImageCounts` call Google Drive even though Drive is "disabled" everywhere else
**Location:** `Backend/src/Controllers/uploads.controller.ts:22-49`, `Backend/src/Services/driveUploader.service.ts:20-62`.
**Why:** Comments throughout claim "Drive disabled — S3 only mode" but `getImageCounts` still calls `drive.files.list` and requires `drive.json` credentials at runtime. Hospital users routinely hit this and get errors if Drive is unavailable.
**Fix direction:** Decide. Either fully retire Drive (remove all calls) or properly support both. The half-state is the worst.

### M36. `index.ts` route mounting order has implicit precedence dependencies with comments warning about it
**Location:** `Backend/src/index.ts:163-195`.
```ts
// Hospital Profile API Routes ... MUST come before hospitalRouter
// because hospitalRouter has catch-all /:hospitalId route
app.use("/api/v1", (req, res, next) => { console.log('[DEBUG] ...'); next(); });
app.use("/api/v1", hospitalProfileRouter);
...
app.use("/api/v1/hospitals", hospitalRouter);
```
**Why:** Mounting `hospitalProfileRouter` at `/api/v1` plus a catch-all `/api/v1/hospitals/:hospitalId` from `hospitalRouter` is a maintenance trap. The debug middleware is doubled and noisy.
**Fix direction:** Move all hospital-profile routes under `/api/v1/hospitals/:hospitalId/profile` consistently; remove the catch-all conflict and the debug middleware.

### M37. `verifyAttribute` in v1 hospital attribute service hardcodes case mapping in SQL
**Location:** `Backend/src/Services/attribute.service.ts:294-300`.
```ts
verification_status = CASE
  WHEN $3 = 'document' THEN 'verified_by_doc'
  WHEN $3 = 'image' THEN 'verified_by_image'
  WHEN $3 = 'manual' THEN 'verified_manual'
  WHEN $3 = 'automated' THEN 'automated_verified'
END
```
**Why:** No ELSE → if `method` is anything unexpected, `verification_status` becomes NULL and the CHECK constraint on the column rejects it; the whole UPDATE throws. The controller validates the enum, but defense in depth would help.
**Fix direction:** `ELSE verification_status` to preserve existing.

### M38. `extractValue` for `data_type = 'boolean'` defaults to `false` instead of null
**Location:** `Backend/src/Services/attribute.service.ts:477`.
```ts
case 'boolean': value.valueBoolean = input.valueBoolean ?? false; break;
```
**Why:** "I forgot to set it" should not become `false` automatically. Semantically distinguishes "missing" from "no".
**Fix direction:** `?? null`.

### M39. `searchHospitals` ILIKE with no rank/score returns LIMIT 20 by `verification_level DESC, name`
**Location:** `Backend/src/Services/hospitalProfile.service.ts:372-390`.
**Why:** No relevance scoring; query "Tata" returns 20 results sorted alphabetically. For a directory feature this will be poor UX as the dataset grows. Also `ILIKE '%query%'` cannot use indexes.
**Fix direction:** GIN trigram index (`pg_trgm`) or full-text search.

### M40. Backend ships built artifacts (`dist/`, `node_modules/`, `backend.log`, `server.log`, `queue_state.json`) in the working tree
**Location:** `Backend/` root.
**Why:** Polluted working tree; `queue_state.json` and logs are runtime artifacts being version-controlled. `backend.log` is 272KB. `dist/` is 17 files of compiled output.
**Fix direction:** Robust `.gitignore`, prune from history if leaks are present.

---

## Low (cleanup, conventions, hygiene)

### L1. Typo in filename `hospitalContoller.ts`
**Location:** `Backend/src/Controllers/hospitalContoller.ts`. Missing 'r' in Controller.
**Fix:** Rename and update imports.

### L2. Class names are inconsistently capitalized
- `class authController` (lowercase) vs `class AttributeController` (uppercase).
- Some files export `new ClassName()`, others export the class itself.
- `Backend/src/Controllers/doctor.controller.ts:632` `export default new DoctorController()` vs `Backend/src/Controllers/doctors.controller.ts:491` `export default DoctorsController` (class). Consumers `new DoctorController()` in some places, treat as singleton in others.
**Fix:** Pick a convention (instance vs class) and apply.

### L3. Two controllers with near-identical names: `doctor.controller.ts` and `doctors.controller.ts`
**Location:** `Backend/src/Controllers/`. They serve different routers (`doctor.routes.ts` and `doctors.routes.ts`), but the dual-existence guarantees confusion.
**Fix:** Merge into one.

### L4. Console output uses emoji prefixes for log levels (`✓`, `✗`, `🔄`, `🔓`, `📦`)
**Location:** Throughout services (e.g. `Backend/src/Services/s3.service.ts:77`, `panelAttribute.service.ts:519`).
**Fix:** Use a logger with structured levels; emojis don't grep.

### L5. `[DEBUG]` request-path logging on the route handler
**Location:** `Backend/src/index.ts:165-168`, `:191-194`.
**Fix:** Remove debug middleware; use a real morgan/pino-http combo.

### L6. `compressWithGS` is invoked synchronously in the request path
**Location:** `Backend/src/Controllers/v2/uploads.controller.ts:80-87`, `Backend/src/Services/uploadQueue.service.ts:93-100`.
**Why:** Ghostscript is slow. The upload endpoint already does concurrent S3 uploads in chunks of 5, but each PDF spawns ghostscript synchronously, adding seconds.
**Fix:** Async compress in a worker, or post-upload compress.

### L7. `fileName.util.ts.imageName` builds a name with `Math.floor(Math.random() * 1000)` suffix — collision-prone
**Location:** `Backend/src/Utils/fileName.util.ts:28-29`, used at `uploads.controller.ts:91`.
**Fix:** Use a UUID slice or the counter alone.

### L8. `Backend/src/Public/` (`src/Public/` mixed case) used as a working temp dir
**Location:** `Backend/src/Workers/downloadImages.worker.ts:62-63`.
**Why:** Express serves `public` as static. Anything written here is accessible at `/raw_<uuid>_<timestamp>.pdf` until cleanup. Race window.
**Fix:** Use `/tmp` or a non-served directory.

### L9. `apiError` doesn't extend a stable shape for the `error` array — typed as `[]`
**Location:** `Backend/src/Utils/errorHandler.util.ts:5`. `error: []|undefined`.
**Fix:** Type properly.

### L10. `Bull` is imported in workers but not used as a default export everywhere
**Location:** `Backend/src/Workers/notification.queue.ts:1`, `Backend/src/Workers/driveBackup.queue.ts:1`.
**Fix:** Standardize import.

### L11. `uploadDischargePhotos` early-returns on first empty folder
**Location:** `Backend/src/Controllers/uploads.controller.ts:154-156`.
```ts
for (let folder in files) {
  if (!files[folder] || files[folder].length == 0) return
  ...
}
```
**Why:** The `return` skips the entire upload loop on the first empty folder — meant to be `continue`.
**Fix:** `continue;`.

### L12. `getThumbnail` route in v1 uploads has no auth
**Location:** `Backend/src/Routes/uploads.routes.ts:36`.
```ts
router.route("/proxy/:fileId").get(UploadsController.getThumbnail);
```
**Why:** Anyone with a `fileId` can fetch any thumbnail. The endpoint also crashes if Drive is disabled.
**Fix:** Add auth and remove if Drive is dead.

### L13. `process.stderr.write` debug strings in `hospitalProfile.service.ts`
**Location:** `Backend/src/Services/hospitalProfile.service.ts:28, 33, 40, 46, 50`.
**Fix:** Remove dev-prints.

### L14. `Express` v5 is in package.json (`^5.2.1`) which is a release candidate as of 2026, and `@types/express ^5.0.6` — verify intended.
**Location:** `Backend/package.json:42, 19`.
**Fix:** Pin to a stable version.

### L15. `node:22-alpine` Dockerfile + `apk add ghostscript` is workable, but no non-root user
**Location:** `Backend/Dockerfile:1-17`.
**Fix:** Run as non-root, `USER node`.

### L16. `npm install` instead of `npm ci` in Dockerfile
**Location:** `Backend/Dockerfile:9`.
**Fix:** `npm ci --omit=dev` for reproducible builds.

### L17. `docker-compose.yml` doesn't include Postgres
**Location:** repo root.
**Why:** Stack expects an externally hosted Postgres. Local dev sets `POSTGRES_HOST=host.docker.internal` (dev compose). New devs need to read the dev compose to figure this out.
**Fix:** Add a Postgres service to dev compose; document that prod uses managed DB.

### L18. No `Procfile`, no graceful shutdown
**Location:** `Backend/src/index.ts`.
**Why:** `app.listen()` has no `SIGTERM` handler. Bull queues + DB pool aren't drained on shutdown.
**Fix:** Trap SIGTERM, drain queues, close pool, exit.

### L19. `prom-client` initialized but the metrics endpoint is not protected
**Location:** `Backend/src/index.ts:132-139`.
**Why:** `/metrics` is open to the world. Useful for an internal Prometheus scrape, but if the service is internet-facing this exposes ops data.
**Fix:** Restrict by IP, basic auth, or only bind to internal interface.

### L20. `getActivePatients` query for hospital users uses `p.panel_id = ANY(hu.role::uuid[])` which crashes if `hu.role` contains 'admin'
**Location:** `Backend/src/Controllers/patient.controller.ts:645-654`.
```ts
WHERE hu.user_id = $1 AND p.is_active = true AND p.panel_id = ANY(hu.role::uuid[])
```
**Why:** Cast of `'admin'` to UUID will throw "invalid input syntax for type uuid". The other queries handle this by `OR 'admin' = ANY(hu.role)`. This one doesn't.
**Fix:** Filter out non-UUID role entries; or use `'admin' = ANY(hu.role) OR p.panel_id::text = ANY(hu.role)`.

### L21. `addClaim` declares a local `response` shadow inside a webhook block
**Location:** `Backend/src/Controllers/claims.controller.ts:86-94`.
```ts
const response = await fetch(sheetURL, ...)
```
shadowing the outer `response` of the DB update. Both names live, but it's confusing.

### L22. `hospitalProfile.service.ts:getOrCreateProfile` returns before logging via process.stderr; debug noise survives prod
**Location:** `Backend/src/Services/hospitalProfile.service.ts:27-52`. Likely a debugging artifact that was committed.

### L23. `prettier` is the only formatter; no ESLint
**Location:** `Backend/package.json`.
**Fix:** Add ESLint with typescript-eslint and a small rule set (no-floating-promises, no-misused-promises, ban template-literal SQL).

### L24. `Backend/node_modules` is committed (or at least tracked) per the `ls -la` showing 273 entries
**Fix:** Verify and gitignore.

### L25. `Backend/src/Routes/v2/uploads.routes.ts` defines two routes for `/photos` DELETE — the second shadows the first
**Location:** `Backend/src/Routes/v2/uploads.routes.ts:48-62`.
```ts
router.delete('/photos', authMiddleware.checkAuth, controller.deletePhoto)
router.delete('/photos/:id', authMiddleware.checkAuth, controller.deletePhoto)
```
**Why:** Both invoke the same controller which reads `req.body.fileId` (an array). The `:id` variant ignores its param. Dead route.
**Fix:** Remove the dead route.

### L26. `getDoctorDocuments` (`doctor.controller.ts:364-374`) always returns `{ documents: [] }`
**Location:** `Backend/src/Controllers/doctor.controller.ts:364-374`.
**Why:** Hardcoded empty. Will mislead any UI that expects the docs to be there.
**Fix:** Remove or wire up to actual data.

### L27. `accessPublicProfile` in `doctor.service.ts` throws `Error` instead of `apiError`
**Location:** `Backend/src/Services/doctor.service.ts:550-563`.
**Why:** Inconsistent error type — `asyncHandler` will turn this into a generic 500, not the intended 404/403.
**Fix:** Use `apiError`.

### L28. `attribute_definitions.label` is `TEXT NOT NULL` but no length cap; a frontend dropdown with 1MB labels is possible
**Location:** `Backend/src/schema/migrations/002_core_new_tables_v2.sql:41`.
**Fix:** Reasonable VARCHAR(255).

### L29. `removeDocumentFromAttribute` in attribute.service.ts adjusts primary doc after delete but doesn't handle the case where the deleted doc was the only one
**Location:** `Backend/src/Services/attribute.service.ts:396-431`.
**Why:** Tries to promote another row to primary, but with zero remaining rows there's nothing to promote and no error. Benign but worth a comment.

### L30. `uploadDoc` in `doctors.controller.ts` reads `customNamesRaw` as either array or JSON-stringified array but `req.files` ordering must match `customNames` ordering. There's no guarantee of order between multipart form fields.
**Location:** `Backend/src/Controllers/doctors.controller.ts:233-280`.
**Fix:** Send filename in each file field, or use a structured upload.

---

## Architecture observations

### Services
The service layer is partially formed. About half the controllers delegate to a service (`DoctorService`, `HospitalProfileService`, `AttributeService`, `panelAttributeService`); the other half (`patient.controller.ts`, `hospitalContoller.ts`, `uploads.controller.ts`, `claims.controller.ts`, `auth.controller.ts`, `hospitalDocs.controller.ts`, `doctors.controller.ts`) embed SQL directly in the request handler. The boundary is arbitrary — `patient.controller.ts` has ~1100 lines of SQL inlined while `doctorAttribute.controller.ts` is 240 lines of thin pass-through. Repositories don't exist; services and controllers reach into `pool.query` directly. Transactional boundaries are inconsistent (`panelAttribute.setMultipleAttributes` opens a client but calls non-client methods inside; `auth.signUp` simulates rollback with a DELETE). No domain model — every layer manipulates raw row dictionaries. The result is duplicated business rules (e.g. "panel access via 'admin' or panel_id in role array" appears 6+ times across services and middleware).

### Schema
The migrations folder is the most concerning artifact in the repo. Twelve `*.sql` files numbered `001`–`008` plus seven additional `_fixed`/`_rollback`/`PRODUCTION_*` variants, with no migration runner — they're hand-applied via psql by an operator. Two parallel document tables (`hospital_doc` vs `hospital_documents`), two doctor tables (`schema.sql:196` `doctors` with `hospital_id` vs migration-005 `hospital.doctors`), two doctor doc tables (`doctor_doc` vs `doctor_attribute_documents` joining `hospital_documents`). Schema prefixing is mixed (`hospital.foo` vs `foo` depending on the file) and only works because `search_path=hospital` is set in `DB/db.ts`. Polymorphic value columns (`value_text/_date/_boolean/_integer`) have no CHECK constraint that exactly one is set. Indexes are decent for hot read paths (the recent `idx_ipds_panel_status` composite is well-chosen) but some hot queries (`audit_logs`, `doctor_attribute_documents` joins) hit tables/columns that may not exist in all environments. There are FK CASCADE chains that will hard-delete patient history; soft-delete is implemented on `ipds.is_active` only and isn't honoured by the `DELETE /patient/:id` endpoint. Adopt a migration runner (Knex/Prisma/Atlas) before adding the next table.

### Routes
There are at least four routing strategies coexisting: (1) RESTful nested resource (`/hospitals/:hospitalId/attributes/:attributeKey` — modern, good), (2) action-based (`/getAllPatients`, `/addHospital`, `/refreshAccessToken` — legacy, ugly), (3) admin-prefixed (`/admin/doctors`, `/admin/attribute-definitions` — fine but inconsistently applied), (4) controller-named without role distinction (`/uploads/admin/upload` — confusing). Plural vs singular shifts mid-stream: `/doctor` (singular) router file vs `/doctors` (plural) routes, `/hospital-docs` (kebab plural) vs `/hospital-profiles` (kebab plural) vs `/hospitals/:hospitalId/profile` (singular sub-resource). `/api/v1` is the only prefix; the v2 upload router lives at `/api/v2/uploads` and shares no other endpoints with v2. Mount order matters and the comments in `index.ts:163-195` explicitly warn about catch-all conflicts. Authorization is per-route-per-middleware — there's no central authz policy file, so the easiest way to ship a tenant leak is to attach `checkAuth` to a new route and call it a day, which is exactly what most of the doctor and panel routes did.

### Error handling
`asyncHandler` is well-intentioned but does several things wrong: (1) it always wraps non-`apiError` exceptions as generic 500s, losing PostgreSQL error context which is sometimes useful; (2) it stringifies the raw `err` to stdout — `JSON.stringify(err)` on PostgreSQL errors with circular refs throws or dumps internals; (3) `NODE_ENV === 'development'` toggles stack-trace inclusion in responses but there's no env validation, so a misconfigured staging environment leaks stacks; (4) several controllers don't use asyncHandler and have try/catch inline (`panelAttribute.controller.ts`, `masterOptions.controller.ts`), with a different response envelope. The result is two error-response shapes in the same API, and several controllers swallow errors with `console.error` and return success (notably `patient.controller.ts:879-882` "Don't throw here to ensure patient update success is returned"). For a healthcare app, silent partial success is the wrong tradeoff — return 207 Multi-Status or fail hard.

---

## Quick wins (each ≤ 1 hour)

In rough priority order. All are surgical, low-risk.

1. **Fix the `hp,sheet_name` typo** in `patient.controller.ts:941` — one character, restores Sheets sync on discharge.
2. **Delete the no-op v1 `deletePhoto`/`deletePhotoForAdmin`** in `uploads.controller.ts:419-461` and point the routes at the v2 implementation. Stops the silent "delete that doesn't" bug.
3. **Fix `panelAttribute.service.ts:486-488` boolean coercion** (`|| null` → `?? null`). Makes "set to false" possible.
4. **Add `checkSuperAdminOrAdmin` to `verifyAttribute` and `setVerificationLevel` routes** in `hospitalProfile.routes.ts` and `doctor.routes.ts`. Five lines, removes the obvious "any user can self-verify" hole.
5. **Replace the inline `multer({ memoryStorage, 100 MB })` in `doctor.routes.ts:12` and `hospitalProfile.routes.ts:12`** with the central `multer.middleware.ts` — closes the MIME bypass.
6. **Add a `if (result.rowCount === 0)` guard in `auth.middleware.ts:332-336`** and `patient.controller.ts:716-719` to prevent the 500 on missing hospital_user row.
7. **Change `INTERVAL '${days} days'` interpolation** in `doctorAttribute.service.ts:360` and `panelAttributeDocument.service.ts:275` to `make_interval(days => $N)`. Removes injection-adjacent code.
8. **Remove the `[DEBUG] Route ...` middleware** at `index.ts:165-167` and `:191-194`. Stops noisy logs.
9. **Add `helmet()`** to `app.ts` for default secure headers. One-liner.
10. **Cap `express.json` body limit** at 1-2MB (currently 100MB) — `app.ts:28`. Stops trivial DoS.
11. **Add `STORAGE_PROVIDER` and other env validation** at boot (zod schema), exit non-zero on missing — prevents the `parseInt(" ")` → `NaN` and the empty-secret JWT cases.
12. **Remove `Backend/dist/`, `Backend/backend.log`, `Backend/server.log`, `Backend/queue_state.json`** from version control. One git command.
13. **Add `pool.connect() + BEGIN/COMMIT` wrappers around `auth.signUp` and `patient.addPatient`** — handles two of the highest-traffic non-transactional flows.
14. **Replace `Math.random() * 1000` collision-prone suffix in `fileName.util.ts:28-29`** with `uuid.v4().slice(0, 8)`.
15. **Add a `LIMIT 500` server-side cap to `getAllPatients`** and the other no-pagination list endpoints, with a TODO to migrate callers to the paginated variants.

---

*End of review. ~80 findings.*
