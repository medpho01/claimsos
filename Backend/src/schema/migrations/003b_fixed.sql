-- Set up Cashless Everywhere system as a default panel
BEGIN;

-- Create CE system panel if it doesn't exist
INSERT INTO hospital.panels (id, name)
VALUES ('00000000-0000-0000-0000-000000000001'::uuid, 'Cashless Everywhere')
ON CONFLICT DO NOTHING;

-- Auto-enroll all hospitals in Cashless Everywhere
INSERT INTO hospital.hospital_panels (hospital_id, panel_id)
SELECT h.id, '00000000-0000-0000-0000-000000000001'::uuid
FROM hospital.hospitals h
WHERE NOT EXISTS (
  SELECT 1 FROM hospital.hospital_panels hp 
  WHERE hp.hospital_id = h.id 
  AND hp.panel_id = '00000000-0000-0000-0000-000000000001'::uuid
)
ON CONFLICT DO NOTHING;

-- Create panel_empanelments for CE
INSERT INTO hospital.panel_empanelments 
  (hospital_panel_id, hospital_id, panel_id, empanelment_status, empanelment_type)
SELECT 
  hp.id,
  hp.hospital_id,
  hp.panel_id,
  'active',
  'cashless'
FROM hospital.hospital_panels hp
WHERE hp.panel_id = '00000000-0000-0000-0000-000000000001'::uuid
AND NOT EXISTS (
  SELECT 1 FROM hospital.panel_empanelments pe
  WHERE pe.hospital_panel_id = hp.id
)
ON CONFLICT (hospital_panel_id) DO NOTHING;

COMMIT;
