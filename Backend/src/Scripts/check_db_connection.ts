import { pool } from '../DB/db.js';
import 'dotenv/config'; // Ensure dotenv is loaded if db.js doesn't guaranteed do it for the script context in some setups, though db.js usually does.

async function checkConnection() {
    try {
        console.log('--- Connection Details ---');
        console.log(`Host: ${process.env.POSTGRES_HOST}`);
        console.log(`Database: ${process.env.POSTGRES_DB}`);
        console.log(`User: ${process.env.POSTGRES_USER}`);
        // Do not log password

        console.log('\n--- Data Check ---');
        const res = await pool.query('SELECT COUNT(*) FROM ipd_doc');
        console.log(`Rows in 'ipd_doc': ${res.rows[0].count}`);

        process.exit(0);
    } catch (e) {
        console.error('Connection failed:', e);
        process.exit(1);
    }
}

checkConnection();
