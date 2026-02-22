import { pool } from '../DB/db.js';
import { S3Client, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { google } from 'googleapis';

const IS_DRY_RUN = process.argv.includes('--dry-run');

const s3Client = new S3Client({
    region: (process.env.AWS_REGION || 'ap-south-1').trim(),
    credentials: {
        accessKeyId: (process.env.AWS_ACCESS_KEY_ID || '').trim(),
        secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
    },
});
const bucket = (process.env.AWS_S3_BUCKET || 'hospital-app-images').trim();

// Google Drive auth
const auth = new google.auth.GoogleAuth({
    keyFile: 'drive.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

/**
 * Get the parent folder ID of a file on Drive
 */
async function getFileParent(fileId: string): Promise<string | null> {
    try {
        const res = await drive.files.get({
            fileId,
            fields: 'parents',
            supportsAllDrives: true,
        });
        return (res.data.parents && res.data.parents[0]) || null;
    } catch (e: any) {
        console.warn(`   [WARN] Cannot get parent for ${fileId}: ${e.message}`);
        return null;
    }
}

async function fixOthersToAdmissionFiles() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`FIX: Root Drive files "others" -> "admission_files" ${IS_DRY_RUN ? '(DRY RUN)' : ''}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
        // Find records with type='others' that have both drive_link and s3_key
        const result = await pool.query(`
            SELECT d.id, d.s3_key, d.s3_link, d.drive_link, d.ipd_id, p.drive_folder_id
            FROM ipd_doc d
            JOIN ipds p ON d.ipd_id = p.id
            WHERE d.type = 'others'
              AND d.s3_key IS NOT NULL
              AND d.s3_key LIKE '%/others/%'
              AND d.drive_link IS NOT NULL
        `);

        const records = result.rows;
        console.log(`Found ${records.length} records with type='others' to check.\n`);

        let movedCount = 0;
        let keptCount = 0;
        let errorCount = 0;

        for (let i = 0; i < records.length; i++) {
            const record = records[i];

            // Extract Drive file ID from drive_link
            const match = record.drive_link.match(/\/d\/([a-zA-Z0-9_-]+)|id=([a-zA-Z0-9_-]+)/);
            if (!match) {
                console.error(`[SKIP] ${record.id}: Invalid drive link`);
                errorCount++;
                continue;
            }
            const driveFileId = match[1] || match[2];

            // Check the file's parent on Drive
            const parentId = await getFileParent(driveFileId);

            if (!parentId) {
                console.warn(`[SKIP] ${record.id}: Cannot determine parent`);
                errorCount++;
                continue;
            }

            // If parent = IPD's root drive_folder_id → should be admission_files
            // If parent = something else (e.g., 'others' subfolder) → keep as 'others'
            if (parentId === record.drive_folder_id) {
                // This file is directly in the root → move to admission_files
                const oldKey = record.s3_key;
                const newKey = oldKey.replace('/others/', '/admission_files/');
                const newLink = record.s3_link?.replace('/others/', '/admission_files/') || '';

                if (IS_DRY_RUN) {
                    console.log(`[${i + 1}/${records.length}] MOVE: Root file → admission_files`);
                    console.log(`   ${oldKey} → ${newKey}`);
                    movedCount++;
                    continue;
                }

                try {
                    // Copy to new key
                    await s3Client.send(new CopyObjectCommand({
                        Bucket: bucket,
                        CopySource: `${bucket}/${oldKey}`,
                        Key: newKey,
                    }));

                    // Delete old key
                    await s3Client.send(new DeleteObjectCommand({
                        Bucket: bucket,
                        Key: oldKey,
                    }));

                    // Update DB
                    await pool.query(
                        `UPDATE ipd_doc 
                         SET s3_key = $1, s3_link = $2, type = 'admission_files', updated_at = NOW()
                         WHERE id = $3`,
                        [newKey, newLink, record.id]
                    );

                    console.log(`[${i + 1}/${records.length}] MOVED: ${oldKey}`);
                    movedCount++;
                } catch (error: any) {
                    console.error(`[ERROR] ${record.id}: ${error.message}`);
                    errorCount++;
                }
            } else {
                // This file is in a subfolder (e.g., "others" subfolder) → keep as is
                console.log(`[${i + 1}/${records.length}] KEEP: Subfolder file (parent: ${parentId})`);
                keptCount++;
            }
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`DONE`);
        console.log(`Moved to admission_files: ${movedCount}`);
        console.log(`Kept as others (subfolder): ${keptCount}`);
        console.log(`Errors/Skipped: ${errorCount}`);
        console.log(`${'='.repeat(60)}\n`);

        process.exit(0);
    } catch (error) {
        console.error('Fatal Error:', error);
        process.exit(1);
    }
}

fixOthersToAdmissionFiles();
