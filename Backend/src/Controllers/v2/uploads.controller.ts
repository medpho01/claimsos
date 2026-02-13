import { pool } from '../../DB/db.js'
import asyncHandler from '../../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../../Utils/errorHandler.util.js'
import apiResponse from '../../Utils/apiResponse.util.js'
import S3Service from '../../Services/s3.service.js'
import driveBackupQueue from '../../Workers/driveBackup.queue.js'
import fileName from '../../Utils/fileName.util.js'

const FileName = new fileName()

class UploadsControllerV2 {
    /**
     * Upload photos to S3 (primary) and queue Drive backup
     * POST /api/v2/uploads/photos
     */
    uploadPhotos = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const files = req.files as Express.Multer.File[] | undefined
            const { patientId, category } = req.body
            const userId = req.user?.id
            const userRole = req.user?.role

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!patientId) throw new apiError(400, 'Patient ID is required')
            if (!files || files.length === 0) {
                throw new apiError(400, 'No files received')
            }

            console.log(
                `[V2 UPLOAD] Starting S3 upload of ${files.length} files for patient: ${patientId}`
            )

            // Get patient data with hospital and panel info
            const patientData = await pool.query(
                `SELECT p.id, p.first_name, p.last_name, p.phone, p.hospital_id, p.panel_id,
                hp.whatsapp_group_id
         FROM ipds p
         JOIN hospital_panels hp ON p.hospital_id = hp.hospital_id AND p.panel_id = hp.panel_id
         WHERE p.id = $1`,
                [patientId]
            )

            if ((patientData.rowCount ?? 0) === 0) {
                throw new apiError(404, 'Patient not found')
            }

            const patient = patientData.rows[0]
            const documentType = category || 'others'

            // Upload all files to S3 in parallel
            const uploadResults = await Promise.allSettled(
                files.map(async (file) => {
                    try {
                        // 1. Generate S3 key
                        const s3Key = S3Service.generateKey(
                            patient.hospital_id,
                            patient.panel_id,
                            patientId,
                            documentType,
                            file.originalname
                        )

                        // 2. Upload to S3
                        const { s3Url } = await S3Service.upload(
                            s3Key,
                            file.buffer,
                            file.mimetype
                        )

                        // 3. Save to database
                        const dbResult = await pool.query(
                            `INSERT INTO ipd_doc 
               (ipd_id, s3_key, s3_link, type, file_name, file_size, mime_type, 
                storage_provider, drive_backup_status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 's3', 'pending')
               RETURNING id`,
                            [
                                patientId,
                                s3Key,
                                s3Url,
                                documentType,
                                file.originalname,
                                file.size,
                                file.mimetype,
                            ]
                        )

                        const documentId = dbResult.rows[0].id

                        // 4. Queue for Drive backup
                        await driveBackupQueue.add({
                            documentId,
                            s3Key,
                            fileName: file.originalname,
                            mimeType: file.mimetype,
                            hospitalId: patient.hospital_id,
                            panelId: patient.panel_id,
                            patientId,
                            documentType,
                        })

                        console.log(`[V2 UPLOAD] ✓ ${file.originalname} → S3 + queued for Drive backup`)

                        return { success: true, documentId, fileName: file.originalname }
                    } catch (error: any) {
                        console.error(`[V2 UPLOAD] ✗ Failed to upload ${file.originalname}:`, error.message)
                        return { success: false, fileName: file.originalname, error: error.message }
                    }
                })
            )

            // Count successes and failures
            const successful = uploadResults.filter((r) => r.status === 'fulfilled' && r.value.success)
            const failed = uploadResults.filter((r) => r.status === 'rejected' || !r.value.success)

            // Update patient timestamp
            await pool.query('UPDATE ipds SET updated_at = NOW() WHERE id = $1', [patientId])

            console.log(
                `[V2 UPLOAD] Completed: ${successful.length} successful, ${failed.length} failed`
            )

            res.status(201).json(
                new apiResponse(
                    201,
                    {
                        uploaded: successful.length,
                        failed: failed.length,
                        totalqueued_for_drive_backup: successful.length,
                    },
                    `Uploaded ${successful.length} file(s) to S3 successfully`
                )
            )
        }
    )

    /**
     * Get photos for a patient (generates presigned URLs)
     * GET /api/v2/uploads/photos/:patientId
     */
    getPhotos = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { patientId } = req.params
            const { category } = req.query
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!patientId) throw new apiError(400, 'Patient ID is required')

            console.log(`[V2 GET PHOTOS] Fetching photos for patient: ${patientId}`)

            // Get documents from database
            let query = `
        SELECT id, s3_key, s3_link, drive_link, type, file_name, file_size, 
               mime_type, storage_provider, drive_backup_status, created_at
        FROM ipd_doc
        WHERE ipd_id = $1
      `
            const params: any[] = [patientId]

            if (category && category !== 'all') {
                query += ` AND type = $2`
                params.push(category)
            }

            query += ` ORDER BY created_at DESC`

            const result = await pool.query(query, params)

            // Generate presigned URLs for S3 files
            const photosWithUrls = await Promise.all(
                result.rows.map(async (doc: any) => {
                    let viewUrl = doc.s3_link

                    // If stored in S3, generate presigned URL
                    if (doc.storage_provider === 's3' && doc.s3_key) {
                        try {
                            viewUrl = await S3Service.getPresignedUrl(doc.s3_key)
                        } catch (error) {
                            console.error(`[V2 GET PHOTOS] Failed to generate presigned URL for ${doc.s3_key}`)
                            // Fallback to Drive if available
                            viewUrl = doc.drive_link || doc.s3_link
                        }
                    }

                    return {
                        id: doc.id,
                        name: doc.file_name,
                        type: doc.type,
                        mimeType: doc.mime_type,
                        fileSize: doc.file_size,
                        webViewLink: viewUrl,
                        thumbnailLink: viewUrl, // Same for now, can optimize later
                        storageProvider: doc.storage_provider,
                        driveBackupStatus: doc.drive_backup_status,
                        createdTime: doc.created_at,
                    }
                })
            )

            console.log(`[V2 GET PHOTOS] Found ${photosWithUrls.length} photo(s)`)

            res.status(200).json(
                new apiResponse(200, photosWithUrls, 'Photos fetched successfully')
            )
        }
    )

    /**
     * Delete photo (from both S3 and Drive)
     * DELETE /api/v2/uploads/photos/:id
     */
    deletePhoto = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { id } = req.params
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!id) throw new apiError(400, 'Document ID is required')

            console.log(`[V2 DELETE] Deleting document: ${id}`)

            // Get document info
            const docResult = await pool.query(
                `SELECT s3_key, drive_link, storage_provider FROM ipd_doc WHERE id = $1`,
                [id]
            )

            if ((docResult.rowCount ?? 0) === 0) {
                throw new apiError(404, 'Document not found')
            }

            const doc = docResult.rows[0]

            // Delete from S3 if exists
            if (doc.s3_key) {
                try {
                    await S3Service.delete(doc.s3_key)
                    console.log(`[V2 DELETE] ✓ Deleted from S3: ${doc.s3_key}`)
                } catch (error: any) {
                    console.error(`[V2 DELETE] Failed to delete from S3:`, error.message)
                }
            }

            // Delete from Drive if exists (extract file ID from link)
            if (doc.drive_link) {
                try {
                    const fileIdMatch = doc.drive_link.match(/\/d\/([^\/]+)/)
                    if (fileIdMatch) {
                        const DriveHandler = (await import('../../Services/driveUploader.service.js')).default
                        const handler = new DriveHandler()
                        await handler.deleteFile(fileIdMatch[1])
                        console.log(`[V2 DELETE] ✓ Deleted from Drive`)
                    }
                } catch (error: any) {
                    console.error(`[V2 DELETE] Failed to delete from Drive:`, error.message)
                }
            }

            // Delete from database
            await pool.query(`DELETE FROM ipd_doc WHERE id = $1`, [id])

            console.log(`[V2 DELETE] ✓ Document deleted successfully`)

            res.status(200).json(
                new apiResponse(200, null, 'Photo deleted successfully')
            )
        }
    )

    /**
     * Get Drive backup queue status (Admin only)
     * GET /api/v2/admin/backup-status
     */
    getBackupStatus = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const userRole = req.user?.role

            if (userRole !== 'superadmin' && userRole !== 'admin') {
                throw new apiError(403, 'Access denied. Admin only.')
            }

            // Get queue statistics
            const queueCounts = await driveBackupQueue.getJobCounts()

            // Get recent failures
            const recentFailures = await pool.query(
                `SELECT id, file_name, drive_backup_error, drive_backup_attempts, created_at
         FROM ipd_doc
         WHERE drive_backup_status = 'failed'
         ORDER BY created_at DESC
         LIMIT 10`
            )

            // Get pending backups
            const pendingCount = await pool.query(
                `SELECT COUNT(*) as count FROM ipd_doc WHERE drive_backup_status = 'pending'`
            )

            res.status(200).json(
                new apiResponse(
                    200,
                    {
                        queue: queueCounts,
                        pendingBackups: parseInt(pendingCount.rows[0].count),
                        recentFailures: recentFailures.rows,
                    },
                    'Backup status fetched successfully'
                )
            )
        }
    )

    /**
     * Retry failed Drive backups (Admin only)
     * POST /api/v2/admin/retry-failed
     */
    retryFailedBackups = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const userRole = req.user?.role

            if (userRole !== 'superadmin' && userRole !== 'admin') {
                throw new apiError(403, 'Access denied. Admin only.')
            }

            // Get failed backups
            const failedDocs = await pool.query(
                `SELECT id, s3_key, file_name, mime_type, ipd_id, type
         FROM ipd_doc
         WHERE drive_backup_status = 'failed' AND drive_backup_attempts < 3`
            )

            console.log(`[V2 ADMIN] Retrying ${failedDocs.rowCount} failed backups`)

            // Re-queue them
            for (const doc of failedDocs.rows) {
                // Get patient's hospital and panel info
                const patientData = await pool.query(
                    `SELECT hospital_id, panel_id FROM ipds WHERE id = $1`,
                    [doc.ipd_id]
                )

                if ((patientData.rowCount ?? 0) > 0) {
                    await driveBackupQueue.add({
                        documentId: doc.id,
                        s3Key: doc.s3_key,
                        fileName: doc.file_name,
                        mimeType: doc.mime_type,
                        hospitalId: patientData.rows[0].hospital_id,
                        panelId: patientData.rows[0].panel_id,
                        patientId: doc.ipd_id,
                        documentType: doc.type,
                    })

                    // Reset status to pending
                    await pool.query(
                        `UPDATE ipd_doc SET drive_backup_status = 'pending' WHERE id = $1`,
                        [doc.id]
                    )
                }
            }

            res.status(200).json(
                new apiResponse(
                    200,
                    { retriedCount: failedDocs.rowCount },
                    `Retrying ${failedDocs.rowCount} failed backup(s)`
                )
            )
        }
    )
}

export default UploadsControllerV2
