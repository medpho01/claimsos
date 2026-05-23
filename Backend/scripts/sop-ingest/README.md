# SOP Ingestion

This script reads the **Cashless Everywhere SOP.xlsx** and generates an
idempotent SQL migration file that seeds:

- `hospital.panels` — the 47 TPA/insurer entities from Sheet 1
- `hospital.preauth_form_templates` — the 42 pre-auth PDF templates from Sheet 3
- `hospital.mou_templates` — the 11 MoU types from Sheet 4
- `hospital.panel_default_attributes` — the per-panel default values that
  pre-fill `panel_attributes` when a hospital enables a panel

## Prerequisites

```bash
pip3 install openpyxl
```

## Running

```bash
python3 Backend/scripts/sop-ingest/ingest.py \
  /path/to/Cashless\ Everywhere\ SOP.xlsx \
  Backend/src/schema/migrations/016_seed_sop_data.sql
```

## When to re-run

- The SOP file is updated (insurer changes their email, deadlines, etc.)
- A new TPA is added to Sheet 1

Re-running produces a new SQL file. Diff it against the previous run
(`git diff Backend/src/schema/migrations/016_seed_sop_data.sql`),
review changes, and commit a new migration (`017_seed_sop_data_v2.sql`)
with only the deltas — never overwrite a migration that's been applied
in production.

## Idempotency

Every generated INSERT uses `ON CONFLICT DO NOTHING` so the migration
is safe to re-run against a partially-seeded DB. The conflict keys are:

- `panels.code` (unique constraint)
- `preauth_form_templates.code` (unique constraint)
- `mou_templates.code` (unique constraint)
- `panel_default_attributes (panel_id, panel_attribute_definition_id)` (unique)

## What's NOT done by this script

1. **PDF binaries are not downloaded.** The `preauth_form_templates.s3_key`
   column is left NULL. A separate `download-forms.py` step (TBD) pulls
   the 42 PDFs from their `source_url` (krbusinesssolutions.in) into our
   S3 bucket and updates the rows.
2. **AcroForm field maps are not populated.** Analysts populate
   `preauth_form_templates.field_map` per PDF after ingest.
3. **Encrypted credentials are NEVER seeded.** Gmail OAuth and portal
   passwords are populated only via the application's OAuth/credential
   flows.

## Source-of-truth note

The SOP `.xlsx` file is the source of truth for the seed data. Once
ingested, the database becomes the runtime source of truth and the SOP
file becomes a reference document only. Hospitals can override any
default for their own panel via the panel-attribute editor UI.
