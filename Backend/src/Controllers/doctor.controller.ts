import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import DoctorService from '../Services/doctor.service.js';
import { pool } from '../DB/db.js';
import S3Service from '../Services/s3.service.js';
import fs from 'fs';

class DoctorController {
  /**
   * POST /doctors/register
   * Register a new doctor (self-registration)
   */
  registerDoctor = asyncHandler(async (req: Request, res: Response) => {
    const { firstName, lastName, email, phone, primarySpecialization, secondarySpecializations, nmcRegistrationNumber, stateRegistrationNumber } = req.body;
    const userId = req.user?.id;

    if (!firstName || !lastName || !email) {
      throw new apiError(400, 'First name, last name, and email are required');
    }

    const doctor = await DoctorService.registerDoctor(
      {
        firstName,
        lastName,
        email,
        phone,
        primarySpecialization,
        secondarySpecializations,
        nmcRegistrationNumber,
        stateRegistrationNumber
      },
      userId
    );

    res.status(201).json(
      new apiResponse(201, doctor, 'Doctor registered successfully')
    );
  });

  /**
   * GET /doctors/me
   * Get own doctor profile
   */
  getOwnProfile = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    // Find doctor by user ID (if doctor registered)
    const result = await DoctorService.listDoctors();
    // TODO: Implement mapping between user and doctor

