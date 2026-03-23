import { pool } from '../../DB/db.js'
import asyncHandler from '../../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../../Utils/errorHandler.util.js'
import apiResponse from '../../Utils/apiResponse.util.js'
import S3Service from '../../Services/s3.service.js'
import driveBackupQueue from '../../Workers/driveBackup.queue.js'
import fileName from '../../Utils/fileName.util.js'
import driveHandler from '../../Services/driveUploader.service.js'
import NotificationBufferService from '../../Services/notificationBuffer.service.js'
import { compressWithGS } from '../../Workers/gsCompress.worker.js'
import fs from 'fs'

const FileName = new fileName()
const handler = new driveHandler();

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

            console.log(`\n${'='.repeat(60)}`);
            console.log(`[S3 Uploader] STARTING BATCH UPLOAD`);
            console.log(`Patient: ${patient.first_name} ${patient.last_name}`);
            console.log(`Files: ${files.length} document(s)`);
            console.log(`${'='.repeat(60)}\n`);
            const safeCategory = category || 'admission';
            const documentType = safeCategory.replaceAll(" ", "_").toLowerCase();

            // Upload files to S3 in concurrent chunks (5 at a time) to prevent memory overload
            const CONCURRENCY_LIMIT = 5;
            const uploadResults: PromiseSettledResult<{ success: boolean; documentId?: any; fileName: string; s3Url?: string; mimeType?: string; error?: string }>[] = [];

            for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
                const chunk = files.slice(i, i + CONCURRENCY_LIMIT);

                const chunkResults = await Promise.allSettled(
                    chunk.map(async (file) => {
                        try {
                            file.originalname = FileName.imageName(patient.first_name, patient.last_name, patient.phone || "", "");
                            // 1. Generate S3 key
                            const s3Key = S3Service.generateKey(
                                patient.hospital_id,
                                patient.panel_id,
                                patientId,
                                documentType,
                                file.originalname,
                                file.mimetype
                            )
                            if (file.mimetype.includes("pdf")) {
                                const tempPath = `${file.path}.compressed`;
                                await compressWithGS(file.path, tempPath);
                                
                                if (fs.existsSync(tempPath)) {
                                    fs.renameSync(tempPath, file.path);
                                }
                            }
                            
                            // 2. Upload to S3
                            file.buffer = fs.readFileSync(file.path);
                            const { s3Url } = await S3Service.upload(
                                s3Key,
                                file.buffer,
                                file.mimetype
                            )
                            fs.unlink(file.path,(err)=>{
                                if(err){
                                    console.log(`[FILE NOT DELETED] path:${file.path}`);
                                }
                            })
                            // 3. Save to database
                            const dbResult = await pool.query(
                                `INSERT INTO ipd_doc 
                   (ipd_id, s3_key, s3_link, type, file_name, file_size, mime_type, 
                    storage_provider, drive_backup_status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 's3', 'pending')
                   RETURNING id`,
                                [
                                    patientId,
                                    file.mimetype.includes("image")?s3Key.replace("uploads/","")+".webp":s3Key,
                                    s3Url,
                                    documentType,
                                    file.originalname,
                                    file.size,
                                    file.mimetype,
                                ]
                            )

                            const documentId = dbResult.rows[0].id

                            // Add to Drive Backup Queue
                            await driveBackupQueue.add({
                                documentId: documentId,
                                s3Key: file.mimetype.includes("image")?s3Key.replace("uploads/","")+".webp":s3Key,
                                fileName: file.originalname,
                                mimeType: file.mimetype,
                                hospitalId: patient.hospital_id,
                                panelId: patient.panel_id,
                                patientId,
                                patientName: `${patient.first_name} ${patient.last_name}`,
                                documentType,
                            }, {
                                attempts: 3,
                                backoff: {
                                    type: 'exponential',
                                    delay: 2000 // 2s, 4s, 8s
                                }
                            })

                            // 5. Add to notification buffer (if group ID exists)
                            const presignedUrl = S3Service.getPresignedUrl(file.mimetype.includes("image")?s3Key.replace("uploads/","")+".webp":s3Key);
                            if (patient.whatsapp_group_id) {
                                try {
                                    NotificationBufferService.add(
                                        patient.whatsapp_group_id,
                                        patientId,
                                        `${patient.first_name} ${patient.last_name}`,
                                        {
                                            link: presignedUrl,
                                            mimeType: file.mimetype,
                                        }
                                    )
                                } catch (notifyError) {
                                    console.error(`[V2 UPLOAD] Failed to queue notification:`, notifyError);
                                }
                            }

                            console.log(`[V2 UPLOAD] ✓ ${file.originalname} → S3 + queued for Drive backup`)

                            return { success: true, documentId, fileName: file.originalname, s3Url:presignedUrl, mimeType: file.mimetype }
                        } catch (error: any) {
                            console.error(`[V2 UPLOAD] ✗ Failed to upload ${file.originalname}:`, error.message)
                            return { success: false, fileName: file.originalname, error: error.message }
                        }
                    })
                )

                uploadResults.push(...chunkResults);
            }

            // Count successes and failures
            const successful = uploadResults.filter((r) => r.status === 'fulfilled' && r.value.success)
            const failed = uploadResults.filter((r) => r.status === 'rejected' || !r.value.success)

            // Update patient timestamp
            await pool.query('UPDATE ipds SET updated_at = NOW() WHERE id = $1', [patientId])

            console.log(
                `[V2 UPLOAD] Completed: ${successful.length} successful, ${failed.length} failed`
            )

            // Explicitly flush notifications for this patient now that batch is done
            if (patient.whatsapp_group_id) {
                NotificationBufferService.checkAndFlushForPatient(patient.whatsapp_group_id, patientId);
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`[S3 Uploader] BATCH COMPLETED`);
            console.log(`Successful: ${successful.length}`);
            console.log(`Failed: ${files.length - successful.length}`);
            console.log(`Drive Backups Queued: ${successful.length}`);
            console.log(`${'='.repeat(60)}\n`);

            res.status(201).json(
                new apiResponse(
                    201,
                    {
                        successful: successful.map(r => (r as PromiseFulfilledResult<any>).value.fileName),
                        failed: failed.map(r => (r as PromiseRejectedResult).reason || (r as PromiseFulfilledResult<any>).value.fileName),
                        total_processed: files.length,
                        queued_for_drive_backup: successful.length,
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
            const category = req.query?.category?.toString().replaceAll(" ", "_").toLowerCase();
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

            // Hybrid: CloudFront signed URLs for fast CDN image delivery + proxy for auth operations
            // CloudFront signing is synchronous (local crypto, no network calls) so this is instant
            const photosWithUrls = result.rows.map((doc: any) => {
                const isS3 = doc.storage_provider === 's3' && doc.s3_key;
                let viewUrl = doc.drive_link || doc.s3_link;

                if (isS3) {
                    try {
                        viewUrl = S3Service.getPresignedUrl(doc.s3_key);
                    } catch {
                        viewUrl = doc.drive_link || doc.s3_link;
                    }
                }

                return {
                    id: doc.id,
                    name: doc.file_name,
                    type: doc.type,
                    mimeType: doc.mime_type,
                    fileSize: doc.file_size,
                    webViewLink: viewUrl,
                    thumbnailLink: viewUrl,
                    storageProvider: doc.storage_provider,
                    driveBackupStatus: doc.drive_backup_status,
                    createdTime: doc.created_at,
                    proxyLink: isS3 ? `/api/v2/uploads/proxy/${doc.id}` : null,
                }
            })

            console.log(`[V2 GET PHOTOS] Found ${photosWithUrls.length} photo(s)`)

            res.status(200).json(
                new apiResponse(200, photosWithUrls, 'Photos fetched successfully')
            )
        }
    )

    /**
     * Get photo metadata only (no URL generation - instant response)
     * GET /api/v2/uploads/photos/:patientId/meta
     */
    getPhotosMeta = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { patientId } = req.params
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!patientId) throw new apiError(400, 'Patient ID is required')

            const result = await pool.query(
                `SELECT id, type, file_name, file_size, mime_type, storage_provider, created_at
                 FROM ipd_doc WHERE ipd_id = $1 ORDER BY created_at DESC`,
                [patientId]
            )

            const photos = result.rows.map((doc: any) => ({
                id: doc.id,
                name: doc.file_name,
                type: doc.type,
                mimeType: doc.mime_type,
                fileSize: doc.file_size,
                storageProvider: doc.storage_provider,
                createdTime: doc.created_at,
                // No URLs yet — these come from the full endpoint
                webViewLink: null,
                thumbnailLink: null,
                proxyLink: null,
            }))

            res.status(200).json(
                new apiResponse(200, photos, 'Photo metadata fetched successfully')
            )
        }
    )
    /**
     * Delete photo (from both S3 and Drive)
     * DELETE /api/v2/uploads/photos/:id
     */
    deletePhoto = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { patientId, fileId } = req.body //fileId is an array
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!fileId) throw new apiError(400, 'Document IDs are required')

            console.log(`[V2 DELETE] Deleting document: ${fileId}`)

            // Get document info
            const docResult = await pool.query(
                `SELECT id,s3_key, drive_link, storage_provider FROM ipd_doc WHERE id=ANY($1) and ipd_id = $2`,
                [fileId, patientId]
            )

            if ((docResult.rowCount ?? 0) === 0) {
                throw new apiError(404, 'Document not found')
            }

            const docs = docResult.rows

            const deleteRes = await Promise.all(docs.map(async (doc) => {
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
                        // Regex to handle both /d/FILE_ID and id=FILE_ID formats
                        const fileIdMatch = doc.drive_link.match(/\/d\/([a-zA-Z0-9_-]+)|id=([a-zA-Z0-9_-]+)/);
                        const driveFileId = fileIdMatch ? (fileIdMatch[1] || fileIdMatch[2]) : null;

                        if (driveFileId) {
                            console.log(`[V2 DELETE] Deleting from Drive: ${driveFileId}`);
                            await handler.deleteFile(driveFileId)
                            console.log(`[V2 DELETE] ✓ Deleted from Drive`)
                        } else {
                            console.warn(`[V2 DELETE] Could not extract Drive File ID from link: ${doc.drive_link}`);
                        }
                    } catch (error: any) {
                        console.error(`[V2 DELETE] Failed to delete from Drive:`, error.message)
                    }
                }
                // Delete from database
                await pool.query(`DELETE FROM ipd_doc WHERE id = $1`, [doc.id])
            }))

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

    /**
     * Get File counts for each category
     * POST /api/v2/admin/retry-failed
     */
    getFileCounts = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const patientId = req.params?.patientId as string;
        console.log(`[File Counts Fetch] Fetching file counts for ${patientId}`)
        if (!patientId) throw new apiError(400, "Patient Id is required");
        const docRes = await pool.query(`SELECT type,count(type) as count from ipd_doc where ipd_id = $1 GROUP BY type`, [patientId]);
        const counts: Record<string, number> = {};
        if (docRes?.rowCount && docRes?.rowCount > 0) {
            docRes.rows.forEach((elem) => {
                let key = elem.type as string;
                key = key.replaceAll(" ", "_").toLowerCase();
                const fieldName = fieldNames[key];
                if (fieldName) {
                    counts[fieldName] = parseInt(elem.count);
                }
            })
        }
        console.log(`[File Counts Fetched] Fetched file counts for ${patientId} successfully`)
        res.status(200).json(new apiResponse(200, counts, "File counts fetched successfully"))
    })

    /**
     * Proxy photo download from S3 to bypass CORS for PDF generation
     * GET /api/v2/uploads/proxy/:fileId
     */
    proxyPhoto = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { fileId } = req.params;

        if (!fileId) throw new apiError(400, 'File ID is required');

        // Fetch file info from DB
        const result = await pool.query(
            `SELECT s3_key, mime_type, file_name, storage_provider FROM ipd_doc WHERE id = $1`,
            [fileId]
        );

        if (result.rowCount === 0) {
            throw new apiError(404, 'File not found');
        }

        const file = result.rows[0];

        if (file.storage_provider !== 's3' || !file.s3_key) {
            throw new apiError(400, 'File is not stored in S3');
        }

        try {
            const buffer = await S3Service.download(file.s3_key);

            res.setHeader('Content-Type', file.mime_type);
            res.setHeader('Content-Disposition', `inline; filename="${file.file_name}"`);
            // Cache control for performance (images are immutable by ID usually)
            res.setHeader('Cache-Control', 'public, max-age=31536000');

            res.send(buffer);
        } catch (error: any) {
            console.error(`[S3 Proxy] Failed to proxy file ${fileId}:`, error);
            throw new apiError(500, 'Failed to fetch file from S3');
        }
    });
}


const fieldNames: Record<string, string> = {
    discharge_slip: 'Discharge Slip',
    investigations: 'Investigations',
    treatment: 'Treatment',
    icps: 'ICPs',
    surgical_discharge_slip: 'Surgical Discharge Slip',
    ot_notes_and_photos: 'OT Notes and Photos',
    post_op_photos: 'Post Op Photos',
    post_op_reports: 'Post Op Reports',
    implant_invoice: 'Implant Invoice',
    others: 'Others',
}

export default UploadsControllerV2
