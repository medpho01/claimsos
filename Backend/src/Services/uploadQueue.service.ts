import fs from 'fs';
import path from 'path';
import driveHandler from './driveUploader.service.js';
import UltraMsgService from './ultraMsg.service.js';
import NotificationBufferService from './notificationBuffer.service.js';
import {pool} from "../DB/db.js"

const DriveHandler = new driveHandler();
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
      console.error('[Queue] Failed to save state:', err);
    }
  }

  private loadState() {
    if (fs.existsSync(QUEUE_STATE_FILE)) {
      try {
        const data = fs.readFileSync(QUEUE_STATE_FILE, 'utf-8');
        this.queue = JSON.parse(data);
        console.log(`[Queue] Restored ${this.queue.length} jobs from disk.`);

        if (this.queue.length > 0) {
          this.processNext();
        }
      } catch (err) {
        console.error('[Queue] Failed to load state:', err);
      }
    }
  }

  public add(jobData: Omit<UploadJob, 'retryCount'>) {
    this.queue.push({ ...jobData, retryCount: 0 });
    this.saveState();
    console.log(`[Queue] Job added. Pending: ${this.queue.length}`);
    this.processNext();
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const job = this.queue[0];

    if (!job || !fs.existsSync(job.filePath)) {
      console.error(`[Queue] File missing on disk: ${job?.filePath}. Skipping.`);
      this.handleFatalError(job!, "Local file not found during recovery");
      return;
    }

    console.log(`[Queue] Uploading: ${job?.fileName}...`);

    try {
      const fileId = await DriveHandler.uploadAndGetLink(
        job?.filePath || "",
        job?.mimeType || "",
        job?.folderId || "",
        job?.fileName || ""
      );
      await pool.query(`INSERT INTO ipd_doc (ipd_id,drive_link,type) values ($1,$2,$3)`, [job.patientId, fileId.directLink, job.type])

      if (job?.hospital_group_id && job?.patientId) {
        NotificationBufferService.add(
          job.hospital_group_id,
          job.patientId,
          job.patientName || "Unknown Patient",
          {
            link: fileId.directLink,
            mimeType: job.mimeType
          }
        );
      }

      console.log(job.mimeType);
      this.handleSuccess(job as UploadJob, fileId.shareLink);

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
    console.log(`[Queue] Upload Success: ${job.fileName} (ID: ${fileId})`);

    this.queue.shift();
    this.saveState();

    fs.unlink(job.filePath, (err) => {
      if (err) console.error("Failed to delete local file:", job.filePath);
    });

    this.isProcessing = false;
    setImmediate(() => this.processNext());
  }

  private handleRateLimit(job: UploadJob) {
    if (job.retryCount >= this.MAX_RETRIES) {
      console.error(`[Queue] Max retries reached. Dropping ${job.fileName}`);
      this.queue.shift();
      this.saveState();
      this.isProcessing = false;
      this.processNext();
      return;
    }

    job.retryCount++;
    this.saveState();

    const waitTime = this.BASE_WAIT_TIME * Math.pow(2, job.retryCount);
    console.warn(`[Queue] Rate Limit. Waiting ${waitTime / 1000}s...`);

    setTimeout(() => {
      console.log(`[Queue] Resuming...`);
      this.isProcessing = false;
      this.processNext();
    }, waitTime);
  }

  private handleFatalError(job: UploadJob, error: string) {
    console.error(`[Queue] Fatal Error for ${job.fileName}:`, error);
    this.queue.shift();
    this.saveState();
    this.isProcessing = false;
    this.processNext();
  }
}

export const UploadQueue = new GlobalUploadQueue();