import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
// Drive disabled (May 23, 2026) — uploads write to S3 only. The
// content_hash column stays (used by the intelligence-layer dedup
// pipeline); drive_backup_status defaults to 'skipped' so the existing
// NOT NULL constraint is satisfied without invoking any Drive code.
import NotificationBufferService from './notificationBuffer.service.js';
import {pool} from "../DB/db.js"
import { compressWithGS } from '../Workers/gsCompress.worker.js';
import S3Service from '../Services/s3.service.js'
import { logger } from '../Utils/logger.js';

const QUEUE_STATE_FILE = path.resolve('./queue_state.json'); // Persistence file

interface UploadJob {
  type:string|null;
  patientId: string|null;
  patientName: string; // Added for notifications
  filePath: string;
  fileName: string;
  mimeType: string;
  folderId: string;
  hospital_group_id: string;
  retryCount: number;
}

class GlobalUploadQueue {
  private queue: UploadJob[] = [];
  private isProcessing: boolean = false;

  private readonly MAX_RETRIES = 5;
  private readonly BASE_WAIT_TIME = 2000;

  constructor() {
    this.loadState();
  }

  private saveState() {
    try {
      fs.writeFileSync(QUEUE_STATE_FILE, JSON.stringify(this.queue, null, 2));
    } catch (err) {
      logger.error({ err }, 'UploadQueue: failed to save state');
    }
  }

  private loadState() {
    if (fs.existsSync(QUEUE_STATE_FILE)) {
      try {
        const data = fs.readFileSync(QUEUE_STATE_FILE, 'utf-8');
        this.queue = JSON.parse(data);
        logger.info({ count: this.queue.length }, 'UploadQueue: restored jobs from disk');

        if (this.queue.length > 0) {
          this.processNext();
        }
      } catch (err) {
        logger.error({ err }, 'UploadQueue: failed to load state');
      }
    }
  }

  public add(jobData: Omit<UploadJob, 'retryCount'>) {
    this.queue.push({ ...jobData, retryCount: 0 });
    this.saveState();

    // Count total files for this patient in the queue
    const patientFileCount = this.queue.filter(
      job => job.patientId === jobData.patientId && job.hospital_group_id === jobData.hospital_group_id
    ).length;

    // Note: patientName is PII; log only ids/counts.
    logger.info(
      { patientId: jobData.patientId, hospitalGroupId: jobData.hospital_group_id, patientFileCount },
      'UploadQueue: added file for patient'
    );
    this.processNext();
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const job = this.queue[0];

    if (!job || !fs.existsSync(job.filePath)) {
      logger.error({ filePath: job?.filePath }, 'UploadQueue: file missing on disk, skipping');
      this.handleFatalError(job!, "Local file not found during recovery");
      return;
    }

    // Count remaining files for this patient
    const remainingForPatient = this.queue.filter(
      qJob => qJob.patientId === job.patientId && qJob.hospital_group_id === job.hospital_group_id
    ).length;

    // Note: patientName is PII; log only ids/counts.
    logger.info(
      { fileName: job.fileName, patientId: job.patientId, remainingForPatient },
      'UploadQueue: uploading file'
    );

    try {
      if (job.mimeType.includes("pdf")) {
        const tempPath = `${job.filePath}.compressed`;
        await compressWithGS(job.filePath, tempPath);
        
        if (fs.existsSync(tempPath)) {
          fs.renameSync(tempPath, job.filePath);
        }
      }
      const patientRes = await pool.query("select hospital_id,first_name,last_name,panel_id from ipds where id = $1",[job.patientId])
      if(patientRes.rowCount == 0)return;
      const patient = patientRes.rows[0];
      // 1. Generate S3 key
      const s3Key = S3Service.generateKey(
                    patient.hospital_id,
                    patient.panel_id,
                    job.patientId as string,
                    job.type as string,
                    job?.fileName,
                    job.mimeType
                  )
      
      // 2. Read + hash. SHA-256 of the raw bytes is the dedup key for
      //    Layer 1: if the SAME patient (ipd_id) already has a row with
      //    this content_hash, we skip S3 upload + INSERT and reuse the
      //    existing doc. Stops bit-identical re-uploads from creating
      //    parallel classify + extract pipelines that produce different
      //    LLM outputs for the same content.
      const fileBuffer = fs.readFileSync(job.filePath);
      const contentHash = createHash('sha256').update(fileBuffer).digest('hex');

      const dupCheck = await pool.query<{ id: string; s3_key: string }>(
        `SELECT id, s3_key
           FROM hospital.ipd_doc
          WHERE ipd_id = $1
            AND content_hash = $2
          LIMIT 1`,
        [job.patientId, contentHash],
      );
      if ((dupCheck.rowCount ?? 0) > 0) {
        const existing = dupCheck.rows[0]!;
        logger.info(
          {
            patientId: job.patientId,
            content_hash: contentHash,
            existing_doc_id: existing.id,
            existing_s3_key: existing.s3_key,
            attempted_file_name: job.fileName,
          },
          'UploadQueue: content_hash hit — skipping duplicate upload',
        );
        // Still call handleSuccess so the queue advances + temp file is
        // cleaned up. The caller doesn't get a new id back, which is
        // fine — they only ever fired-and-forgot via UploadQueue.add().
        this.handleSuccess(job as UploadJob, '');
        return;
      }

      // 3. Upload to S3 (only reached when not a duplicate).
      const { s3Url } = await S3Service.upload(
                              s3Key,
                              fileBuffer,
                              job.mimeType
                            )
      const dbResult = await pool.query(
                                `INSERT INTO ipd_doc
                   (ipd_id, s3_key, s3_link, type, file_name, file_size, mime_type,
                     storage_provider, drive_backup_status, drive_link, content_hash)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 's3', 'skipped', $8, $9)
                   RETURNING id`,
                                [
                                    job.patientId,
                                    job.mimeType.includes("image")?s3Key.replace("uploads/","")+".webp":s3Key,
                                    s3Url,
                                    job.type,
                                    job.fileName,
                                    fileBuffer.length,
                                    job.mimeType,
                                    null, // drive_link — Drive disabled
                                    contentHash,
                                ]
                            )

      if (job?.hospital_group_id && job?.patientId) {
        let presignedUrl = await S3Service.getPresignedUrl(job.mimeType.includes("image")?s3Key.replace("uploads/","")+".webp":s3Key);
        NotificationBufferService.add(
          job.hospital_group_id,
          job.patientId,
          `${patient.first_name} ${patient.last_name}`,
          {
            link: presignedUrl,
            mimeType: job.mimeType,
          }
        )
      }

      logger.debug({ mimeType: job.mimeType }, 'UploadQueue: completed upload');
      this.handleSuccess(job as UploadJob, ''); // Drive disabled — no shareLink

    } catch (error: any) {
      const errorMsg = error.message || JSON.stringify(error);

      if (errorMsg.includes('403') || errorMsg.includes('429') || errorMsg.includes('Rate Limit')) {
        this.handleRateLimit(job as UploadJob);
      } else {
        this.handleFatalError(job as UploadJob, errorMsg);
      }
    }
  }

