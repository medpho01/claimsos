-- ============================================================================
-- MANUAL-RUN ONLY. NOT executed by the node-pg-migrate runner.
-- Apply with: psql -f PRODUCTION_SEED_DATA_MIGRATION.sql (review first).
-- Moved from migrations/ to data-seeds/ on 2026-05-14 (BE-review M21).
-- ============================================================================
-- ============================================================================
-- CLAIMSOS PRODUCTION SEED DATA MIGRATION
-- Date: April 27, 2026
-- Purpose: Insert seed data for attribute definitions and master options
-- Prerequisites: PRODUCTION_NEW_TABLES_SCRIPT.sql must be run first
-- ============================================================================

-- Run with: PGPASSWORD="your_password" psql -U postgres -h prod-db-host -d claimsos -f this_file.sql

BEGIN;

-- ============================================================================
-- 1. ATTRIBUTE DEFINITIONS (Hospital Attributes Catalog)
-- ============================================================================

INSERT INTO hospital.attribute_definitions (key, category, label, description, data_type, unit, requires_document, has_expiry, expected_issuing_authority, can_verify_by_image, is_mandatory_basic, is_mandatory_empanelment, sort_order, is_active)
VALUES
-- Accreditation Category
('accreditation.nabh.gold', 'accreditation', 'NABH GOLD', 'NABH Gold Certification', 'document', '', false, true, 'NABH', true, true, true, 2, true),
('accreditation.nabh_entry', 'accreditation', 'NABH', 'NABH Certification', 'document', '', true, true, 'NABH', false, false, false, 11, true),
('accreditation.jci', 'accreditation', 'JCI Accreditation', 'Joint Commission International', 'document', '', true, true, 'Joint Commission International', false, false, false, 12, true),
('accreditation.state_govt', 'accreditation', 'State Govt Registration', 'Registration certificate from State Health Department', 'document', '', true, true, '', false, true, true, 15, true),

-- Beds Category
('beds.general_wards_total', 'beds', 'General Ward Beds', 'Total number of general ward beds', 'integer', 'count', true, false, '', false, false, false, 50, true),
('beds.private_rooms', 'beds', 'Private Room Beds', 'Total number of private room beds', 'integer', 'count', true, false, '', false, true, false, 51, true),
('icu.icu_beds_total', 'beds', 'ICU Beds', 'Total number of Intensive Care Unit beds', 'integer', 'count', true, false, '', false, false, false, 60, true),
('beds.hdu', 'beds', 'HDU Beds', '', 'integer', 'Beds', true, false, '', false, false, false, 999, true),
('beds.sharing', 'beds', 'Sharing Beds', 'Number of Sharing Beds', 'integer', 'Beds', true, false, '', false, false, false, 999, true),

-- Compliance Category
('compliance_cert.fire_noc', 'compliance_cert', 'Fire NOC', 'No Objection Certificate from Fire Department', 'document', '', true, true, '', false, true, true, 20, true),
('compliance_cert.biomedical_waste', 'compliance_cert', 'Biomedical Waste Authorization', 'Authorization from State Pollution Control Board for biomedical waste handling', 'document', '', true, true, '', false, true, true, 21, true),
('compliance_cert.clinical_est_lic', 'compliance_cert', 'Clinical Establishment License', 'License under Clinical Establishments (Registration and Regulation) Act', 'document', '', true, true, '', false, true, true, 22, true),
('compliance_policy.infection_control', 'compliance_policy', 'Infection Control Policy', 'Documented hospital infection control policy', 'boolean', '', true, false, '', false, false, false, 30, true),
('compliance_policy.waste_management', 'compliance_policy', 'Waste Management System', 'Documented medical waste management and disposal system', 'boolean', '', true, false, '', false, false, false, 31, true),

