import { pool } from '../DB/db.js';

async function checkRelations() {
    try {
        console.log('Checking counts...');
        const docCount = await pool.query('SELECT COUNT(*) FROM ipd_doc');
        console.log(`ipd_doc count: ${docCount.rows[0].count}`);

        const patientCount = await pool.query('SELECT COUNT(*) FROM ipds');
        console.log(`ipds count: ${patientCount.rows[0].count}`);

        const orphanedDocs = await pool.query(`
            SELECT COUNT(*) FROM ipd_doc d
            LEFT JOIN ipds p ON d.ipd_id = p.id
            WHERE p.id IS NULL
        `);
        console.log(`Orphaned docs (ipd_id not found in ipds): ${orphanedDocs.rows[0].count}`);

        // Also check if we have any valid join
        const validJoin = await pool.query(`
            SELECT COUNT(*) FROM ipd_doc d
            JOIN ipds p ON d.ipd_id = p.id
        `);
        console.log(`Valid JOIN count: ${validJoin.rows[0].count}`);

        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

checkRelations();
