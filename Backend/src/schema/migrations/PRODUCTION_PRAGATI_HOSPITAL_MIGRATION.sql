-- ============================================================================
-- CLAIMSOS PRAGATI HOSPITAL DATA MIGRATION
-- Date: April 27, 2026
-- Hospital ID: 309ae4b9-846d-44ed-8ce4-d37c16c2d649
-- Data: 30 attributes + 20 documents + profile
-- Prerequisites: PRODUCTION_NEW_TABLES_SCRIPT.sql & PRODUCTION_SEED_DATA_MIGRATION.sql
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. VERIFY PRAGATI HOSPITAL EXISTS (in existing hospitals table)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hospital.hospitals WHERE id = '309ae4b9-846d-44ed-8ce4-d37c16c2d649') THEN
    RAISE EXCEPTION 'Pragati Hospital not found in hospitals table. Hospital must exist before data migration.';
  END IF;
END $$;

-- ============================================================================
-- 2. HOSPITAL PROFILE FOR PRAGATI
-- ============================================================================

INSERT INTO hospital.hospital_profile (
  id, hospital_id, legal_name, city, state, pincode, website, phone,
  verification_level, is_public_profile_enabled,
  created_at, updated_at
) VALUES (
  'a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6'::uuid,
  '309ae4b9-846d-44ed-8ce4-d37c16c2d649',
  'Pragati Medcity and Stem Cell Centre',
  'Bhopal',
  'Madhya Pradesh',
  '462039',
  'https://pragatistemcells.com/',
  '9713086679',
  'verified',
  true,
  NOW(),
  NOW()
) ON CONFLICT (hospital_id) DO NOTHING;

-- ============================================================================
-- 3. HOSPITAL DOCUMENTS FOR PRAGATI (20 documents)
-- ============================================================================

