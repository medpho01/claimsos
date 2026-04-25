import { pool } from '../DB/db.js';
import driveBackupQueue from '../Workers/driveBackup.queue.js';

class StartupService {
    /**
     * recoverDriveBackups
     * Checks for stuck 'processing' or 'failed' backups in the DB and re-queues them     
     */
    async recoverDriveBackups() {
        // Skip drive recovery in local dev or when Redis/Drive is not configured
        if (!process.env.GOOGLE_DRIVE_ROOT_ID && !process.env.PARENT) {
            console.log('[Startup] Google Drive not configured — skipping backup recovery.');
            return;
        }

        console.log('[Startup] Checking for pending/failed Drive backups...');

        try {
            // 1. Reset 'processing' to 'pending'
            // If the server crashed while a job was 'processing', it's stuck.
            const stuckResult = await pool.query(
                `UPDATE ipd_doc 
                 SET drive_backup_status = 'pending' 
                 WHERE drive_backup_status = 'processing'`
            );

            if ((stuckResult.rowCount ?? 0) > 0) {
                console.log(`[Startup] Reset ${stuckResult.rowCount ?? 0} stuck 'processing' backups to 'pending'.`);
            }

            // 2. Find 'pending' or 'failed' items that need to be queued
            // explicitly find items that are NOT completed and have retries left
            // We re-select 'pending' because we just updated stuck ones to 'pending'
            const recoverQuery = `
                SELECT id, s3_key, file_name, mime_type, ipd_id, type 
                FROM ipd_doc 
                WHERE 
                    (drive_backup_status = 'pending') 
                    OR 
                    (drive_backup_status = 'failed' AND drive_backup_attempts < 3)
            `;

            const recoverResult = await pool.query(recoverQuery);

            if ((recoverResult.rowCount ?? 0) === 0) {
                console.log('[Startup] No backups need recovery.');
                return;
            }

            console.log(`[Startup] Recovering ${recoverResult.rowCount ?? 0} backups...`);

            let queuedCount = 0;
            for (const doc of recoverResult.rows) {
                const patientData = await pool.query(
                    `SELECT hospital_id, panel_id FROM ipds WHERE id = $1`,
                    [doc.ipd_id]
                );

                if ((patientData.rowCount ?? 0) > 0) {
                    const { hospital_id, panel_id } = patientData.rows[0];

                    // Re-add to queue
                    await driveBackupQueue.add({
                        documentId: doc.id,
                        s3Key: doc.s3_key,
                        fileName: doc.file_name,
                        mimeType: doc.mime_type,
                        hospitalId: hospital_id,
                        panelId: panel_id,
                        patientId: doc.ipd_id,
                        documentType: doc.type,
                    }, {
                        attempts: 3,
                        backoff: {
                            type: 'exponential',
                            delay: 2000
                        }
                    });
                    queuedCount++;
                }
            }

            console.log(`[Startup] Successfully re-queued ${queuedCount} backups.`);

        } catch (error) {
            console.error('[Startup] Failed to recover backups:', error);
        }
    }
}

export default new StartupService();
