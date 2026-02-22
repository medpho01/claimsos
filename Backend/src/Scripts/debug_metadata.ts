import { pool } from '../DB/db.js';
import DriveHandler from '../Services/driveUploader.service.js';

const driveHandler = new DriveHandler();

async function checkMetadata() {
    // ID from the user's screenshot (partial match)
    // migrated_03fd86dc-83ca-4448-8b3a-20192576b623...
    // We will search for a record with this ID pattern

    console.log('Searching for record...');
    const res = await pool.query(`
        SELECT id, drive_link, s3_key, file_name, mime_type 
        FROM ipd_doc 
        WHERE id::text LIKE '03fd86dc%'
    `);

    if (res.rows.length === 0) {
        console.log('Record not found in DB.');
        process.exit(0);
    }

    const doc = res.rows[0];
    console.log('DB Record:', doc);

    if (!doc.drive_link) {
        console.log('No drive_link for this record.');
        process.exit(0);
    }

    const fileIdMatch = doc.drive_link.match(/\/d\/([a-zA-Z0-9_-]+)|id=([a-zA-Z0-9_-]+)/);
    const driveFileId = fileIdMatch ? (fileIdMatch[1] || fileIdMatch[2]) : null;

    if (!driveFileId) {
        console.log('Could not extract Drive ID');
        process.exit(0);
    }

    console.log(`Fetching metadata for Drive ID: ${driveFileId}`);
    const meta = await driveHandler.getFileMetadata(driveFileId);
    console.log('Drive Metadata Result:', meta);

    process.exit(0);
}

checkMetadata();