INSERT INTO hospital.hospital_documents (
  id, hospital_id, document_category, document_type, document_name, s3_key, file_name, mime_type, created_at, updated_at
) VALUES
('b6b3ae30-e44d-4b9c-87bd-168261685e2a', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_cert', 'attribute_document', 'BMW certificate.pdf', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/compliance_cert/1776838986588_BMW certificate.pdf', 'BMW certificate.pdf', 'application/pdf', NOW(), NOW()),
('e94df827-b9b0-4592-b736-4ec244c1ad25', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'images', 'attribute_document', 'electricity.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/images/1776846113785_electricity.jpeg', 'electricity.jpeg', 'image/jpeg', NOW(), NOW()),
('f8691d8d-c66c-4235-87d9-0363a750a139', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service', 'attribute_document', 'Emergency.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/service/1776846173293_Emergency.jpeg', 'Emergency.jpeg', 'image/jpeg', NOW(), NOW()),
('31985282-ac74-40b2-87f5-d63ea3320636', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'images', 'attribute_document', 'Equipment.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/images/1776846112099_Equipment.jpeg', 'Equipment.jpeg', 'image/jpeg', NOW(), NOW()),
('7ffc1442-a044-4a0f-b45e-3c9878838f5a', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_cert', 'attribute_document', 'firequipment.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/compliance_cert/1776846144871_firequipment.jpeg', 'firequipment.jpeg', 'image/jpeg', NOW(), NOW()),
('c169537b-049a-43e5-84e6-57931cbb0479', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'accreditation', 'attribute_document', 'hospital licence.pdf', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/accreditation/1776838743638_hospital licence.pdf', 'hospital licence.pdf', 'application/pdf', NOW(), NOW()),
('745c6ae7-838d-4a5f-b3b1-a2d1a5627345', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_cert', 'attribute_document', 'hospital licence.pdf', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/compliance_cert/1776839046521_hospital licence.pdf', 'hospital licence.pdf', 'application/pdf', NOW(), NOW()),
('8385cfd4-9f0a-4044-bd8a-13d29432ddde', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'accreditation', 'attribute_document', 'hospital registeration.pdf', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/accreditation/1776838817086_hospital registeration.pdf', 'hospital registeration.pdf', 'application/pdf', NOW(), NOW()),
('0f040859-62f1-4942-9673-2b0a742a9a50', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'images', 'attribute_document', 'Hospital1.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/images/1776846017969_Hospital1.jpeg', 'Hospital1.jpeg', 'image/jpeg', NOW(), NOW()),
('08fc3a6b-a513-470a-afa9-131856864280', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'images', 'attribute_document', 'Hospital2.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/images/1776846019678_Hospital2.jpeg', 'Hospital2.jpeg', 'image/jpeg', NOW(), NOW()),
('bf2cb089-fe6f-4bbe-bd96-1b4f8d0b7185', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'images', 'attribute_document', 'HospitalF.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/images/1776846014768_HospitalF.jpeg', 'HospitalF.jpeg', 'image/jpeg', NOW(), NOW()),
('90822b43-ba42-4574-839b-5c4ea11f0ba6', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'beds', 'attribute_document', 'ICU.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/beds/1776846771219_ICU.jpeg', 'ICU.jpeg', 'image/jpeg', NOW(), NOW()),
('f230c55d-2602-4369-8a02-2b4b0188a022', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'lab', 'attribute_document', 'Lab1.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/lab/1776846798603_Lab1.jpeg', 'Lab1.jpeg', 'image/jpeg', NOW(), NOW()),
('76910e19-6835-4c89-bafa-deb2f3d0b8b2', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'ot', 'attribute_document', 'OT.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/ot/1776846890836_OT.jpeg', 'OT.jpeg', 'image/jpeg', NOW(), NOW()),
('bd108307-ba39-4da7-aa55-3c9e096ddce5', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'ot', 'attribute_document', 'OT1.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/ot/1776846892982_OT1.jpeg', 'OT1.jpeg', 'image/jpeg', NOW(), NOW()),
('ded3c6da-c77e-4bbc-bdc1-73ee3e66333a', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service', 'attribute_document', 'Pharmacy.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/service/1776846993722_Pharmacy.jpeg', 'Pharmacy.jpeg', 'image/jpeg', NOW(), NOW()),
('35e3b113-13c3-4342-b48a-c4e7b873bd56', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service', 'attribute_document', 'physiotherapy.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/service/1776846048992_physiotherapy.jpeg', 'physiotherapy.jpeg', 'image/jpeg', NOW(), NOW()),
('92973c87-2d61-4d22-a3c8-01558d5ab752', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_cert', 'attribute_document', 'PRAGATI MEDCITY & STEM CELL CENTRE. FIRE AUDIT.pdf', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/compliance_cert/1776838908348_PRAGATI MEDCITY & STEM CELL CENTRE. FIRE AUDIT.pdf', 'PRAGATI MEDCITY & STEM CELL CENTRE. FIRE AUDIT.pdf', 'application/pdf', NOW(), NOW()),
('4bf1bc62-0f54-48f5-870f-d8bbdfec2336', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'beds', 'attribute_document', 'Private.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/beds/1776846905328_Private.jpeg', 'Private.jpeg', 'image/jpeg', NOW(), NOW()),
('51a4951d-0a06-4142-86d5-b497bc15616c', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'tariff', 'attribute_document', 'tariff charges.pdf', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/tariff/1776844455505_tariff charges.pdf', 'tariff charges.pdf', 'application/pdf', NOW(), NOW()),
('2fe74af4-75c5-4f53-a666-ea6bff2023e6', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'lab', 'attribute_document', 'WhatsApp Image 2026-04-22 at 13.28.33.jpeg', 'hospitals/309ae4b9-846d-44ed-8ce4-d37c16c2d649/documents/lab/1776846795144_WhatsApp Image 2026-04-22 at 13.28.33.jpeg', 'WhatsApp Image 2026-04-22 at 13.28.33.jpeg', 'image/jpeg', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- 4. HOSPITAL ATTRIBUTES FOR PRAGATI (30 attributes)
-- ============================================================================

INSERT INTO hospital.hospital_attributes (
  id, hospital_id, attribute_key, value_text, value_date, value_boolean, value_integer,
  certificate_number, issuing_authority, issued_at, expires_at, verification_status, created_at, updated_at
) VALUES
('604cd67c-e798-44b0-8460-ad8a96502b3a', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'accreditation.state_govt', null, null, null, null, 'LL/9309/JUN-2023', null, '2023-06-16', '2026-03-31', 'verified_manual', NOW(), NOW()),
('633bd9be-8ed7-4b05-831f-20abfa5547bf', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'beds.general_wards_total', null, null, null, 5, null, null, null, null, 'verified_manual', NOW(), NOW()),
('c434581a-5fb9-4a4e-b179-243230c489fb', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'beds.private_rooms', null, null, null, 5, null, null, null, null, 'verified_manual', NOW(), NOW()),
('d5d35b18-76e7-461e-a54a-501fe12c47fe', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'beds.sharing', null, null, null, 2, null, null, null, null, 'verified_manual', NOW(), NOW()),
('ad3ec27e-754c-4419-9a72-1699e0ab1800', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_cert.biomedical_waste', null, null, null, null, '0492', null, '2026-01-01', '2026-12-31', 'verified_manual', NOW(), NOW()),
('62e6ae74-3599-4a70-a10e-43626316ddb4', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_cert.clinical_est_lic', null, null, null, null, 'LL/9309/JUN-2023', null, '2023-06-16', '2026-03-31', 'verified_manual', NOW(), NOW()),
('7d898497-2ee5-4d59-8712-5dca39820398', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_cert.fire_noc', null, null, null, null, 'REF N0- FIRE/HOS/112', null, '2026-02-22', '2027-02-21', 'verified_manual', NOW(), NOW()),
('b9fa9f3d-98aa-41a6-824c-c46ac5a548a5', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_policy.infection_control', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('2b2e4f83-1532-4f87-8b3f-ff7d54b41aee', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'compliance_policy.waste_management', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('fb74d018-14a3-4fde-8cfc-12cddc1951da', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'equipment.ultrasound', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('ee26751e-832a-40fc-971a-67e338eb5c4b', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'icu.icu_beds_total', null, null, null, 10, null, null, null, null, 'verified_manual', NOW(), NOW()),
('8fb43356-d7f8-4439-a845-5b48d858a51b', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'icu.ventilators', null, null, null, 1, null, null, null, null, 'verified_manual', NOW(), NOW()),
('2b11d66e-9cda-4618-83d8-50644534efb2', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'images.equipment', null, null, null, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('bf476200-8c75-4552-abb7-87c68d2cfe4a', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'images.hospital.front', null, null, null, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('406c2dc0-ae92-4166-8670-0aadcd495abe', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'infrastructure.backup_power', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('1090bd82-1a24-4267-9277-00200002db7f', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'infrastructure.lift_available', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('8c635a17-bdb7-49e1-a0d9-9662a92bf902', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'infrastructure.ramp_availability', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('28ac7ed0-76b6-434f-9478-67e2dc5163a3', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'lab.biochemistry_lab', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('b2332ba7-ebc9-462f-8951-bd909b8cb0ee', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'ot.minor', null, null, null, 1, null, null, null, null, 'verified_manual', NOW(), NOW()),
('df0e471a-f272-41bd-ba5e-98d3948c0cc0', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'ot.operation_theaters', null, null, null, 1, null, null, null, null, 'verified_manual', NOW(), NOW()),
('317c2231-7856-4920-9419-d30f67a85282', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service.emergency', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('94485038-37f9-42b8-843f-315be3b61de1', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service.labour.room', null, null, null, 1, null, null, null, null, 'verified_manual', NOW(), NOW()),
('199d09d6-a447-4ce0-a503-68aeaec88c51', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service.pediatrics', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('3e5343ae-f94a-441f-b177-c089bebbd580', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service.pharmacy', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('dccf6879-d074-4e20-8ec8-7adb16a2ed8f', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'service.physiotherapy', null, null, true, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('5d877ce5-e200-4dd1-9cf3-894edec1c593', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'tariff.general_ward', null, null, null, 1000, null, null, null, null, 'verified_manual', NOW(), NOW()),
('96076a67-a145-43a5-aba0-a37ed9409adc', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'tariff.icu', null, null, null, 4500, null, null, null, null, 'verified_manual', NOW(), NOW()),
('cfcfa2d3-9a50-407d-8ba5-c938e6eb6712', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'tariff.others', null, null, null, null, null, null, null, null, 'verified_manual', NOW(), NOW()),
('290b5c39-b719-424d-86e1-67d27ddafced', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'tariff.private', null, null, null, 3000, null, null, null, null, 'verified_manual', NOW(), NOW()),
('d567b6bb-c571-4601-bafb-ae865ef8b171', '309ae4b9-846d-44ed-8ce4-d37c16c2d649', 'tariff.semiprivate', null, null, null, 2000, null, null, null, null, 'verified_manual', NOW(), NOW())
ON CONFLICT (hospital_id, attribute_key) DO NOTHING;

-- ============================================================================
-- 5. LINK DOCUMENTS TO HOSPITAL ATTRIBUTES (20 links)
-- ============================================================================

INSERT INTO hospital.hospital_attribute_documents (
  hospital_attribute_id, document_id, is_primary
) VALUES
('ad3ec27e-754c-4419-9a72-1699e0ab1800', 'b6b3ae30-e44d-4b9c-87bd-168261685e2a', true),
('62e6ae74-3599-4a70-a10e-43626316ddb4', '745c6ae7-838d-4a5f-b3b1-a2d1a5627345', true),
('28ac7ed0-76b6-434f-9478-67e2dc5163a3', 'f230c55d-2602-4369-8a02-2b4b0188a022', false),
('28ac7ed0-76b6-434f-9478-67e2dc5163a3', '2fe74af4-75c5-4f53-a666-ea6bff2023e6', false),
('df0e471a-f272-41bd-ba5e-98d3948c0cc0', 'bd108307-ba39-4da7-aa55-3c9e096ddce5', false),
('df0e471a-f272-41bd-ba5e-98d3948c0cc0', '76910e19-6835-4c89-bafa-deb2f3d0b8b2', false),
('604cd67c-e798-44b0-8460-ad8a96502b3a', '8385cfd4-9f0a-4044-bd8a-13d29432ddde', false),
('cfcfa2d3-9a50-407d-8ba5-c938e6eb6712', '51a4951d-0a06-4142-86d5-b497bc15616c', true),
('bf476200-8c75-4552-abb7-87c68d2cfe4a', '08fc3a6b-a513-470a-afa9-131856864280', false),
('bf476200-8c75-4552-abb7-87c68d2cfe4a', '0f040859-62f1-4942-9673-2b0a742a9a50', false),
('bf476200-8c75-4552-abb7-87c68d2cfe4a', 'bf2cb089-fe6f-4bbe-bd96-1b4f8d0b7185', true),
('dccf6879-d074-4e20-8ec8-7adb16a2ed8f', '35e3b113-13c3-4342-b48a-c4e7b873bd56', true),
('2b11d66e-9cda-4618-83d8-50644534efb2', 'e94df827-b9b0-4592-b736-4ec244c1ad25', false),
('2b11d66e-9cda-4618-83d8-50644534efb2', '31985282-ac74-40b2-87f5-d63ea3320636', true),
('7d898497-2ee5-4d59-8712-5dca39820398', '7ffc1442-a044-4a0f-b45e-3c9878838f5a', false),
('7d898497-2ee5-4d59-8712-5dca39820398', '92973c87-2d61-4d22-a3c8-01558d5ab752', true),
('317c2231-7856-4920-9419-d30f67a85282', 'f8691d8d-c66c-4235-87d9-0363a750a139', false),
('ee26751e-832a-40fc-971a-67e338eb5c4b', '90822b43-ba42-4574-839b-5c4ea11f0ba6', false),
('c434581a-5fb9-4a4e-b179-243230c489fb', '4bf1bc62-0f54-48f5-870f-d8bbdfec2336', false),
('3e5343ae-f94a-441f-b177-c089bebbd580', 'ded3c6da-c77e-4bbc-bdc1-73ee3e66333a', true)
ON CONFLICT (hospital_attribute_id, document_id) DO NOTHING;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT 'PRAGATI HOSPITAL MIGRATION RESULTS' as status;

SELECT 'Hospital Profile' as item, COUNT(*) as count
FROM hospital.hospital_profile
WHERE hospital_id = '309ae4b9-846d-44ed-8ce4-d37c16c2d649';

SELECT 'Hospital Attributes' as item, COUNT(*) as count
FROM hospital.hospital_attributes
WHERE hospital_id = '309ae4b9-846d-44ed-8ce4-d37c16c2d649';

SELECT 'Hospital Documents' as item, COUNT(*) as count
FROM hospital.hospital_documents
WHERE hospital_id = '309ae4b9-846d-44ed-8ce4-d37c16c2d649';

SELECT 'Attribute-Document Links' as item, COUNT(*) as count
FROM hospital.hospital_attribute_documents had
JOIN hospital.hospital_attributes ha ON ha.id = had.hospital_attribute_id
WHERE ha.hospital_id = '309ae4b9-846d-44ed-8ce4-d37c16c2d649';

COMMIT;

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================
-- Pragati Hospital migration complete!
-- Profile: 1 | Attributes: 30 | Documents: 20 | Links: 20
-- ============================================================================
