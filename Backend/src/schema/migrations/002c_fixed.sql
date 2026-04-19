-- Seed attribute_definitions catalog
BEGIN;

INSERT INTO hospital.attribute_definitions
  (key, category, label, description, data_type, unit, requires_document, has_expiry,
   expected_issuing_authority, can_verify_by_image, image_guidance,
   is_mandatory_basic, is_mandatory_empanelment, sort_order)
VALUES
-- ACCREDITATIONS
('accreditation.nabh_full',       'accreditation', 'NABH Full Accreditation',     'National Accreditation Board for Hospitals — Full', 'document', NULL, TRUE, TRUE, 'NABH', FALSE, NULL, FALSE, FALSE, 10),
('accreditation.nabh_entry',      'accreditation', 'NABH Entry Level',            'NABH Entry Level Certification', 'document', NULL, TRUE, TRUE, 'NABH', FALSE, NULL, FALSE, FALSE, 11),
('accreditation.jci',             'accreditation', 'JCI Accreditation',           'Joint Commission International', 'document', NULL, TRUE, TRUE, 'Joint Commission International', FALSE, NULL, FALSE, FALSE, 12),
('accreditation.state_govt',      'accreditation', 'State Govt Registration',     'Registration certificate from State Health Department', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 15),
-- COMPLIANCE CERTIFICATES
('compliance_cert.fire_noc',           'compliance_cert', 'Fire NOC',                     'No Objection Certificate from Fire Department', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 20),
('compliance_cert.biomedical_waste',   'compliance_cert', 'Biomedical Waste Authorization','Authorization from State Pollution Control Board for biomedical waste handling', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 21),
('compliance_cert.clinical_est_lic',   'compliance_cert', 'Clinical Establishment License','License under Clinical Establishments (Registration and Regulation) Act', 'document', NULL, TRUE, TRUE, NULL, FALSE, NULL, TRUE, TRUE, 22),
-- COMPLIANCE POLICIES
('compliance_policy.infection_control',  'compliance_policy', 'Infection Control Policy',           'Documented hospital infection control policy', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 30),
('compliance_policy.waste_management',   'compliance_policy', 'Waste Management System',            'Documented medical waste management and disposal system', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 31),
('compliance_policy.tpa_connectivity',   'compliance_policy', 'TPA Online Connectivity',            'Capability to connect online with Insurer/TPA for pre-authorization', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, TRUE, 35),
-- INFRASTRUCTURE
('infrastructure.ramp_availability',     'infrastructure', 'Ramp for Disabled Access',     'Wheelchair ramp or accessible entry for disabled patients — verifiable by photo', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Take clear photo of ramp at main entrance', FALSE, FALSE, 40),
('infrastructure.lift_available',        'infrastructure', 'Elevator/Lift Access',         'Functional elevator for patient movement between floors', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Photo of working elevator', FALSE, FALSE, 41),
('infrastructure.backup_power',          'infrastructure', 'Backup Power Generator',       'Backup power generation facility for uninterrupted operations', 'boolean', NULL, FALSE, FALSE, NULL, TRUE, 'Photo of generator and maintenance records', FALSE, FALSE, 43),
-- BEDS
('beds.general_wards_total',      'beds', 'General Ward Beds',          'Total number of general ward beds', 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 50),
('beds.private_rooms',            'beds', 'Private Room Beds',          'Total number of private room beds', 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 51),
-- ICU
('icu.icu_beds_total',            'icu', 'ICU Beds',                  'Total number of Intensive Care Unit beds', 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 60),
('icu.ventilators',               'icu', 'Ventilators',               'Number of ventilators available', 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 62),
-- OT
('ot.operation_theaters',         'ot', 'Operation Theaters',         'Total number of operational OTs', 'integer', 'count', FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 70),
-- EQUIPMENT
('equipment.mri_machine',         'equipment', 'MRI Machine',                'Magnetic Resonance Imaging machine', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 80),
('equipment.ct_scanner',          'equipment', 'CT Scanner',                 'Computed Tomography Scanner', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 81),
('equipment.ultrasound',          'equipment', 'Ultrasound Machine',         'Ultrasound diagnostic equipment', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 82),
-- LAB SERVICES
('lab.blood_bank',                'lab', 'Blood Bank',                 'In-house blood bank facility', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 90),
('lab.biochemistry_lab',          'lab', 'Biochemistry Lab',           'Laboratory for biochemical tests', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 91),
-- SPECIALIST SERVICES
('service.cardiology',            'service', 'Cardiology Department',     'Cardiac care and intervention services', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 100),
('service.pediatrics',            'service', 'Pediatrics Department',     'Pediatric care services', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 102),
('service.emergency',             'service', 'Emergency Department',      '24/7 Emergency care facility', 'boolean', NULL, FALSE, FALSE, NULL, FALSE, NULL, FALSE, FALSE, 104)
ON CONFLICT (key) DO NOTHING;

COMMIT;
