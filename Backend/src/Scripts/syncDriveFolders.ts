import { pool } from '../DB/db.js';
import S3Service from '../Services/s3.service.js';
import DriveHandler from '../Services/driveUploader.service.js';
import path from 'path';
import fs from 'fs';

const driveHandler = new DriveHandler();
const IS_DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY_LIMIT = 5;

const TEMP_DIR = path.resolve('temp_sync');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    size: string;
}

async function syncDriveFolders() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`DRIVE FOLDER SYNC ${IS_DRY_RUN ? '(DRY RUN)' : ''}`);
    console.log(`${'='.repeat(50)}\n`);

    let totalDiscovered = 0;
    let totalNew = 0;
    let totalUploaded = 0;
    let totalSkipped = 0;

    try {
        // 1. Fetch all IPDs with a drive_folder_id
        const ipdsResult = await pool.query(`
            SELECT id, drive_folder_id, hospital_id, panel_id, first_name, last_name
            FROM ipds 
            WHERE drive_folder_id IS NOT NULL AND drive_folder_id != ''
        `);

        const ipds = ipdsResult.rows;
        console.log(`Found ${ipds.length} IPDs with Drive folders.\n`);

        for (let idx = 0; idx < ipds.length; idx++) {
            const ipd = ipds[idx];
            const { id: ipdId, drive_folder_id, hospital_id, panel_id, first_name, last_name } = ipd;

            console.log(`\n--- [${idx + 1}/${ipds.length}] Patient: ${first_name} ${last_name || ''} (IPD: ${ipdId}) ---`);
            console.log(`   Drive Folder: ${drive_folder_id}`);

            // 2. Get existing ipd_doc records for this IPD (to check for duplicates)
            const existingDocsResult = await pool.query(
                `SELECT id, drive_link FROM ipd_doc WHERE ipd_id = $1`,
                [ipdId]
            );
            // Build a set of known Drive file IDs from existing records
            const knownDriveFileIds = new Set<string>();
            for (const doc of existingDocsResult.rows) {
                if (doc.drive_link) {
                    const match = doc.drive_link.match(/\/d\/([a-zA-Z0-9_-]+)|id=([a-zA-Z0-9_-]+)/);
                    if (match) {
                        knownDriveFileIds.add(match[1] || match[2]);
                    }
                }
            }

            // 3. List subfolders (type folders) in this Drive folder
            let subFolders: { id: string; name: string }[] = [];
            try {
                subFolders = await driveHandler.listSubFolders(drive_folder_id);
            } catch (e: any) {
                console.error(`   [ERROR] Cannot list subfolders for ${drive_folder_id}: ${e.message}`);
                continue;
            }

            // 4. Also check for files directly in the root folder (no subfolder)
            const sourcesToScan: { folderId: string; type: string }[] = [];

            // Root folder files → type = 'admission_files'
            sourcesToScan.push({ folderId: drive_folder_id, type: 'admission_files' });

            // Subfolder files → type = subfolder name
            for (const folder of subFolders) {
                sourcesToScan.push({ folderId: folder.id, type: folder.name });
            }

            // 5. Process each source
            for (const source of sourcesToScan) {
                let driveFiles: DriveFile[] = [];
                try {
                    driveFiles = await driveHandler.listFilesInFolder(source.folderId);
                } catch (e: any) {
                    console.error(`   [ERROR] Cannot list files in ${source.type} (${source.folderId}): ${e.message}`);
                    continue;
                }

                if (driveFiles.length === 0) continue;

                totalDiscovered += driveFiles.length;

                // Filter out already-known files
                const newFiles = driveFiles.filter(f => !knownDriveFileIds.has(f.id));
                const skippedCount = driveFiles.length - newFiles.length;
                totalSkipped += skippedCount;

                if (skippedCount > 0) {
                    console.log(`   [${source.type}] ${driveFiles.length} files found, ${skippedCount} already tracked, ${newFiles.length} NEW`);
                }
                if (newFiles.length === 0) continue;

                console.log(`   [${source.type}] ${newFiles.length} new files to sync`);
                totalNew += newFiles.length;

                // Process new files in chunks
                for (let i = 0; i < newFiles.length; i += CONCURRENCY_LIMIT) {
                    const chunk = newFiles.slice(i, i + CONCURRENCY_LIMIT);

                    const results = await Promise.all(
                        chunk.map(file => processNewFile(file, ipdId, hospital_id, panel_id, source.type))
                    );

                    totalUploaded += results.filter(r => r).length;
                }
            }
        }

        console.log(`\n${'='.repeat(50)}`);
        console.log(`SYNC COMPLETED`);
        console.log(`Total Files Discovered on Drive: ${totalDiscovered}`);
        console.log(`Already Tracked (Skipped): ${totalSkipped}`);
        console.log(`New Files Found: ${totalNew}`);
        console.log(`Successfully Uploaded to S3: ${totalUploaded}`);
        console.log(`${'='.repeat(50)}\n`);

        // Cleanup
        try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (e) { }

        process.exit(0);

    } catch (error) {
        console.error('Fatal Sync Error:', error);
        process.exit(1);
    }
}

