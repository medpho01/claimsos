# Filing Document Sharing — Design & Implementation Plan (v2, agreed)

Status: agreed · Context: cashless/pre-auth email filing (`InsuranceComposeModal` + `insuranceSubmission.service`)

## Decisions (locked)
- **Full build** (not phased rollout).
- **Nothing pre-checked** — every attachment is an explicit opt-in each send. (No `auto_attach` flag needed.)
- **Tagging is implicit in where the doc is attached** — no new scope column, no new tagging UI:
  - **Common** = documents attached to **hospital attributes** → `hospital_documents` rows with `attribute_key IS NOT NULL`.
  - **Panel-specific** = documents attached to **panel attributes** → `panel_attribute_documents` (`panel_attribute_id → panel_attributes`, `document_id → hospital_documents`).

## Problem being fixed
1. Auto-attach reads the wrong/empty table (`hospital_doc`) and force-attaches **everything hospital-wide** (24 photos on every email).
2. Insurer-specific docs (`panel_attribute_documents`) are never offered.
3. Only patient docs have checkboxes; hospital/insurer docs can't be chosen per send.

## Verified data model
- Single binary store for hospital + panel docs: **`hospital.hospital_documents`** (has `s3_key`, `file_name`, `mime_type`, `file_size_bytes`, `document_name`, `attribute_key`).
- `panel_attribute_documents.document_id` → FK → `hospital_documents.id`; `panel_attribute_id` → `panel_attributes.id` (which carries `hospital_panel_id`).
- Patient docs remain in `ipd_doc` (per claim).
- `hospital_doc` (singular) is **no longer used by filing** after this change.

## Target behavior — 3 attachment groups, all checkboxes, none pre-checked

| Group | Read query | Scope |
|---|---|---|
| **Patient documents** | `ipd_doc WHERE ipd_id = :claim AND s3_key IS NOT NULL` | this claim *(unchanged)* |
| **Common hospital documents** | `hospital_documents WHERE hospital_id = :h AND attribute_key IS NOT NULL AND s3_key IS NOT NULL` | hospital (any panel) |
| **Insurer / panel documents** | `hospital_documents hd JOIN panel_attribute_documents pad ON pad.document_id = hd.id JOIN panel_attributes pa ON pa.id = pad.panel_attribute_id WHERE pa.hospital_panel_id = :claimHospitalPanel AND hd.s3_key IS NOT NULL` | this claim's panel only |

All candidates returned with `default_selected = false`. Footer count = number checked.

## Backend changes

**`insuranceSubmission.service.ts`**
- Delete/replace `listHospitalDocs(hospitalId)` (reads `hospital_doc`).
- Add `listFilingCandidates(ipdId)` → resolves the claim's `hospital_id` + `hospital_panel_id`, runs the three queries above, returns:
  ```ts
  { groups: [
      { key:'common',  label:'Common hospital documents',  docs:[Candidate] },
      { key:'panel',   label:`${panelName} documents`,      docs:[Candidate] },
      { key:'patient', label:'Patient documents',           docs:[Candidate] },
  ]}
  // Candidate = { source:'hospital_document'|'ipd_doc', id, file_name, mime_type, size_bytes, default_selected:false }
  ```
- De-dupe: a `hospital_documents` row could be both a hospital-attribute doc and linked to a panel attribute — key by `id`, prefer the panel group, drop the dup from common.

**`insuranceSubmission.controller.ts`**
- `draft`: return `groups` (above) instead of flat `auto_hospital_documents`.
- `send`: accept `attachments: [{ source, id }]` = the checked set only. Drop any implicit "attach all." Validate each id belongs to this claim/hospital/panel before fetching from S3 (prevents a tampered id pulling another hospital's file).

**Attachment fetch on send**
- `source='hospital_document'` → `SELECT s3_key, file_name, mime_type FROM hospital_documents WHERE id = :id` (after the ownership check) → S3 download.
- `source='ipd_doc'` → existing path.

## Frontend changes — `InsuranceComposeModal.tsx`
- Render **three collapsible groups**, each with **per-file checkboxes** + **Select all (group)**. **None checked by default.**
- Group order: Patient · Common hospital · {Panel} documents.
- Footer: `N attachment(s)` = total checked; Send disabled at 0 (or allow 0 with a confirm).
- Send posts the checked `{source,id}[]`.
- Remove the old read-only "Hospital documents (auto-attached)" list.

## Out of scope (explicitly)
- No migration of `hospital_documents` → `hospital_doc`.
- No `scope`/`auto_attach` columns.
- No new tagging UI — admins already control common-vs-panel by attaching the file to a hospital attribute vs a panel attribute.
- The earlier `hospital_doc` backfill is now dead for filing; can be left or cleaned up separately.

## Risks / checks
- Confirm prod's deployed `hospital_documents` rows have `s3_key` populated (they do locally). Drive-only docs (`s3_key NULL`) are correctly skipped.
- Panel resolution uses the claim's `hospital_panel_id` (same one the to-address fix used) — consistent.
- Email size: with explicit opt-in (nothing pre-checked) the 24-image blast is structurally impossible; optionally add a total-size warning.

## Affected files
- BE: `Backend/src/Services/insuranceSubmission.service.ts`, `Backend/src/Controllers/insuranceSubmission.controller.ts`.
- FE: `webapp/src/pages/hospital/PatientDetail/InsuranceComposeModal.tsx`.
- No DB migration.
