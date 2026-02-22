import { pool } from '../DB/db.js';

const sampleDoc = {
    id: "d7c8f58e-0ebb-4f5f-a517-e36465e4ac4c",
    ipd_id: "c7c0501f-4a2f-4b8c-8cc4-7efced59a537",
    drive_link: "https://drive.google.com/uc?id=11Pf6HU2cwk3Vr5CyT0afoAslR6f6ktlh",
    type: "admission",
    created_at: "2026-02-01 12:33:46.337641+00"
};

const dummyHospitalId = "dummy-hospital-id";
const dummyPanelId = "dummy-panel-id";

async function seed() {
    try {
        console.log('Seeding sample data including dependencies...');

        // 1. Create Dummy Hospital (if needed, but assuming simple FKs or loose constraints for now, let's just insert what we need)
        // If the schema enforces FKs to tables we don't know, we might hit more walls.
        // Let's assume standard normalization.

        /* 
           We need:
           1. Hospital
           2. Panel
           3. Hospital_Panel
           4. IPD (Patient)
           5. IPD_Doc
        */

        // Try to insert dummy hospital
        await pool.query(`
            INSERT INTO hospitals (id, name) VALUES ($1, 'Test Hospital') ON CONFLICT (id) DO NOTHING
        `, [dummyHospitalId]);

        // Try to insert dummy panel
        await pool.query(`
            INSERT INTO panels (id, name) VALUES ($1, 'Test Panel') ON CONFLICT (id) DO NOTHING
        `, [dummyPanelId]);

        // Try to insert hospital_panel
        await pool.query(`
            INSERT INTO hospital_panels (hospital_id, panel_id) VALUES ($1, $2) ON CONFLICT (hospital_id, panel_id) DO NOTHING
        `, [dummyHospitalId, dummyPanelId]);

        // Insert Patient (IPD)
        await pool.query(`
            INSERT INTO ipds (id, first_name, last_name, hospital_id, panel_id, phone) 
            VALUES ($1, 'Test', 'Patient', $2, $3, '9999999999') 
            ON CONFLICT (id) DO NOTHING
        `, [sampleDoc.ipd_id, dummyHospitalId, dummyPanelId]);

        // Insert Document
        await pool.query(`
            INSERT INTO ipd_doc (id, ipd_id, drive_link, type, created_at, storage_provider, drive_backup_status)
            VALUES ($1, $2, $3, $4, $5, 'drive', 'pending')
            ON CONFLICT (id) DO NOTHING
        `, [sampleDoc.id, sampleDoc.ipd_id, sampleDoc.drive_link, sampleDoc.type, sampleDoc.created_at]);

        console.log(`Successfully seeded document ${sampleDoc.id}`);
        process.exit(0);

    } catch (e: any) {
        if (e.code === '42P01') {
            console.error('Table missing: ' + e.message);
        } else {
            console.error('Seed error:', e);
        }
        process.exit(1);
    }
}

seed();
