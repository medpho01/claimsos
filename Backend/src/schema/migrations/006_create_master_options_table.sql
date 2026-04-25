-- Migration: Create Master Options Generic Dropdown Management System
-- Date: 2026-04-22
-- Description:
--   Creates a generic master_options table for managing all dropdown/select field values
--   Supports unlimited dropdown fields through category field (hospital_type, speciality, etc.)
--   Scalable alternative to creating separate master tables for each dropdown field
--   Includes seeding for hospital types and specialities (from hospitals.hospital_type column)

BEGIN;

-- ============================================================================
-- TABLE: master_options (GENERIC MASTER DATA)
-- ============================================================================
-- Generic table for storing all dropdown option values
-- Supports any number of dropdown fields through the 'category' field

CREATE TABLE IF NOT EXISTS hospital.master_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Category identifies which dropdown this option belongs to
    -- Examples: 'hospital_type', 'speciality', 'department', etc.
    category VARCHAR(100) NOT NULL,

    -- Unique identifier within the category
    -- Examples: 'cardiology', 'multi_specialty', 'neurology'
    code VARCHAR(100) NOT NULL,

    -- Display label shown in UI
    -- Examples: 'Cardiology', 'Multi-Specialty Hospital'
    label VARCHAR(255) NOT NULL,

    -- Optional description for admin reference
    description TEXT,

    -- Display order in dropdowns
    sort_order INT DEFAULT 999,

    -- Soft delete support (false = inactive/deleted)
    is_active BOOLEAN DEFAULT true,

    -- Audit timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),

    -- Constraints
    UNIQUE(category, code)
);

-- Create indexes for performance
CREATE INDEX idx_master_options_category ON hospital.master_options(category);
CREATE INDEX idx_master_options_active ON hospital.master_options(category, is_active);
CREATE INDEX idx_master_options_code ON hospital.master_options(category, code);

-- ============================================================================
-- SEED DATA: Hospital Types
-- ============================================================================
-- Seed the four standard hospital types

INSERT INTO hospital.master_options (category, code, label, description, sort_order)
VALUES
    ('hospital_type', 'single_specialty', 'Single Specialty Hospital', 'Specializing in one medical field', 10),
    ('hospital_type', 'multi_specialty', 'Multi-Specialty Hospital', 'Multiple medical specialties', 20),
    ('hospital_type', 'nursing_home', 'Nursing Home', 'Long-term care facility', 30),
    ('hospital_type', 'day_care_center', 'Day Care Center', 'Outpatient day care', 40)
ON CONFLICT (category, code) DO NOTHING;

-- ============================================================================
-- SEED DATA: Specialities
-- ============================================================================
-- Seed common medical specialities (50+ options)

