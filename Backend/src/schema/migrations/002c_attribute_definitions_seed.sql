-- Migration 002c: Seed attribute_definitions catalog
-- Run after: 002_core_new_tables_v2.sql
-- This is the full catalog of hospital attributes.
-- To add a new attribute type in future: INSERT a row here — NO MIGRATION NEEDED.

BEGIN;

INSERT INTO attribute_definitions
  (key, category, label, description, data_type, unit, requires_document, has_expiry,
   expected_issuing_authority, can_verify_by_image, image_guidance,
   is_mandatory_basic, is_mandatory_empanelment, sort_order)
VALUES

-- ============================================================
-- ACCREDITATIONS
-- ============================================================
('accreditation.nabh_full',       'accreditation', 'NABH Full Accreditation',     'National Accreditation Board for Hospitals — Full', 'document', NULL, TRUE, TRUE, 'NABH', FALSE, NULL, FALSE, FALSE, 10),
('accreditation.nabh_entry',      'accreditation', 'NABH Entry Level',            'NABH Entry Level Certification', 'document', NULL, TRUE, TRUE, 'NABH', FALSE, NULL, FALSE, FALSE, 11),
('accreditation.jci',             'accreditation', 'JCI Accreditation',           'Joint Commission International', 'document', NULL, TRUE, TRUE, 'Joint Commission International', FALSE, NULL, FALSE, FALSE, 12),
('accreditation.nabl',            'accreditation', 'NABL Lab Accreditation',      'National Accreditation Board for Testing and Calibration Laboratories', 'document', NULL, TRUE, TRUE, 'NABL', FALSE, NULL, FALSE, FALSE, 13),
('accreditation.cghs',            'accreditation', 'CGHS Empanelment',            'Central Government Health Scheme empanelment', 'document', NULL, TRUE, TRUE, 'CGHS', FALSE, NULL, FALSE, FALSE, 14),
('accreditation.state_govt',      'accreditation', 'State Govt Registration',     'Registration certificate from State Health Department', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 15),
('accreditation.min_of_health',   'accreditation', 'Ministry of Health',          'Central Ministry of Health and Family Welfare', 'document', NULL, TRUE, TRUE, 'MoHFW', FALSE, NULL, FALSE, FALSE, 16),
('accreditation.iso_9001',        'accreditation', 'ISO 9001 Certification',      'ISO 9001 Quality Management System', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, FALSE, FALSE, 17),

-- ============================================================
-- COMPLIANCE CERTIFICATES (regulatory, with expiry dates)
-- ============================================================
('compliance_cert.fire_noc',           'compliance_cert', 'Fire NOC',                     'No Objection Certificate from Fire Department', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 20),
('compliance_cert.biomedical_waste',   'compliance_cert', 'Biomedical Waste Authorization','Authorization from State Pollution Control Board for biomedical waste handling', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 21),
('compliance_cert.clinical_est_lic',   'compliance_cert', 'Clinical Establishment License','License under Clinical Establishments (Registration and Regulation) Act', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 22),
('compliance_cert.pcpndt_license',     'compliance_cert', 'PCPNDT License',               'Pre-Conception and Pre-Natal Diagnostic Techniques Act license (if applicable)', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, FALSE, FALSE, 23),
('compliance_cert.lift_inspection',    'compliance_cert', 'Lift Inspection Certificate',  'Annual inspection certificate for passenger lifts from State Electrical Inspectorate', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, FALSE, FALSE, 24),
('compliance_cert.blood_bank_license', 'compliance_cert', 'Blood Bank License',           'License from Drug Controller for operating blood bank', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, FALSE, FALSE, 25),
('compliance_cert.pharmacy_license',   'compliance_cert', 'Pharmacy License',             'Drug license for operating in-house pharmacy', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, FALSE, FALSE, 26),
('compliance_cert.water_test_report',  'compliance_cert', 'Water Quality Test Report',    'Recent water quality testing report from accredited lab', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, FALSE, FALSE, 27),
('compliance_cert.boiler_cert',        'compliance_cert', 'Boiler/Pressure Vessel Cert',  'Annual safety certificate for boilers and pressure vessels', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, FALSE, FALSE, 28),

-- ============================================================
-- COMPLIANCE POLICIES (internal — verifiable by document, no expiry)
-- ============================================================
('compliance_policy.infection_control',  'compliance_policy', 'Infection Control Policy',           'Documented hospital infection control policy', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 30),
('compliance_policy.waste_management',   'compliance_policy', 'Waste Management System',            'Documented medical waste management and disposal system', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 31),
('compliance_policy.hims',               'compliance_policy', 'Hospital Information Mgmt System',   'Hospital Information Management System operational', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 32),
('compliance_policy.coding_practices',   'compliance_policy', 'Medical Coding Practices',           'Coding practices followed: ICD 09, ICD 10, CPT, PCS or other', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 33),
('compliance_policy.record_archiving',   'compliance_policy', 'Record Storage and Archiving',       'Documented system for medical record storage and archiving', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 34),
('compliance_policy.tpa_connectivity',   'compliance_policy', 'TPA Online Connectivity',            'Capability to connect online with Insurer/TPA for pre-authorization and document submission', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, TRUE, 35),

