-- Migration: Add Hybrid OCR Pipeline Support
-- Tables for storing canonical episode JSON and per-document OCR results

-- 1. Canonical Episodes — final merged JSON per patient
CREATE TABLE IF NOT EXISTS canonical_episodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ipd_id UUID REFERENCES ipds(id) ON DELETE CASCADE,
    episode_json JSONB NOT NULL DEFAULT '{}',
    schema_version VARCHAR(50) DEFAULT 'v1',
    completeness_score NUMERIC(5,2) DEFAULT 0,
    processing_status VARCHAR(20) DEFAULT 'pending'
        CHECK (processing_status IN ('pending', 'classifying', 'extracting', 'merging', 'completed', 'failed', 'partial')),
    processing_started_at TIMESTAMPTZ,
    processing_completed_at TIMESTAMPTZ,
    processing_cost_cents INTEGER DEFAULT 0,
    tier_summary JSONB DEFAULT '{}',
    error_log TEXT,
    triggered_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_canonical_episodes_modtime
    BEFORE UPDATE ON canonical_episodes
    FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

-- Only one active episode per patient (latest wins)
CREATE INDEX IF NOT EXISTS idx_canonical_episodes_ipd_id ON canonical_episodes(ipd_id);
CREATE INDEX IF NOT EXISTS idx_canonical_episodes_status ON canonical_episodes(processing_status)
    WHERE processing_status IN ('pending', 'classifying', 'extracting', 'merging');

-- 2. Per-document OCR results
CREATE TABLE IF NOT EXISTS ocr_document_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    canonical_episode_id UUID REFERENCES canonical_episodes(id) ON DELETE CASCADE,
    ipd_doc_id UUID REFERENCES ipd_doc(id) ON DELETE CASCADE,
    document_classification VARCHAR(50),
    classification_confidence NUMERIC(3,2),
    complexity VARCHAR(20),
    processing_tier VARCHAR(20)
        CHECK (processing_tier IN ('tier_1_tesseract', 'tier_2_gemini', 'tier_3_gpt4o', 'tier_4_photo')),
    extracted_text TEXT,
    extracted_json JSONB DEFAULT '{}',
    field_confidences JSONB DEFAULT '{}',
    processing_status VARCHAR(20) DEFAULT 'pending'
        CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'escalated')),
    cost_cents INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ocr_results_episode ON ocr_document_results(canonical_episode_id);
CREATE INDEX IF NOT EXISTS idx_ocr_results_doc ON ocr_document_results(ipd_doc_id);
