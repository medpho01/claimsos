# ClaimOS Migration - Quick Reference Guide

## TL;DR - What You Need to Know ⚡

✅ **Your local database is READY TO USE**
- All production data already migrated
- Both Pragati & Ganga hospitals fully configured
- No additional migration scripts needed

---

## Quick Verification (60 seconds)

### Test 1: Verify Database Connection
```bash
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod -c "SELECT COUNT(*) as tables FROM information_schema.tables WHERE table_schema = 'hospital';"
```
**Expected Output:** `33` tables

### Test 2: Check Pragati Hospital
```bash
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod -c "SELECT name, (SELECT COUNT(*) FROM hospital.hospital_attributes WHERE hospital_id = hospitals.id) as attrs FROM hospital.hospitals WHERE name ILIKE '%pragati%';"
```
**Expected Output:** `30` attributes for Pragati Hospital

### Test 3: Check Ganga Hospital  
```bash
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod -c "SELECT name, (SELECT COUNT(*) FROM hospital.hospital_attributes WHERE hospital_id = hospitals.id) as attrs, (SELECT COUNT(*) FROM hospital.hospital_panels WHERE hospital_id = hospitals.id) as panels FROM hospital.hospitals WHERE name ILIKE '%ganga%';"
```
**Expected Output:** `24` attributes, `2` panels for Ganga Hospital

---

## Data Snapshot

### Pragati Hospital
```
ID:           9a16278c-5605-4116-b19e-d434716af27a
Attributes:   30 (all verified_manual)
Documents:    20
Panels:       0 (not needed)
Doctors:      0 (not needed)
Status:       ✅ COMPLETE
```

### Ganga Hospital
```
ID:           df2c60d6-d634-4697-a997-e9fd0f3b9960
Attributes:   24 (all verified)
Documents:    10
Panels:       2 (fully configured)
Doctors:      1 (fully configured)
Status:       ✅ COMPLETE
```

---

## Attribute Categories

Both hospitals have attributes in these categories:
- ✓ Accreditation (JCI, NABH, Registration)
- ✓ Beds (General, HDU, ICU, Private)
- ✓ Compliance (Waste, Licenses, Fire NOC)
- ✓ Equipment (CT, MRI, Ultrasound, Ventilators)
- ✓ Infrastructure (Power, Elevator, Disabled Access)
- ✓ Lab Services (Biochemistry, Blood Bank)
- ✓ Operation Theatres (Minor & Major)
- ✓ Services (Emergency, Cardiology, Pediatrics, Pharmacy, Physio)
- ✓ Images (Emergency, Equipment, Hospital, ICU, Lab, OT)
- ✓ Tariffs (General, ICU, Private, Semi-Private)

---

## All Tables Present ✅

33/33 tables exist:
- **Seed:** hospitals, profiles, users, definitions, master_options (7)
- **Hospital:** attributes, documents, key_contacts (6)
- **Panel:** panels, attributes, definitions, empanelments (5)
- **Doctor:** doctors, attributes, definitions, hospital_doctors (6)
- **Features:** share_tokens, verification, claims, ipds, etc. (9)

---

## What Works Right Now

✅ Hospital profile viewing (both hospitals)
✅ Hospital attributes display (30 & 24 attributes)
✅ Attribute verification status
✅ Document listing & download
✅ Panel management (Ganga)
✅ Doctor management (Ganga)
✅ Public hospital profiles
✅ Share tokens

⚠️ Document upload (needs S3 config)
⚠️ WhatsApp notifications (needs UltraMsg setup)

---

## File Locations

All migration analysis in:
```
Backend/src/schema/migrations/
├── MIGRATION_PLAN_2026-04-27.md        ← Full detailed plan
├── MIGRATION_SUMMARY_2026-04-27.md     ← Complete summary  
├── QUICK_REFERENCE.md                  ← This file
├── 006_verify_seed_data.sql            ← Run to verify seed data
├── 007_export_pragati_hospital.sql     ← Pragati data export
├── 008_export_ganga_hospital.sql       ← Ganga data export
└── 009_migration_status_report.sql     ← Full database report
```

---

## Common Tasks

### View Pragati Attributes
```bash
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
-c "SELECT ad.label, ad.category, ha.verification_status 
    FROM hospital.hospital_attributes ha
    JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
    WHERE ha.hospital_id = '9a16278c-5605-4116-b19e-d434716af27a'
    ORDER BY ad.category, ad.label"
```

### View Ganga Panels
```bash
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
-c "SELECT hp.name, COUNT(pa.id) as attributes, COUNT(pe.id) as empanelments
    FROM hospital.hospital_panels hp
    LEFT JOIN hospital.panel_attributes pa ON hp.id = pa.hospital_panel_id
    LEFT JOIN hospital.panel_empanelments pe ON hp.id = pe.hospital_panel_id
    WHERE hp.hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960'
    GROUP BY hp.id, hp.name"
```

### View Ganga Doctors
```bash
PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
-c "SELECT d.first_name, d.last_name, hd.employment_type, COUNT(da.id) as attributes
    FROM hospital.hospital_doctors hd
    JOIN hospital.doctors d ON hd.doctor_id = d.id
    LEFT JOIN hospital.doctor_attributes da ON d.id = da.doctor_id
    WHERE hd.hospital_id = 'df2c60d6-d634-4697-a997-e9fd0f3b9960'
    GROUP BY hd.id, d.id, d.first_name, d.last_name, hd.employment_type"
```

---

## If You Need to Reset

Backup your current DB:
```bash
PGPASSWORD="Abhishek@24" pg_dump -U postgres -h localhost finclarity_prod \
  > ~/claimsos_backup_2026-04-27.sql
```

Then you can safely test without worrying about data loss.

---

## Next Steps

1. **Start the backend:**
   ```bash
   cd Backend && npm install && npm start
   ```

2. **Start the frontend:**
   ```bash
   cd webapp && npm install && npm start
   ```

3. **Test in browser:**
   - Go to http://localhost:3000
   - Login with a hospital user account
   - Navigate to Pragati & Ganga hospitals
   - Verify attributes display correctly

4. **Run the diagnostics:**
   ```bash
   PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
     -f Backend/src/schema/migrations/006_verify_seed_data.sql
   ```

---

## Support

If something seems wrong:

1. **Check database integrity:**
   ```bash
   PGPASSWORD="Abhishek@24" psql -U postgres -h localhost -d finclarity_prod \
     -f Backend/src/schema/migrations/009_migration_status_report.sql
   ```

2. **Verify no missing data:**
   Check the "MIGRATION_SUMMARY_2026-04-27.md" for expected counts

3. **Review logs:**
   - Backend logs: `Backend/npm-debug.log`
   - Database logs: PostgreSQL logs
   - Browser console: Chrome DevTools

---

**Last Updated:** April 27, 2026  
**Status:** ✅ Ready for Development
