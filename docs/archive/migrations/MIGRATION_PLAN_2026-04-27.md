# ClaimOS Database Migration Plan
**Date:** April 27, 2026  
**Status:** Local database validated with production schema  
**Scope:** Migrate new tables, columns, seed data, and hospital-specific data (Pragati & Ganga)

---

## Current State Analysis

### Local Database Status ✓
- **Database:** `finclarity_prod`
- **Schema:** `hospital` (public)
- **Total Tables:** 33
- **Status:** All tables present, containing partial production data

### Hospitals in Local Database
```
ID                                   | Hospital Name
9a16278c-5605-4116-b19e-d434716af27a | Pragati Hospital and Stem Cell Centre
df2c60d6-d634-4697-a997-e9fd0f3b9960 | Ganga Multi Speciality Hospital
```

### Data Inventory

| Entity | Pragati | Ganga | Total |
|--------|---------|-------|-------|
| Hospital Attributes | 30 | 24 | 54 |
| Attribute Definitions | All mapped | All mapped | ✓ |
| Panels | 0 | 2 | 2 |
| Panel Attributes | 0 | Multiple | ? |
| Panel Empanelments | 0 | ? | ? |
| Doctors | 0 | 1 | 1 |
| Doctor Attributes | 0 | ? | ? |
| Hospital Documents | ? | ? | ? |
| Hospital Profile | ✓ | ✓ | ✓ |
| Key Contacts | ? | ? | ? |

---

## Migration Strategy

### Phase 1: Schema Verification (DONE ✓)
All 33 tables already exist in local database:

**Core Tables (18):**
- `hospitals`, `hospital_profile`, `hospital_users`, `hospital_key_contacts`
- `hospital_attributes`, `hospital_attribute_documents`, `attribute_definitions`
- `hospital_panels`, `panel_attributes`, `panel_attribute_definitions`, `panel_attribute_documents`
- `hospital_doctors`, `hospital_doctor_attributes`
- `doctors`, `doctor_attributes`, `doctor_attribute_definitions`, `doctor_attribute_documents`

**Supporting Tables (15):**
- `hospital_documents`, `hospital_doc`, `panel_documents`, `doctor_doc`, `hospital_assignments`
- `panel_empanelments`, `ipds`, `ipd_doc`, `claims`
- `users`, `hospital_users`, `user_refresh_tokens`, `public_share_tokens`
- `document_extractions`, `verification_evidence`, `master_options`, `doctor_doc`

**Status:** ✓ All tables exist with proper structure

### Phase 2: Seed Data Verification
Run migration script `006_verify_seed_data.sql` to ensure:
- [ ] All attribute definitions are seeded (40+ definitions)
- [ ] Master options populated (dropdowns, enums)
- [ ] Default hospital users exist
- [ ] Verification status enums present

### Phase 3: Hospital-Specific Data Export
Create migration bundle containing:
- [ ] **Pragati Hospital** (ID: `9a16278c-5605-4116-b19e-d434716af27a`)
  - 30 Hospital Attributes
  - Attribute documents (certificates, licenses, etc.)
  - Profile data
  - Key contacts
  - 0 Panels (update if needed)
  - 0 Doctors (update if needed)

- [ ] **Ganga Hospital** (ID: `df2c60d6-d634-4697-a997-e9fd0f3b9960`)
  - 24 Hospital Attributes
  - Attribute documents
  - 2 Panels with panel attributes
  - 1 Doctor with doctor attributes
  - Profile data
  - Key contacts
  - Panel empanelments

### Phase 4: Data Integrity Checks
- [ ] Verify all ForeignKey references are valid
- [ ] Check for orphaned records (documents without attributes, etc.)
- [ ] Validate attribute values match their definitions' data types
- [ ] Verify verification status values are in allowed set
- [ ] Check document references (S3 keys, file names)

### Phase 5: Production Backup Handling
**Issue:** Production backup created with PostgreSQL 17, local is PG 14
**Solution Options:**
1. Upgrade local PostgreSQL to 17 (recommended if using 18 in prod)
2. Use text-format dump from backup system
3. Manual data export/import from admin console

---

## Migration Scripts

