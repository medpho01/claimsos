import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import S3Service from '../Services/s3.service.js'
import fileName from '../Utils/fileName.util.js'
import { UploadQueue } from '../Services/uploadQueue.service.js'

const FileName = new fileName()

// Mapping between document type folder names and display names.
// Keeps response shape consistent with the historical Drive listing.
const FIELD_NAMES: Record<string, string> = {
  discharge_slip: 'Discharge Slip',
  investigations: 'Investigations',
  treatment: 'Treatment',
  icps: 'ICPs',
  others: 'Others',
  surgical_discharge_slip: 'Surgical Discharge Slip',
  ot_notes_and_photos: 'OT Notes and Photos',
  post_op_photo: 'Post Op Photos',
  post_op_reports: 'Post Op Reports',
  implant_invoice: 'Implant Invoice',
}

/**
 * Convert an S3 object (from listPatientFiles) into the same shape the
 * Drive listing API used to return, so the FE keeps working unchanged.
 *  - id        : the s3 key (used as a stable identifier for the file)
 *  - name      : the original file name (last path segment)
 *  - mimeType  : best-effort guess from the file extension
 *  - webViewLink / thumbnailLink : CloudFront presigned URL
 */
const s3ObjectToFile = (obj: { Key?: string; Size?: number; LastModified?: Date }) => {
  const key = obj.Key || ''
  const parts = key.split('/')
  const name = parts[parts.length - 1] || key
  const ext = (name.split('.').pop() || '').toLowerCase()
  let mimeType = 'application/octet-stream'
  if (['jpg', 'jpeg'].includes(ext)) mimeType = 'image/jpeg'
  else if (ext === 'png') mimeType = 'image/png'
  else if (ext === 'webp') mimeType = 'image/webp'
  else if (ext === 'gif') mimeType = 'image/gif'
  else if (ext === 'pdf') mimeType = 'application/pdf'

  let link: string
  try {
    link = S3Service.getPresignedUrl(key)
  } catch {
    link = ''
  }

  return {
    id: key,
    fileId: key,
    name,
    mimeType,
    size: obj.Size,
    createdTime: obj.LastModified,
    webViewLink: link,
    thumbnailLink: link,
  }
}

class uploadsController {
  /**
   * Return file counts grouped by category (document type) for a patient.
   * Source: S3 (was: Google Drive subfolders).
   */
  getCounts = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const user = req.user
      const { patientId } = req.params
      if (!user || !patientId)
        throw new apiError(
          400,
          'Bad Request. Unauthourized or missing patient id.'
        )

