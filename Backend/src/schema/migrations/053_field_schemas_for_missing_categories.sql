-- ============================================================================
-- Wave 12 follow-up — field schemas for categories surfaced by the bundle
-- classifier that still had no schema and were being silently marked
-- extractor_model='no_schema' in document_sections.
-- ============================================================================
-- Diagnosed on the Vahid claim (05cf88cb-c7bd-4b33-8e47-25a1f52a05e6):
-- 23 of 33 sections were stamped no_schema because the bundle classifier
-- emitted the canonical category code (gps_tagged_patient_photos,
-- implant_sticker, etc.) but no row existed in document_field_schemas
-- for that code. Result: harmonised_episode.supporting_documents was
-- empty for every claim that touched these document types.
--
-- This migration seeds minimal field schemas (3-7 fields each) for the
-- ten missing categories. Most fields are optional because:
--   * Implant stickers / bills are often photographed in landscape with
--     printed labels — OCR catches some lines reliably (manufacturer,
--     model number) but not others (lot/expiry).
--   * Consent forms have huge layout variance across hospitals; we only
--     ask for the slots that travel.
--   * GPS-tagged photos carry mostly geotag metadata, not text.
--
-- Pairs with migration 052 which already flipped some of these to
-- extraction_mode='vision'. The extractor's per-category routing
-- (extraction_mode + categoryHint from master_options.description) is
-- unchanged; this migration only fixes the upstream "no schema → skip"
-- short-circuit at docExtractor.service.ts:410-438.

BEGIN;