-- Equipment Category
('icu.ventilators', 'equipment', 'Ventilators', 'Number of ventilators available', 'integer', 'count', false, false, '', false, false, false, 62, true),
('equipment.mri_machine', 'equipment', 'MRI Machine', 'Magnetic Resonance Imaging machine', 'boolean', '', false, false, '', false, false, false, 80, true),
('equipment.ct_scanner', 'equipment', 'CT Scanner', 'Computed Tomography Scanner', 'boolean', '', false, false, '', false, false, false, 81, true),
('equipment.ultrasound', 'equipment', 'Ultrasound Machine', 'Ultrasound diagnostic equipment', 'boolean', '', false, false, '', false, false, false, 82, true),

-- Images Category
('images.hospital.front', 'images', 'Hospital Front Image', 'Hospital Front Images', 'document', '', true, false, '', false, false, false, 0, true),
('images.emergency', 'images', 'Emergency Images', '', 'document', '', false, false, '', false, false, false, 999, true),
('images.equipment', 'images', 'Equipment Images', '', 'document', '', false, false, '', false, false, false, 999, true),
('images.icu', 'images', 'ICU images', '', 'document', '', false, false, '', false, false, false, 999, true),
('images.lab', 'images', 'Lab Images', '', 'document', '', false, false, '', false, false, false, 999, true),
('images.ot', 'images', 'OT Images', '', 'document', '', false, false, '', false, false, false, 999, true),
('images.private.ward', 'images', 'Private ward Images', '', 'document', '', false, false, '', false, false, false, 999, true),

-- Infrastructure Category
('infrastructure.ramp_availability', 'infrastructure', 'Ramp for Disabled Access', 'Wheelchair ramp or accessible entry for disabled patients — verifiable by photo', 'boolean', '', false, false, '', true, false, false, 40, true),
('infrastructure.lift_available', 'infrastructure', 'Elevator/Lift Access', 'Functional elevator for patient movement between floors', 'boolean', '', true, false, '', true, false, false, 41, true),
('infrastructure.backup_power', 'infrastructure', 'Backup Power Generator', 'Backup power generation facility for uninterrupted operations', 'boolean', '', false, false, '', true, false, false, 43, true),

-- Lab Category
('lab.blood_bank', 'lab', 'Blood Bank', 'In-house blood bank facility', 'boolean', '', true, false, '', false, false, false, 90, true),
('lab.biochemistry_lab', 'lab', 'Biochemistry Lab', 'Laboratory for biochemical tests', 'boolean', '', true, false, '', false, false, false, 91, true),

-- OT Category
('ot.minor', 'ot', 'Minor Operation Theatres', 'Number of minor OTs', 'integer', 'count', true, false, '', false, true, false, 70, true),
('ot.operation_theaters', 'ot', 'Operation Theaters', 'Total number of operational OTs', 'integer', 'count', true, false, '', false, true, false, 70, true),

-- Service Category
('service.cardiology', 'service', 'Cardiology Department', 'Cardiac care and intervention services', 'boolean', '', false, false, '', false, false, false, 100, true),
('service.pediatrics', 'service', 'Pediatrics Department', 'Pediatric care services', 'boolean', '', false, false, '', false, false, false, 102, true),
('service.emergency', 'service', 'Emergency Department', '24/7 Emergency care facility', 'boolean', '', true, false, '', false, false, false, 104, true),
('service.pharmacy', 'service', 'Pharmacy Department', '24/7 Pharmacy facility', 'boolean', '', true, false, '', false, false, false, 104, true),
('service.physiotherapy', 'service', 'Physiotherapy Department', 'Physiotherapy facility', 'boolean', '', true, false, '', false, false, false, 104, true),
('service.labour.room', 'service', 'Availability of labour rooms', 'Number of labour rooms', 'integer', 'Rooms', true, false, '', false, false, false, 999, true),

