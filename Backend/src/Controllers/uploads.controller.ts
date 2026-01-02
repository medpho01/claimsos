import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import driveHandler from '../Services/driveUploader.service.js'
import ultraMsgService from '../Services/ultraMsg.service.js'
import fs from 'fs'

const DriveHandler = new driveHandler()

class uploadsController {
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

      console.log(`[UPLOAD] Starting upload of ${files.length} file(s) to folder: ${folderId}`);

      // Fetch patient details if sending to WhatsApp
      const hospitalGroupId = (req.user as any)?.hospital_group_id;
      if (hospitalGroupId) {
        try {
          const patientResult = await pool.query(
            "SELECT first_name, last_name, phone, admitted_at FROM PATIENTS WHERE folder_id = $1",
            [folderId]
          );

          if ((patientResult.rowCount ?? 0) > 0) {
            const p = patientResult.rows[0];
            const message = `*New Patient Documents Uploaded*\n\n` +
              `*Name:* ${p.first_name} ${p.last_name}\n` +
              `*Phone:* ${p.phone}\n` +
              `*Admitted:* ${new Date(p.admitted_at).toLocaleString()}\n` +
              `*Files:* ${files.length} images attached below`;

            console.log(`  [WHATSAPP] Sending patient summary to group ${hospitalGroupId}...`);
            await ultraMsgService.sendMessage(hospitalGroupId, message);
          }
        } catch (err) {
          console.error("  Failed to fetch patient details or send summary:", err);
        }
      }

      let successCount = 0;
      let errorCount = 0;

      const uploadPromises = files.map(async (file) => {
        try {
          console.log(`  Uploading: ${file.filename}...`);

          // 1. Upload to Drive (Always)
          const driveResponse = await DriveHandler.uploadAndGetLink(
            file?.path,
            file?.mimetype,
            folderId,
            file.filename
          );
          console.log(`  Uploaded: ${file.filename}`);

          const hospitalGroupId = (req.user as any)?.hospital_group_id;
          if (hospitalGroupId) {
            console.log(`  [WHATSAPP] Sending image to group ${hospitalGroupId}...`);

            // Send image without caption since we sent a summary above
            if (driveResponse && driveResponse.directLink) {
              await ultraMsgService.sendImage(
                hospitalGroupId,
                driveResponse.directLink,
                ""
              );
            } else {
              // Fallback if link is missing
              await ultraMsgService.sendMessage(hospitalGroupId, `Image: ${file.filename} (Link unavailable)`);
            }
          }

          successCount++;

          fs.unlink(file?.path, (err) => {
            if (err) console.error(`  Could not delete temp file: ${file.filename}`);
          })
        } catch (error) {
          console.error(`  Upload failed for ${file.filename}:`, error);
          errorCount++;
        }
      });

      await Promise.all(uploadPromises);

      console.log(`[UPLOAD] Complete: ${successCount} succeeded, ${errorCount} failed`);
      res.status(201).json(new apiResponse(201, { filesUploaded: successCount, filesFailed: errorCount }, 'Upload complete'))
    }
  )
}

export default uploadsController
