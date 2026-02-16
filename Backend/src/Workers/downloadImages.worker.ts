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
 * Worker to generate PDFs from Patient Photos
 * Source: S3 (Primary)
 * Destination: S3 (Backup) + Google Drive (Backup)
 */
const run = async () => {
  // workerData now contains comprehensive patient info
  const { folderId, patientId, hospitalId, panelId } = workerData

  try {
    // 1. Get Categories (Folders) from Drive
    // and to know where to upload the final PDFs on Drive.
    const subfolders = await DriveHandler.getFolders(folderId)
    // Map: CategoryName -> DriveFolderID
    const categoryMap = new Map<string, string>();
    subfolders.forEach((f: any) => categoryMap.set(f.name, f.fileId));

    console.log(`[Worker] Starting PDF generation for patient ${patientId}`);
    console.log(`[Worker] Found ${subfolders.length} categories`);

    // 2. Fetch all S3 files for this patient
    // Returns array of objects { Key, LastModified, ... }
    const s3Files = await S3Service.listPatientFiles(hospitalId, panelId, patientId);

    // 3. Group S3 files by category
    // Key format: hospitalId/panelId/patientId/CATEGORY/filename
    const filesByCategory: Record<string, string[]> = {};

    s3Files.forEach((file: any) => {
      // Filter out existing PDFs to prevent recursive processing
      if (file.Key.toLowerCase().endsWith('.pdf')) return;

      const parts = file.Key.split('/');
      // Expected: [hospital, panel, patient, CATEGORY, filename]
      if (parts.length >= 5) {
        const category = parts[3]; // The category folder
        if (!filesByCategory[category]) filesByCategory[category] = [];
        filesByCategory[category].push(file.Key);
      }
    });

    const uploads = []
    let tempFilesToDelete: string[] = []

    // 4. Process each category
    for (const [category, fileKeys] of Object.entries(filesByCategory)) {
      if (fileKeys.length === 0) continue;

      // Skip PDF generation for Admission Files
      if (category === 'admission' || category === 'admission_files') {
        console.log(`[Worker] Skipping PDF generation for category: ${category}`);
        continue;
      }

      const timestamp = Date.now(); // Define timestamp here for shared use

      console.log(`[Worker] Processing category: ${category} (${fileKeys.length} files)`);

      // A. Download all images for this category from S3
      const imgPaths: string[] = []

      const downloadPromises = fileKeys.map(async (key) => {
        try {
          // Determine extension
          const ext = path.extname(key) || '.jpg';
          const localDest = `src/Public/${Date.now()}-${Math.random().toString(36).substring(7)}${ext}`;

          const buffer = await S3Service.download(key);
          fs.writeFileSync(localDest, buffer);
          imgPaths.push(localDest);
        } catch (err) {
          console.error(`[Worker] Failed to download ${key}:`, err);
        }
      });

      await Promise.all(downloadPromises);
      tempFilesToDelete.push(...imgPaths); // Mark for cleanup

      if (imgPaths.length === 0) continue;

      // B. Generate PDF
      const rawPdfPath = `src/Public/raw_${patientId}_${category}_${timestamp}.pdf`
      let optimizedPdfPath = `src/Public/${patientId}_${category}_${timestamp}.pdf`

      try {
        await pdfHandler.createPdfFromImages(imgPaths, rawPdfPath);
        tempFilesToDelete.push(rawPdfPath);

        // C. Compress PDF
        optimizedPdfPath = await compressWithGS(rawPdfPath, optimizedPdfPath);
        tempFilesToDelete.push(optimizedPdfPath);

        // D. Upload to S3 (Backup)
        // Format: hospitalId/panelId/patientId/category/timestamp_filename.pdf
        const fileName = `${timestamp}_${category}_generated.pdf`;
        const s3Key = `${hospitalId}/${panelId}/${patientId}/${category}/${fileName}`;

        try {
          const fileBuffer = fs.readFileSync(optimizedPdfPath);

          await S3Service.upload(s3Key, fileBuffer, 'application/pdf');
          console.log(`[Worker] Uploaded PDF to S3: ${s3Key}`);
        } catch (s3Error) {
          console.error(`[Worker] S3 Upload failed (continuing to Drive):`, s3Error);
        }

        let driveFileId: string | null = null;
        let driveLink: string | null = null;

        // E. Upload to Google Drive (Legacy/User Access)
        const targetDriveFolderId = categoryMap.get(category);
        if (targetDriveFolderId) {
          try {
            const driveResult = await DriveHandler.uploadAndGetLink(
              optimizedPdfPath,
              'application/pdf',
              targetDriveFolderId,
              `${category}_${timestamp}.pdf`
            );
            // uploads.push(uploadPromise); // We need to await it to get the ID for DB, or do we?
            // If we await here, we lose parallel drive uploads speed?
            // But we need the link for the DB if we want to store it.
            // Let's await it. PDF generation is already heavy/slow.
            // driveResult now contains fileId thanks to the update
            driveFileId = driveResult.fileId || null;
            driveLink = driveResult.directLink || null;
          } catch (driveErr) {
            console.error(`[Worker] Drive Upload failed:`, driveErr);
          }
        } else {
          console.warn(`[Worker] No Drive folder found for category '${category}'. Skipping Drive upload.`);
        }

        // F. Store in DB
        try {
          await pool.query(
            `INSERT INTO ipd_doc 
                (ipd_id, s3_key, s3_link, drive_link, type, file_name, file_size, mime_type, storage_provider, drive_backup_status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 's3', $9, NOW())`,
            [
              patientId,
              s3Key, // s3_key
              `https://${process.env.AWS_S3_BUCKET || 'hospital-app-images'}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${s3Key}`, // s3_link
              driveLink,
              category, // type - keep same category so it shows in the folder
              `${category}_generated.pdf`, // file_name
              fs.statSync(optimizedPdfPath).size,
              'application/pdf',
              driveLink ? 'completed' : 'failed'
            ]
          );
          console.log(`[Worker] DB Record inserted for ${category} PDF`);
        } catch (dbErr) {
          console.error(`[Worker] DB Insert failed:`, dbErr);
        }

      } catch (err) {
        console.error(`[Worker] Error processing category ${category}:`, err);
      }
    }

    // Wait for all Drive uploads (if any were pushed to array - currently we await them inline to get IDs)
    // await Promise.all(uploads); 

    // Cleanup local files
    const uniqueFilesToDelete = [...new Set(tempFilesToDelete)];
    uniqueFilesToDelete.forEach((elem) => {
      if (fs.existsSync(elem)) {
        try {
          fs.unlinkSync(elem);
        } catch (err) {
          console.log('Failed to delete temp file: ', elem, err);
        }
      }
    });

    parentPort?.postMessage({ status: 'success' })

  } catch (error: any) {
    console.error("[Worker] Fatal error:", error);
    parentPort?.postMessage({ status: 'error', error: error.message || error })
  }
}

run()