async function processNewFile(
    file: DriveFile,
    ipdId: string,
    hospitalId: string,
    panelId: string,
    type: string
): Promise<boolean> {
    const driveLink = `https://drive.google.com/file/d/${file.id}/view`;
    const fileName = file.name.trim().replace(/\s+/g, '_');
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const mimeType = file.mimeType;
    const tempFilePath = path.join(TEMP_DIR, `${file.id}_${sanitizedFileName}`);

    if (IS_DRY_RUN) {
        const s3KeyPreview = `${hospitalId}/${panelId}/${ipdId}/${type}/${sanitizedFileName}`;
        console.log(`     [DRY RUN] NEW: ${file.name} (${mimeType}) -> ${s3KeyPreview}`);
        return true;
    }

    try {
        // Step 1: Insert record into ipd_doc
        const insertResult = await pool.query(
            `INSERT INTO ipd_doc (ipd_id, drive_link, type, file_name, mime_type, storage_provider, drive_backup_status)
             VALUES ($1, $2, $3, $4, $5, 'drive', 'completed')
             RETURNING id`,
            [ipdId, driveLink, type, file.name, mimeType]
        );
        const docId = insertResult.rows[0].id;

        // Step 2: Download from Drive
        try {
            await driveHandler.downloadToDisk(file.id, tempFilePath);
        } catch (err: any) {
            console.error(`     [ERROR] Download failed for ${file.name}: ${err.message}`);
            return false;
        }

        // Step 3: Get file size
        const stats = fs.statSync(tempFilePath);
        const fileSize = stats.size;

        if (fileSize === 0) {
            console.error(`     [ERROR] File size 0: ${file.name}`);
            fs.unlinkSync(tempFilePath);
            return false;
        }

        // Step 4: Upload to S3 with retry
        const s3Key = `${hospitalId}/${panelId}/${ipdId}/${type}/${sanitizedFileName}`;
        let s3Url = '';
        const MAX_RETRIES = 3;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const fileStream = fs.createReadStream(tempFilePath);
            try {
                const res = await S3Service.upload(s3Key, fileStream as any, mimeType, fileSize);
                s3Url = res.s3Url;
                fileStream.destroy();
                break;
            } catch (error: any) {
                fileStream.destroy();
                const isRateLimit = error.message.includes('reduce your request rate') || error.message.includes('SlowDown');
                if (attempt === MAX_RETRIES || !isRateLimit) {
                    throw error;
                }
                const delay = 1000 * Math.pow(2, attempt - 1);
                console.warn(`     [RETRY] Rate limit for ${file.name}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // Step 5: Cleanup temp file
        try { fs.unlinkSync(tempFilePath); } catch (e) { }

        // Step 6: Update ipd_doc with S3 info
        await pool.query(
            `UPDATE ipd_doc 
             SET s3_key = $1, 
                 s3_link = $2, 
                 storage_provider = 's3', 
                 file_size = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [s3Key, s3Url, fileSize, docId]
        );

        console.log(`     [SUCCESS] ${file.name} -> S3`);
        return true;

    } catch (error: any) {
        console.error(`     [ERROR] Failed ${file.name}: ${error.message}`);
        if (fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) { }
        }
        return false;
    }
}

syncDriveFolders();
