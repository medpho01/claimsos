import { pool } from '../DB/db.js';

async function checkDataSample() {
    try {
        console.log('--- Sample Record Check ---');
        // Get a few records that HAVE drive links
        const res = await pool.query(`
            SELECT id, drive_link, s3_key, storage_provider, type 
            FROM ipd_doc 
            WHERE drive_link IS NOT NULL 
            LIMIT 5
        `);
        console.table(res.rows);

        // Check specifically for admission type as per user sample
        const resAdm = await pool.query(`
            SELECT id, drive_link, s3_key, storage_provider 
            FROM ipd_doc 
            WHERE type = 'admission' AND drive_link IS NOT NULL 
            LIMIT 5
        `);
        console.log('\n--- Admission Sample ---');
        console.table(resAdm.rows);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

checkDataSample();