-- Tariff Category
('tariff.general_ward', 'tariff', 'General Ward Tariff', 'Tariff for general ward per night', 'integer', 'INR', false, false, '', false, false, false, 0, true),
('tariff.icu', 'tariff', 'ICU Tariff', 'Per day tariff for ICU ward', 'integer', 'INR/day', false, false, '', false, false, false, 999, true),
('tariff.others', 'tariff', 'Other Tariff Chrarges', 'Upload tariff charge sheet/document', 'document', '', false, false, '', false, false, false, 999, true),
('tariff.private', 'tariff', 'Tariff for Private Ward', 'Per day tariff for Private Ward', 'integer', 'INR/day', false, false, '', false, false, false, 999, true),
('tariff.semiprivate', 'tariff', 'Tariff for Semi Private ward', 'Per day tariff for semi private ward', 'integer', 'INR/day', false, false, '', false, false, false, 999, true)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- 2. MASTER OPTIONS (Dropdowns for Hospital Type & Specialties)
-- ============================================================================

INSERT INTO hospital.master_options (category, key, value, label, sort_order, is_active)
VALUES
-- Hospital Type Category
('hospital_type', 'single_specialty', 'single_specialty', 'Single Specialty Hospital', 10, true),
('hospital_type', 'multi_specialty', 'multi_specialty', 'Multi-Specialty Hospital', 20, true),
('hospital_type', 'nursing_home', 'nursing_home', 'Nursing Home', 30, true),
('hospital_type', 'day_care_center', 'day_care_center', 'Day Care Center', 40, true),
('hospital_type', 'super_speciality_1', 'super_speciality_1', 'Super Speciality', 50, true),

