# Sprint 2B — God-Component Split Plans

Three components that exceed 1000 LOC each. Splitting them properly requires
careful regression of every dialog flow + every read path. This document is
the executable plan; the actual splits should land on their own branches with
per-slice commits the way `PanelsManager.tsx` (1721 → 239 LOC) did.

The proven template lives at
`webapp/src/pages/hospital/Profile/components/panels/`:

```
panels/
  types.ts                      — pure types (HospitalPanel, PanelAttribute, etc.)
  attributeApi.ts                — fetch helpers + normalizers + payload builders
  AttributeInputField.tsx        — dispatches on data_type, renders the right input
  PanelAttributeDocumentRow.tsx  — single doc row (download/preview/delete)
  PanelAttributeAddDialog.tsx    — Add dialog: owns its own form state
  PanelAttributeEditDialog.tsx   — Edit dialog: owns its own form state
  PanelAttributeDeleteDialog.tsx — Confirm dialog
  PanelAttributeEditor.tsx       — Reusable form chunk shared by Add + Edit
  PanelConfigureTab.tsx          — Tab body
  PanelOverviewTab.tsx           — Tab body
```

The orchestrator (`PanelsManager.tsx`) becomes a thin shell: ~240 LOC of
state-glue + tab switching.

---

## 1. `pages/hospital/Profile/components/AttributesManager.tsx` (1478 LOC)

**Already scaffolded by Agent G**:
- `attributes/types.ts` — `HospitalAttribute`, `AttributeDefinition`, `AttributeDocument`,
  `AttributeFormData` + `EMPTY_ATTRIBUTE_FORM`, `VerifyFormData` + `EMPTY_VERIFY_FORM`
- `attributes/attributeApi.ts` — `normalizeAttribute`, `buildAttributePayload`,
  `uploadMultipleDocuments`, `attributeToFormData`, `hasCertificateData`,
  `downloadAttributeDocument`

**Remaining slices** (mirror `panels/`):

