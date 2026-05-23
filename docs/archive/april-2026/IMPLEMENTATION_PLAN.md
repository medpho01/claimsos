# Hospital Profile — Implementation Guide

Build order: DB → Backend Services → Backend Routes → Webapp  
Each step depends on the one before it.

---

## Step 1 — Run Migrations

Run in this exact order. Each is in `Backend/src/schema/migrations/`.

```
1. 002b_hospital_table_updates.sql      ← makes drive_folder_id nullable, adds CE columns to hospitals
2. 002_core_new_tables_v2.sql           ← creates all 10 new tables
3. 002c_attribute_definitions_seed.sql  ← seeds 80+ attribute definitions (accreditations, compliance, beds, equipment, etc.)
4. 003_migrate_hospital_details.sql     ← copies existing hospitals.details JSONB → hospital_profile rows
5. 003b_cashless_everywhere_seed.sql    ← creates the Cashless Everywhere panel, enrolls all hospitals
```

**Verify after step 2:**
```sql
SELECT COUNT(*) FROM attribute_definitions; -- should be 80+
SELECT COUNT(*) FROM hospital_profile;      -- should match COUNT(*) FROM hospitals
```

---

## Step 2 — Fix 3 Existing Bugs Before Building Anything New

These will break new features if left in.

**Bug 1** — `Backend/src/Controllers/patient.controller.ts`  
`deletePatient` passes `userId` where `hospitalId` is expected. Fix the query binding.

**Bug 2** — `Backend/src/Controllers/auth.controller.ts`  
`jwt.decode()` used instead of `jwt.verify()` in `refreshAccessToken`. Fix to verify the signature.

**Bug 3** — `Backend/src/Controllers/hospitalContoller.ts`  
`addPatient` creates a Drive folder before the DB insert. Wrap it in try/catch — Drive failure must not block patient creation now that `drive_folder_id` is nullable.

---

## Step 3 — Backend: New Services

### `Backend/src/Services/encryption.service.ts`
AES-256-GCM encrypt/decrypt. Used for portal credentials in Step 9.  
Reads key from `PORTAL_CREDS_KEY` env var (32-byte hex).  
Add `PORTAL_CREDS_KEY` to `.env` and `docker-compose.yml`.

```typescript
export class EncryptionService {
  encrypt(plaintext: string): string    // → "iv:tag:ciphertext" (hex)
  decrypt(ciphertext: string): string
}
```

### `Backend/src/Services/attributeDefinitions.service.ts`
Loads `attribute_definitions` table into memory at startup. Everything reads from this cache — no DB hit per request.

```typescript
export class AttributeDefinitionsService {
  async loadAll(): Promise<void>
  getByKey(key: string): AttributeDefinition | undefined
  getByCategory(category: string): AttributeDefinition[]
  invalidateCache(): void
}
```

Call `attributeDefinitionsService.loadAll()` inside `StartupService` in `startup.service.ts`.

### `Backend/src/Services/hospitalDocuments.service.ts`
Unified document upload — wraps `s3.service.ts`, writes to `hospital_documents` table.  
S3 key pattern: `hospital-docs/{hospital_id}/{category}/{timestamp}_{filename}`

```typescript
export class HospitalDocumentsService {
  async upload(hospitalId: string, file: Express.Multer.File, meta: DocumentMeta): Promise<HospitalDocument>
  async getSignedUrl(documentId: string): Promise<string>          // CloudFront signed URL
  async listByHospital(hospitalId: string, filters?: Filters): Promise<HospitalDocument[]>
  async listByAttribute(hospitalId: string, attributeKey: string): Promise<HospitalDocument[]>
  async softDelete(documentId: string): Promise<void>              // sets is_primary = false
}
```

---

## Step 4 — Backend: Hospital Profile Controller + Routes

### `Backend/src/Controllers/hospitalProfile.controller.ts`

```
GET    /api/v1/hospitals/:hospitalId/profile
       → Returns hospital_profile + hospital_key_contacts joined

PATCH  /api/v1/hospitals/:hospitalId/profile
       → Body: { section: 'identity'|'address'|'type'|'banking', data: {...} }
       → Validates with Zod per section, upserts hospital_profile

GET    /api/v1/hospitals/:hospitalId/profile/completion
       → Returns { score: 67, sections: { identity: 80, address: 100, contacts: 33, banking: 0 } }
```