-- Speciality Category
('speciality', 'cardiology', 'cardiology', 'Cardiology', 10, true),
('speciality', 'cardiothoracic_surgery', 'cardiothoracic_surgery', 'Cardiothoracic Surgery', 15, true),
('speciality', 'neurology', 'neurology', 'Neurology', 20, true),
('speciality', 'neurosurgery', 'neurosurgery', 'Neurosurgery', 25, true),
('speciality', 'orthopedic', 'orthopedic', 'Orthopedic Surgery', 30, true),
('speciality', 'orthopedic_trauma', 'orthopedic_trauma', 'Orthopedic Trauma', 35, true),
('speciality', 'pediatrics', 'pediatrics', 'Pediatrics', 40, true),
('speciality', 'pediatric_surgery', 'pediatric_surgery', 'Pediatric Surgery', 45, true),
('speciality', 'general_surgery', 'general_surgery', 'General Surgery', 50, true),
('speciality', 'gastroenterology', 'gastroenterology', 'Gastroenterology', 55, true),
('speciality', 'hepatology', 'hepatology', 'Hepatology', 60, true),
('speciality', 'oncology', 'oncology', 'Oncology', 65, true),
('speciality', 'medical_oncology', 'medical_oncology', 'Medical Oncology', 70, true),
('speciality', 'radiation_oncology', 'radiation_oncology', 'Radiation Oncology', 75, true),
('speciality', 'hematology', 'hematology', 'Hematology', 80, true),
('speciality', 'pulmonology', 'pulmonology', 'Pulmonology/Chest Medicine', 85, true),
('speciality', 'nephrology', 'nephrology', 'Nephrology', 90, true),
('speciality', 'rheumatology', 'rheumatology', 'Rheumatology', 95, true),
('speciality', 'endocrinology', 'endocrinology', 'Endocrinology', 100, true),
('speciality', 'infectious_diseases', 'infectious_diseases', 'Infectious Diseases', 105, true),
('speciality', 'ent', 'ent', 'Ear, Nose & Throat (ENT)', 110, true),
('speciality', 'ophthalmology', 'ophthalmology', 'Ophthalmology', 115, true),
('speciality', 'dermatology', 'dermatology', 'Dermatology', 120, true),
('speciality', 'psychiatry', 'psychiatry', 'Psychiatry', 125, true),
('speciality', 'psychology', 'psychology', 'Psychology', 130, true),
('speciality', 'urology', 'urology', 'Urology', 135, true),
('speciality', 'nephro_urology', 'nephro_urology', 'Nephro-Urology', 140, true),
('speciality', 'obstetrics_gynecology', 'obstetrics_gynecology', 'Obstetrics & Gynecology', 145, true),
('speciality', 'maternal_fetal_medicine', 'maternal_fetal_medicine', 'Maternal-Fetal Medicine', 150, true),
('speciality', 'reproductive_medicine', 'reproductive_medicine', 'Reproductive Medicine', 155, true),
('speciality', 'anesthesiology', 'anesthesiology', 'Anesthesiology', 160, true),
('speciality', 'critical_care', 'critical_care', 'Critical Care/ICU', 165, true),
('speciality', 'emergency_medicine', 'emergency_medicine', 'Emergency Medicine', 170, true),
('speciality', 'trauma_surgery', 'trauma_surgery', 'Trauma Surgery', 175, true),
('speciality', 'radiology', 'radiology', 'Radiology/Imaging', 180, true),
('speciality', 'interventional_radiology', 'interventional_radiology', 'Interventional Radiology', 185, true),
('speciality', 'pathology', 'pathology', 'Pathology', 190, true),
('speciality', 'laboratory_medicine', 'laboratory_medicine', 'Laboratory Medicine', 195, true),
('speciality', 'physical_medicine_rehabilitation', 'physical_medicine_rehabilitation', 'Physical Medicine & Rehabilitation', 200, true),
('speciality', 'orthopedic_rehabilitation', 'orthopedic_rehabilitation', 'Orthopedic Rehabilitation', 205, true),
('speciality', 'neurology_rehabilitation', 'neurology_rehabilitation', 'Neurology Rehabilitation', 210, true),
('speciality', 'sports_medicine', 'sports_medicine', 'Sports Medicine', 215, true),
('speciality', 'occupational_health', 'occupational_health', 'Occupational Health', 220, true),
('speciality', 'preventive_medicine', 'preventive_medicine', 'Preventive Medicine', 225, true),
('speciality', 'dentistry', 'dentistry', 'Dentistry', 230, true),
('speciality', 'oral_surgery', 'oral_surgery', 'Oral & Maxillofacial Surgery', 235, true),
('speciality', 'prosthodontics', 'prosthodontics', 'Prosthodontics', 240, true),
('speciality', 'pediatric_dentistry', 'pediatric_dentistry', 'Pediatric Dentistry', 245, true),
('speciality', 'ayurveda', 'ayurveda', 'Ayurveda', 250, true),
('speciality', 'homeopathy', 'homeopathy', 'Homeopathy', 255, true),
('speciality', 'naturopathy', 'naturopathy', 'Naturopathy', 260, true),
('speciality', 'unani', 'unani', 'Unani', 265, true),
('speciality', 'siddha', 'siddha', 'Siddha', 270, true),
('speciality', 'nursing', 'nursing', 'Nursing', 275, true),
('speciality', 'physiotherapy', 'physiotherapy', 'Physiotherapy', 280, true),
('speciality', 'pharmacology', 'pharmacology', 'Pharmacology', 285, true),
('speciality', 'public_health', 'public_health', 'Public Health', 290, true),
('speciality', 'nutrition', 'nutrition', 'Nutrition & Dietetics', 295, true)
ON CONFLICT (category, key) DO NOTHING;

-- ============================================================================
-- 3. VERIFICATION
-- ============================================================================

-- Verify attribute definitions were inserted
SELECT
  'Attribute Definitions' as data_type,
  COUNT(*) as inserted_count
FROM hospital.attribute_definitions
WHERE created_at >= NOW() - INTERVAL '5 minutes';

-- Verify master options were inserted
SELECT
  'Master Options' as data_type,
  COUNT(*) as inserted_count
FROM hospital.master_options
WHERE created_at >= NOW() - INTERVAL '5 minutes';

COMMIT;

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================
-- If you see this, all seed data has been inserted successfully!
-- Total: 43 attribute definitions + 63 master options
-- ============================================================================