| File | Source lines | What goes in |
|---|---|---|
| `attributes/AttributeInputField.tsx` | ~517-558 (`renderAttributeValue`) | Dispatches on `definition.data_type` (text / textarea / boolean / date / document), returns the right `<Input>` / `<Textarea>` / `<Switch>` / `<input type="date">` / file upload. Mirrors `panels/AttributeInputField.tsx`. |
| `attributes/AttributeDocumentRow.tsx` | ~700-790 (each doc row inside the card) | Single doc tile with preview / download / delete buttons. Mirrors `panels/PanelAttributeDocumentRow.tsx`. |
| `attributes/AttributeCard.tsx` | ~646-902 (`filteredAttributes.map(...)`) | The whole card UI for one attribute (value display, cert details, doc list, edit/verify/delete buttons). |
| `attributes/AttributeAddDialog.tsx` | ~905-1100 (`<Dialog open={showAddDialog}>`) | Own state: `formData`, `selectedFiles`, `uploadLoading`. On submit calls `apiService.setAttributeValue + uploadMultipleDocuments`. **Critical**: state lifted out of orchestrator (closes the bug where re-opening the dialog re-used the previous attribute's data — same pattern that bit PanelAttributeEditDialog before its split). |
| `attributes/AttributeEditDialog.tsx` | ~1100-1300 (`<Dialog open={showEditDialog}>`) | Own state. Receives the attribute to edit as a prop; seeds form from `attributeToFormData(attr)`. Doc list inside the dialog uses `AttributeDocumentRow`. |
| `attributes/AttributeVerifyDialog.tsx` | ~1300-1400 (`<Dialog open={showVerifyDialog}>`) | Tiny — verify method dropdown + notes textarea. |
| `attributes/AttributeDeleteDialog.tsx` | ~1400-1478 | Confirm dialog (or replace with `useConfirm()` from `lib/confirm.tsx` and drop the dialog entirely). |

**Orchestrator (`AttributesManager.tsx`) keeps**:
- `attributes` / `definitions` state + `fetchData`
- Category filter pills
- `filteredAttributes` mapping
- The `<AttributeCard>` map
- "Add Attribute" button + `<AttributeAddDialog open … />` wiring

**Estimated end state**: `AttributesManager.tsx` ~280 LOC.

**Test loop per slice**:
1. Read existing AttributesManager flow end-to-end (Add → upload → Edit → Verify → Delete)
2. Extract one slice, replace the inline JSX with the new component
3. Refresh page in browser, exercise the same flow, watch console for missing-prop / missing-state regressions
4. Commit. Repeat.

---

## 2. `components/DoctorDetailsTabs/CredentialsTab.tsx` (1050 LOC)

Already split out of `DoctorDetailsModal.tsx`; this is the next-level split.

**Existing seams** (interfaces already declared at top):
- `AttributeDefinition`, `DoctorAttribute`, `AttributesByCategory`, `AddCredentialFormData`

**Remaining slices**:

| File | Source lines | What goes in |
|---|---|---|
| `DoctorDetailsTabs/credentials/types.ts` | 20-70 | The four interfaces above. |
| `DoctorDetailsTabs/credentials/credentialApi.ts` | new | Wraps the calls scattered in CredentialsTab: `setDoctorAttribute`, `uploadDoctorDoc`, `addDoctorAttributeDocument`, plus a `normalizeDoctorAttribute` helper. |
| `DoctorDetailsTabs/credentials/CredentialInputField.tsx` | ~150-250 | data_type dispatcher specific to doctor attributes (text / boolean / date / document). |
| `DoctorDetailsTabs/credentials/CredentialDocumentRow.tsx` | inside add/edit dialog | Single uploaded doc with preview / download / remove buttons. |
| `DoctorDetailsTabs/credentials/CredentialAddDialog.tsx` | ~735-950 | Owns its own `formData` + `selectedFiles` state. Submission runs the 3-step chain: `setDoctorAttribute` → `uploadDoctorDoc` → `addDoctorAttributeDocument`. |
| `DoctorDetailsTabs/credentials/CredentialEditDialog.tsx` | ~950-1050 | Owns its own state. Document edit removes existing docs via `removeDoctorAttributeDocument`. |
| `DoctorDetailsTabs/credentials/CredentialCard.tsx` | ~400-700 (credential card inside the category accordion) | One credential row in the list. |

**Orchestrator (`CredentialsTab.tsx`) keeps**:
- `attributesByCategory` + `definitions` state + `loadData`
- Category accordion render
- `<CredentialCard>` map + Add button + dialog wiring
- Already exposes `registerAddCredential(open)` to parent — keep.

**Estimated end state**: `CredentialsTab.tsx` ~300 LOC.

---

## 3. `pages/PublicHospitalProfile.tsx` (1023 LOC)

Read-only single-purpose page; lower priority because there are no
mutating dialogs to extract (= fewer state-management gotchas). Still
worth splitting for readability.

**Slices**:

| File | Source lines | What goes in |
|---|---|---|
| `pages/public-profile/types.ts` | 73-108 | `PublicProfileData` and its nested shapes. |
| `pages/public-profile/jsonExport.ts` | ~128-220 (`generateJsonExport`, `handleDownloadJson`, `handleCopyJson`) | The "Export as JSON" feature lives in isolation — pure functions. |
| `pages/public-profile/ProfileHeader.tsx` | ~270-380 | Hero card with hospital name, logo, verification badge, share/json buttons. |
| `pages/public-profile/ProfileTab.tsx` | ~514-714 | The "Profile" tab body (legal info, location, registration, banking). |
| `pages/public-profile/AttributesTab.tsx` | ~715-980 | The "Attributes" tab body: category filter pills + cards + document download/preview wiring. |
| `pages/public-profile/AttributeDocumentChip.tsx` | inside attributes tab | Document tile with public-share preview/download via `downloadPublicDocument`. |

**Orchestrator (`PublicHospitalProfile.tsx`) keeps**:
- Param parsing (`token`)
- Single `fetchPublicProfile` effect + `data` / `loading` / `error` state
- `<Tabs>` shell
- Preview modal mounting (`<FilePreviewModal />`)

**Estimated end state**: `PublicHospitalProfile.tsx` ~280 LOC.

---

## Order & branch strategy

1. **AttributesManager** first — largest, scaffold is already there. One slice per commit; ~7 commits.
2. **CredentialsTab** second — pattern is identical to AttributesManager so the second pass is faster.
3. **PublicHospitalProfile** last — lowest risk, can be done in one or two commits.

Each on its own branch (`sprint-2b-attributes-split`, `sprint-2b-credentials-split`,
`sprint-2b-public-profile-split`) so a regression in one doesn't block the others.

## Why deferred

A proper split exposes every dialog state-bug that was previously hidden by the
"one giant component shares everything" anti-pattern (Agent C's PanelsManager
split caught three real bugs that way — FE H11/12/13). That means each slice
needs a live UI-pass to verify a) the dialog still opens with clean state, b)
re-opening doesn't carry stale data, c) the doc-upload chain still completes
end-to-end. Without that pass the splits are risky-looking refactors.

For now: this document is the executable plan. The 1D fetch→axios migration
that *did* land in this branch is the orthogonal piece of Sprint 2B-1D that
was safe to mechanize.
