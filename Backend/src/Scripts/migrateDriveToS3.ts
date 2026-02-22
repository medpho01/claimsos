import { pool } from '../DB/db.js';
import S3Service from '../Services/s3.service.js';
import DriveHandler from '../Services/driveUploader.service.js';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const driveHandler = new DriveHandler();
const MIGRATE_BATCH_SIZE = 100;

// Check for --dry-run flag
const IS_DRY_RUN = process.argv.includes('--dry-run');

// Ensure temp directory exists
const TEMP_DIR = path.resolve('temp_migration');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

async function migrateDriveToS3() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`STARTING DRIVE TO S3 MIGRATION ${IS_DRY_RUN ? '(DRY RUN)' : ''} (DISK BUFFER STRATEGY)`);
    console.log(`${'='.repeat(50)}\n`);

    try {
        let processedCount = 0;
        let successCount = 0;
        let hasMore = true;

        const query = `
            SELECT d.id, d.ipd_id, d.drive_link, d.type, d.file_name, d.mime_type, 
                   p.hospital_id, p.panel_id, p.first_name, p.last_name
            FROM ipd_doc d
            LEFT JOIN ipds p ON d.ipd_id = p.id
            WHERE d.drive_link IS NOT NULL 
              AND (d.s3_key IS NULL OR d.s3_key = '')
            LIMIT $1
        `;

        while (hasMore) {
            const result = await pool.query(query, [MIGRATE_BATCH_SIZE]);
            const files = result.rows;

            if (files.length === 0) {
                console.log('No more records found needing migration.');
                hasMore = false;
                break;
            }

            console.log(`Fetched batch of ${files.length} files...`);

            const CONCURRENCY_LIMIT = 10;
            for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
                const chunk = files.slice(i, i + CONCURRENCY_LIMIT);

                const results = await Promise.all(chunk.map(file => processFile(file)));

                results.forEach(success => {
                    processedCount++;
                    if (success) successCount++;
                });
            }

            console.log(`Batch complete. total processed: ${processedCount}, successful: ${successCount}`);

            if (IS_DRY_RUN) {
                console.log('[DRY RUN] Stopping after first batch analysis.');
                hasMore = false;
            } else {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        console.log(`\n${'='.repeat(50)}`);
        console.log(`MIGRATION COMPLETED`);
        console.log(`Total Processed: ${processedCount}`);
        console.log(`Successfully Migrated: ${successCount}`);
        console.log(`${'='.repeat(50)}\n`);

        // Cleanup temp dir
        try {
            fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        } catch (e) { console.error('Failed to cleanup temp dir', e); }

        process.exit(0);

    } catch (error) {
        console.error('Fatal Migration Error:', error);
        process.exit(1);
    }
}

