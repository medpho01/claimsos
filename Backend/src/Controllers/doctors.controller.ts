import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import S3Service from '../Services/s3.service.js'
import fs from 'fs'

class DoctorsController {
    /**
     * Get all doctors for a specific hospital
     * GET /api/v1/doctors/hospital/:hospitalId
     */
    getDoctors = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { hospitalId } = req.params;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, 'No user found, please log in again');
        if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

        // Use the new hospital_doctors junction table to get doctors for a hospital
        const query = `
            SELECT
                hd.id,
                hd.hospital_id,
                hd.doctor_id,
                d.first_name,
                d.last_name,
                d.primary_specialization,
                d.nmc_registration_number,
                hd.employment_type,
                hd.department,
                hd.designation,
                hd.start_date,
                hd.end_date,
                hd.status,
                hd.created_at,
                hd.updated_at
            FROM hospital.hospital_doctors hd
            JOIN hospital.doctors d ON hd.doctor_id = d.id
            WHERE hd.hospital_id = $1 AND hd.status = 'active'
            ORDER BY hd.created_at DESC
        `;

        const result = await pool.query(query, [hospitalId]);

        res.status(200).json(
            new apiResponse(200, result.rows, 'Doctors fetched successfully')
        );
    });

    /**
     * Add a new doctor
     * POST /api/v1/doctors
     */
    addDoctor = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { hospitalId, firstName, lastName, email, phone, primarySpecialization, nmcRegistrationNumber } = req.body;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, 'No user found, please log in again');
        if (!hospitalId) throw new apiError(400, 'Hospital ID is required');
        if (!firstName) throw new apiError(400, 'First Name is required');
        if (!lastName) throw new apiError(400, 'Last Name is required');
        if (!email) throw new apiError(400, 'Email is required');

        // Verify hospital exists
        const hospitalData = await pool.query(
            `SELECT id FROM hospital.hospitals WHERE id = $1`,
            [hospitalId]
        );

        if ((hospitalData.rowCount ?? 0) === 0) {
            throw new apiError(404, 'Hospital not found');
        }

        // First, create independent doctor
        const doctorQuery = `
            INSERT INTO hospital.doctors (first_name, last_name, email, phone, primary_specialization, nmc_registration_number, registration_status, registration_method, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, 'active', 'admin_created', $7)
            RETURNING id
        `;

        const doctorResult = await pool.query(doctorQuery, [
            firstName, lastName, email, phone, primarySpecialization, nmcRegistrationNumber, userId
        ]);

        const doctorId = doctorResult.rows[0].id;

        // Then, link to hospital
        const linkQuery = `
            INSERT INTO hospital.hospital_doctors (hospital_id, doctor_id, employment_type, status)
            VALUES ($1, $2, 'empanelled', 'active')
            RETURNING *
        `;

        const result = await pool.query(linkQuery, [hospitalId, doctorId]);

        res.status(201).json(
            new apiResponse(201, result.rows[0], 'Doctor added successfully')
        );
    });

    /**
     * Update an existing doctor
     * PATCH /api/v1/doctors/:id
     */
    updateDoctor = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { firstName, lastName, email, phone, primarySpecialization, department, designation, employmentType } = req.body;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, 'No user found, please log in again');
        if (!id) throw new apiError(400, 'Doctor ID is required');

        // If updating hospital-doctor relationship fields, update hospital_doctors table
        if (department !== undefined || designation !== undefined || employmentType !== undefined) {
            const hdFields = [];
            const hdValues: any[] = [];
            let hdIndex = 1;

            if (department !== undefined) {
                hdFields.push(`department = $${hdIndex++}`);
                hdValues.push(department);
            }
            if (designation !== undefined) {
                hdFields.push(`designation = $${hdIndex++}`);
                hdValues.push(designation);
            }
            if (employmentType !== undefined) {
                hdFields.push(`employment_type = $${hdIndex++}`);
                hdValues.push(employmentType);
            }

            hdValues.push(id);
            const hdQuery = `
                UPDATE hospital.hospital_doctors
                SET ${hdFields.join(', ')}
                WHERE doctor_id = $${hdIndex}
                RETURNING *
            `;

            await pool.query(hdQuery, hdValues);
        }

        // Update doctor record
        const fields = [];
        const values: any[] = [];
        let index = 1;

        if (firstName !== undefined) {
            fields.push(`first_name = $${index++}`);
            values.push(firstName);
        }
        if (lastName !== undefined) {
            fields.push(`last_name = $${index++}`);
            values.push(lastName);
        }
        if (email !== undefined) {
            fields.push(`email = $${index++}`);
            values.push(email);
        }
        if (phone !== undefined) {
            fields.push(`phone = $${index++}`);
            values.push(phone);
        }
        if (primarySpecialization !== undefined) {
            fields.push(`primary_specialization = $${index++}`);
            values.push(primarySpecialization);
        }

        if (fields.length === 0) {
            throw new apiError(400, 'No fields to update');
        }

        values.push(id);
        const query = `
            UPDATE hospital.doctors
            SET ${fields.join(', ')}
            WHERE id = $${index}
            RETURNING *
        `;

        const result = await pool.query(query, values);

        if ((result.rowCount ?? 0) === 0) {
            throw new apiError(404, 'Doctor not found');
        }

        res.status(200).json(
            new apiResponse(200, result.rows[0], 'Doctor updated successfully')
        );
    });

    /**
     * Delete a doctor
     * DELETE /api/v1/doctors/:id
     */
    deleteDoctor = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, 'No user found, please log in again');
        if (!id) throw new apiError(400, 'Doctor ID is required');

        // With the new schema, deletion is handled by cascades:
        // - hospital_doctors will be deleted via CASCADE
        // - doctor_attributes will be deleted via CASCADE
        // - doctor_attribute_documents will be deleted via CASCADE
        // But we should still handle S3 files if they exist

        // Note: Document cleanup for S3 can be added here if needed
        // For now, just delete the doctor record

        const result = await pool.query(`DELETE FROM hospital.doctors WHERE id = $1`, [id]);

        if ((result.rowCount ?? 0) === 0) {
            throw new apiError(404, 'Doctor not found');
        }

        res.status(200).json(
            new apiResponse(200, null, 'Doctor deleted successfully')
        );
    });

    /**
     * Upload doctor documents mapping array to custom names
     * POST /api/v1/doctors/:id/docs
     */
    uploadDoc = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const files = req.files as Express.Multer.File[] | undefined;
        // customNames will be an array of strings correlating to the files array index
        const customNamesRaw = req.body.customNames; 
        
        let customNames: string[] = [];
        if (customNamesRaw) {
            if (Array.isArray(customNamesRaw)) {
                customNames = customNamesRaw;
            } else if (typeof customNamesRaw === 'string') {
                try {
                    customNames = JSON.parse(customNamesRaw);
                } catch {
                    customNames = [customNamesRaw];
                }
            }
        }

        const userId = req.user?.id;

        if (!userId) throw new apiError(401, 'No user found, please log in again');
        if (!id) throw new apiError(400, 'Doctor ID is required');
        if (!files || files.length === 0) {
            throw new apiError(400, 'No files received');
        }

        // Verify doctor exists and get hospitalId for S3 path
        const doctorData = await pool.query(
            `SELECT d.id, hd.hospital_id FROM hospital.doctors d
             LEFT JOIN hospital.hospital_doctors hd ON d.id = hd.doctor_id
             WHERE d.id = $1
             LIMIT 1`,
            [id]
        );

        if ((doctorData.rowCount ?? 0) === 0) {
            throw new apiError(404, 'Doctor not found');
        }

        const hospitalId = doctorData.rows[0].hospital_id || 'unknown';
        const uploadResults: PromiseSettledResult<any>[] = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file) continue;
            
            const originalFileName = file.originalname;
            // Get user provided custom name or fallback to original file name
            const explicitName = customNames[i];
            const documentName = explicitName && explicitName.trim() !== "" ? explicitName.trim() : originalFileName;

            try {
                const timestamp = Date.now();
                const ext = originalFileName.includes('.') ? originalFileName.substring(originalFileName.lastIndexOf('.')) : '';
                
                // Sanitize file name for S3
                const safeNameForSuffix = documentName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
                const newFileName = `${safeNameForSuffix}_${timestamp}${ext}`;
                
                // S3 path structure
                const s3Key = `${hospitalId}/doctors/${id}/${newFileName}`;

                // Upload to S3
                file.buffer = fs.readFileSync(file.path);
                const { s3Url } = await S3Service.upload(
                    s3Key,
                    file.buffer,
                    file.mimetype
                );

                fs.unlink(file.path, (err) => {
                    if (err) console.log(`[FILE NOT DELETED] path:${file.path}`);
                });

                // Save to DB with 'name' as Document Name provided by User
                const dbResult = await pool.query(
                    `INSERT INTO doctor_doc 
                       (doctor_id, name, s3_key, s3_link, file_name, file_size, mime_type, storage_provider)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 's3')
                     RETURNING id`,
                    [
                        id,
                        documentName, // Storing the custom Name
                        s3Key,
                        s3Url,
                        newFileName,
                        file.size,
                        file.mimetype,
                    ]
                );

                const documentId = dbResult.rows[0].id;
                const presignedUrl = await S3Service.getPresignedUrl(s3Key);

                uploadResults.push({
                    status: 'fulfilled',
                    value: { 
                        success: true, 
                        documentId, 
                        name: documentName, 
                        fileName: newFileName, 
                        s3Url: presignedUrl, 
                        mimeType: file.mimetype 
                    }
                } as PromiseFulfilledResult<any>);
            } catch (error: any) {
                console.error(`[DOCTOR DOC UPLOAD] ✗ Failed to upload ${originalFileName}:`, error.message);
                uploadResults.push({
                    status: 'rejected',
                    reason: { success: false, fileName: originalFileName, error: error.message }
                } as PromiseRejectedResult);
            }
        }

        const successful = uploadResults.filter((r) => r.status === 'fulfilled' && r.value.success);
        const failed = uploadResults.filter((r) => r.status === 'rejected' || !r.value.success);

        res.status(201).json(
            new apiResponse(
                201,
                {
                    successful: successful.map(r => (r as PromiseFulfilledResult<any>).value),
                    failed: failed.map(r => {
                        if (r.status === 'rejected') return { fileName: 'Unknown', error: r.reason };
                        return { fileName: r.value.fileName, error: r.value.error };
                    }),
                    total_processed: files.length,
                },
                `Uploaded ${successful.length} document(s) successfully`
            )
        );
    });

    /**
     * Get documents for a doctor
     * GET /api/v1/doctors/:id/docs
     */
    getDocs = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, 'No user found, please log in again');
        if (!id) throw new apiError(400, 'Doctor ID is required');

        const query = `
            SELECT id, name, s3_key, s3_link, drive_link, file_name, file_size, 
                   mime_type, storage_provider, created_at
            FROM doctor_doc
            WHERE doctor_id = $1
            ORDER BY created_at DESC
        `;

        const result = await pool.query(query, [id]);

        const docsWithUrls = await Promise.all(result.rows.map(async (doc: any) => {
            const isS3 = doc.storage_provider === 's3' && doc.s3_key;
            let viewUrl = doc.s3_link;

            if (isS3) {
                // getPresignedUrl returns null on failure — `||` keeps a
                // usable URL on the response.
                const signed = await S3Service.getPresignedUrl(doc.s3_key);
                viewUrl = signed || doc.s3_link;
            }

            return {
                id: doc.id,
                name: doc.name || doc.file_name, // Fallback to file_name if no name is present
                fileName: doc.file_name,
                mimeType: doc.mime_type,
                fileSize: doc.file_size,
                webViewLink: viewUrl,
                thumbnailLink: viewUrl,
                storageProvider: doc.storage_provider,
                createdTime: doc.created_at,
                proxyLink: isS3 ? `/api/v1/doctors/docs/proxy/${doc.id}` : null,
            };
        }));

        res.status(200).json(
            new apiResponse(200, docsWithUrls, 'Documents fetched successfully')
        );
    });

    /**
     * Delete a doctor document
     * DELETE /api/v1/doctors/docs/:docId
     */
    deleteDoc = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { docId } = req.params;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, 'No user found, please log in again');
        if (!docId) throw new apiError(400, 'Document ID is required');

        const docResult = await pool.query(
            `SELECT id, s3_key, storage_provider FROM doctor_doc WHERE id=$1`,
            [docId]
        );

        if ((docResult.rowCount ?? 0) === 0) {
            throw new apiError(404, 'Document not found');
        }

        const doc = docResult.rows[0];

        if (doc.s3_key) {
            try {
                await S3Service.delete(doc.s3_key);
            } catch (error: any) {
                console.error(`[DOCTOR DOC DELETE] Failed to delete from S3:`, error.message);
            }
        }

        await pool.query(`DELETE FROM doctor_doc WHERE id = $1`, [docId]);

        res.status(200).json(
            new apiResponse(200, null, 'Document deleted successfully')
        );
    });

    /**
     * Proxy photo download from S3 to bypass CORS if needed
     * GET /api/v1/doctors/docs/proxy/:docId
     */
    proxyPhoto = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { docId } = req.params;

        if (!docId) throw new apiError(400, 'Document ID is required');

        const result = await pool.query(
            `SELECT s3_key, mime_type, file_name, storage_provider FROM doctor_doc WHERE id = $1`,
            [docId]
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
            console.error(`[S3 Proxy] Failed to proxy doctor doc ${docId}:`, error);
            throw new apiError(500, 'Failed to fetch file from S3');
        }
    });
}

export default DoctorsController;