### `Backend/src/Controllers/hospitalContacts.controller.ts`

```
GET    /api/v1/hospitals/:hospitalId/contacts
POST   /api/v1/hospitals/:hospitalId/contacts
PUT    /api/v1/hospitals/:hospitalId/contacts/:id
DELETE /api/v1/hospitals/:hospitalId/contacts/:id
```

### `Backend/src/Routes/hospitalProfile.routes.ts`
Wire up both controllers. Apply existing `verifyToken` + hospital access middleware.

### Register in `Backend/src/index.ts`
```typescript
app.use("/api/v1/hospitals/:hospitalId/profile",  hospitalProfileRouter);
app.use("/api/v1/hospitals/:hospitalId/contacts", hospitalContactsRouter);
```

### Zod schemas — `Backend/src/schemas/hospitalProfile.schema.ts`
One schema per section: `identitySchema`, `addressSchema`, `hospitalTypeSchema`, `bankingSchema`.  
Banking schema validates PAN format, IFSC format.

---

## Step 5 — Backend: Attributes Controller + Routes

### `Backend/src/Controllers/hospitalAttributes.controller.ts`

```
GET    /api/v1/hospitals/:hospitalId/attributes
       → Optional ?category=compliance_cert,infrastructure
       → Returns hospital_attributes rows joined with attribute_definitions
       → Groups response by category

GET    /api/v1/hospitals/:hospitalId/attributes/:key
       → Single attribute + its documents + verification_evidence

PUT    /api/v1/hospitals/:hospitalId/attributes/:key
       → Upsert: validates value type against attribute_definitions.data_type
       → Resets verification_status to 'unverified' on value change (unless admin setting it directly)
```

### `Backend/src/Routes/hospitalAttributes.routes.ts`

### Register in `Backend/src/index.ts`
```typescript
app.use("/api/v1/hospitals/:hospitalId/attributes", hospitalAttributesRouter);
```

---

## Step 6 — Backend: Documents Controller + Routes

### `Backend/src/Controllers/hospitalDocuments.controller.ts`

```
GET    /api/v1/hospitals/:hospitalId/documents
       → Optional ?category=compliance&attribute_key=compliance_cert.fire_noc

POST   /api/v1/hospitals/:hospitalId/documents/upload
       → Multipart: file + { document_category, document_type, document_name, attribute_key? }
       → Calls HospitalDocumentsService.upload()
       → If attribute_key provided: also upserts hospital_attributes.document_id

DELETE /api/v1/hospitals/:hospitalId/documents/:id
       → Soft delete via HospitalDocumentsService.softDelete()

GET    /api/v1/hospitals/:hospitalId/documents/:id/url
       → Returns fresh CloudFront signed URL
```

### `Backend/src/Routes/hospitalDocuments.routes.ts`

### Register in `Backend/src/index.ts`
```typescript
app.use("/api/v1/hospitals/:hospitalId/documents", hospitalDocumentsRouter);
```

---

## Step 7 — Backend: Verification Evidence Controller + Routes

### `Backend/src/Controllers/verificationEvidence.controller.ts`

```
POST   /api/v1/hospitals/:hospitalId/attributes/:key/evidence
       → Multipart: photo or document
       → Uploads via HospitalDocumentsService (category: 'infrastructure', type: 'photo')
       → Creates verification_evidence record linking to hospital_attributes
       → Sets hospital_attributes.verification_status = 'pending_review'

GET    /api/v1/hospitals/:hospitalId/attributes/:key/evidence
       → Lists evidence items with signed URLs

DELETE /api/v1/hospitals/:hospitalId/attributes/:key/evidence/:id
```

### Admin verification endpoints — add to `Backend/src/Controllers/admin.controller.ts`

```
GET    /api/v1/admin/verification/queue
       → All hospital_attributes WHERE verification_status = 'pending_review'
       → Joined with hospital name, attribute label, evidence count

POST   /api/v1/admin/verification/:attributeId/review
       → Body: { status: 'verified_by_image'|'verified_by_doc'|'rejected', notes: string }
       → Updates hospital_attributes.verification_status + verified_by + verified_at
```

### Register in `Backend/src/index.ts`
```typescript
app.use("/api/v1/hospitals/:hospitalId/attributes/:key/evidence", verificationEvidenceRouter);
// Admin routes go under existing /api/v1/admin router
```

---

## Step 8 — Backend: Public Profile + Share Tokens

