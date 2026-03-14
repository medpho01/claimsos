import { parentPort, workerData } from 'worker_threads'
import driveHandler from '../Services/driveUploader.service.js'
import PDFHandler from '../Services/pdfConverter.service.js'
import { compressWithGS } from './gsCompress.worker.js'
import S3Service from '../Services/s3.service.js'
import fs from 'fs'
import path from 'path'
import { pool } from '../DB/db.js'

const DriveHandler = new driveHandler()
const pdfHandler = new PDFHandler()

/**
 * Process a single category: download images → create PDF → compress → upload → DB record.
 * Returns an array of temp file paths created during processing (for cleanup).
 */
const processCategory = async (
  category: string,
  fileKeys: string[],
  ctx: { patientId: string; hospitalId: string; panelId: string; categoryMap: Map<string, string> }
): Promise<string[]> => {
  const { patientId, hospitalId, panelId, categoryMap } = ctx
  const tempFiles: string[] = []
  const timestamp = Date.now()

  console.log(`[Worker] Processing category: ${category} (${fileKeys.length} files)`)

  // A. Download all images for this category from S3 (parallel within category)
  const imgPaths: string[] = []

  const downloadPromises = fileKeys.map(async (key) => {
    try {
      const ext = path.extname(key) || '.jpg'
      const localDest = `src/Public/${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`

      const buffer = await S3Service.download(key)
      fs.writeFileSync(localDest, buffer)
      imgPaths.push(localDest)
    } catch (err) {
      console.error(`[Worker] Failed to download ${key}:`, err)
    }
  })

  await Promise.all(downloadPromises)
  tempFiles.push(...imgPaths)

  if (imgPaths.length === 0) return tempFiles

  // B. Generate PDF
  const rawPdfPath = `src/Public/raw_${patientId}_${category}_${timestamp}.pdf`
  let optimizedPdfPath = `src/Public/${patientId}_${category}_${timestamp}.pdf`

  try {
    await pdfHandler.createPdfFromImages(imgPaths, rawPdfPath)
    tempFiles.push(rawPdfPath)

    // C. Compress PDF
    optimizedPdfPath = await compressWithGS(rawPdfPath, optimizedPdfPath)
    tempFiles.push(optimizedPdfPath)

    // D. Upload to S3
    const fileName = `${timestamp}_${category}_generated.pdf`
    const s3Key = `${hospitalId}/${panelId}/${patientId}/${category}/${fileName}`

    try {
      const fileBuffer = fs.readFileSync(optimizedPdfPath)
      await S3Service.upload(s3Key, fileBuffer, 'application/pdf')
      console.log(`[Worker] Uploaded PDF to S3: ${s3Key}`)
    } catch (s3Error) {
      console.error(`[Worker] S3 Upload failed (continuing to Drive):`, s3Error)
    }

    let driveFileId: string | null = null
    let driveLink: string | null = null

    // E. Upload to Google Drive (Legacy/User Access)
    const targetDriveFolderId = categoryMap.get(category)
    if (targetDriveFolderId) {
      try {
        const driveResult = await DriveHandler.uploadAndGetLink(
          optimizedPdfPath,
          'application/pdf',
          targetDriveFolderId,
          `${category}_${timestamp}.pdf`
        )
        driveFileId = driveResult.fileId || null
        driveLink = driveResult.directLink || null
      } catch (driveErr) {
        console.error(`[Worker] Drive Upload failed:`, driveErr)
      }
    } else {
      console.warn(`[Worker] No Drive folder found for category '${category}'. Skipping Drive upload.`)
    }

    // F. Store in DB
    try {
      await pool.query(
        `INSERT INTO ipd_doc 
            (ipd_id, s3_key, s3_link, drive_link, type, file_name, file_size, mime_type, storage_provider, drive_backup_status, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 's3', $9, NOW())`,
        [
          patientId,
          s3Key,
          `https://${process.env.AWS_S3_BUCKET || 'hospital-app-images'}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Key}`,
          driveLink,
          category,
          `${category}_generated.pdf`,
          fs.statSync(optimizedPdfPath).size,
          'application/pdf',
          driveLink ? 'completed' : 'failed'
        ]
      )
      console.log(`[Worker] DB Record inserted for ${category} PDF`)
    } catch (dbErr) {
      console.error(`[Worker] DB Insert failed:`, dbErr)
    }

  } catch (err) {
    console.error(`[Worker] Error processing category ${category}:`, err)
  }

  return tempFiles
}

/**
 * Worker to generate PDFs from Patient Photos
 * Source: S3 (Primary)
 * Destination: S3 (Backup) + Google Drive (Backup)
 *
 * All categories are processed in PARALLEL
 */
const run = async () => {
  const { folderId, patientId, hospitalId, panelId } = workerData

  let tempFilesToDelete: string[] = []

  try {
    // 1. Get Categories (Folders) from Drive
    const subfolders = await DriveHandler.getFolders(folderId)
    const categoryMap = new Map<string, string>()
    subfolders.forEach((f: any) => categoryMap.set(f.name, f.fileId))

    console.log(`[Worker] Starting PDF generation for patient ${patientId}`)
    console.log(`[Worker] Found ${subfolders.length} categories`)

    // 2. Fetch all S3 files for this patient
    const s3Files = await S3Service.listPatientFiles(hospitalId, panelId, patientId)

    // 3. Group S3 files by category
    // Key format: hospitalId/panelId/patientId/CATEGORY/filename
    const filesByCategory: Record<string, string[]> = {}

    s3Files.forEach((file: any) => {
      if (file.Key.toLowerCase().endsWith('.pdf')) return
      const parts = file.Key.split('/')
      if (parts.length >= 5) {
        const category = parts[3]
        if (!filesByCategory[category]) filesByCategory[category] = []
        filesByCategory[category].push(file.Key)
      }
    })

    // 4. Filter categories to process
    const categoriesToProcess = Object.entries(filesByCategory).filter(
      ([category, fileKeys]) => {
        if (fileKeys.length === 0) return false
        if (category === 'admission' || category === 'admission_files') {
          console.log(`[Worker] Skipping PDF generation for category: ${category}`)
          return false
        }
        return true
      }
    )

    console.log(`[Worker] Processing ${categoriesToProcess.length} categories in parallel`)

    // 5. Process ALL categories in parallel
    const results = await Promise.all(
      categoriesToProcess.map(([category, fileKeys]) =>
        processCategory(category, fileKeys, { patientId, hospitalId, panelId, categoryMap })
      )
    )

    // Merge temp files from all categories for cleanup
    results.forEach(tempFiles => tempFilesToDelete.push(...tempFiles))

    parentPort?.postMessage({ status: 'success' })

  } catch (error: any) {
    console.error("[Worker] Fatal error:", error)
    parentPort?.postMessage({ status: 'error', error: error.message || error })
  } finally {
    // Cleanup local files - ALWAYS runs, even on errors
    const uniqueFilesToDelete = [...new Set(tempFilesToDelete)]
    if (uniqueFilesToDelete.length > 0) {
      console.log(`[Worker] Cleaning up ${uniqueFilesToDelete.length} temp files`)
      uniqueFilesToDelete.forEach((elem: string) => {
        if (fs.existsSync(elem)) {
          try {
            fs.unlinkSync(elem)
          } catch (err) {
            console.log('Failed to delete temp file: ', elem, err)
          }
        }
      })
    }
  }
}

run()