-- ─── GPS-tagged patient photos ───────────────────────────────────────────
-- Layout: usually a single image with a corner overlay showing
-- timestamp + GPS coordinates + sometimes hospital name. The actual
-- patient image is the entire frame. We capture only the overlay
-- metadata; the photo itself is referenced via section.s3_key.
INSERT INTO hospital.document_field_schemas
    (doc_category,                field_key,             field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('gps_tagged_patient_photos', 'capture_timestamp',   'Photo Capture Timestamp',   'date',     false, NULL, 10),
    ('gps_tagged_patient_photos', 'gps_latitude',        'GPS Latitude',              'text',     false, NULL, 20),
    ('gps_tagged_patient_photos', 'gps_longitude',       'GPS Longitude',             'text',     false, NULL, 30),
    ('gps_tagged_patient_photos', 'hospital_name_in_photo','Hospital Name (overlay)', 'text',     false, NULL, 40),
    ('gps_tagged_patient_photos', 'photo_subject',       'Subject (patient/scar/site)','text',    false, NULL, 50)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Implant sticker (peeled label from box, taped to OT notes) ──────────
-- Standard joint-replacement / cardiac implant stickers carry:
-- manufacturer, model, lot/serial, size, expiry. Often photographed
-- multiple times per implant (front + back of sticker).
INSERT INTO hospital.document_field_schemas
    (doc_category,       field_key,         field_label,         field_type, is_required, enum_values, extraction_priority) VALUES
    ('implant_sticker',  'manufacturer',    'Manufacturer',      'text',     false, NULL, 10),
    ('implant_sticker',  'model_name',      'Model / Product Name','text',   false, NULL, 20),
    ('implant_sticker',  'catalog_number',  'Catalog / REF Number','text',   false, NULL, 30),
    ('implant_sticker',  'lot_number',      'Lot / Serial Number','text',    false, NULL, 40),
    ('implant_sticker',  'size_or_spec',    'Size / Specification','text',   false, NULL, 50),
    ('implant_sticker',  'expiry_date',     'Expiry Date',       'date',     false, NULL, 60),
    ('implant_sticker',  'sterilisation_method','Sterilisation Method','text',false, NULL, 70)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Implant bill (vendor invoice for the implant) ───────────────────────
-- Distinct from the sticker — this is the printed invoice from the
-- implant vendor (Stryker, Zimmer, Johnson & Johnson, Meril, etc.).
-- Carries the price the hospital paid + GST breakup.
INSERT INTO hospital.document_field_schemas
    (doc_category,    field_key,           field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('implant_bill',  'invoice_number',    'Invoice Number',            'text',     false, NULL, 10),
    ('implant_bill',  'invoice_date',      'Invoice Date',              'date',     false, NULL, 20),
    ('implant_bill',  'vendor_name',       'Vendor / Manufacturer',     'text',     false, NULL, 30),
    ('implant_bill',  'implant_description','Implant Description',      'text',     false, NULL, 40),
    ('implant_bill',  'catalog_number',    'Catalog / REF Number',      'text',     false, NULL, 50),
    ('implant_bill',  'lot_number',        'Lot / Batch Number',        'text',     false, NULL, 60),
    ('implant_bill',  'unit_price',        'Unit Price',                'money',    false, NULL, 70),
    ('implant_bill',  'gst_amount',        'GST Amount',                'money',    false, NULL, 80),
    ('implant_bill',  'total_amount',      'Total Amount',              'money',    false, NULL, 90)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Discharge summary (long-form variant; distinct from discharge_slip) ─
-- discharge_slip already exists (6 fields, short form). discharge_summary
-- is the multi-page narrative variant — admission notes, daily progress,
-- treatment given, condition at discharge, follow-up advice.
INSERT INTO hospital.document_field_schemas
    (doc_category,         field_key,                 field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('discharge_summary',  'admission_date',          'Admission Date',            'date',     true,  NULL, 10),
    ('discharge_summary',  'discharge_date',          'Discharge Date',            'date',     true,  NULL, 20),
    ('discharge_summary',  'primary_diagnosis',       'Primary Diagnosis',         'text',     true,  NULL, 30),
    ('discharge_summary',  'secondary_diagnoses',     'Secondary Diagnoses',       'text',     false, NULL, 40),
    ('discharge_summary',  'presenting_complaints',   'Presenting Complaints',     'text',     false, NULL, 50),
    ('discharge_summary',  'treatment_given',         'Treatment Given',           'text',     false, NULL, 60),
    ('discharge_summary',  'procedure_performed',     'Procedure Performed',       'text',     false, NULL, 70),
    ('discharge_summary',  'condition_at_discharge',  'Condition at Discharge',    'text',     false, NULL, 80),
    ('discharge_summary',  'follow_up_advice',        'Follow-up Advice',          'text',     false, NULL, 90),
    ('discharge_summary',  'treating_doctor',         'Treating Doctor',           'text',     false, NULL, 100),
    ('discharge_summary',  'discharge_medications',   'Discharge Medications',     'text',     false, NULL, 110)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Consent (generic — pre-existing anaesthesia_consent stays its own) ──
-- Bundle classifier emits 'consent' as a generic catch-all when it can't
-- distinguish surgery_consent_form vs anaesthesia_consent. Schema mirrors
-- the union of common consent fields without committing to a sub-type.
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key,             field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('consent',    'consent_date',        'Consent Date',              'date',     false, NULL, 10),
    ('consent',    'consent_type',        'Consent Type',              'enum',     false, '["surgery","anaesthesia","blood_transfusion","procedure","admission","general"]'::jsonb, 20),
    ('consent',    'procedure_described', 'Procedure Described',       'text',     false, NULL, 30),
    ('consent',    'patient_name',        'Patient Name',              'text',     false, NULL, 40),
    ('consent',    'signed_by',           'Signed By',                 'text',     false, NULL, 50),
    ('consent',    'relationship_to_patient','Relationship to Patient','text',     false, NULL, 60),
    ('consent',    'witness_name',        'Witness Name',              'text',     false, NULL, 70)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Pharmacy bill (in-hospital pharmacy itemised invoice) ───────────────
-- Multi-line invoices; we only capture header + totals. Line items live
-- in the original PDF and are referenced by section for audit.
INSERT INTO hospital.document_field_schemas
    (doc_category,     field_key,           field_label,             field_type, is_required, enum_values, extraction_priority) VALUES
    ('pharmacy_bill',  'bill_number',       'Bill / Invoice Number', 'text',     false, NULL, 10),
    ('pharmacy_bill',  'bill_date',         'Bill Date',             'date',     false, NULL, 20),
    ('pharmacy_bill',  'patient_name',      'Patient Name',          'text',     false, NULL, 30),
    ('pharmacy_bill',  'pharmacy_name',     'Pharmacy / Vendor Name','text',     false, NULL, 40),
    ('pharmacy_bill',  'gross_amount',      'Gross Amount',          'money',    false, NULL, 50),
    ('pharmacy_bill',  'discount_amount',   'Discount',              'money',    false, NULL, 60),
    ('pharmacy_bill',  'gst_amount',        'GST Amount',            'money',    false, NULL, 70),
    ('pharmacy_bill',  'net_amount',        'Net Amount Payable',    'money',    false, NULL, 80),
    ('pharmacy_bill',  'line_item_count',   'Number of Line Items',  'number',   false, NULL, 90)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── Identity proof (generic; distinct from aadhaar_card/ration_card) ────
-- Bundle classifier emits 'identity_proof' for non-Aadhaar/PAN identity
-- documents (passport, voter ID, driver's licence). Schema is type-aware.
INSERT INTO hospital.document_field_schemas
    (doc_category,     field_key,           field_label,           field_type, is_required, enum_values, extraction_priority) VALUES
    ('identity_proof', 'document_type',     'Identity Document Type','enum',   false, '["passport","voter_id","drivers_licence","pan_card","employee_id","other"]'::jsonb, 10),
    ('identity_proof', 'document_number',   'Document Number',     'text',     false, NULL, 20),
    ('identity_proof', 'holder_name',       'Holder Name',         'text',     false, NULL, 30),
    ('identity_proof', 'date_of_birth',     'Date of Birth',       'date',     false, NULL, 40),
    ('identity_proof', 'issuing_authority', 'Issuing Authority',   'text',     false, NULL, 50),
    ('identity_proof', 'expiry_date',       'Expiry Date',         'date',     false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── OT notes (intra-op surgical notes; distinct from ot_notes_and_photos) ─
-- ot_notes_and_photos already exists (6 fields). 'ot_notes' is the
-- variant where the bundle has the typed/written notes WITHOUT the
-- accompanying photos as one logical section.
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key,             field_label,                 field_type, is_required, enum_values, extraction_priority) VALUES
    ('ot_notes',   'surgery_date',        'Surgery Date',              'date',     true,  NULL, 10),
    ('ot_notes',   'procedure_performed', 'Procedure Performed',       'text',     true,  NULL, 20),
    ('ot_notes',   'surgeon',             'Surgeon',                   'text',     true,  NULL, 30),
    ('ot_notes',   'assistant_surgeons',  'Assistant Surgeon(s)',      'text',     false, NULL, 40),
    ('ot_notes',   'anaesthetist',        'Anaesthetist',              'text',     false, NULL, 50),
    ('ot_notes',   'duration_minutes',    'Duration (minutes)',        'number',   false, NULL, 60),
    ('ot_notes',   'anaesthesia_type',    'Anaesthesia Type',          'text',     false, NULL, 70),
    ('ot_notes',   'findings',            'Intra-op Findings',         'text',     false, NULL, 80),
    ('ot_notes',   'implants_used',       'Implants Used',             'text',     false, NULL, 90),
    ('ot_notes',   'complications',       'Intra-op Complications',    'text',     false, NULL, 100),
    ('ot_notes',   'blood_loss_ml',       'Estimated Blood Loss (ml)', 'number',   false, NULL, 110)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

-- ─── ABHA card (Ayushman Bharat Health Account ID) ───────────────────────
-- Central-government issued health ID; 14-digit ABHA number + ABHA
-- address (user@abdm). Usually a clean printed card.
INSERT INTO hospital.document_field_schemas
    (doc_category, field_key,         field_label,         field_type, is_required, enum_values, extraction_priority) VALUES
    ('abha_card',  'abha_number',     'ABHA Number (14 digits)','text', true,  NULL, 10),
    ('abha_card',  'abha_address',    'ABHA Address',      'text',     false, NULL, 20),
    ('abha_card',  'holder_name',     'Holder Name',       'text',     true,  NULL, 30),
    ('abha_card',  'date_of_birth',   'Date of Birth',     'date',     false, NULL, 40),
    ('abha_card',  'gender',          'Gender',            'enum',     false, '["male","female","other"]'::jsonb, 50),
    ('abha_card',  'issued_date',     'Issued Date',       'date',     false, NULL, 60)
ON CONFLICT (doc_category, field_key, schema_version) DO NOTHING;

COMMIT;