### `Backend/src/Controllers/publicProfile.controller.ts`

```
GET    /api/public/h/:slug
       → No auth
       → Returns hospital_profile WHERE public_slug = slug AND is_public_profile_enabled = true
       → Filters hospital_attributes to only verified ones
       → Returns only sections in public_profile_sections

GET    /api/public/share/:token
       → No auth
       → Validates token (is_active, expires_at, max_views)
       → Increments view_count, sets last_viewed_at
       → Returns resource based on resource_type + visible_sections
```

### `Backend/src/Controllers/shareTokens.controller.ts`

```
POST   /api/v1/hospitals/:hospitalId/profile/share
       → Body: { visible_sections, expires_in_days?, max_views? }
       → Creates public_share_tokens record, returns full URL

GET    /api/v1/hospitals/:hospitalId/profile/share
DELETE /api/v1/hospitals/:hospitalId/profile/share/:tokenId
```

### `Backend/src/Routes/public.routes.ts`
**No auth middleware on this router.**

### Register in `Backend/src/index.ts`
```typescript
app.use("/api/public", publicRouter);    // must be before auth middleware groups
app.use("/api/v1/hospitals/:hospitalId/profile/share", shareTokensRouter);
```

---

## Step 9 — Backend: Panel Empanelments Controller + Routes

### `Backend/src/Controllers/panelEmpanelments.controller.ts`

```
GET    /api/v1/hospitals/:hospitalId/empanelments
       → All empanelments with panel name, status, expiry, portal_name

GET    /api/v1/hospitals/:hospitalId/empanelments/:id
       → Full detail — excludes portal_password_enc from response

PUT    /api/v1/hospitals/:hospitalId/empanelments/:id
       → Update all fields except credentials

POST   /api/v1/hospitals/:hospitalId/empanelments/:id/credentials
       → Admin only (new requireAdmin middleware)
       → Encrypts password with EncryptionService before storing

GET    /api/v1/hospitals/:hospitalId/empanelments/:id/credentials
       → Admin only
       → Decrypts and returns credentials
       → Writes to audit_logs on every access

POST   /api/v1/hospitals/:hospitalId/empanelments/:id/documents/upload
       → Uploads contract/MoU via HospitalDocumentsService
       → Creates panel_documents record
       → Sets previous docs of same type to is_active = false

GET    /api/v1/hospitals/:hospitalId/empanelments/:id/documents
```

### Auto-create empanelment on panel assignment
In `Backend/src/Controllers/hospitalContoller.ts` — wherever `addHospitalToPanel` inserts into `hospital_panels`, also `INSERT INTO panel_empanelments` with defaults and set `has_empanelment_record = true`.

### New middleware in `Backend/src/Middlewares/auth.middleware.ts`
```typescript
export const requireAdmin = (req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};
```

### `Backend/src/Routes/panelEmpanelments.routes.ts`

### Register in `Backend/src/index.ts`
```typescript
app.use("/api/v1/hospitals/:hospitalId/empanelments", panelEmpanelmentsRouter);
```

---

## Step 10 — Backend: Document Extraction

### `Backend/src/Services/documentExtraction.service.ts`
Calls Claude API (`claude-sonnet-4-6`) with the document + extraction template prompt.  
Reads `CLAUDE_API_KEY` from env.  
Stores result in `document_extractions`.

```typescript
export class DocumentExtractionService {
  async queueExtraction(documentId: string, attributeKey: string): Promise<void>
  async applyExtraction(extractionId: string, userId: string, overrides?: object): Promise<void>
  // applyExtraction pushes structured_data fields into hospital_attributes
}
```

Call `queueExtraction()` inside `HospitalDocumentsService.upload()` when `attribute_key` is present.

### `Backend/src/Workers/extraction.queue.ts`
Bull queue `extraction-queue`. Worker fetches doc from S3, sends to Claude, stores result.  
On completion: sets `extraction_status = 'completed'`, sends WhatsApp to admin that extraction is ready.

### Admin extraction endpoints — add to `Backend/src/Controllers/admin.controller.ts`

```
GET    /api/v1/admin/extractions
       → ?status=completed&reviewed=false

GET    /api/v1/admin/extractions/:id
       → Full extraction with structured_data and document signed URL

POST   /api/v1/admin/extractions/:id/apply
       → Body: { overrides?: {...} }   — optional field corrections before applying
       → Calls DocumentExtractionService.applyExtraction()

POST   /api/v1/admin/extractions/:id/skip
```

