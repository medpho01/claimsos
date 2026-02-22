import { pool } from '../DB/db.js';

async function checkCounts() {
    try {
        const resTotal = await pool.query('SELECT COUNT(*) FROM ipd_doc');
        console.log(`Total records: ${resTotal.rows[0].count}`);

        const resDrive = await pool.query('SELECT COUNT(*) FROM ipd_doc WHERE drive_link IS NOT NULL');
        console.log(`With drive_link: ${resDrive.rows[0].count}`);

        const resS3Null = await pool.query('SELECT COUNT(*) FROM ipd_doc WHERE s3_key IS NULL');
        console.log(`With s3_key IS NULL: ${resS3Null.rows[0].count}`);

        const resTarget = await pool.query('SELECT COUNT(*) FROM ipd_doc WHERE drive_link IS NOT NULL AND s3_key IS NULL');
        console.log(`Target records (drive_link set, s3_key null): ${resTarget.rows[0].count}`);

        // Check for empty strings just in case
        const resS3Empty = await pool.query("SELECT COUNT(*) FROM ipd_doc WHERE s3_key = ''");
        console.log(`With s3_key = '': ${resS3Empty.rows[0].count}`);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

checkCounts();