-- ============================================================
-- INFRASTRUCTURE (physical — verifiable by image)
-- ============================================================
('infrastructure.generator_backup',  'infrastructure', 'Full Generator Back-up',         'Dedicated generator providing full hospital backup power', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of generator room showing nameplate with KVA capacity', FALSE, FALSE, 40),
('infrastructure.lift',              'infrastructure', 'Lifts Available',                 'Passenger/goods lifts accessible to patients', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of lift interior showing capacity plate and latest inspection certificate displayed', FALSE, FALSE, 41),
('infrastructure.ramp',              'infrastructure', 'Ramp Availability',               'Wheelchair-accessible ramp for patient mobility', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of ramp showing full length, slope, and handrails clearly', FALSE, FALSE, 42),
('infrastructure.parking_capacity',  'infrastructure', 'Parking Capacity',               'Number of vehicles the parking area can accommodate', 'integer', 'vehicles', FALSE, FALSE, NULL, TRUE, 'Upload photo of parking area with capacity signage visible', FALSE, FALSE, 43),
('infrastructure.central_gas',       'infrastructure', 'Central Gas Supply',             'Centralized medical gas supply system', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of central gas manifold/pipeline installation', FALSE, FALSE, 44),
('infrastructure.cssd',              'infrastructure', 'Central Sterile Services Dept',  'Dedicated CSSD for sterilization of surgical instruments', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of CSSD area with autoclave equipment visible', FALSE, FALSE, 45),
('infrastructure.air_conditioning',  'infrastructure', 'Fully Air-Conditioned',          'All patient areas are air-conditioned', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo showing AC units in ward/room', FALSE, FALSE, 46),
('infrastructure.kitchen_canteen',   'infrastructure', 'In-House Kitchen & Canteen',     'Dedicated in-house kitchen and patient/staff canteen', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of kitchen facility', FALSE, FALSE, 47),
('infrastructure.housekeeping',      'infrastructure', 'Housekeeping & Laundry',         'In-house housekeeping and laundry services', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of laundry facility', FALSE, FALSE, 48),
('infrastructure.fire_system',       'infrastructure', 'Fire Protection System',         'Installed fire protection system (sprinklers, fire extinguishers, fire panel)', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of fire panel/sprinkler heads/extinguisher locations', FALSE, FALSE, 49),
('infrastructure.water_purification','infrastructure', 'Water Purification & Filtration','Water purification and filtration system for potable water', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of water purification equipment', FALSE, FALSE, 50),
('infrastructure.gas_plant',         'infrastructure', 'Gas Plant/Boiler/Sterilizers',   'On-site gas plant, steam boiler, or industrial sterilizers', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of boiler/gas plant', FALSE, FALSE, 51),

-- In-house services
('in_house.blood_bank',   'in_house', 'Blood Bank',        'Licensed in-house blood bank', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of blood bank area', FALSE, FALSE, 55),
('in_house.ambulance',    'in_house', 'Ambulance',         'Hospital-operated ambulance service', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of ambulance', FALSE, FALSE, 56),
('in_house.pharmacy',     'in_house', 'In-House Pharmacy', 'Licensed in-house pharmacy', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 57),
('in_house.defibrillator','in_house', 'Defibrillator',     'Defibrillator(s) available', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Upload photo of defibrillator unit', FALSE, FALSE, 58),
('in_house.o2_supply',    'in_house', 'Oxygen Supply',     'Centralized or bedside oxygen supply', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 59),

-- ============================================================
-- BEDS
-- ============================================================
('beds.general_ward', 'beds', 'General Ward Beds',  NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, TRUE, TRUE, 60),
('beds.sharing',      'beds', 'Sharing Room Beds',  NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 61),
('beds.private',      'beds', 'Private Room Beds',  NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 62),
('beds.deluxe',       'beds', 'Deluxe Room Beds',   NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 63),
('beds.burns',        'beds', 'Burns Unit Beds',    NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 64),

-- ============================================================
-- ICU BEDS
-- ============================================================
('icu.micu',    'icu', 'MICU Beds (Medical ICU)',          NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 70),
('icu.iccu',    'icu', 'ICCU Beds (Cardiac Care)',         NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 71),
('icu.nicu',    'icu', 'NICU Beds (Neonatal)',             NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 72),
('icu.picu',    'icu', 'PICU Beds (Paediatric)',           NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 73),
('icu.neuro',   'icu', 'Neuro ICU Beds',                  NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 74),
('icu.sicu',    'icu', 'SICU Beds (Surgical)',             NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 75),

-- ============================================================
-- OT / EMERGENCY
-- ============================================================
('ot.emergency_room', 'ot', 'Emergency Room Beds',     NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 80),
('ot.trauma',         'ot', 'Trauma Bays',             NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 81),
('ot.minor_ot',       'ot', 'Minor OT',                NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 82),
('ot.major_ot',       'ot', 'Major OT',                NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 83),
('ot.cath_lab',       'ot', 'Cath Lab',                NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 84),

-- ============================================================
-- EQUIPMENT
-- ============================================================
('equipment.ventilator',          'equipment', 'Ventilator',             NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of ventilator equipment area', FALSE, FALSE, 90),
('equipment.c_arm',               'equipment', 'C-Arm',                  NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of C-Arm machine', FALSE, FALSE, 91),
('equipment.ct_scan',             'equipment', 'CT Scan',                NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of CT scanner', FALSE, FALSE, 92),
('equipment.mri',                 'equipment', 'MRI',                    NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of MRI machine', FALSE, FALSE, 93),
('equipment.pet_ct',              'equipment', 'PET CT',                 NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of PET CT machine', FALSE, FALSE, 94),
('equipment.angiography',         'equipment', 'Angiography Machine',    NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of angiography suite', FALSE, FALSE, 95),
('equipment.usg',                 'equipment', 'USG Machine',            NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, NULL, FALSE, FALSE, 96),
('equipment.echo',                'equipment', 'Echo Machine',           NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, NULL, FALSE, FALSE, 97),
('equipment.tmt',                 'equipment', 'TMT Machine',            NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 98),
('equipment.holter',              'equipment', 'Holter Monitor',         NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 99),
('equipment.iabp',                'equipment', 'IABP',                   'Intra-Aortic Balloon Pump', 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 100),
('equipment.linear_accelerator',  'equipment', 'Linear Accelerator',     NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of LINAC machine', FALSE, FALSE, 101),
('equipment.brachytherapy',       'equipment', 'Brachytherapy',          NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 102),
('equipment.gamma_knife',         'equipment', 'Gamma Knife',            NULL, 'integer', 'count', FALSE, FALSE, NULL, TRUE, 'Upload photo of Gamma Knife unit', FALSE, FALSE, 103),

-- ============================================================
-- LAB CAPABILITIES
-- ============================================================
('lab.hematology',       'lab', 'Hematology Lab',       NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 110),
('lab.biochemistry',     'lab', 'Biochemistry Lab',     NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 111),
('lab.pathology',        'lab', 'Pathology Lab',        NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 112),
('lab.microbiology',     'lab', 'Microbiology Lab',     NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 113),
('lab.virology',         'lab', 'Virology Lab',         NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 114),
('lab.serology',         'lab', 'Serology Lab',         NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 115),
('lab.immunology',       'lab', 'Immunology Lab',       NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 116),
('lab.histopathology',   'lab', 'Histopathology Lab',   NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 117),
('lab.cytology',         'lab', 'Cytology Lab',         NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 118),
('lab.genetics',         'lab', 'Genetics Lab',         NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 119),
('lab.radiology_xray',   'lab', 'X-Ray',                NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 120),
('lab.nuclear_medicine', 'lab', 'Nuclear Medicine',     NULL, 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 121),

-- ============================================================
-- STAFFING
-- ============================================================
('staffing.resident_doctors',  'staffing', 'Resident Doctors',       NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 130),
('staffing.specialists',       'staffing', 'Specialist Doctors',     NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 131),
('staffing.visiting',          'staffing', 'Visiting Consultants',   NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 132),
('staffing.nursing',           'staffing', 'Nursing Staff',          NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 133),
('staffing.paramedical',       'staffing', 'Paramedical Staff',      NULL, 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 134),

-- ============================================================
-- ROOM RENTS
-- ============================================================
('room_rent.general_ward', 'room_rent', 'General Ward Rate',   'Daily room rent for general ward', 'integer', 'INR/day', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 140),
('room_rent.sharing',      'room_rent', 'Sharing Room Rate',   'Daily room rent for sharing room', 'integer', 'INR/day', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 141),
('room_rent.private',      'room_rent', 'Private Room Rate',   'Daily room rent for private room', 'integer', 'INR/day', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 142),
('room_rent.deluxe',       'room_rent', 'Deluxe Room Rate',    'Daily room rent for deluxe room', 'integer', 'INR/day', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 143),
('room_rent.icu',          'room_rent', 'ICU Daily Rate',      'Daily charge for ICU bed', 'integer', 'INR/day', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 144),
('room_rent.iccu',         'room_rent', 'ICCU Daily Rate',     'Daily charge for ICCU bed', 'integer', 'INR/day', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 145),
('room_rent.nicu',         'room_rent', 'NICU Daily Rate',     'Daily charge for NICU bed', 'integer', 'INR/day', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 146)

ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  can_verify_by_image = EXCLUDED.can_verify_by_image,
  image_guidance = EXCLUDED.image_guidance,
  has_expiry = EXCLUDED.has_expiry,
  requires_document = EXCLUDED.requires_document,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

COMMIT;
