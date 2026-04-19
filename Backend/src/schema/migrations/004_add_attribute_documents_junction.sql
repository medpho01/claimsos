-- Create junction table for 1:many relationship between attributes and documents
-- This allows hospital attributes to have multiple documents attached

-- 1. CREATE hospital_attribute_documents junction table
CREATE TABLE IF NOT EXISTS hospital.hospital_attribute_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospital.hospitals(id) ON DELETE CASCADE,
  hospital_attribute_id UUID NOT NULL REFERENCES hospital.hospital_attributes(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES hospital.hospital_documents(id) ON DELETE CASCADE,

  is_primary BOOLEAN DEFAULT FALSE,
  added_at TIMESTAMPTZ DEFAULT NOW(),

  -- Ensure we don't link the same document twice to the same attribute
  UNIQUE (hospital_attribute_id, document_id)
);

-- Create indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_attr_docs_hospital ON hospital.hospital_attribute_documents(hospital_id);
CREATE INDEX IF NOT EXISTS idx_attr_docs_attribute ON hospital.hospital_attribute_documents(hospital_attribute_id);
CREATE INDEX IF NOT EXISTS idx_attr_docs_document ON hospital.hospital_attribute_documents(document_id);
CREATE INDEX IF NOT EXISTS idx_attr_docs_primary ON hospital.hospital_attribute_documents(hospital_attribute_id, is_primary);

-- Add comments for clarity
COMMENT ON TABLE hospital.hospital_attribute_documents IS 'Junction table linking hospital attributes to documents in a 1:many relationship';
COMMENT ON COLUMN hospital.hospital_attribute_documents.is_primary IS 'Flag to mark the primary/main document for an attribute (for backward compatibility)';
COMMENT ON COLUMN hospital.hospital_attribute_documents.added_at IS 'Timestamp when the document was linked to this attribute';

-- 2. MIGRATE existing data from hospital_attributes.document_id to junction table
INSERT INTO hospital.hospital_attribute_documents (
  id,
  hospital_id,
  hospital_attribute_id,
  document_id,
  is_primary,
  added_at
)
SELECT
  gen_random_uuid(),
  ha.hospital_id,
  ha.id AS hospital_attribute_id,
  ha.document_id,
  TRUE AS is_primary,
  COALESCE(hd.created_at, NOW()) AS added_at
FROM hospital.hospital_attributes ha
LEFT JOIN hospital.hospital_documents hd ON ha.document_id = hd.id
WHERE ha.document_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 3. DROP the old document_id column from hospital_attributes
ALTER TABLE hospital.hospital_attributes DROP COLUMN IF EXISTS document_id;

-- Add comment to hospital_attributes explaining the relationship
COMMENT ON TABLE hospital.hospital_attributes IS 'Hospital attributes with flexible value types. Documents are linked via hospital_attribute_documents junction table (1:many relationship)';
