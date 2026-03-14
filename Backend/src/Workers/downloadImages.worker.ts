import { parentPort, workerData } from 'worker_threads'
import driveHandler from '../Services/driveUploader.service.js'
import PDFHandler from '../Services/pdfConverter.service.js'
import { compressWithGS } from './gsCompress.worker.js'
import S3Service from '../Services/s3.service.js'
import fs from 'fs'
import { pool } from '../DB/db.js'

const DriveHandler = new driveHandler()
const pdfHandler = new PDFHandler()

/**
 * Concurrency limiter — runs at most `limit` async tasks at a time.
 */
const withConcurrency = <T>(limit: number, tasks: (() => Promise<T>)[]): Promise<T[]> => {
  return new Promise((resolve, reject) => {
    const results: T[] = new Array(tasks.length)
    let running = 0
    let nextIndex = 0
    let completed = 0

    const runNext = () => {
      while (running < limit && nextIndex < tasks.length) {
        const idx = nextIndex++
        const task = tasks[idx]
        if (!task) continue
        running++
        task()
          .then(result => {
            results[idx] = result
            running--
            completed++
            if (completed === tasks.length) resolve(results)
            else runNext()
          })
          .catch(reject)
      }
    }
    if (tasks.length === 0) resolve([])
    else runNext()
  })
}

/**
 * Process a single category using pre-downloaded image buffers.
 * Creates PDF → compresses → uploads to S3 + Drive → inserts DB record.
 * Returns temp file paths for cleanup.
 */
