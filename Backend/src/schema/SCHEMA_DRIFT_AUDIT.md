# Schema Drift Audit — Sprint 1B

**Date:** May 2026 (live DB compared against `Backend/src/schema/migrations/*.sql` + runtime code)

## TL;DR

The "drift" the earlier reviews flagged was largely cosmetic. Real findings:

| Concern | Status | Action |
|---|---|---|
| Two `doctors` tables | Not real — single `hospital.doctors` table exists, code reads only that | None |
| Two doc tables | Intentional segmentation, not drift (see below) | None |
| `validator_*` / `verification_evidence` | Tables exist but zero runtime callers | Flagged for product decision |
| `audit_logs` writes never happened | Was wired but commented out | **Fixed in this commit** — login success / failure / logout now leave a trail |
| `user_refresh_tokens.device_id` | Missing column | **Fixed by migration 011** |

## Doc tables — intentional segmentation

```
doctor_doc                       — per-doctor file uploads (cv, profile)
hospital_doc                     — legacy single-doc-per-hospital (early)
hospital_documents               — newer per-attribute documents
panel_documents                  — legacy panel-level documents
ipd_doc                          — patient/admission documents
```

Junction tables (one row per (attribute, document) pair, NOT duplication):
```
hospital_attribute_documents
panel_attribute_documents
doctor_attribute_documents
```

This is the intentional storage shape, not drift. The four primary tables hold
the actual `s3_key` / `file_name` / etc.; the junction tables only carry
`{id, attribute_id, document_id, is_primary, document_type, added_at}`.

`hospital_doc` is the only true legacy holdover — it's referenced in early
migrations but not by current controllers. Could be deprecated, but is in a
follow-up.

## Validator system

`004_create_validator_verification_system.sql` created the table family but
**no service or controller references them at runtime.** Either the validator
feature ships (then we'd wire `Services/validator.service.ts` to read/write
these tables) or it doesn't (then migrations should drop them).

This is a product decision, not an engineering cleanup. Leaving the tables
in place — they're not referenced so they don't risk corruption, but they
do show up as dead-table noise in any schema audit.

## audit_logs

Migration 010 created the table with the canonical column set:
```
id user_id action entity_type entity_id details ip_address user_agent created_at
```

`Services/audit.service.ts` had the INSERT but every call site was commented
out. Wired now in `Controllers/auth.controller.ts`:

* `LOGIN_SUCCESS` — on successful login (role + username captured)
* `LOGIN_FAILED` — wrong username OR wrong password (separate `reason`)
* `LOGOUT`     — captures whether a refresh-token row was actually revoked

Follow-up hooks worth adding (deferred):
* `PATIENT_DELETE` (regulatory)
* `DOCTOR_SUSPEND` / `DOCTOR_VERIFY` (admin actions)
* `HOSPITAL_USER_ROLE_CHANGE` (privilege grants)

## device_id

Migration 011 adds `device_id UUID`, `user_agent TEXT`, `last_used_at TIMESTAMPTZ`
plus a partial-unique index on `(user_id, device_id)`. Refresh code still
runs in legacy-bcrypt-scan mode until `generateAccessToken` carries a
`deviceId` claim and login populates the column — separate change.