async function processFile(file: any): Promise<boolean> {
    const { id, drive_link, mime_type, ipd_id, type } = file;

    // Fallback logic
    const hospital_id = file.hospital_id || 'unknown_hospital';
    const panel_id = file.panel_id || 'unknown_panel';
    const isOrphan = !file.hospital_id;

    let fileName = file.file_name || `migrated_${id}`;
    fileName = fileName.trim().replace(/\s+/g, '_');

    const tempFilePath = path.join(TEMP_DIR, `${id}_${fileName}`);

    try {
        const fileIdMatch = drive_link.match(/\/d\/([a-zA-Z0-9_-]+)|id=([a-zA-Z0-9_-]+)/);
        const driveFileId = fileIdMatch ? (fileIdMatch[1] || fileIdMatch[2]) : null;

        if (!driveFileId) {
            console.error(`[SKIP] ID ${id}: Invalid Drive Link (${drive_link})`);
            return false;
        }

        // Fetch Metadata from Drive
        let driveMetadata: any = null;
        try {
            driveMetadata = await driveHandler.getFileMetadata(driveFileId);
        } catch (e) {
            console.warn(`[WARN] Could not fetch metadata for ${id}, using defaults.`);
        }

        // If metadata is null, it likely means 404 (File Not Found)
        if (!driveMetadata) {
            console.error(`[SKIP] ID ${id}: File not found on Drive (404).`);
            // Optionally update DB to 'failed' or 'missing' state here if desired
            return false;
        }

        // Use Drive metadata if DB metadata is missing
        if (driveMetadata && driveMetadata.name) {
            fileName = driveMetadata.name;
        }

        // Basic cleanup of filename
        fileName = fileName.trim().replace(/\s+/g, '_');

        if (IS_DRY_RUN) {
            const s3KeyPreview = `${hospital_id}/${panel_id}/${ipd_id}/${type || 'other'}/${fileName}`;
            console.log(`[DRY RUN] Would migrate ID ${id} ${isOrphan ? '(ORPHAN)' : ''}:`);
            console.log(`   - Drive ID: ${driveFileId}`);
            console.log(`   - Name: ${fileName} (Original: ${driveMetadata?.name || 'N/A'})`);
            console.log(`   - Mime: ${driveMetadata?.mimeType || 'N/A'}`);
            console.log(`   - S3 Key: ${s3KeyPreview}`);
            return true;
        }

        console.log(`Migrating ID ${id} (Drive ID: ${driveFileId})...`);

        // DOWNLOAD TO DISK
        try {
            await driveHandler.downloadToDisk(driveFileId, tempFilePath);
        } catch (err: any) {
            console.error(`[ERROR] Download failed for ${id}:`, err.message);
            return false;
        }

        // Get file stats
        const stats = fs.statSync(tempFilePath);
        const fileSize = stats.size;

        if (fileSize === 0) {
            console.error(`[ERROR] File size is 0 for ${id}`);
            fs.unlinkSync(tempFilePath);
            return false;
        }

        // Create Stream (Removed - moved inside retry loop)
        // const fileStream = fs.createReadStream(tempFilePath);

        // Determine Mime Type (DB > Drive > Fallback)
        const finalMimeType = mime_type || driveMetadata?.mimeType || 'application/octet-stream';

        // Generate S3 Key (Custom for migration to preserve exact filename)
        const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const s3Key = `${hospital_id}/${panel_id}/${ipd_id}/${type || 'uncategorized'}/${sanitizedFileName}`;

        // Upload with Retry Logic
        let s3Url = '';
        const MAX_RETRIES = 3;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const fileStream = fs.createReadStream(tempFilePath);
            try {
                const res = await S3Service.upload(s3Key, fileStream as any, finalMimeType, fileSize);
                s3Url = res.s3Url;
                fileStream.destroy();
                break; // Success
            } catch (error: any) {
                fileStream.destroy();
                const isRateLimit = error.message.includes('reduce your request rate') || error.message.includes('SlowDown');

                if (attempt === MAX_RETRIES || !isRateLimit) {
                    throw error; // Give up
                }

                // Exponential Backoff: 1s, 2s, 4s...
                const delay = 1000 * Math.pow(2, attempt - 1);
                console.warn(`[RETRY] Rate limit for ${id}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        try { fs.unlinkSync(tempFilePath); } catch (e) { }

        // Update DB
        await pool.query(
            `UPDATE ipd_doc 
             SET s3_key = $1, 
                 s3_link = $2, 
                 storage_provider = 's3', 
                 drive_backup_status = 'completed',
                 file_name = $4,
                 file_size = $5,
                 mime_type = $6,
                 updated_at = NOW()
             WHERE id = $3`,
            [s3Key, s3Url, id, fileName, fileSize, finalMimeType]
        );

        console.log(`[SUCCESS] Migrated ${id} -> S3`);
        return true;

    } catch (error: any) {
        console.error(`[ERROR] Failed to migrate ${id}:`, error.message);
        // Try cleanup
        if (fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) { }
        }
        return false;
    }
}

migrateDriveToS3();
