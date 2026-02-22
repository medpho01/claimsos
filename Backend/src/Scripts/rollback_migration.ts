import { pool } from '../DB/db.js';

async function rollbackMigration() {
    console.log('Starting Rollback...');

    try {
        const res = await pool.query(`
            UPDATE ipd_doc
            SET 
                s3_key = NULL,
                s3_link = NULL,
                file_name = NULL,
                file_size = NULL,
                mime_type = NULL,
                drive_backup_status = 'pending',
                storage_provider = 'drive'
            WHERE 
                s3_key IS NOT NULL 
                AND drive_link IS NOT NULL
        `);

        console.log(`Rollback Complete. Updated ${res.rowCount} records.`);
    } catch (error) {
        console.error('Rollback Failed:', error);
    }

    process.exit(0);
}

rollbackMigration();