      const patientRes = await pool.query(
        'select hospital_id, panel_id from ipds where id = $1',
        [patientId]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(
          400,
          'No patient data available for the patient id in the hospital'
        )

      const { hospital_id, panel_id } = patientRes.rows[0]

      const s3Files = await S3Service.listPatientFiles(
        hospital_id,
        panel_id,
        patientId
      )

      // Group by category. S3 key layout (mirrors S3Service.generateKey):
      //   [uploads/]<hospitalId>/<panelId>/<patientId>/<category>/<file>
      // The optional leading "uploads/" prefix means the category index is
      // 3 OR 4. Detect by checking for the prefix.
      const counts: Record<string, number> = {}
      s3Files.forEach((file: any) => {
        const key: string = file.Key || ''
        const parts = key.split('/')
        const offset = parts[0] === 'uploads' ? 1 : 0
        const category = parts[3 + offset]
        if (!category) return
        counts[category] = (counts[category] || 0) + 1
      })

      res
        .status(200)
        .json(new apiResponse(200, counts, 'Counts fetched successfully'))
    }
  )

  upload = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const filesRaw = (req as any).files as
        | Express.Multer.File[]
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined

      const files: Express.Multer.File[] = Array.isArray(filesRaw)
        ? filesRaw
        : Object.values(filesRaw ?? {}).flat()
      const { patientId } = req.body

      const patientResult = await pool.query(
        'SELECT first_name, last_name, phone, admitted_at, hospital_panel_id FROM IPDS WHERE id = $1',
        [patientId]
      )

      if (patientResult.rowCount == 0) throw new apiError(400, "No patient found with the provided id");

      const patientData = patientResult.rows[0]

      console.log(
        `[UPLOAD] Starting upload of ${files.length} for patient: ${patientId}`
      )

      // Send WhatsApp Summary if needed
      const whatsappRes = await pool.query("select id,whatsapp_group_id from hospital_panels where id = $1", [patientData.hospital_panel_id]);
      if (whatsappRes.rowCount == 0) throw new apiError(400, "No panel is associated with the patient or corrupted data");
      const hospitalGroupId = whatsappRes.rows[0].whatsapp_group_id;
      // Notification is now handled by UploadQueue + NotificationBuffer

      files.forEach((file) => {
        let finalFileName = file.filename
        if (patientData) {
          const ext = file.originalname.split('.').pop() || 'jpg'
          const baseName = FileName.imageName(
            patientData.first_name,
            patientData.last_name,
            patientData.phone
          )
          finalFileName = `${baseName}_${Math.floor(Math.random() * 1000)}.${ext}`
        }
        UploadQueue.add({
          type: "admission",
          patientId: patientId,
          patientName: `${patientData.first_name} ${patientData.last_name}`,
          filePath: file?.path,
          fileName: finalFileName,
          mimeType: file?.mimetype,
          folderId: '', // Drive removed — unused by S3 queue
          hospital_group_id: hospitalGroupId,
        })
      })

      await pool.query("update ipds set updated_at = NOW() where id = $1 returning id", [patientId]);

      res
        .status(201)
        .json(
          new apiResponse(
            201,
            { message: 'Files queued for uploads' },
            'Upload complete'
          )
        )
    }
  )

  uploadDischargePhotos = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { patientId } = req.body
      const user = req.user

      if (!user || !patientId)
        throw new apiError(
          400,
          'Bad Request. Unauthourized or missing patient id.'
        )

      const patientRes = await pool.query(
        'select first_name, last_name, hospital_panel_id from ipds where id = $1',
        [patientId]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(
          400,
          'No patient data available for the patient id in the hospital'
        )

      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined
      if (!files) throw new apiError(400, 'No files recieved')

      // Send WhatsApp Summary if needed
      const whatsappRes = await pool.query("select id,whatsapp_group_id from hospital_panels where id = $1", [patientRes.rows[0].hospital_panel_id]);
      if (whatsappRes.rowCount == 0) throw new apiError(400, "No panel is associated with the patient or corrupted data");
      const hospitalGroupId = whatsappRes.rows[0].whatsapp_group_id;

      for (let folder in files) {
        if (!files[folder] || files[folder].length == 0) return
        files[folder].map(async (file) => {
          const finalFileName = FileName.imageName(folder, '', '')
          UploadQueue.add({
            type: folder,
            patientId: patientId,
            patientName: `${patientRes.rows[0].first_name} ${patientRes.rows[0].last_name}`,
            filePath: file?.path,
            fileName: finalFileName,
            mimeType: file?.mimetype,
            folderId: '', // Drive removed
            hospital_group_id: hospitalGroupId,
          })
        })
      }

      await pool.query("update ipds set updated_at = NOW() where id = $1 returning id", [patientId]);

      res
        .status(201)
        .json(
          new apiResponse(
            201,
            { message: 'Data uploaded successfully' },
            'Data uploaded successfully'
          )
        )
    }
  )

  /**
   * List photos for a patient. If category is "all" returns every file under
   * the patient prefix in S3; otherwise filters to a single category subprefix.
   * Source: S3 (was: Google Drive).
   */
  listPhotos = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { patientId, category } = req.params
      const userId = req.user?.id

      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!patientId) throw new apiError(400, 'Patient ID is required')

      const patientRes = await pool.query(
        'SELECT hospital_id, panel_id FROM ipds WHERE id = $1',
        [patientId]
      )

      if (patientRes.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }

      const { hospital_id, panel_id } = patientRes.rows[0]

      if (category == 'all') {
        const s3Files = await S3Service.listPatientFiles(
          hospital_id,
          panel_id,
          patientId
        )
        const files = s3Files.map(s3ObjectToFile)
        console.log(`[LIST PHOTOS] Found ${files.length} files`)
        res
          .status(200)
          .json(new apiResponse(200, files, 'Photos fetched successfully'))
      } else {
        const normalizedCategory = category?.toLowerCase().replaceAll(' ', '_')
        const s3Files = await S3Service.listPatientFiles(
          hospital_id,
          panel_id,
          patientId,
          normalizedCategory
        )
        const files = s3Files.map(s3ObjectToFile)
        res
          .status(200)
          .json(new apiResponse(200, files, 'Images fetched successfully'))
      }
    }
  )

  // List photos for admin/superadmin users - includes subfolders
  listPhotosForAdmin = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { patientId } = req.params
      const userId = req.user?.id
      const userRole = req.user?.role

      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!patientId) throw new apiError(400, 'Patient ID is required')

      // Get patient info
      let patientQuery = ''
      let queryParams: any[] = []

      if (userRole === 'superadmin') {
        patientQuery =
          'SELECT hospital_id, panel_id, first_name, last_name, admission_type FROM ipds WHERE id = $1'
        queryParams = [patientId]
      } else if (userRole === 'admin') {
        patientQuery = `
          SELECT p.hospital_id, p.panel_id, p.first_name, p.last_name, p.admission_type
          FROM ipds p
          JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
          WHERE p.id = $1 AND ha.admin_id = $2 AND ha.can_view = true
        `
        queryParams = [patientId, userId]
      } else if (userRole === 'hospital') {
        patientQuery = `
          SELECT p.hospital_id, p.panel_id, p.first_name, p.last_name, p.admission_type
          FROM ipds p
          JOIN hospital_users hu ON p.hospital_id = hu.hospital_id
          WHERE p.id = $1 AND hu.user_id = $2
        `
        queryParams = [patientId, userId]
      } else {
        throw new apiError(403, 'Unauthorized. Access denied.')
      }

      const patientResult = await pool.query(patientQuery, queryParams)

      if (patientResult.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }

      const { hospital_id, panel_id } = patientResult.rows[0]
      const admissionType = patientResult.rows[0].admission_type?.toLowerCase() || 'conservative'

      // Define expected categories based on admission type
      const COMMON_FOLDERS = ['discharge_slip', 'investigations', 'treatment', 'icps', 'others'];
      const SURGICAL_FOLDERS = [
        'surgical_discharge_slip',
        'ot_notes_and_photos',
        'post_op_photo',
        'post_op_reports',
        'implant_invoice'
      ];

      const expectedFolders = (admissionType.includes('surgical') || admissionType === 'surgical')
        ? SURGICAL_FOLDERS
        : COMMON_FOLDERS;

      if (!hospital_id || !panel_id) {
        // Patient has no hospital/panel — return virtual empty structure.
        const categories = expectedFolders.map(name => ({
          id: null,
          name: name,
          displayName: FIELD_NAMES[name] || name,
          photos: []
        }));

        res.status(200).json(
          new apiResponse(
            200,
            {
              rootPhotos: [],
              categories: categories,
              admissionType,
            },
            'No photos folder found (Virtual Structure Created)'
          )
        )
        return
      }

      console.log(
        `[LIST PHOTOS ADMIN] Fetching photos for patient: ${patientId} (hospital ${hospital_id}, panel ${panel_id})`
      )

      // Fetch all S3 files for the patient in one shot, then group by category.
      const s3Files = await S3Service.listPatientFiles(hospital_id, panel_id, patientId)

      // Group by category key (parts[3] relative to the patient prefix).
      const filesByCategory = new Map<string, any[]>()
      const rootPhotos: any[] = []

      s3Files.forEach((file: any) => {
        const key: string = file.Key || ''
        const parts = key.split('/')
        const offset = parts[0] === 'uploads' ? 1 : 0
        const category = parts[3 + offset]
        if (!category) return
        // Anything immediately under the patient prefix is root; deeper is a
        // category. With the current generateKey scheme everything has a
        // category — keep rootPhotos for backwards compat (will usually be []).
        if (parts.length === 4 + offset) {
          rootPhotos.push(s3ObjectToFile(file))
          return
        }
        if (!filesByCategory.has(category)) filesByCategory.set(category, [])
        filesByCategory.get(category)!.push(s3ObjectToFile(file))
      })

      // Build the categories array — start from expected folders (so empty
      // ones still surface for upload UI), then merge in anything actually
      // present in S3.
      const categoryMap = new Map<string, any>()
      expectedFolders.forEach(name => {
        categoryMap.set(name, {
          id: null,
          name: name,
          displayName: FIELD_NAMES[name] || name,
          photos: [],
        })
      })

      filesByCategory.forEach((photos, name) => {
        categoryMap.set(name, {
          id: name,
          name,
          displayName: FIELD_NAMES[name] || name,
          photos,
        })
      })

      const categories = Array.from(categoryMap.values())
      const finalCategories = categories.filter(
        (cat) => cat.photos.length > 0 || expectedFolders.includes(cat.name)
      )

      res.status(200).json(
        new apiResponse(
          200,
          {
            rootPhotos,
            categories: finalCategories,
            admissionType,
          },
          'Photos fetched successfully'
        )
      )
    }
  )

  /**
   * Delete a photo by S3 key (passed as :fileId path param, URL-encoded).
   * Source: S3 (was: Google Drive).
   */
  deletePhoto = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { fileId } = req.params
      const { patientId } = req.body

      if (!fileId || !patientId) throw new apiError(400, 'File ID and patient ID are required')

      // fileId is the S3 key — may be URL-encoded.
      const s3Key = decodeURIComponent(fileId)

      console.log(`[DELETE PHOTO] Deleting S3 object: ${s3Key}`)
      await S3Service.delete(s3Key)

      // Best-effort: clean up any ipd_doc row that referenced this key.
      await pool.query(
        `DELETE FROM ipd_doc WHERE s3_key = $1 AND ipd_id = $2`,
        [s3Key, patientId]
      )

      res
        .status(200)
        .json(new apiResponse(200, null, 'Photo deleted successfully'))
    }
  )

  // Delete photo for admin/superadmin users
  deletePhotoForAdmin = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { fileId } = req.params
      const userId = req.user?.id
      const userRole = req.user?.role

      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!fileId) throw new apiError(400, 'File ID is required')

      const s3Key = decodeURIComponent(fileId)

      console.log(`[DELETE PHOTO ADMIN] Deleting S3 object: ${s3Key} by ${userRole}: ${userId}`)
      await S3Service.delete(s3Key)

      // Best-effort: clean up the matching ipd_doc row if present.
      await pool.query(`DELETE FROM ipd_doc WHERE s3_key = $1`, [s3Key])

      res
        .status(200)
        .json(new apiResponse(200, null, 'Photo deleted successfully'))
    }
  )

  /**
   * v1 generatePDFs is retired. The previous implementation spawned the
   * downloadImages worker which round-tripped through Google Drive. With
   * Drive removed and no v1-shaped S3-only PDF pipeline available, the v2
   * endpoint should be used instead.
   *
   * FE call site that still hits this route: webapp/src/services/api.ts:218
   * (`/uploads/generatePDF/${id}`). FE should migrate to the v2 equivalent.
   */
  generatePDFs = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      throw new apiError(
        410,
        'PDF generation via v1 has been retired along with the Google Drive integration. Please use the v2 PDF generation endpoint.'
      )
    }
  )

  // Upload files for admin/superadmin users with optional category
  uploadForAdmin = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const filesRaw = (req as any).files as
        | Express.Multer.File[]
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined

      const files: Express.Multer.File[] = Array.isArray(filesRaw)
        ? filesRaw
        : Object.values(filesRaw ?? {}).flat()

      const { patientId, category, customName } = req.body
      const userId = req.user?.id
      const userRole = req.user?.role

      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!patientId) throw new apiError(400, 'Patient ID is required')

      // Verify hospital user has access to this patient
      if (userRole === 'hospital') {
        const accessCheck = await pool.query(
          `SELECT hu.role, p.panel_id
           FROM hospital_users hu
           INNER JOIN ipds p ON hu.hospital_id = p.hospital_id
           WHERE hu.user_id = $1 AND p.id = $2`,
          [userId, patientId]
        )
        if (accessCheck.rowCount === 0) {
          throw new apiError(403, 'Access denied. You do not have access to this patient.')
        }
        const userRoles = accessCheck.rows[0].role || []
        const patientPanelId = accessCheck.rows[0].panel_id
        if (!userRoles.includes('admin') && !userRoles.includes(patientPanelId)) {
          throw new apiError(403, 'Access denied. You do not have access to this panel.')
        }
      }

      if (!files || files.length === 0) {
        throw new apiError(400, 'No files received')
      }

      // Get patient info
      const patientRes = await pool.query(
        'SELECT first_name, last_name, phone, hospital_panel_id FROM ipds WHERE id = $1',
        [patientId]
      )

      if (patientRes.rowCount === 0) {
        throw new apiError(404, 'Patient not found')
      }

      const patientData = patientRes.rows[0]

      console.log(
        `[UPLOAD ADMIN] Starting upload of ${files.length} files for patient: ${patientId} by ${userRole}: ${userId}${customName ? ` with custom name: ${customName}` : ''}`
      )

      // Get WhatsApp group for notifications
      let hospitalGroupId = null
      if (patientData.hospital_panel_id) {
        const whatsappRes = await pool.query(
          'SELECT whatsapp_group_id FROM hospital_panels WHERE id = $1',
          [patientData.hospital_panel_id]
        )
        if (whatsappRes.rowCount && whatsappRes.rowCount > 0) {
          hospitalGroupId = whatsappRes.rows[0].whatsapp_group_id
        }
      }

      // Queue files for upload
      files.forEach((file) => {
        const ext = file.originalname.split('.').pop() || 'jpg'
        const baseName = FileName.imageName(
          patientData.first_name,
          patientData.last_name,
          patientData.phone || '',
          customName // Pass optional custom name
        )
        const finalFileName = `${baseName}_${Math.floor(Math.random() * 1000)}.${ext}`

        UploadQueue.add({
          type: (category && category !== 'all') ? category : "admission",
          patientId: patientId,
          patientName: `${patientData.first_name} ${patientData.last_name}`,
          filePath: file.path,
          fileName: finalFileName,
          mimeType: file.mimetype,
          folderId: '', // Drive removed
          hospital_group_id: hospitalGroupId,
        })
      })

      // Update patient's updated_at timestamp
      await pool.query(
        'UPDATE ipds SET updated_at = NOW() WHERE id = $1',
        [patientId]
      )

      console.log(`[UPLOAD ADMIN] ${files.length} files queued for upload`)

      res.status(201).json(
        new apiResponse(
          201,
          { message: `${files.length} file(s) queued for upload` },
          'Upload initiated successfully'
        )
      )
    }
  )

  /**
   * Stream a file from S3 (used as an image / PDF proxy).
   * Source: S3 (was: Google Drive). fileId here is the S3 key, URL-encoded.
   */
  getThumbnail = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { fileId } = req.params

      if (!fileId) throw new apiError(400, 'File ID is required')

      const s3Key = decodeURIComponent(fileId)

      try {
        const buffer = await S3Service.download(s3Key)

        // Best-effort content type from extension.
        const ext = (s3Key.split('.').pop() || '').toLowerCase()
        let contentType = 'application/octet-stream'
        if (['jpg', 'jpeg'].includes(ext)) contentType = 'image/jpeg'
        else if (ext === 'png') contentType = 'image/png'
        else if (ext === 'webp') contentType = 'image/webp'
        else if (ext === 'gif') contentType = 'image/gif'
        else if (ext === 'pdf') contentType = 'application/pdf'

        res.setHeader('Content-Type', contentType)
        res.setHeader('Content-Length', buffer.length)
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
        res.setHeader('ETag', `"${s3Key}"`)
        res.send(buffer)
      } catch (error) {
        console.error(`[PROXY] Failed to stream S3 object ${s3Key}:`, error)
        throw new apiError(404, 'File not found or inaccessible')
      }
    }
  )

  renameFiles = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { patientId, customName, files } = req.body;
    if (!patientId || files.length == 0 || !customName) {
      throw new apiError(401, "All details are required");
    }
    console.log(`[FILES RENAMING] patientId:${patientId}`)
    for (let file of files) {
      const parts = file.fileName?.split("_") as Array<string>;
      const last = parts.pop() as string;
      const Slast = parts.pop() as string;
      parts.push(customName, Slast, last);
      const newName = parts.join("_").replaceAll(" ", "_");
      const docRes = await pool.query("update ipd_doc set file_name = $1 where id = $2 returning id", [newName, file.fileId]);
      if (docRes.rowCount == 0) throw new apiError(500, "No file exists or failed to rename");
    }
    console.log(`[FILES RENAMED] patientId:${patientId}`)
    res.status(201).json(new apiResponse(201, null, "Files renamed succesfully"));
  })
}

export default uploadsController