  private handleSuccess(job: UploadJob, fileId: string) {
    this.queue.shift();
    this.saveState();

    fs.unlink(job.filePath, (err) => {
      if (err) logger.error({ err, filePath: job.filePath }, 'UploadQueue: failed to delete local file');
    });

    // Check if there are any more files for this patient in the remaining queue
    const hasMoreFilesForPatient = this.queue.some(
      queuedJob => queuedJob.patientId === job.patientId && queuedJob.hospital_group_id === job.hospital_group_id
    );

    if (!hasMoreFilesForPatient && job.patientId && job.hospital_group_id) {
      // This was the last file for this patient - trigger immediate flush
      // Note: patientName is PII; log only ids.
      logger.info({ fileName: job.fileName, patientId: job.patientId }, 'UploadQueue: file uploaded');
      logger.info(
        { patientId: job.patientId, hospitalGroupId: job.hospital_group_id },
        'UploadQueue: all files uploaded for patient, triggering WhatsApp notification'
      );
      NotificationBufferService.checkAndFlushForPatient(job.hospital_group_id, job.patientId);
    } else {
      // Note: patientName is PII; log only ids.
      logger.info(
        { fileName: job.fileName, patientId: job.patientId },
        'UploadQueue: file uploaded, more files pending for patient'
      );
    }

    this.isProcessing = false;
    setImmediate(() => this.processNext());
  }

  private handleRateLimit(job: UploadJob) {
    if (job.retryCount >= this.MAX_RETRIES) {
      logger.error({ fileName: job.fileName, retryCount: job.retryCount }, 'UploadQueue: max retries reached, dropping job');
      this.queue.shift();
      this.saveState();
      this.isProcessing = false;
      this.processNext();
      return;
    }

    job.retryCount++;
    this.saveState();

    const waitTime = this.BASE_WAIT_TIME * Math.pow(2, job.retryCount);
    logger.warn({ waitTimeMs: waitTime, retryCount: job.retryCount }, 'UploadQueue: rate-limited, waiting before retry');

    setTimeout(() => {
      logger.info('UploadQueue: resuming after rate-limit wait');
      this.isProcessing = false;
      this.processNext();
    }, waitTime);
  }

  private handleFatalError(job: UploadJob, error: string) {
    logger.error({ err: error, fileName: job.fileName, patientId: job.patientId }, 'UploadQueue: fatal error for job');
    this.queue.shift();
    this.saveState();
    this.isProcessing = false;
    this.processNext();
  }
}

export const UploadQueue = new GlobalUploadQueue();