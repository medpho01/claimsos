import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import S3Service from '../Services/s3.service.js'
import fileName from '../Utils/fileName.util.js'
import fs from 'fs'

const FileName = new fileName()

class HospitalDocsController {
    /**
     * Upload official hospital documents to S3
     * POST /api/v1/hospital-docs/upload
     */
    uploadDoc = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const files = req.files as Express.Multer.File[] | undefined
            const { hospitalId, panelId, category } = req.body
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!hospitalId) throw new apiError(400, 'Hospital ID is required')
            if (!files || files.length === 0) {
                throw new apiError(400, 'No files received')
            }

            // Verify hospital exists
            const hospitalData = await pool.query(
                `SELECT id, name FROM hospitals WHERE id = $1`,
                [hospitalId]
            )

            if ((hospitalData.rowCount ?? 0) === 0) {
                throw new apiError(404, 'Hospital not found')
            }

            const safeCategory = category || 'general_doc';
            const documentType = safeCategory.replaceAll(" ", "_").toLowerCase();
            const safePanelId = panelId || null; // NULL if it's not panel-specific
            const hospitalNameRaw = hospitalData.rows[0].name;
            const hospitalNamePrefix = hospitalNameRaw.replace(/[^a-zA-Z0-9]/g, '_');

            const uploadResults: PromiseSettledResult<any>[] = [];

            for (const file of files) {
                const originalFileName = file.originalname;
                try {
                    // Generate new filename
                    const timestamp = Date.now();
                    const ext = originalFileName.includes('.') ? originalFileName.substring(originalFileName.lastIndexOf('.')) : '';
                    const newFileName = `${hospitalNamePrefix}_${documentType}_${timestamp}${ext}`;
                    
                    // Bypass the 'uploads/' lambda folder
                    const s3Key = `${hospitalId}/hospital_docs/${safePanelId || 'general'}/${documentType}/${newFileName}`;

                    // Upload to S3
                    file.buffer = fs.readFileSync(file.path);
                    const { s3Url } = await S3Service.upload(
                        s3Key,
                        file.buffer,
                        file.mimetype
                    )

                    fs.unlink(file.path, (err) => {
                        if (err) console.log(`[FILE NOT DELETED] path:${file.path}`);
                    })

                    // Save to database, use the original key directly
                    const finalS3Key = s3Key;

                    const dbResult = await pool.query(
                        `INSERT INTO hospital_doc 
                           (hospital_id, panel_id, type, s3_key, s3_link, file_name, file_size, mime_type, storage_provider)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 's3')
                         RETURNING id`,
                        [
                            hospitalId,
                            safePanelId,
                            documentType,
                            finalS3Key,
                            s3Url,
                            newFileName,
                            file.size,
                            file.mimetype,
                        ]
                    )

                    const documentId = dbResult.rows[0].id

                    const presignedUrl = S3Service.getPresignedUrl(finalS3Key);

                    console.log(`[HOSPITAL DOC UPLOAD] ✓ ${originalFileName} → S3 as ${newFileName}`)

                    uploadResults.push({
                        status: 'fulfilled',
                        value: { success: true, documentId, fileName: newFileName, s3Url: presignedUrl, mimeType: file.mimetype }
                    } as PromiseFulfilledResult<any>);
                } catch (error: any) {
                    console.error(`[HOSPITAL DOC UPLOAD] ✗ Failed to upload ${originalFileName}:`, error.message)
                    uploadResults.push({
                        status: 'rejected',
                        reason: { success: false, fileName: originalFileName, error: error.message }
                    } as PromiseRejectedResult);
                }
            }

            const successful = uploadResults.filter((r) => r.status === 'fulfilled' && r.value.success)
            const failed = uploadResults.filter((r) => r.status === 'rejected' || !r.value.success)

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
                    `Uploaded ${successful.length} document(s) successfully`
                )
            )
        }
    )

    /**
     * Get documents for a hospital
     * GET /api/v1/hospital-docs/:hospitalId
     */
    getDocs = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params
            const category = req.query?.category?.toString().replaceAll(" ", "_").toLowerCase();
            const panelId = req.query?.panelId?.toString();
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!hospitalId) throw new apiError(400, 'Hospital ID is required')

            let query = `
                SELECT id, s3_key, s3_link, drive_link, type, panel_id, file_name, file_size, 
                       mime_type, storage_provider, created_at
                FROM hospital_doc
                WHERE hospital_id = $1
            `
            const params: any[] = [hospitalId]

            if (category && category !== 'all') {
                params.push(category)
                query += ` AND type = $${params.length}`
            }

            if (panelId) {
                params.push(panelId)
                query += ` AND panel_id = $${params.length}`
            } else if (req.query.panelId !== undefined) { 
                // if panelId is strictly passed as empty string, it might mean we only want general docs
                query += ` AND panel_id IS NULL`
            }

            query += ` ORDER BY created_at DESC`

            const result = await pool.query(query, params)

            const docsWithUrls = result.rows.map((doc: any) => {
                const isS3 = doc.storage_provider === 's3' && doc.s3_key;
                let viewUrl = doc.s3_link;

                if (isS3) {
                    try {
                        viewUrl = S3Service.getPresignedUrl(doc.s3_key);
                    } catch {
                        viewUrl = doc.s3_link;
                    }
                }

                return {
                    id: doc.id,
                    name: doc.file_name,
                    type: doc.type,
                    panelId: doc.panel_id,
                    mimeType: doc.mime_type,
                    fileSize: doc.file_size,
                    webViewLink: viewUrl,
                    thumbnailLink: viewUrl,
                    storageProvider: doc.storage_provider,
                    createdTime: doc.created_at,
                    proxyLink: isS3 ? `/api/v1/hospital-docs/proxy/${doc.id}` : null,
                }
            })

            res.status(200).json(
                new apiResponse(200, docsWithUrls, 'Documents fetched successfully')
            )
        }
    )

    /**
     * Delete document
     * DELETE /api/v1/hospital-docs/:id
     */
    deleteDoc = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { id } = req.params
            const userId = req.user?.id

            if (!userId) throw new apiError(401, 'No user found, please log in again')
            if (!id) throw new apiError(400, 'Document ID is required')

            const docResult = await pool.query(
                `SELECT id, s3_key, storage_provider FROM hospital_doc WHERE id=$1`,
                [id]
            )

            if ((docResult.rowCount ?? 0) === 0) {
                throw new apiError(404, 'Document not found')
            }

            const doc = docResult.rows[0]

            if (doc.s3_key) {
                try {
                    await S3Service.delete(doc.s3_key)
                } catch (error: any) {
                    console.error(`[HOSPITAL DOC DELETE] Failed to delete from S3:`, error.message)
                }
            }

            await pool.query(`DELETE FROM hospital_doc WHERE id = $1`, [id])

            res.status(200).json(
                new apiResponse(200, null, 'Document deleted successfully')
            )
        }
    )

    /**
     * Proxy photo download from S3 to bypass CORS if needed
     * GET /api/v1/hospital-docs/proxy/:fileId
     */
    proxyPhoto = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { fileId } = req.params;

        if (!fileId) throw new apiError(400, 'File ID is required');

        const result = await pool.query(
            `SELECT s3_key, s3_link, mime_type, file_name, storage_provider FROM hospital_doc WHERE id = $1`,
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
            res.setHeader('Cache-Control', 'public, max-age=31536000');

            res.send(buffer);
        } catch (error: any) {
            console.error(`[S3 Proxy] Failed to proxy file ${fileId}:`, error);
            throw new apiError(500, 'Failed to fetch file from S3');
        }
    });
}

export default HospitalDocsController
