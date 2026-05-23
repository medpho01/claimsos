-- ============================================================================
-- Wave 12 follow-up #2 — round-2 field schemas for categories the bundle
-- classifier picks on RE-RUNS but not on first runs.
-- ============================================================================
-- Discovered when re-analysing the Vahid claim (05cf88cb-...) after
-- migration 053 landed: the bundle classifier (Sonnet) is
-- non-deterministic across runs on the same source docs. The first run
-- chose `implant_sticker` / `consent` / `ot_notes` / `discharge_summary`;
-- the re-run chose `implant_barcode` / `surgery_consent_form` /
-- `ot_notes_and_photos` / `post_op_reports` for materially the same
-- content. This taxonomy churn means schema coverage has to be a SUPERSET
-- of what the LLM might emit, not just what it emitted last time.
--
-- This migration seeds 8 more category codes that surfaced on the
-- Vahid re-run. Each gets minimal but useful field coverage. Most
-- fields are optional because the source material (photos of stickers,
-- post-op selfies, etc.) carries thin structured data.
--
-- Companion to migration 053. Follow-up work tracked in the todo to
-- audit master_options for the COMPLETE candidate-category list the
-- classifier might emit, and seed schemas for the long tail.

BEGIN;

-- ─── Implant barcode (peeled barcode label from implant box) ─────────────
-- Subset of implant_sticker — the barcode-only variant where the photo
-- captures just the linear/2D barcode without the surrounding label.
-- We extract the barcode string + any visible reference number.
INSERT INTO hospital.document_field_schemas
    (doc_category,        field_key,          field_label,          field_type, is_required, enum_values, extraction_priority) VALUES
    ('implant_barcode',   'barcode_value',    'Barcode / GS1 Value','text',     false, NULL, 10),
    ('implant_barcode',   'manufacturer',     'Manufacturer',       'text',     false, NULL, 20),
    ('implant_barcode',   'catalog_number',   'Catalog / REF Number','text',    false, NULL, 30),
    ('implant_barcode',   'lot_number',       'Lot / Serial Number','text',     false, NULL, 40),
    ('implant_barcode',   'expiry_date',      'Expiry Date',        'date',     false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Implant invoice (printed vendor invoice — variant naming) ───────────
-- Bundle classifier sometimes emits `implant_invoice` instead of
-- `implant_bill` for the same vendor-invoice document type. Schema
-- mirrors implant_bill (migration 053) field-for-field.
INSERT INTO hospital.document_field_schemas
    (doc_category,      field_key,           field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('implant_invoice', 'invoice_number',    'Invoice Number',            'text',     false, NULL, 10),
    ('implant_invoice', 'invoice_date',      'Invoice Date',              'date',     false, NULL, 20),
    ('implant_invoice', 'vendor_name',       'Vendor / Manufacturer',     'text',     false, NULL, 30),
    ('implant_invoice', 'implant_description','Implant Description',      'text',     false, NULL, 40),
    ('implant_invoice', 'catalog_number',    'Catalog / REF Number',      'text',     false, NULL, 50),
    ('implant_invoice', 'lot_number',        'Lot / Batch Number',        'text',     false, NULL, 60),
    ('implant_invoice', 'unit_price',        'Unit Price',                'money',    false, NULL, 70),
    ('implant_invoice', 'gst_amount',        'GST Amount',                'money',    false, NULL, 80),
    ('implant_invoice', 'total_amount',      'Total Amount',              'money',    false, NULL, 90)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Implant photos (table-top photos of the actual implant) ─────────────
-- Photographs of the physical implant on a sterile surface — usually
-- taken in OT immediately before insertion. Minimal text overlay.
INSERT INTO hospital.document_field_schemas
    (doc_category,     field_key,             field_label,            field_type, is_required, enum_values, extraction_priority) VALUES
    ('implant_photos', 'capture_timestamp',   'Photo Capture Timestamp','date',   false, NULL, 10),
    ('implant_photos', 'implant_type',        'Implant Type (visible)','text',    false, NULL, 20),
    ('implant_photos', 'gps_latitude',        'GPS Latitude',         'text',     false, NULL, 30),
    ('implant_photos', 'gps_longitude',       'GPS Longitude',        'text',     false, NULL, 40),
    ('implant_photos', 'visible_markings',    'Visible Markings / Branding','text',false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── General patient photo (KYC / pre-op identity photo) ─────────────────
-- Generic patient-facing photograph — NOT the GPS-tagged operative
-- photo (gps_tagged_patient_photos). Used for identity confirmation,
-- patient-with-doctor photos, ward photos, etc.
INSERT INTO hospital.document_field_schemas
    (doc_category,           field_key,             field_label,         field_type, is_required, enum_values, extraction_priority) VALUES
    ('general_patient_photo','capture_timestamp',   'Photo Capture Timestamp','date',false, NULL, 10),
    ('general_patient_photo','photo_purpose',       'Photo Purpose',     'enum',     false, '["identity","with_doctor","ward","post_op","other"]'::jsonb, 20),
    ('general_patient_photo','visible_text',        'Visible Text / Overlay','text', false, NULL, 30),
    ('general_patient_photo','hospital_name_in_photo','Hospital Name (overlay)','text',false, NULL, 40)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Post-op reports (post-operative narrative reports) ──────────────────
-- Typed/written reports describing the surgical procedure outcome,
-- complications, post-op course. Closely related to discharge_summary
-- but specifically the surgical-outcome section.
INSERT INTO hospital.document_field_schemas
    (doc_category,      field_key,            field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('post_op_reports', 'surgery_date',       'Surgery Date',              'date',     false, NULL, 10),
    ('post_op_reports', 'procedure_performed','Procedure Performed',       'text',     false, NULL, 20),
    ('post_op_reports', 'surgeon',            'Surgeon',                   'text',     false, NULL, 30),
    ('post_op_reports', 'post_op_findings',   'Post-op Findings',          'text',     false, NULL, 40),
    ('post_op_reports', 'complications',      'Post-op Complications',     'text',     false, NULL, 50),
    ('post_op_reports', 'recovery_notes',     'Recovery / Course Notes',   'text',     false, NULL, 60),
    ('post_op_reports', 'follow_up_plan',     'Follow-up Plan',            'text',     false, NULL, 70)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Post-op photos (GPS-tagged scar / wound photos taken post-surgery) ──
-- Variant of gps_tagged_patient_photos specifically for post-surgical
-- documentation (scar photos for PMJAY surgical-discharge requirement).
INSERT INTO hospital.document_field_schemas
    (doc_category,     field_key,             field_label,            field_type, is_required, enum_values, extraction_priority) VALUES
    ('post_op_photos', 'capture_timestamp',   'Photo Capture Timestamp','date',   false, NULL, 10),
    ('post_op_photos', 'gps_latitude',        'GPS Latitude',         'text',     false, NULL, 20),
    ('post_op_photos', 'gps_longitude',       'GPS Longitude',        'text',     false, NULL, 30),
    ('post_op_photos', 'post_op_day',         'Post-op Day Number',   'number',   false, NULL, 40),
    ('post_op_photos', 'body_part_photographed','Body Part Photographed','text', false, NULL, 50),
    ('post_op_photos', 'hospital_name_in_photo','Hospital Name (overlay)','text',false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Surgery consent form (variant of generic consent) ───────────────────
-- Specific to surgical procedures. Bundle classifier prefers this over
-- the generic `consent` when it can read a procedure description.
INSERT INTO hospital.document_field_schemas
    (doc_category,           field_key,             field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('surgery_consent_form', 'consent_date',        'Consent Date',              'date',     false, NULL, 10),
    ('surgery_consent_form', 'procedure_planned',   'Planned Procedure',         'text',     false, NULL, 20),
    ('surgery_consent_form', 'surgeon_name',        'Surgeon Name',              'text',     false, NULL, 30),
    ('surgery_consent_form', 'patient_name',        'Patient Name',              'text',     false, NULL, 40),
    ('surgery_consent_form', 'signed_by',           'Signed By',                 'text',     false, NULL, 50),
    ('surgery_consent_form', 'relationship_to_patient','Relationship to Patient','text',     false, NULL, 60),
    ('surgery_consent_form', 'risks_discussed',     'Risks Discussed',           'text',     false, NULL, 70),
    ('surgery_consent_form', 'witness_name',        'Witness Name',              'text',     false, NULL, 80)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Others (catch-all for unclassifiable sections) ──────────────────────
-- The bundle classifier falls back to 'others' when nothing else fits.
-- We still want SOMETHING extracted so the section isn't just a black
-- box for the harmoniser. Minimal schema: just capture the visible
-- text / title and any dates.
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key,           field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('others',     'document_title',    'Visible Document Title',    'text',     false, NULL, 10),
    ('others',     'document_date',     'Document Date',             'date',     false, NULL, 20),
    ('others',     'visible_summary',   'Visible Summary / Key Text','text',     false, NULL, 30),
    ('others',     'apparent_purpose',  'Apparent Purpose',          'text',     false, NULL, 40)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

COMMIT;
