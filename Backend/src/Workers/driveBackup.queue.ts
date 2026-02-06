import Queue from 'bull'
import S3Service from '../Services/s3.service.js'
import DriveHandler from '../Services/driveUploader.service.js'
import { pool } from '../DB/db.js'
import fs from 'fs'
import path from 'path'

// Create queue
const driveBackupQueue = new Queue('drive-backup', process.env.REDIS_URL || 'redis://localhost:6379')

// Job data interface
interface DriveBackupJob {
    documentId: string
    s3Key: string
    fileName: string
    mimeType: string
    hospitalId: string
    panelId: string
    patientId: string
    documentType: string
}

// Worker process
driveBackupQueue.process(async (job) => {
    const { documentId, s3Key, fileName, mimeType, patientId, documentType } =
        job.data as DriveBackupJob

    try {
        console.log(`[DriveWorker] Starting backup for ${fileName}`)

        // 1. Update status to 'processing'
        await pool.query(`UPDATE ipd_doc SET drive_backup_status = 'processing' WHERE id = $1`, [
            documentId,
        ])

        // 2. Get patient's Drive folder ID
        const patientData = await pool.query(`SELECT drive_folder_id FROM ipds WHERE id = $1`, [
            patientId,
        ])

        if (patientData.rowCount === 0) {
            throw new Error('Patient not found')
        }

        const patientDriveFolderId = patientData.rows[0].drive_folder_id

        // 3. Get or create document type subfolder in Drive
        const driveHandler = new DriveHandler()
        const existingFolders = await driveHandler.getFolders(patientDriveFolderId)

        let documentTypeFolderId = existingFolders.find(
            (f: any) => f.name?.toLowerCase() === documentType.toLowerCase()
        )?.fileId

        if (!documentTypeFolderId) {
            // Create subfolder if doesn't exist
            const folderResult = await driveHandler.createFolder(documentType, patientDriveFolderId)
            documentTypeFolderId = folderResult.fileId
        }

        // 4. Download from S3
        console.log(`[DriveWorker] Downloading from S3: ${s3Key}`)
        const buffer = await S3Service.download(s3Key)

        // 5. Save to temp file (Drive API requires file path)
        const tempDir = path.resolve('./temp')
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true })
        }

        const tempPath = path.join(tempDir, `${Date.now()}_${fileName}`)
        fs.writeFileSync(tempPath, buffer)

        // 6. Upload to Google Drive in correct subfolder
        console.log(`[DriveWorker] Uploading to Drive: ${documentType}/`)
        const driveResult = await driveHandler.uploadAndGetLink(
            tempPath,
            mimeType,
            documentTypeFolderId ?? '', // Provide fallback for TypeScript
            fileName
        )

        // 7. Clean up temp file
        fs.unlinkSync(tempPath)

        // 8. Update database with Drive link
        await pool.query(
            `UPDATE ipd_doc 
       SET drive_link = $1, 
           drive_backup_status = 'completed',
           drive_backup_attempts = drive_backup_attempts + 1
       WHERE id = $2`,
            [driveResult.shareLink, documentId]
        )

        console.log(`[DriveWorker] ✓ Backup completed: ${fileName} → ${documentType}/`)
    } catch (error: any) {
        console.error(`[DriveWorker] ✗ Backup failed for ${fileName}:`, error.message)

        // Update failure status
        await pool.query(
            `UPDATE ipd_doc 
       SET drive_backup_status = 'failed',
           drive_backup_error = $1,
           drive_backup_attempts = drive_backup_attempts + 1
       WHERE id = $2`,
            [error.message, documentId]
        )

        // Check retry count
        const attempts = await pool.query(
            `SELECT drive_backup_attempts FROM ipd_doc WHERE id = $1`,
            [documentId]
        )

        // Retry max 3 times with exponential backoff
        if (attempts.rows[0]?.drive_backup_attempts < 3) {
            throw error // Bull will automatically retry
        } else {
            console.error(`[DriveWorker] Max retries reached for ${fileName}`)
        }
    }
})

// Queue events
driveBackupQueue.on('completed', (job) => {
    console.log(`[DriveWorker] Job ${job.id} completed successfully`)
})

driveBackupQueue.on('failed', (job, err) => {
    console.error(`[DriveWorker] Job ${job?.id} failed:`, err.message)
})

driveBackupQueue.on(' stalled', (job) => {
    console.warn(`[DriveWorker] Job ${job.id} stalled, will be retried`)
})

export default driveBackupQueue
