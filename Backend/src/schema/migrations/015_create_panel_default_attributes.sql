-- Migration 015: panel_default_attributes table
-- Date: 2026-05-16
-- Description:
--   Stores the SOP-derived DEFAULT value for each (panel × attribute_definition)
--   pair. Used only to pre-fill panel_attributes when a hospital first enables
--   a panel (no runtime reads).
--
--   Polymorphic value columns mirror panel_attributes for direct copy.
--
--   Seeded by the SOP ingestion script (migration 016 onwards), which reads
--   the SOP Excel file and generates INSERTs.

BEGIN;

CREATE TABLE IF NOT EXISTS hospital.panel_default_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The (panel, attribute) pair this default applies to
  panel_id UUID NOT NULL REFERENCES hospital.panels(id) ON DELETE CASCADE,
  panel_attribute_definition_id UUID NOT NULL REFERENCES hospital.panel_attribute_definitions(id) ON DELETE CASCADE,

  -- Polymorphic default value (mirrors panel_attributes value columns)
  default_value_text TEXT,
  default_value_boolean BOOLEAN,
  default_value_date DATE,
  default_value_json JSONB,
  -- NOTE: no default_value_encrypted - secrets aren't seeded as defaults.

  -- Provenance
  source VARCHAR(50) NOT NULL DEFAULT 'sop_seed',  -- 'sop_seed' | 'manual'
  sop_version VARCHAR(20),
  seed_notes TEXT,                                  -- any context worth keeping
  seeded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (panel_id, panel_attribute_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_pda_panel ON hospital.panel_default_attributes(panel_id);
CREATE INDEX IF NOT EXISTS idx_pda_definition ON hospital.panel_default_attributes(panel_attribute_definition_id);

CREATE TRIGGER update_panel_default_attributes_modtime
  BEFORE UPDATE ON hospital.panel_default_attributes
  FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

COMMIT;
