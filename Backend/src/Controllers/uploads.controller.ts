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
        'select folder_id from patients where id = $1 and hospital_id = $2 ',
        [patientId, user.id]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(
          400,
          'No patient data available for the patient id in the hospital'
        )

      const folderId = patientRes.rows[0].folder_id

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
      const { folderId } = req.body

      console.log(
        `[UPLOAD] Starting upload of ${files.length} file(s) to folder: ${folderId}`
      )

      let patientData: any = null
      try {
        const patientResult = await pool.query(
          'SELECT first_name, last_name, phone, admitted_at FROM PATIENTS WHERE folder_id = $1',
          [folderId]
        )
        if ((patientResult.rowCount ?? 0) > 0) {
          patientData = patientResult.rows[0]
        }
      } catch (err) {
        console.error('Failed to fetch patient details:', err)
        throw new apiError(500, 'Failed to fetch patient details')
      }

      // Send WhatsApp Summary if needed
      const hospitalGroupId = (req.user as any)?.hospital_group_id
      if (hospitalGroupId && patientData) {
        try {
          const p = patientData
          const message =
            `*New Patient Documents Uploaded*\n\n` +
            `*Name:* ${p.first_name} ${p.last_name}\n` +
            `*Phone:* ${p.phone}\n` +
            `*Files:* ${files.length} images attached below`

          console.log(
            `  [WHATSAPP] Sending patient summary to group ${hospitalGroupId}...`
          )
          await ultraMsgService.sendMessage(hospitalGroupId, message)
        } catch (err) {
          console.error('  Failed to send summary:', err)
        }
      }

      let successCount = 0
      let errorCount = 0

      const uploadPromises = files.map(async (file) => {
        try {
          console.log(`  Uploading: ${file.filename}...`)
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

          const driveResponse = await DriveHandler.uploadAndGetLink(
            file?.path,
            file?.mimetype,
            folderId,
            finalFileName
          )
          console.log(`  Uploaded: ${file.filename}`)

          const hospitalGroupId = (req.user as any)?.hospital_group_id
          if (hospitalGroupId) {
            console.log(
              `  [WHATSAPP] Sending image to group ${hospitalGroupId}...`
            )

            if (driveResponse && driveResponse.directLink) {
              const caption = patientData
                ? `${patientData.first_name} ${patientData.last_name} (${patientData.phone})`
                : ''

              await ultraMsgService.sendImage(
                hospitalGroupId,
                driveResponse.directLink,
                caption
              )
            } else {
              await ultraMsgService.sendMessage(
                hospitalGroupId,
                `Image: ${file.filename} (Link unavailable)`
              )
            }
          }

          successCount++

          fs.unlink(file?.path, (err) => {
            if (err)
              console.error(`  Could not delete temp file: ${file.filename}`)
          })
        } catch (error) {
          console.error(`  Upload failed for ${file.filename}:`, error)
          errorCount++
        }
      })

      await Promise.all(uploadPromises)

      console.log(
        `[UPLOAD] Complete: ${successCount} succeeded, ${errorCount} failed`
      )
      res
        .status(201)
        .json(
          new apiResponse(
            201,
            { filesUploaded: successCount, filesFailed: errorCount },
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
        'select folder_id from patients where id = $1 and hospital_id = $2 ',
        [patientId, user.id]
      )
      if (patientRes.rowCount == 0)
        throw new apiError(
          400,
          'No patient data available for the patient id in the hospital'
        )

      const folderId = patientRes.rows[0].folder_id

      const files = req.files as
        | { [fieldname: string]: Express.Multer.File[] }
        | undefined
      if (!files) throw new apiError(400, 'No files recieved')
      const uploads = []
      for (let folder in files) {
        uploads.push(
          (async () => {
            if (!files[folder] || files[folder].length == 0) return
            const driveFolders = await DriveHandler.getFolders(folderId)
            let child_folder_id: any = null
            driveFolders.forEach((elem) => {
              if (elem.name == folder) child_folder_id = elem
            })
            if (!child_folder_id)
              child_folder_id = await DriveHandler.createFolder(
                folder,
                folderId
              )
            const uploadPromises = files[folder].map(async (file) => {
              try {
                console.log(`  Uploading: ${file.filename}...`)
                let finalFileName = FileName.imageName(folder, '', '')
                const driveResponse = await DriveHandler.uploadAndGetLink(
                  file?.path,
                  file?.mimetype,
                  child_folder_id.fileId || '',
                  finalFileName
                )
                console.log(`  Uploaded: ${file.filename}`)
              } catch (error) {
                console.error(`  Upload failed for ${file.filename}:`, error)
              }
            })
            // const generatePDF = this.generateCompressedPdf(
            //   files[folder].map((elem) => elem.path),
            //   `src/public/result_${Date.now()}.pdf`,
            //   child_folder_id.fileId || '',
            //   folder
            // )
            // uploadPromises.push(generatePDF)
            await Promise.all(uploadPromises)
            files[folder].forEach((elem) => {
              fs.unlink(elem.path, (err) => {
                if (err) console.error(`  Could not delete temp file:`, err)
              })
            })
          })()
        )
      }

      await Promise.all(uploads)
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

      // Verify the folder belongs to a patient of this hospital
      const checkOwnership = await pool.query(
        'SELECT folder_id FROM patients WHERE id = $1 AND hospital_id = $2',
        [patientId, userId]
      )

      if (checkOwnership.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }
      const folderId = checkOwnership.rows[0].folder_id
      if (category == 'all') {
        console.log(`[LIST PHOTOS] Fetching photos from folder: ${folderId}`)
        const files = await DriveHandler.listFiles(folderId)
        console.log(`[LIST PHOTOS] Found ${files.length} files`)
        res
          .status(200)
          .json(new apiResponse(200, files, 'Photos fetched successfully'))
      } else {
        const driveFolders = await DriveHandler.getFolders(folderId);
        console.log(driveFolders);
        let child_folder: any = null
        driveFolders.forEach((elem) => {
          if (elem.name == category?.toLowerCase().replaceAll(' ', '_')) child_folder = elem;
        })

        if (!child_folder) res.status(200).json(new apiResponse(200, [], "Images fetched successfully"));
        const files = await DriveHandler.listFiles(child_folder?.fileId);
        res.status(200).json(new apiResponse(200, files, "Images fetched successfully"));
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
        patientQuery = 'SELECT folder_id, first_name, last_name, admission_type FROM patients WHERE id = $1'
        queryParams = [patientId]
      } else if (userRole === 'admin') {
        // Admin can only access patients from assigned hospitals
        patientQuery = `
          SELECT p.folder_id, p.first_name, p.last_name, p.admission_type 
          FROM patients p
          JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
          WHERE p.id = $1 AND ha.admin_id = $2 AND ha.is_active = true AND ha.can_view = true
        `
        queryParams = [patientId, userId]
      } else {
        throw new apiError(403, 'Unauthorized. Admin or Superadmin access required.')
      }

      const patientResult = await pool.query(patientQuery, queryParams)

      if (patientResult.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }

      const folderId = patientResult.rows[0].folder_id
      const admissionType = patientResult.rows[0].admission_type

      if (!folderId) {
        // No folder yet, return empty structure
        res.status(200).json(new apiResponse(200, {
          rootPhotos: [],
          categories: [],
          admissionType
        }, 'No photos folder found'))
        return
      }

      console.log(`[LIST PHOTOS ADMIN] Fetching photos from folder: ${folderId}`)

      // Fetch root level photos
      const rootFiles = await DriveHandler.listFiles(folderId)
      console.log(`[LIST PHOTOS ADMIN] Found ${rootFiles.length} root files`)

      // Fetch subfolders
      const subFolders = await DriveHandler.getFolders(folderId)
      console.log(`[LIST PHOTOS ADMIN] Found ${subFolders.length} subfolders`)

      // Field name mapping for display
      const fieldNames: Record<string, string> = {
        discharge_slip: 'Discharge Slip',
        investigations: 'Investigations',
        treatment: 'Treatment',
        icps: 'ICPs',
        surgical_discharge_slip: 'Surgical Discharge Slip',
        ot_notes_and_photos: 'OT Notes and Photos',
        post_op_photo: 'Post Op Photos',
        post_op_reports: 'Post Op Reports',
        implant_invoice: 'Implant Invoice'
      }

      // Fetch photos from each subfolder
      const categories = await Promise.all(
        subFolders.map(async (folder: any) => {
          const photos = await DriveHandler.listFiles(folder.fileId)
          return {
            id: folder.fileId,
            name: folder.name,
            displayName: fieldNames[folder.name] || folder.name,
            photos: photos
          }
        })
      )

      // Filter out empty categories
      const nonEmptyCategories = categories.filter(cat => cat.photos.length > 0)

      res.status(200).json(new apiResponse(200, {
        rootPhotos: rootFiles,
        categories: nonEmptyCategories,
        admissionType
      }, 'Photos fetched successfully'))
    }
  )

  deletePhoto = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { fileId } = req.params
      const { folderId } = req.body
      const userId = req.user?.id

      if (!userId) throw new apiError(401, 'No user found please Log in again')
      if (!fileId) throw new apiError(400, 'File ID is required')
      if (!folderId)
        throw new apiError(400, 'Folder ID is required for verification')

      // Verify the folder belongs to a patient of this hospital
      const checkOwnership = await pool.query(
        'SELECT id FROM patients WHERE folder_id = $1 AND hospital_id = $2',
        [folderId, userId]
      )

      if (checkOwnership.rowCount === 0) {
        throw new apiError(404, 'Patient not found or unauthorized')
      }

      console.log(`[DELETE PHOTO] Deleting file: ${fileId}`)
      await DriveHandler.deleteFile(fileId)
      console.log(`[DELETE PHOTO] File deleted successfully`)

      res
        .status(200)
        .json(new apiResponse(200, null, 'Photo deleted successfully'))
    }
  )

  generateCompressedPdf = (
    imagePaths: string[],
    outputDestination: string,
    parentFolderId: string,
    docName: string
  ): Promise<void> => {
    return new Promise((resolve, reject) => {
      const workerPath = path.resolve(
        __dirname,
        '../Workers/pdfConverter.worker.ts'
      )

      const worker = new Worker(workerPath, {
        workerData: {
          imagePaths,
          finalOutputPath: outputDestination,
        },
        execArgv: ['--loader', 'ts-node/esm', '--no-warnings'],
      })

      worker.on('message', async (msg) => {
        if (msg.status === 'success') {
          await DriveHandler.uploadAndGetLink(
            msg.filePath,
            'application/pdf',
            parentFolderId,
            docName
          )
          fs.unlink(msg.filePath, (err) => {
            if (err) console.log("Couldn't delete the file ", err)
          })
          resolve()
        } else reject(new Error(msg.error))
      })

      worker.on('error', reject)
      worker.on('exit', (code) => {
        if (code !== 0)
          reject(new Error(`Worker stopped with exit code ${code}`))
      })
    })
  }
}

export default uploadsController
