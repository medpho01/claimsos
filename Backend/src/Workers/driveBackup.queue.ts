import Queue from 'bull'
import S3Service from '../Services/s3.service.js'
import DriveHandler from '../Services/driveUploader.service.js'
import { pool } from '../DB/db.js'
import fs from 'fs'
import path from 'path'

interface DriveBackupJob {
    documentId: string
    s3Key: string
    fileName: string
    mimeType: string
    hospitalId: string
    panelId: string
    patientId: string
    patientName?: string
    documentType: string
}

function createQueue(): Queue.Queue {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
    const url = new URL(redisUrl)

    const q = new Queue('drive-backup', {
        redis: {
            host: url.hostname,
            port: parseInt(url.port || '6379'),
            retryStrategy: (times: number) => {
                if (times >= 1) return null
                return 500
            },
            enableOfflineQueue: false,
        } as any
    })

    q.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED') {
            console.warn('[DriveBackupQueue] Redis not available — drive backup disabled.')
        }
    })

    q.process(async (job: Queue.Job<DriveBackupJob>) => {
        const { documentId, s3Key, fileName, mimeType, patientId, patientName, documentType } = job.data
        const patientLabel = patientName || patientId

        console.log(`[DriveWorker] Processing: ${patientLabel} - ${fileName}`)

        const docRes = await pool.query(
            `UPDATE ipd_doc SET drive_backup_status = 'processing' WHERE id = $1 RETURNING s3_link`,
            [documentId]
        )
        const s3Link = docRes.rows[0]?.s3_link

        const patientData = await pool.query(`SELECT drive_folder_id FROM ipds WHERE id = $1`, [patientId])
        if (patientData.rowCount === 0) throw new Error('Patient not found')

        const patientDriveFolderId = patientData.rows[0].drive_folder_id
        const driveHandler = new DriveHandler()
        const existingFolders = await driveHandler.getFolders(patientDriveFolderId)

        let documentTypeFolderId = existingFolders.find(
            (f: any) => f.name?.toLowerCase() === documentType.toLowerCase()
        )?.fileId

        if (!documentTypeFolderId) {
            if (documentType.toLowerCase() === 'admission') {
                documentTypeFolderId = patientDriveFolderId
            } else {
                const folderResult = await driveHandler.createFolder(documentType, patientDriveFolderId)
                documentTypeFolderId = folderResult.fileId
            }
        }

        let buffer: Buffer
        try {
            buffer = await S3Service.download(s3Key)
        } catch (downloadErr: any) {
            if (s3Link && s3Link.includes('.amazonaws.com/')) {
                const originalKey = s3Link.split('.amazonaws.com/')[1]
                buffer = await S3Service.download(originalKey)
            } else {
                throw downloadErr
            }
        }

        const tempDir = path.resolve('./temp')
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true })

        const tempPath = path.join(tempDir, `${Date.now()}_${fileName}`)
        fs.writeFileSync(tempPath, buffer)

        const driveResult = await driveHandler.uploadAndGetLink(
            tempPath, mimeType, documentTypeFolderId ?? '', fileName
        )

        fs.unlinkSync(tempPath)

        await pool.query(
            `UPDATE ipd_doc SET drive_link = $1, drive_backup_status = 'completed', drive_backup_attempts = drive_backup_attempts + 1 WHERE id = $2`,
            [driveResult.shareLink, documentId]
        )

        console.log(`[DriveWorker] ✓ Uploaded to Drive: ${documentType}/`)
    })

    q.on('completed', (job) => console.log(`[DriveWorker] Job ${job.id} completed`))
    q.on('failed', (job, err) => console.error(`[DriveWorker] Job ${job?.id} failed:`, err.message))

    return q
}

const driveBackupQueue = createQueue()

export default driveBackupQueue
