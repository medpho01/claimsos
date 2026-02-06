-- Migration: Add S3 Dual Storage Support
-- Run this migration to add system_settings table and update ipd_doc for S3 support

-- 1. Create system_settings table
CREATE TABLE IF NOT EXISTS system_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER update_system_settings_modtime BEFORE UPDATE ON system_settings FOR EACH ROW EXECUTE PROCEDURE update_modified_column();

-- 2. Insert default settings
INSERT INTO system_settings (setting_key, setting_value, description) VALUES
    ('s3_parallel_uploads', '5', 'Number of concurrent S3 uploads (1-10)'),
    ('storage_provider', 'both', 'Storage provider: drive, s3, or both'),
    ('primary_storage_read', 's3', 'Primary storage for reading files: drive or s3'),
    ('s3_enable_parallel', 'true', 'Enable parallel uploads to S3')
ON CONFLICT (setting_key) DO NOTHING;

-- 3. Add S3 columns to ipd_doc table
ALTER TABLE ipd_doc 
ADD COLUMN IF NOT EXISTS s3_key VARCHAR(500),
ADD COLUMN IF NOT EXISTS s3_url TEXT,
ADD COLUMN IF NOT EXISTS storage_provider VARCHAR(10) DEFAULT 'drive',
ADD COLUMN IF NOT EXISTS file_name VARCHAR(500),
ADD COLUMN IF NOT EXISTS file_size INTEGER,
ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100);

-- 4. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_ipd_doc_ipd_id ON ipd_doc(ipd_id);
CREATE INDEX IF NOT EXISTS idx_ipd_doc_storage_provider ON ipd_doc(storage_provider);

-- 5. Update existing records to have storage_provider='drive'
UPDATE ipd_doc SET storage_provider = 'drive' WHERE storage_provider IS NULL;