    res.status(200).json(
      new apiResponse(200, { message: 'Not yet implemented' }, 'Get own profile')
    );
  });

  /**
   * PUT /doctors/me
   * Update own doctor profile
   */
  updateOwnProfile = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;
    const updates = req.body;

    const doctor = await DoctorService.updateDoctor(doctorId, updates);

    res.status(200).json(
      new apiResponse(200, doctor, 'Doctor profile updated successfully')
    );
  });

  /**
   * GET /doctors/search
   * Search for doctors (public)
   */
  searchDoctors = asyncHandler(async (req: Request, res: Response) => {
    const { query, specialization, nmcNumber, page = 1, limit = 20 } = req.query;

    const result = await DoctorService.searchDoctors(
      query as string,
      specialization as string,
      nmcNumber as string,
      parseInt(page as string),
      parseInt(limit as string)
    );

    res.status(200).json(
      new apiResponse(200, result, 'Doctors retrieved successfully')
    );
  });

  /**
   * GET /doctors/:doctorId
   * Get doctor profile
   */
  getDoctorProfile = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;

    const doctor = await DoctorService.getDoctorProfileWithAttributes(doctorId);

    res.status(200).json(
      new apiResponse(200, doctor, 'Doctor profile retrieved successfully')
    );
  });

  /**
   * PUT /doctors/:doctorId
   * Update doctor profile (admin)
   */
  updateDoctor = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;
    const updates = req.body;

    const doctor = await DoctorService.updateDoctor(doctorId, updates);

    res.status(200).json(
      new apiResponse(200, doctor, 'Doctor profile updated successfully')
    );
  });

  /**
   * GET /admin/doctors
   * List all doctors (admin)
   */
  listDoctors = asyncHandler(async (req: Request, res: Response) => {
    const { status, page = 1, limit = 20 } = req.query;

    const result = await DoctorService.listDoctors(
      status as string,
      parseInt(page as string),
      parseInt(limit as string)
    );

    res.status(200).json(
      new apiResponse(200, result, 'Doctors retrieved successfully')
    );
  });

  /**
   * POST /admin/doctors
   * Create new doctor (admin)
   */
  createDoctor = asyncHandler(async (req: Request, res: Response) => {
    const { firstName, lastName, email, phone, primarySpecialization, secondarySpecializations, nmcRegistrationNumber, stateRegistrationNumber } = req.body;
    const adminId = req.user?.id;

    if (!firstName || !lastName || !email) {
      throw new apiError(400, 'First name, last name, and email are required');
    }

    const doctor = await DoctorService.registerDoctor(
      {
        firstName,
        lastName,
        email,
        phone,
        primarySpecialization,
        secondarySpecializations,
        nmcRegistrationNumber,
        stateRegistrationNumber
      },
      adminId
    );

    res.status(201).json(
      new apiResponse(201, doctor, 'Doctor created successfully')
    );
  });

  /**
   * POST /admin/doctors/:doctorId/verify
   * Verify doctor registration
   */
  verifyDoctor = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;
    const adminId = req.user?.id;

    if (!adminId) {
      throw new apiError(401, 'Unauthorized');
    }

    const doctor = await DoctorService.verifyDoctor(doctorId, adminId);

    res.status(200).json(
      new apiResponse(200, doctor, 'Doctor verified successfully')
    );
  });

  /**
   * POST /admin/doctors/:doctorId/suspend
   * Suspend doctor account
   */
  suspendDoctor = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;
    const { reason } = req.body;

    const doctor = await DoctorService.suspendDoctor(doctorId, reason);

    res.status(200).json(
      new apiResponse(200, doctor, 'Doctor suspended successfully')
    );
  });

  /**
   * GET /hospitals/:hospitalId/doctors
   * Get hospital's doctors
   */
  getHospitalDoctors = asyncHandler(async (req: Request, res: Response) => {
    const { hospitalId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const result = await DoctorService.getHospitalDoctors(
      hospitalId,
      parseInt(page as string),
      parseInt(limit as string)
    );

    res.status(200).json(
      new apiResponse(200, result, 'Hospital doctors retrieved successfully')
    );
  });

  /**
   * POST /doctors/:doctorId/share-links
   * Generate shareable link for doctor profile
   */
  generateShareLink = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;
    const { expiresInDays } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    const shareLink = await DoctorService.generateShareLink(
      doctorId,
      userId,
      expiresInDays
    );

    res.status(201).json(
      new apiResponse(201, shareLink, 'Share link generated successfully')
    );
  });

  /**
   * GET /doctors/:doctorId/share-links
   * List share links for doctor
   */
  getShareLinks = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    const shareLinks = await DoctorService.getShareLinks(doctorId, userId);

    res.status(200).json(
      new apiResponse(200, shareLinks, 'Share links retrieved successfully')
    );
  });

  /**
   * DELETE /doctors/:doctorId/share-links/:linkId
   * Revoke share link
   */
  revokeShareLink = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId, linkId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    await DoctorService.revokeShareLink(doctorId, linkId, userId);

    res.status(200).json(
      new apiResponse(200, null, 'Share link revoked successfully')
    );
  });

  /**
   * GET /public/doctor/:token
   * Access public doctor profile via share link
   */
  accessPublicProfile = asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params;

    if (!token) {
      throw new apiError(400, 'Share token required');
    }

    const profile = await DoctorService.accessPublicProfile(token);

    res.status(200).json(
      new apiResponse(200, profile, 'Profile accessed via share link')
    );
  });

  /**
   * GET /doctors/public/directory
   * Get public doctor directory (search/filter)
   */
  getPublicDirectory = asyncHandler(async (req: Request, res: Response) => {
    const { query, specialization, status, page = 1, limit = 12 } = req.query;

    const result = await DoctorService.getPublicDirectory(
      query as string,
      specialization as string,
      status as string,
      parseInt(page as string),
      parseInt(limit as string)
    );

    res.status(200).json(
      new apiResponse(200, result, 'Public directory retrieved successfully')
    );
  });

  /**
   * POST /doctors/:doctorId/docs
   * Upload documents for doctor attributes
   */
  uploadDoctorDocuments = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;
    const files = (req as any).files || [];
    const customNames = req.body?.customNames || [];

    if (!doctorId) {
      throw new apiError(400, 'Doctor ID is required');
    }

    if (!files || files.length === 0) {
      throw new apiError(400, 'No files provided');
    }

    // For now, return mock document IDs
    // In a real implementation, you would save files to S3 or storage
    const documents = files.map((file: any, index: number) => ({
      id: `doc_${Date.now()}_${index}`,
      fileName: customNames[index] || file.originalname,
      fileSize: file.size,
      mimeType: file.mimetype,
      uploadedAt: new Date().toISOString()
    }));

    res.status(201).json(
      new apiResponse(201, { documents }, 'Documents uploaded successfully')
    );
  });

  /**
   * GET /doctors/:doctorId/docs
   * Get documents for doctor attributes
   */
  getDoctorDocuments = asyncHandler(async (req: Request, res: Response) => {
    const { doctorId } = req.params;

    if (!doctorId) {
      throw new apiError(400, 'Doctor ID is required');
    }

    // Return empty documents list for now
    res.status(200).json(
      new apiResponse(200, { documents: [] }, 'Documents retrieved')
    );
  });

  /**
   * POST /doctors/:doctorId/docs
   * Upload documents for doctor
   */
  uploadDoc = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    console.log('[DOCTOR DOC UPLOAD] ===== START =====');
    try {
      const { doctorId } = req.params;
      // upload.any() puts files in req.files (array); also fall back to req.file
      const filesArr = (req.files as Express.Multer.File[] | undefined) || [];
      const file = filesArr[0] || (req.file as Express.Multer.File | undefined);
      const userId = req.user?.id;

      // Derive metadata from body, with safe defaults so legacy callers still work
      const documentName: string =
        req.body.documentName || req.body.name || (file?.originalname ?? 'document');
      const documentCategory: string = req.body.documentCategory || 'general';
      const documentType: string = req.body.documentType || 'other';
      const attributeKey: string | undefined = req.body.attributeKey;

      console.log('[DOCTOR DOC UPLOAD] doctorId:', doctorId);
      console.log('[DOCTOR DOC UPLOAD] userId:', userId);
      console.log('[DOCTOR DOC UPLOAD] file:', file ? {
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        bufferLength: file.buffer?.length || 0
      } : 'undefined');
      console.log('[DOCTOR DOC UPLOAD] body:', { documentName, documentCategory, documentType, attributeKey });

      if (!userId) throw new apiError(401, 'No user found, please log in again');
      if (!doctorId) throw new apiError(400, 'Doctor ID is required');
      if (!file) throw new apiError(400, 'No file provided');

      // Verify doctor exists
      console.log('[DOCTOR DOC UPLOAD] Verifying doctor exists...');
      const doctorData = await pool.query(
        `SELECT id FROM doctors WHERE id = $1`,
        [doctorId]
      );
      console.log('[DOCTOR DOC UPLOAD] Doctor query result:', doctorData.rowCount);

      if ((doctorData.rowCount ?? 0) === 0) {
        throw new apiError(404, 'Doctor not found');
      }

      try {
        const timestamp = Date.now();
        const ext = file.originalname.includes('.')
          ? file.originalname.substring(file.originalname.lastIndexOf('.'))
          : '';

        const safeNameForSuffix = documentName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        const newFileName = `${safeNameForSuffix}_${timestamp}${ext}`;

        const s3Key = `doctors/${doctorId}/${newFileName}`;

        // Get file buffer (multer with memory storage populates file.buffer)
        const fileBuffer = file.buffer;
        console.log('[DOCTOR DOC UPLOAD] File buffer size:', fileBuffer?.length || 0, 'bytes');

        if (!fileBuffer || fileBuffer.length === 0) {
          throw new Error('File buffer is empty - no data to upload');
        }

        // Upload to S3
        console.log('[DOCTOR DOC UPLOAD] Uploading to S3:', s3Key);
        const { s3Url } = await S3Service.upload(
          s3Key,
          fileBuffer,
          file.mimetype
        );
        console.log('[DOCTOR DOC UPLOAD] S3 upload successful, s3Url:', s3Url);

        // Save to doctor_doc (doctor-specific document storage)
        console.log('[DOCTOR DOC UPLOAD] Inserting into doctor_doc...');
        const dbResult = await pool.query(
          `INSERT INTO doctor_doc
             (doctor_id, name, s3_key, s3_link, file_name, file_size, mime_type, storage_provider)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 's3')
           RETURNING *`,
          [
            doctorId,
            documentName,
            s3Key,
            s3Url,
            newFileName,
            file.size,
            file.mimetype,
          ]
        );
        console.log('[DOCTOR DOC UPLOAD] DB insert result rows:', dbResult.rowCount);

        const document = dbResult.rows[0];

        console.log('[DOCTOR DOC UPLOAD] SUCCESS - documentId:', document.id);

        res.status(201).json(
          new apiResponse(201, {
            id: document.id,
            name: documentName,
            fileName: newFileName,
            s3Url: s3Url,
            mimeType: file.mimetype,
            size: file.size
          }, 'Document uploaded successfully')
        );
      } catch (error: any) {
        console.error('[DOCTOR DOC UPLOAD] INNER ERROR:', error.message);
        console.error('[DOCTOR DOC UPLOAD] INNER STACK:', error.stack);
        throw new apiError(500, `Document upload failed: ${error.message}`);
      }
    } catch (outerError: any) {
      console.error('[DOCTOR DOC UPLOAD] OUTER ERROR:', outerError.message);
      console.error('[DOCTOR DOC UPLOAD] OUTER STACK:', outerError.stack);
      throw outerError;
    }
  });

  /**
   * GET /doctors/:doctorId/docs
   * Get documents for doctor
   */
  getDocs = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId } = req.params;
    const userId = req.user?.id;

    if (!userId) throw new apiError(401, 'No user found, please log in again');
    if (!doctorId) throw new apiError(400, 'Doctor ID is required');

    const query = `
      SELECT id, name, s3_key, s3_link, drive_link, file_name, file_size,
             mime_type, storage_provider, created_at
      FROM doctor_doc
      WHERE doctor_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [doctorId]);

    const docsWithUrls = result.rows.map((doc: any) => {
      const isS3 = doc.storage_provider === 's3' && doc.s3_key;
      let viewUrl = doc.drive_link || doc.s3_link;

      // NOTE: Do NOT call S3Service.getPresignedUrl here — the CloudFront key signing
      // can throw an OpenSSL DECODER error if the private key isn't loaded. The frontend
      // will fetch a signed URL on demand (matches hospital pattern).
      if (isS3 && !viewUrl) {
        viewUrl = doc.s3_link;
      }

      return {
        id: doc.id,
        name: doc.name || doc.file_name,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
        webViewLink: viewUrl,
        thumbnailLink: viewUrl,
        storageProvider: doc.storage_provider,
        createdTime: doc.created_at,
        proxyLink: isS3 ? `/api/v1/doctors/docs/proxy/${doc.id}` : null,
      };
    });

    res.status(200).json(
      new apiResponse(200, docsWithUrls, 'Documents fetched successfully')
    );
  });

  /**
   * GET /doctors/:doctorId/docs/:documentId/download
   * Download doctor document file content
   */
  downloadDoc = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { doctorId, documentId } = req.params;
    const userId = req.user?.id;

    if (!userId) throw new apiError(401, 'No user found, please log in again');
    if (!doctorId) throw new apiError(400, 'Doctor ID is required');
    if (!documentId) throw new apiError(400, 'Document ID is required');

    // Fetch document from database
    const docResult = await pool.query(
      `SELECT id, doctor_id, file_name, mime_type, s3_key, storage_provider
       FROM doctor_doc
       WHERE id = $1 AND doctor_id = $2`,
      [documentId, doctorId]
    );

    if ((docResult.rowCount ?? 0) === 0) {
      throw new apiError(404, 'Document not found');
    }

    const doc = docResult.rows[0];

    // Fetch from S3 if stored there
    if (doc.storage_provider === 's3' && doc.s3_key) {
      try {
        const buffer = await S3Service.download(doc.s3_key);

        // Set response headers for download
        res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
        res.setHeader('Content-Length', buffer.length);

        return res.send(buffer);
      } catch (error: any) {
        console.error('[DOCTOR DOC DOWNLOAD] Failed to download from S3:', error.message);
        throw new apiError(500, 'Failed to download document from S3');
      }
    }

    throw new apiError(400, 'Document storage location not found');
  });

  /**
   * DELETE /doctors/:doctorId/docs/:documentId
   * Delete doctor document
   */
  deleteDoc = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { documentId } = req.params;
    const userId = req.user?.id;

    if (!userId) throw new apiError(401, 'No user found, please log in again');
    if (!documentId) throw new apiError(400, 'Document ID is required');

    const docResult = await pool.query(
      `SELECT id, s3_key, storage_provider FROM doctor_doc WHERE id=$1`,
      [documentId]
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

    await pool.query(`DELETE FROM doctor_doc WHERE id = $1`, [documentId]);

    res.status(200).json(
      new apiResponse(200, null, 'Document deleted successfully')
    );
  });
}

export default new DoctorController();
