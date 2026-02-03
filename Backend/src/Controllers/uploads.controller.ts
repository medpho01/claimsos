import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import driveHandler from '../Services/driveUploader.service.js'
import ultraMsgService from '../Services/ultraMsg.service.js'
import fileName from '../Utils/fileName.util.js'
import fs from 'fs'
import { Worker } from 'worker_threads'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'
import { UploadQueue } from '../Services/uploadQueue.service.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DriveHandler = new driveHandler()
const FileName = new fileName()

class uploadsController {
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
        'select drive_folder_id from ipds where id = $1',
        [patientId]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(
          400,
          'No patient data available for the patient id in the hospital'
        )

      const folderId = patientRes.rows[0].drive_folder_id

      const Counts = await DriveHandler.getImageCounts(folderId)
      res
        .status(200)
        .json(new apiResponse(200, Counts, 'Counts fetched successfully'))
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
        'SELECT first_name, last_name, phone, admitted_at, drive_folder_id,hospital_panel_id FROM IPDS WHERE id = $1',
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
          folderId: patientData.drive_folder_id,
          hospital_group_id: hospitalGroupId,
        })
      })

      const result = await pool.query("update ipds set updated_at = NOW() where id = $1 returning id", [patientId]);

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
        'select first_name, last_name, drive_folder_id,hospital_panel_id from ipds where id = $1',
        [patientId]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(
          400,
          'No patient data available for the patient id in the hospital'
        )

      const folderId = patientRes.rows[0].drive_folder_id

      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined
      if (!files) throw new apiError(400, 'No files recieved')

      // Send WhatsApp Summary if needed
      const whatsappRes = await pool.query("select id,whatsapp_group_id from hospital_panels where id = $1", [patientRes.rows[0].hospital_panel_id]);
      if (whatsappRes.rowCount == 0) throw new apiError(400, "No panel is associated with the patient or corrupted data");
      const hospitalGroupId = whatsappRes.rows[0].whatsapp_group_id;

      const driveFolders = await DriveHandler.getFolders(folderId)
      for (let folder in files) {
        if (!files[folder] || files[folder].length == 0) return
        let child_folder_id: any = null
        driveFolders.forEach((elem) => {
          if (elem.name == folder) child_folder_id = elem
        })
        if (!child_folder_id)
          child_folder_id = await DriveHandler.createFolder(folder, folderId)
        files[folder].map(async (file) => {
          const finalFileName = FileName.imageName(folder, '', '')
          UploadQueue.add({
            type: folder,
            patientId: patientId,
            patientName: `${patientRes.rows[0].first_name} ${patientRes.rows[0].last_name}`,
            filePath: file?.path,
            fileName: finalFileName,
            mimeType: file?.mimetype,
            folderId: child_folder_id.fileId,
            hospital_group_id: hospitalGroupId,
          })
        })
      }

      const result = await pool.query("update ipds set updated_at = NOW() where id = $1 returning id", [patientId]);

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

  listPhotos = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { patientId, category } = req.params
      const userId = req.user?.id

      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!patientId) throw new apiError(400, 'Patient ID is required')

      const patientRes = await pool.query(
        'SELECT drive_folder_id FROM ipds WHERE id = $1',
        [patientId]
      )

      if (patientRes.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }
      const folderId = patientRes.rows[0].drive_folder_id
      if (category == 'all') {
        console.log(`[LIST PHOTOS] Fetching photos from folder: ${folderId}`)
        const files = await DriveHandler.listFiles(folderId)
        console.log(`[LIST PHOTOS] Found ${files.length} files`)
        res
          .status(200)
          .json(new apiResponse(200, files, 'Photos fetched successfully'))
      } else {
        const driveFolders = await DriveHandler.getFolders(folderId)
        let child_folder: any = null
        driveFolders.forEach((elem) => {
          if (elem.name == category?.toLowerCase().replaceAll(' ', '_'))
            child_folder = elem
        })

        if (!child_folder)
          res
            .status(200)
            .json(new apiResponse(200, [], 'Images fetched successfully'))
        const files = await DriveHandler.listFiles(child_folder?.fileId)
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

      // Get patient info including folder_id
      let patientQuery = ''
      let queryParams: any[] = []

      if (userRole === 'superadmin') {
        // Superadmin can access any patient
        patientQuery =
          'SELECT drive_folder_id, first_name, last_name, admission_type FROM ipds WHERE id = $1'
        queryParams = [patientId]
      } else if (userRole === 'admin') {
        // Admin can only access ipds from assigned hospitals
        patientQuery = `
          SELECT p.drive_folder_id, p.first_name, p.last_name, p.admission_type 
          FROM ipds p
          JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
          WHERE p.id = $1 AND ha.admin_id = $2 AND ha.is_active = true AND ha.can_view = true
        `
        queryParams = [patientId, userId]
      } else {
        throw new apiError(
          403,
          'Unauthorized. Admin or Superadmin access required.'
        )
      }

      const patientResult = await pool.query(patientQuery, queryParams)

      if (patientResult.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }

      const folderId = patientResult.rows[0].drive_folder_id
      const admissionType = patientResult.rows[0].admission_type?.toLowerCase() || 'conservative'

      // Define expected folders based on admission type
      const COMMON_FOLDERS = ['discharge_slip', 'investigations', 'treatment', 'icps', 'others'];
      const SURGICAL_FOLDERS = [
        ...COMMON_FOLDERS,
        'surgical_discharge_slip',
        'ot_notes_and_photos',
        'post_op_photo',
        'post_op_reports',
        'implant_invoice'
      ];

      const expectedFolders = (admissionType.includes('surgical') || admissionType === 'surgical')
        ? SURGICAL_FOLDERS
        : COMMON_FOLDERS;

      if (!folderId) {
        // Return mostly empty structure but with expected categories for upload
        const fieldNames: Record<string, string> = {
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

        const categories = expectedFolders.map(name => ({
          id: null,
          name: name,
          displayName: fieldNames[name] || name,
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
        `[LIST PHOTOS ADMIN] Fetching photos from folder: ${folderId}`
      )

      // Fetch root level photos
      const rootFiles = await DriveHandler.listFiles(folderId)

      // Fetch subfolders from Drive
      const subFolders = await DriveHandler.getFolders(folderId)

      // Field name mapping for display
      const fieldNames: Record<string, string> = {
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

      // Map to store Final Categories (ensuring uniqueness)
      // Key: folder name (e.g., 'discharge_slip')
      const categoryMap = new Map<string, any>();

      // 1. Initialize with EXPECTED folders (Empty/Virtual)
      expectedFolders.forEach(name => {
        categoryMap.set(name, {
          id: null, // Will be updated if found in Drive
          name: name,
          displayName: fieldNames[name] || name,
          photos: []
        });
      });

      // 2. Process ACTUAL folders from Drive (Update or Add)
      // Use parallel processing for fetching photos
      const actualCategories = await Promise.all(
        subFolders.map(async (folder: any) => {
          const photos = await DriveHandler.listFiles(folder.fileId)
          return {
            id: folder.fileId,
            name: folder.name,
            displayName: fieldNames[folder.name] || folder.name,
            photos: photos,
          }
        })
      );

      // Merge actual data into map
      actualCategories.forEach(cat => {
        categoryMap.set(cat.name, cat); // Overwrite virtual with actual
      });

      // 3. Convert to array (Preserves insertion order of expected folders + appended extra folders)
      const categories = Array.from(categoryMap.values());

      // 4. Filter: Keep a category IF (It has photos) OR (It is an expected folder)
      const finalCategories = categories.filter(
        (cat) => cat.photos.length > 0 || expectedFolders.includes(cat.name)
      )

      res.status(200).json(
        new apiResponse(
          200,
          {
            rootPhotos: rootFiles,
            categories: finalCategories,
            admissionType,
          },
          'Photos fetched successfully'
        )
      )
    }
  )

  deletePhoto = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { fileId } = req.params
      const { folderId, patientId } = req.body

      if (!fileId || !patientId) throw new apiError(400, 'File ID and patient ID are required')
      if (!folderId)
        throw new apiError(400, 'Folder ID is required for verification')


      console.log(`[DELETE PHOTO] Deleting file: ${fileId}`)
      await DriveHandler.deleteFile(fileId)
      console.log(`[DELETE PHOTO] File deleted successfully`)

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

      console.log(`[DELETE PHOTO ADMIN] Deleting file: ${fileId} by ${userRole}: ${userId}`)
      await DriveHandler.deleteFile(fileId)
      console.log(`[DELETE PHOTO ADMIN] File deleted successfully`)

      res
        .status(200)
        .json(new apiResponse(200, null, 'Photo deleted successfully'))
    }
  )

  generatePDFs = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { patientId } = req.params
      const user = req.user

      if (!user || !patientId)
        throw new apiError(
          400,
          'Bad Request. Unauthourized or missing patient id.'
        )

      const patientRes = await pool.query(
        'select drive_folder_id,hospital_id from ipds where id = $1 ',
        [patientId]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(400, 'No patient data available for the patient id')
      if (user.role == 'superadmin') {
      } else if (user.role == 'admin') {
        const hospitalRes = await pool.query(
          'select * from hospital_assignments where admin_id = $1 and hospital_id = $2',
          [user.id, patientRes.rows[0].hospital_id]
        )
        if (hospitalRes.rowCount == 0) {
          throw new apiError(403, 'Forbidden')
        }
      } else {
        throw new apiError(403, 'Forbidden')
      }
      const folderId = patientRes.rows[0].drive_folder_id

      const success = await this.downloadImages(folderId)
      if (success == 1)
        res
          .status(200)
          .json(new apiResponse(200, {}, 'PDFs generated successfully'))
      else
        res
          .status(500)
          .json(
            new apiResponse(500, {}, 'Some error occured while genrating pdfs')
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

      if (!files || files.length === 0) {
        throw new apiError(400, 'No files received')
      }

      // Get patient info
      const patientRes = await pool.query(
        'SELECT drive_folder_id, first_name, last_name, phone, hospital_panel_id FROM ipds WHERE id = $1',
        [patientId]
      )

      if (patientRes.rowCount === 0) {
        throw new apiError(404, 'Patient not found')
      }

      const patientData = patientRes.rows[0]
      let targetFolderId = patientData.drive_folder_id

      if (!targetFolderId) {
        throw new apiError(400, 'Patient does not have a drive folder')
      }

      console.log(
        `[UPLOAD ADMIN] Starting upload of ${files.length} files for patient: ${patientId} by ${userRole}: ${userId}${customName ? ` with custom name: ${customName}` : ''}`
      )

      // If category provided and not 'all', get or create subfolder
      if (category && category !== 'all') {
        const subFolders = await DriveHandler.getFolders(targetFolderId)
        let subFolder = subFolders.find((f: any) => f.name === category)

        if (!subFolder) {
          console.log(`[UPLOAD ADMIN] Creating subfolder: ${category}`)
          const newFolder = await DriveHandler.createFolder(category, targetFolderId)
          targetFolderId = newFolder.fileId
        } else {
          targetFolderId = subFolder.fileId
        }
      }

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

      // Send WhatsApp notification
      // WhatsApp notifications are now handled by UploadQueue -> NotificationBuffer

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
          folderId: targetFolderId,
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

  getThumbnail = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { fileId } = req.params

      if (!fileId) throw new apiError(400, 'File ID is required')

      try {
        const { stream, headers } = await DriveHandler.getFileStream(fileId)

        // Set content headers
        if (headers['content-type']) {
          res.setHeader('Content-Type', headers['content-type'])
        }
        if (headers['content-length']) {
          res.setHeader('Content-Length', headers['content-length'])
        }

        // Cache headers for 7 days (images don't change once uploaded)
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
        res.setHeader('ETag', `"${fileId}"`)

          // Pipe the stream
          ; (stream as any).pipe(res)
      } catch (error) {
        console.error(`[PROXY] Failed to stream file ${fileId}:`, error)
        throw new apiError(404, 'File not found or inaccessible')
      }
    }
  )

  downloadImages = (folderId: string) => {
    return new Promise((resolve, reject) => {
      const workerPath = path.resolve(
        __dirname,
        '../Workers/downloadImages.worker.js'
      )
      console.log(folderId)
      const worker = new Worker(workerPath, {
        workerData: {
          folderId,
        },
        execArgv: ['--loader', 'ts-node/esm', '--no-warnings'],
      })

      worker.on('message', async (msg) => {
        if (msg.status === 'success') {
          resolve(1)
        } else reject(new Error(msg.error))
      })

      worker.on('error', reject)
      worker.on('exit', (code) => {
        if (code !== 0)
          reject(new Error(`Worker stopped with exit code ${code}`))
      })
    })
  }


  renameFiles = asyncHandler(async(req:Request,res:Response,next:NextFunction)=>{
    const {patientId,customName,files} = req.body;
    if(!patientId || files.length == 0 || !customName ){
      throw new apiError(401,"All details are required");
    }
    console.log(fileName,patientId,customName);
    for(let file of files){
      const parts = file.fileName.split("_") as Array<string>;
      const last = parts.pop() as string;
      const Slast = parts.pop() as string;
      parts.push(customName,Slast,last);
      const newName = parts.join("_").replaceAll(" ","_");
      const res = await DriveHandler.renameFile(file?.fileId,newName);
    }
    res.status(201).json(new apiResponse(201,null,"Files renamed succesfully"));
  })
}

export default uploadsController