const processCategory = async (
  category: string,
  imgBuffers: Buffer[],
  ctx: { patientId: string; hospitalId: string; panelId: string; categoryMap: Map<string, string> }
): Promise<string[]> => {
  const { patientId, hospitalId, panelId, categoryMap } = ctx
  const tempFiles: string[] = []
  const timestamp = Date.now()
  const categoryStart = Date.now()

  if (imgBuffers.length === 0) return tempFiles

  // A. Generate PDF from buffers (no download needed — already in memory)
  const rawPdfPath = `src/Public/raw_${patientId}_${category}_${timestamp}.pdf`
  let optimizedPdfPath = `src/Public/${patientId}_${category}_${timestamp}.pdf`
  let stepStart = Date.now()

  try {
    await pdfHandler.createPdfFromImages(imgBuffers, rawPdfPath)
    console.log(`[Worker]   [${category}] Sharp + PDF creation: ${((Date.now() - stepStart) / 1000).toFixed(1)}s (${imgBuffers.length} images)`)
    tempFiles.push(rawPdfPath)

    // B. Compress PDF
    stepStart = Date.now()
    optimizedPdfPath = await compressWithGS(rawPdfPath, optimizedPdfPath)
    console.log(`[Worker]   [${category}] Ghostscript compress: ${((Date.now() - stepStart) / 1000).toFixed(1)}s`)
    tempFiles.push(optimizedPdfPath)

    // C. Upload to S3
    const fileName = `${timestamp}_${category}_generated.pdf`
    const s3Key = `${hospitalId}/${panelId}/${patientId}/${category}/${fileName}`

    try {
      stepStart = Date.now()
      const fileBuffer = fs.readFileSync(optimizedPdfPath)
      await S3Service.upload(s3Key, fileBuffer, 'application/pdf')
      console.log(`[Worker]   [${category}] S3 Upload: ${((Date.now() - stepStart) / 1000).toFixed(1)}s`)
    } catch (s3Error) {
      console.error(`[Worker] S3 Upload failed (continuing to Drive):`, s3Error)
    }

    let driveFileId: string | null = null
    let driveLink: string | null = null

    // D. Upload to Google Drive (Legacy/User Access)
    const targetDriveFolderId = categoryMap.get(category)
    if (targetDriveFolderId) {
      try {
        stepStart = Date.now()
        const driveResult = await DriveHandler.uploadAndGetLink(
          optimizedPdfPath,
          'application/pdf',
          targetDriveFolderId,
          `${category}_${timestamp}.pdf`
        )
        console.log(`[Worker]   [${category}] Drive Upload: ${((Date.now() - stepStart) / 1000).toFixed(1)}s`)
        driveFileId = driveResult.fileId || null
        driveLink = driveResult.directLink || null
      } catch (driveErr) {
        console.error(`[Worker] Drive Upload failed:`, driveErr)
      }
    } else {
      console.warn(`[Worker] No Drive folder found for category '${category}'. Skipping Drive upload.`)
    }

    // E. Store in DB
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

  console.log(`[Worker] ⏱ Category '${category}' completed in ${((Date.now() - categoryStart) / 1000).toFixed(1)}s`)
  return tempFiles
}

/**
 * Worker to generate PDFs from Patient Photos
 * Source: S3 (Primary)
 * Destination: S3 (Backup) + Google Drive (Backup)
 *
 * Phase 1: Download ALL files from S3 in one batch (global concurrency limit)
 * Phase 2: Process categories in PARALLEL using pre-downloaded buffers
 */
const run = async () => {
  const { folderId, patientId, hospitalId, panelId } = workerData

  let tempFilesToDelete: string[] = []

  try {
    // 1. Get Categories (Folders) from Drive
    const subfolders = await DriveHandler.getFolders(folderId)
    const categoryMap = new Map<string, string>()
    subfolders.forEach((f: any) => categoryMap.set(f.name, f.fileId))

    const totalStart = Date.now()
    console.log(`[Worker] Starting PDF generation for patient ${patientId}`)
    console.log(`[Worker] Found ${subfolders.length} categories`)

    // 2. Fetch all S3 files for this patient
    const s3Files = await S3Service.listPatientFiles(hospitalId, panelId, patientId)

    // 3. Group S3 keys by category
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

    // 4. Filter categories
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

    // 5. PHASE 1: Download ALL files in one batch (max 10 concurrent)
    //    This prevents 5 categories from competing for bandwidth separately
    const allKeys: { category: string; key: string }[] = []
    categoriesToProcess.forEach(([category, fileKeys]) => {
      fileKeys.forEach(key => allKeys.push({ category, key }))
    })

    console.log(`[Worker] Phase 1: Downloading ${allKeys.length} files across ${categoriesToProcess.length} categories`)
    let stepStart = Date.now()

    const downloadTasks = allKeys.map(({ key }) => async () => {
      try {
        return await S3Service.download(key)
      } catch (err) {
        console.error(`[Worker] Failed to download ${key}:`, err)
        return null
      }
    })

    const downloadResults = await withConcurrency(10, downloadTasks)
    const downloadTime = ((Date.now() - stepStart) / 1000).toFixed(1)

    // Group downloaded buffers back by category
    const buffersByCategory: Record<string, Buffer[]> = {}
    allKeys.forEach(({ category }, idx) => {
      const buffer = downloadResults[idx]
      if (buffer) {
        if (!buffersByCategory[category]) buffersByCategory[category] = []
        buffersByCategory[category].push(buffer)
      }
    })

    const successCount = downloadResults.filter(b => b !== null).length
    console.log(`[Worker] Phase 1 complete: Downloaded ${successCount}/${allKeys.length} files in ${downloadTime}s`)

    // 6. PHASE 2: Process all categories in parallel (no downloads needed)
    console.log(`[Worker] Phase 2: Processing ${categoriesToProcess.length} categories in parallel`)

    const results = await Promise.all(
      categoriesToProcess.map(([category]) =>
        processCategory(category, buffersByCategory[category] || [], { patientId, hospitalId, panelId, categoryMap })
      )
    )

    // Merge temp files from all categories for cleanup
    results.forEach(tempFiles => tempFilesToDelete.push(...tempFiles))

    const totalPhotos = allKeys.length
    console.log(`[Worker] ⏱ Total PDF generation completed in ${((Date.now() - totalStart) / 1000).toFixed(1)}s | ${categoriesToProcess.length} categories | ${totalPhotos} photos`)
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


