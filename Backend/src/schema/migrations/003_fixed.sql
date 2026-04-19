-- Create hospital_profile entries for existing hospitals
BEGIN;

INSERT INTO hospital.hospital_profile 
  (hospital_id, legal_name, city)
SELECT 
  h.id,
  h.name,
  h.city
FROM hospital.hospitals h
WHERE NOT EXISTS (
  SELECT 1 FROM hospital.hospital_profile hp WHERE hp.hospital_id = h.id
)
ON CONFLICT (hospital_id) DO NOTHING;

COMMIT;