Register worker in `Backend/src/index.ts`:
```typescript
import './Workers/extraction.queue.js'
```

---

## Step 11 — Backend: Expiry Monitoring Cron

### `Backend/src/Workers/expiryMonitor.ts`
Daily cron at 9 AM IST. Two queries: expiring `hospital_attributes` (certs) + expiring `panel_empanelments`.  
Groups by hospital, sends one WhatsApp per hospital to their TPA contact.  
Alert windows: 60 days · 30 days · 7 days · 1 day.

Register in `Backend/src/index.ts`:
```typescript
import './Workers/expiryMonitor.js'
```

---

## Step 12 — Webapp: Hospital Profile Page

### `webapp/src/pages/hospital/Profile/index.tsx`
Route: `/portal/:hospitalId/profile`

Five tabs using shadcn `Tabs`: **Identity · Address · Type & Specialties · Contacts · Banking**

Top of page: `ProfileCompletionBar` showing overall % and which sections need attention.

Each tab section: read view by default, [Edit] button switches to form, [Save] calls `PATCH /profile`.

### Components to create:

**`webapp/src/components/profile/ProfileCompletionBar.tsx`**  
Progress bar + per-section scores. Clicking a section jumps to that tab.

**`webapp/src/components/profile/SectionCard.tsx`**  
Reusable wrapper: title + edit/save/cancel toggle. Auto-saves on blur with 1s debounce.

**`webapp/src/components/profile/ContactsSection.tsx`**  
Three contact cards (Institution Head, Finance Head, TPA). Add/Edit/Delete inline.

**`webapp/src/components/profile/BankingSection.tsx`**  
Renders account number and PAN masked. [Reveal] requires entering current password first.

### Add to sidebar
`webapp/src/pages/hospital/Layout/index.tsx` — add **Profile** nav link.

### API additions to `webapp/src/services/api.ts`
```typescript
getHospitalProfile(hospitalId)
updateHospitalProfileSection(hospitalId, section, data)
getProfileCompletion(hospitalId)
getHospitalContacts(hospitalId)
createContact(hospitalId, data)
updateContact(hospitalId, id, data)
deleteContact(hospitalId, id)
```

---

## Step 13 — Webapp: Attributes Page

### `webapp/src/pages/hospital/Attributes/index.tsx`
Route: `/portal/:hospitalId/profile/attributes`

Left sidebar with category links. Main area shows attribute cards for selected category.

### Components to create:

**`webapp/src/components/attributes/AttributeCard.tsx`**  
Shows: label · value · verification status badge · expiry date (color-coded: green/amber/red).  
[Upload] or [Edit] CTA based on attribute type.

**`webapp/src/components/attributes/AttributeEditModal.tsx`**  
Dynamic form based on `data_type`:
- `boolean` → toggle
- `integer` → number input + unit label  
- `document` → triggers cert upload flow

If `has_expiry = true`: shows Cert Number, Issuing Authority, Issue Date, Expiry Date fields.  
If `can_verify_by_image = true`: shows `image_guidance` text and photo upload.

**`webapp/src/components/attributes/EvidenceUploader.tsx`**  
Drag-and-drop for infrastructure attributes.  
Shows existing evidence with status: pending · accepted · rejected.

**`webapp/src/components/attributes/SectionProgress.tsx`**  
"4 of 8 set · 1 expiring soon" shown at top of each category section.

### API additions to `webapp/src/services/api.ts`
```typescript
getHospitalAttributes(hospitalId, category?)
upsertHospitalAttribute(hospitalId, key, data)
uploadHospitalDocument(hospitalId, file, meta)
getHospitalDocuments(hospitalId, filters?)
getDocumentSignedUrl(hospitalId, documentId)
uploadAttributeEvidence(hospitalId, key, file, caption?)
getAttributeEvidence(hospitalId, key)
```

---

## Step 14 — Webapp: Admin Verification Queue

### `webapp/src/pages/admin/VerificationQueue/index.tsx`
Route: `/dashboard/verification`

Table: Hospital · Attribute · Category · Evidence Count · Submitted · [Review]

### `webapp/src/components/admin/VerificationDrawer.tsx`
Side drawer with:
- Attribute details
- Evidence preview (image lightbox or PDF viewer via CloudFront URL)
- [Approve] / [Reject with notes] buttons