INSERT INTO hospital.master_options (category, code, label, sort_order)
VALUES
    ('speciality', 'cardiology', 'Cardiology', 10),
    ('speciality', 'cardiothoracic_surgery', 'Cardiothoracic Surgery', 15),
    ('speciality', 'neurology', 'Neurology', 20),
    ('speciality', 'neurosurgery', 'Neurosurgery', 25),
    ('speciality', 'orthopedic', 'Orthopedic Surgery', 30),
    ('speciality', 'orthopedic_trauma', 'Orthopedic Trauma', 35),
    ('speciality', 'pediatrics', 'Pediatrics', 40),
    ('speciality', 'pediatric_surgery', 'Pediatric Surgery', 45),
    ('speciality', 'general_surgery', 'General Surgery', 50),
    ('speciality', 'gastroenterology', 'Gastroenterology', 55),
    ('speciality', 'hepatology', 'Hepatology', 60),
    ('speciality', 'oncology', 'Oncology', 65),
    ('speciality', 'medical_oncology', 'Medical Oncology', 70),
    ('speciality', 'radiation_oncology', 'Radiation Oncology', 75),
    ('speciality', 'hematology', 'Hematology', 80),
    ('speciality', 'pulmonology', 'Pulmonology/Chest Medicine', 85),
    ('speciality', 'nephrology', 'Nephrology', 90),
    ('speciality', 'rheumatology', 'Rheumatology', 95),
    ('speciality', 'endocrinology', 'Endocrinology', 100),
    ('speciality', 'infectious_diseases', 'Infectious Diseases', 105),
    ('speciality', 'ent', 'Ear, Nose & Throat (ENT)', 110),
    ('speciality', 'ophthalmology', 'Ophthalmology', 115),
    ('speciality', 'dermatology', 'Dermatology', 120),
    ('speciality', 'psychiatry', 'Psychiatry', 125),
    ('speciality', 'psychology', 'Psychology', 130),
    ('speciality', 'urology', 'Urology', 135),
    ('speciality', 'nephro_urology', 'Nephro-Urology', 140),
    ('speciality', 'obstetrics_gynecology', 'Obstetrics & Gynecology', 145),
    ('speciality', 'maternal_fetal_medicine', 'Maternal-Fetal Medicine', 150),
    ('speciality', 'reproductive_medicine', 'Reproductive Medicine', 155),
    ('speciality', 'anesthesiology', 'Anesthesiology', 160),
    ('speciality', 'critical_care', 'Critical Care/ICU', 165),
    ('speciality', 'emergency_medicine', 'Emergency Medicine', 170),
    ('speciality', 'trauma_surgery', 'Trauma Surgery', 175),
    ('speciality', 'radiology', 'Radiology/Imaging', 180),
    ('speciality', 'interventional_radiology', 'Interventional Radiology', 185),
    ('speciality', 'pathology', 'Pathology', 190),
    ('speciality', 'laboratory_medicine', 'Laboratory Medicine', 195),
    ('speciality', 'physical_medicine_rehabilitation', 'Physical Medicine & Rehabilitation', 200),
    ('speciality', 'orthopedic_rehabilitation', 'Orthopedic Rehabilitation', 205),
    ('speciality', 'neurology_rehabilitation', 'Neurology Rehabilitation', 210),
    ('speciality', 'sports_medicine', 'Sports Medicine', 215),
    ('speciality', 'occupational_health', 'Occupational Health', 220),
    ('speciality', 'preventive_medicine', 'Preventive Medicine', 225),
    ('speciality', 'dentistry', 'Dentistry', 230),
    ('speciality', 'oral_surgery', 'Oral & Maxillofacial Surgery', 235),
    ('speciality', 'prosthodontics', 'Prosthodontics', 240),
    ('speciality', 'pediatric_dentistry', 'Pediatric Dentistry', 245),
    ('speciality', 'ayurveda', 'Ayurveda', 250),
    ('speciality', 'homeopathy', 'Homeopathy', 255),
    ('speciality', 'naturopathy', 'Naturopathy', 260),
    ('speciality', 'unani', 'Unani', 265),
    ('speciality', 'siddha', 'Siddha', 270),
    ('speciality', 'nursing', 'Nursing', 275),
    ('speciality', 'physiotherapy', 'Physiotherapy', 280),
    ('speciality', 'pharmacology', 'Pharmacology', 285),
    ('speciality', 'public_health', 'Public Health', 290),
    ('speciality', 'nutrition', 'Nutrition & Dietetics', 295)
ON CONFLICT (category, code) DO NOTHING;

-- ============================================================================
-- VERIFICATION QUERIES (uncomment to verify after migration)
-- ============================================================================
-- SELECT COUNT(*) as total_options FROM hospital.master_options;
-- SELECT DISTINCT category FROM hospital.master_options;
-- SELECT * FROM hospital.master_options WHERE category = 'hospital_type' ORDER BY sort_order;
-- SELECT * FROM hospital.master_options WHERE category = 'speciality' ORDER BY sort_order;

COMMIT;
