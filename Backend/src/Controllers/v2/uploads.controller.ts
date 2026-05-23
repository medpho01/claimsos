import { pool } from '../../DB/db.js'
import asyncHandler from '../../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../../Utils/errorHandler.util.js'
import apiResponse from '../../Utils/apiResponse.util.js'
import S3Service from '../../Services/s3.service.js'
import fileName from '../../Utils/fileName.util.js'
import NotificationBufferService from '../../Services/notificationBuffer.service.js'
import { compressWithGS } from '../../Workers/gsCompress.worker.js'
import fs from 'fs'
import { createHash } from 'crypto'

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
                        const originalFileName = file.originalname;
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
                            
                            // 2. Read + hash for Layer 1 dedup.
                            file.buffer = fs.readFileSync(file.path);
                            const contentHash = createHash('sha256').update(file.buffer).digest('hex');

                            // 2a. Dedup probe — same patient + same bytes
                            //     means we already have this file.
                            const dupCheck = await pool.query<{ id: string }>(
                                `SELECT id FROM hospital.ipd_doc
                                  WHERE ipd_id = $1 AND content_hash = $2
                                  LIMIT 1`,
                                [patientId, contentHash],
                            );
                            if ((dupCheck.rowCount ?? 0) > 0) {
                                console.log(`[V2 UPLOAD] content_hash hit — reusing existing doc ${dupCheck.rows[0].id} (skipped S3 upload)`);
                                fs.unlink(file.path, () => undefined);
                                // We're inside `chunk.map(async (file) =>
                                // {...})` so `continue` isn't valid — we
                                // return the existing doc as the result
                                // for this slot. The FE treats it as a
                                // successful upload (with the original
                                // file name) and the existing documentId.
                                return {
                                    success: true,
                                    documentId: dupCheck.rows[0].id,
                                    fileName: originalFileName,
                                    deduped: true,
                                } as any;
                            }

                            // 3. Upload to S3 (only reached when not a duplicate).
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
                            // 4. Save to database
                            const dbResult = await pool.query(
                                `INSERT INTO ipd_doc
                   (ipd_id, s3_key, s3_link, type, file_name, file_size, mime_type,
                    storage_provider, drive_backup_status, content_hash)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 's3', 'skipped', $8)
                   RETURNING id`,
                                [
                                    patientId,
                                    file.mimetype.includes("image")?s3Key.replace("uploads/","")+".webp":s3Key,
                                    s3Url,
                                    documentType,
                                    file.originalname,
                                    file.size,
                                    file.mimetype,
                                    contentHash,
                                ]
                            )

                            const documentId = dbResult.rows[0].id

                            // --- Drive Backup Queue disabled — S3 only mode ---
                            // await driveBackupQueue.add({
                            //     documentId: documentId,
                            //     s3Key: file.mimetype.includes("image")?s3Key.replace("uploads/","")+".webp":s3Key,
                            //     fileName: file.originalname,
                            //     mimeType: file.mimetype,
                            //     hospitalId: patient.hospital_id,
                            //     panelId: patient.panel_id,
                            //     patientId,
                            //     patientName: `${patient.first_name} ${patient.last_name}`,
                            //     documentType,
                            // }, {
                            //     delay: 5000,
                            //     attempts: 8,
                            //     backoff: {
                            //         type: 'exponential',
                            //         delay: 3000
                            //     }
                            // })
                            // --- End Drive Backup Queue disabled ---

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

                            return { success: true, documentId, fileName: originalFileName, s3Url:presignedUrl, mimeType: file.mimetype }
                        } catch (error: any) {
                            console.error(`[V2 UPLOAD] ✗ Failed to upload ${originalFileName}:`, error.message)
                            return { success: false, fileName: originalFileName, error: error.message }
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
            console.log(`${'='.repeat(60)}\n`);

            res.status(201).json(
                new apiResponse(
                    201,
                    {
                        successful: successful.map(r => (r as PromiseFulfilledResult<any>).value.fileName),
                        failed: failed.map(r => {
                            if (r.status === 'rejected') return { fileName: 'Unknown', error: r.reason };
                            return { fileName: r.value.fileName, error: r.value.error };
                        }),
                        total_processed: files.length,
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

            // Get documents from database.
            //
            // LAYER 3 DEDUP: join to the document's sections to surface
            // the AI-classified category alongside the upload-time
            // `type`. The FE then prefers ai_category when present so
            // a file uploaded as "surgical_discharge_slip" but
            // re-classified by the AI as "implant_sticker" stops
            // appearing under both buckets in the patient documents
            // tabs (only under the AI's category).
            //
            // A document with multiple sections of different categories
            // (the multi-page PDFs split by the bundle classifier) gets
            // `ai_category` = the FIRST section's category, ordered by
            // page_start. The FE can decide whether to also surface the
            // secondary categories via expand.
            // FILE-LEVEL DEDUP FILTER (migration 057):
            //   d.dedup_of IS NOT NULL   means this row is a duplicate
            //   upload of an earlier (canonical) file with identical
            //   bytes — caller can pass `include_duplicates=true` to
            //   see them anyway (audit / debugging). Default behaviour
            //   excludes duplicates so the AI Summary's Documents
            //   panel shows only the "original medical context"
            //   per the product brief.
            const includeDuplicates = req.query?.include_duplicates === 'true' || req.query?.include_duplicates === '1';
            const dedupFilterSql = includeDuplicates ? '' : ' AND d.dedup_of IS NULL';

            let query = `
        SELECT d.id, d.s3_key, d.s3_link, d.drive_link, d.type, d.file_name, d.file_size,
               d.mime_type, d.storage_provider, d.drive_backup_status, d.created_at,
               d.dedup_of, d.dedup_method, d.dedup_confidence,
               COALESCE(
                 (SELECT json_agg(json_build_object(
                     'id', ds.id,
                     'category', ds.category,
                     'page_start', ds.page_start,
                     'page_end', ds.page_end,
                     'status', ds.status
                   ) ORDER BY ds.page_start NULLS LAST, ds.id)
                  FROM hospital.document_sections ds
                  WHERE ds.document_id = d.id
                    AND ds.category IS NOT NULL),
                 '[]'::json
               ) AS ai_sections
        FROM ipd_doc d
        WHERE d.ipd_id = $1
          ${dedupFilterSql}
      `
            const params: any[] = [patientId]

            if (category && category !== 'all') {
                query += ` AND d.type = $2`
                params.push(category)
            }

            query += ` ORDER BY d.created_at DESC`

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

                // AI-derived category lineage. ai_category = primary
                // (first section by page_start). ai_categories = all
                // distinct AI categories on this doc. Both null/empty
                // when the AI hasn't classified this doc yet — FE
                // falls back to the upload-time `type` in that case.
                const sections: any[] = Array.isArray(doc.ai_sections) ? doc.ai_sections : [];
                const aiCategory: string | null = sections[0]?.category ?? null;
                const aiCategories: string[] = sections.length > 0
                    ? Array.from(new Set(sections.map((s) => s.category).filter(Boolean)))
                    : [];

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
                    // Layer 3 dedup fields: present iff AI has classified
                    // this doc. FE should prefer `ai_category` over `type`
                    // when rendering category tabs. `ai_categories` lists
                    // every category present (multi-section PDFs).
                    ai_category: aiCategory,
                    ai_categories: aiCategories,
                    // File-level dedup metadata (migration 057). When
                    // include_duplicates=true the FE will receive rows
                    // with dedup_of != null — the FE can render them in
                    // a separate "duplicate uploads" section so users
                    // know the file IS present in the system even if
                    // it's been merged with another canonical.
                    dedup_of: doc.dedup_of ?? null,
                    dedup_method: doc.dedup_method ?? null,
                    dedup_confidence:
                      doc.dedup_confidence == null ? null : Number(doc.dedup_confidence),
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

                // --- Drive delete disabled — 
                // if (doc.drive_link) {
                //     try {
                //         const fileIdMatch = doc.drive_link.match(/\/d\/([a-zA-Z0-9_-]+)|id=([a-zA-Z0-9_-]+)/);
                //         const driveFileId = fileIdMatch ? (fileIdMatch[1] || fileIdMatch[2]) : null;
                //         if (driveFileId) {
                //             await handler.deleteFile(driveFileId)
                //         }
                //     } catch (error: any) {
                //         console.error(`[V2 DELETE] Failed to delete from Drive:`, error.message)
                //     }
                // }
                // --- End Drive delete disabled ---
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
     * NOTE: Drive backups are currently disabled — S3 only mode
     */
    getBackupStatus = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const userRole = req.user?.role

            if (userRole !== 'superadmin' && userRole !== 'admin') {
                throw new apiError(403, 'Access denied. Admin only.')
            }

            // Drive backup queue disabled — return empty status
            // const queueCounts = await driveBackupQueue.getJobCounts()

            // Get recent failures (if any historical ones exist)
            const recentFailures = await pool.query(
                `SELECT id, file_name, drive_backup_error, drive_backup_attempts, created_at
         FROM ipd_doc
         WHERE drive_backup_status = 'failed'
         ORDER BY created_at DESC
         LIMIT 10`
            )

            const pendingCount = await pool.query(
                `SELECT COUNT(*) as count FROM ipd_doc WHERE drive_backup_status = 'pending'`
            )

            res.status(200).json(
                new apiResponse(
                    200,
                    {
                        queue: { disabled: true, message: 'Drive backups are disabled — S3 only mode' },
                        pendingBackups: parseInt(pendingCount.rows[0].count),
                        recentFailures: recentFailures.rows,
                    },
                    'Backup status fetched successfully (Drive disabled)'
                )
            )
        }
    )

    /**
     * Retry failed Drive backups (Admin only)
     * POST /api/v2/admin/retry-failed
     * NOTE: Drive backups are currently disabled — S3 only mode
     */
    retryFailedBackups = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const userRole = req.user?.role

            if (userRole !== 'superadmin' && userRole !== 'admin') {
                throw new apiError(403, 'Access denied. Admin only.')
            }

            // Drive backup queue disabled — no retries possible
            // const failedDocs = await pool.query(...)
            // for (const doc of failedDocs.rows) {
            //     await driveBackupQueue.add({ ... })
            // }

            res.status(200).json(
                new apiResponse(
                    200,
                    { retriedCount: 0, message: 'Drive backups are disabled — S3 only mode' },
                    'Drive backups are currently disabled'
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
            `SELECT s3_key, s3_link, mime_type, file_name, storage_provider FROM ipd_doc WHERE id = $1`,
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
            if (file.s3_link && file.s3_link.includes('.amazonaws.com/')) {
                try {
                    const originalKey = file.s3_link.split('.amazonaws.com/')[1];
                    const fallbackBuffer = await S3Service.download(originalKey);
                    
                    res.setHeader('Content-Type', file.mime_type);
                    res.setHeader('Content-Disposition', `inline; filename="${file.file_name}"`);
                    res.setHeader('Cache-Control', 'public, max-age=31536000');
                    res.send(fallbackBuffer);
                    return;
                } catch (fallbackError) {
                    console.error(`[S3 Proxy] Fallback failed for ${fileId}:`, fallbackError);
                }
            }
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