---

## Step 15 — Webapp: Panel Empanelments

### `webapp/src/pages/hospital/Empanelments/index.tsx`
Route: `/portal/:hospitalId/panels`

Replace existing `Panels/index.tsx` or extend it.

Grid of panel cards showing: name · status badge · empanelment type · expiry · [Manage]

### `webapp/src/pages/hospital/Empanelments/EmpanelmentDetail.tsx`
Five tabs: **Basic Info · Contacts · Portal Access · Contract · Documents**

**Portal Access tab:**  
Username visible. Password shows `••••••••` with [Show] — only visible to admin role.  
2FA section: type + which person receives OTP.

**Contract tab:**  
Package rates table (procedure → ₹). Room rents grid. Payment terms, TAT fields.

**Documents tab:**  
List of contracts/MoUs with upload dates + extraction status badge. [Upload Contract] / [Upload MoU].

### `webapp/src/components/empanelments/PortalCredentialField.tsx`
Password reveal: calls credential API (admin-only endpoint). Shows permission error to hospital users.

---

## Step 16 — Webapp: Extraction Review

### `webapp/src/pages/admin/Extractions/index.tsx`
Route: `/dashboard/extractions`

List of completed-but-not-reviewed extractions: Hospital · Document · Attribute · [Review]

### `webapp/src/components/extraction/ExtractionReviewModal.tsx`
Split view:
- Left: PDF embed (CloudFront signed URL)
- Right: Extracted fields — all editable before applying

[Apply Fields] → calls `POST /admin/extractions/:id/apply`  
[Enter Manually] → skips extraction, opens AttributeEditModal directly

---

## Step 17 — Webapp: Public Profile Page

### `webapp/src/pages/public/HospitalPublicProfile.tsx`
Route: `/h/:slug`  
**Outside `PrivateRoute` — no auth required.**

Sections (only shown if hospital has enabled them):
- Identity: name, logo, address, phone, website
- Verification badge (level from `verification_level`)
- Accreditations: verified only, with expiry
- Specialties
- Infrastructure: bed counts, ICU, key facilities (verified only)
- Public contact

Bottom: "Powered by Finclarity" link.

### `webapp/src/pages/public/SharedResource.tsx`
Route: `/share/:token`  
Handles `hospital_profile`, `patient_summary`, `ipd_discharge_summary` resource types.

### Public Profile Settings — add tab to `webapp/src/pages/hospital/Profile/index.tsx`
- Enable public profile toggle
- Section visibility toggles
- Custom slug input with availability check API call
- [Copy link] button
- Share tokens list with [Revoke] per token

### `webapp/src/components/ShareModal.tsx`
Reusable across profile + IPD pages.  
Inputs: sections to share · expiry · max views.  
Output: generated link + copy button.

---

## Step 18 — Webapp: Renewal Widget

### `webapp/src/components/dashboard/RenewalWidget.tsx`
Shows certs and empanelments expiring in next 60 days, sorted by urgency.  
Color: red < 7 days · amber < 30 days · yellow < 60 days.

Add to:
- `webapp/src/pages/hospital/Dashboard/` — hospital sees their own
- `webapp/src/pages/admin/AdminDashboardPage.tsx` — admin sees all hospitals

---

## What Goes in `.env`

Add these before starting:
```
PORTAL_CREDS_KEY=         # 32-byte hex — generate with: openssl rand -hex 32
CLAUDE_API_KEY=           # Anthropic API key for extraction
PUBLIC_PROFILE_BASE_URL=https://app.finclarity.in
```

---

## Build Order Summary

```
Step 1   Run migrations
Step 2   Fix 3 bugs
Step 3   New backend services (encryption, attributeDefinitions, hospitalDocuments)
Step 4   Profile controller + routes
Step 5   Attributes controller + routes
Step 6   Documents controller + routes
Step 7   Verification evidence controller + routes
Step 8   Public profile + share tokens
Step 9   Panel empanelments controller + routes
Step 10  Document extraction (Claude API + Bull queue)
Step 11  Expiry monitoring cron
─────── Backend complete ────────
Step 12  Webapp: Hospital Profile page
Step 13  Webapp: Attributes page
Step 14  Webapp: Admin verification queue
Step 15  Webapp: Panel empanelments
Step 16  Webapp: Extraction review
Step 17  Webapp: Public profile + share
Step 18  Webapp: Renewal widget
```