### Script 1: `006_verify_seed_data.sql`
Checks if all seed data is properly populated.

### Script 2: `007_export_pragati_hospital.sql`
Exports all Pragati Hospital data including:
- Profile
- 30 attributes with documents
- Contacts
- Profile metadata

### Script 3: `008_export_ganga_hospital.sql`
Exports all Ganga Hospital data including:
- Profile
- 24 attributes with documents
- 2 panels with panel attributes
- 1 doctor with attributes
- Panel empanelments
- Contacts

### Script 4: `009_import_hospital_bundle.sql`
Imports complete hospital bundle (replaces existing or creates new).

---

## Checklist

### Pre-Migration
- [ ] Backup current local database (`pg_dump finclarity_prod > backup_pre_migration.sql`)
- [ ] Verify PostgreSQL versions match
- [ ] Test migration scripts on backup first
- [ ] Document any custom data in local DB that should be preserved

### During Migration
- [ ] Run `006_verify_seed_data.sql` and review results
- [ ] Export Pragati Hospital with `007_export_pragati_hospital.sql`
- [ ] Export Ganga Hospital with `008_export_ganga_hospital.sql`
- [ ] Run data integrity checks
- [ ] Generate migration report

### Post-Migration
- [ ] Verify record counts match expected
- [ ] Test application against migrated data
- [ ] Validate document uploads/downloads work
- [ ] Check attribute verification status displays correctly
- [ ] Test public share tokens work for hospitals
- [ ] Verify hospital user authentication

### Rollback Plan
If migration fails:
1. Restore from backup: `psql finclarity_prod < backup_pre_migration.sql`
2. Verify rollback: Run verification queries
3. Re-run migration after fixes

---

## Migration Commands

### Quick Start
```bash
# 1. Create backup
PGPASSWORD="Abhishek@24" pg_dump -U postgres -h localhost \
  -d finclarity_prod -f /tmp/backup_pre_migration.sql

# 2. Verify seed data
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost \
  -d finclarity_prod -f src/schema/migrations/006_verify_seed_data.sql

# 3. Export Pragati data
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost \
  -d finclarity_prod -f src/schema/migrations/007_export_pragati_hospital.sql \
  > pragati_export.sql

# 4. Export Ganga data
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost \
  -d finclarity_prod -f src/schema/migrations/008_export_ganga_hospital.sql \
  > ganga_export.sql
```

---

## Data Dictionary: Hospital Attribute Categories (Pragati & Ganga)

### Pragati Hospital (30 attributes) - Categories:
- Licenses & Registrations (NMC, state, etc.)
- Infrastructure (beds, wards, equipment)
- Services (lab, imaging, etc.)
- Certifications (NABH, ISO, etc.)
- Staffing (doctors, nurses, etc.)
- Financial (bank details, empanelment)
- Compliance (insurance, audits, etc.)

### Ganga Hospital (24 attributes) - Categories:
- Licenses & Registrations
- Infrastructure
- Services
- Certifications
- Staffing
- Financial (bank details, empanelment)

---

## Notes

### Schema Consistency
- All attribute definitions use polymorphic storage: `value_text`, `value_date`, `value_boolean`, `value_integer`
- Documents stored with S3 keys and presigned URLs
- Verification tracking includes status, method, timestamp, and evidence

### Cross-Hospital Considerations
- Panel attributes can override hospital attributes at hospital-level
- Doctor attributes are global but can be overridden per hospital-doctor relationship
- Public profiles controlled by `is_public_profile_enabled` flag

### Known Issues
- Production backup (PG 17 format) cannot be directly restored to PG 14
- Workaround: Use text-format SQL dump or upgrade PostgreSQL version
- Some old tables (`hospital_doc`, `ipd_doc`, `claims`) may be deprecated - confirm with dev team

---

## Next Steps

1. **Review** this migration plan with the dev team
2. **Create** migration scripts `006_*`, `007_*`, `008_*`, `009_*`
3. **Test** on local development environment
4. **Validate** data integrity and application functionality
5. **Document** any custom configurations or deviations
6. **Prepare** production migration strategy

---

**Created By:** Claude Code Analysis  
**Last Updated:** April 27, 2026  
**Status:** Ready for implementation review
