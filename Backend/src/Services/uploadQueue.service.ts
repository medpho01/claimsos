import fs from 'fs';
import driveHandler from './driveUploader.service.js';

const DriveHandler = new driveHandler();

interface UploadJob {
  filePath: string;
  fileName: string;
  mimeType: string;
  folderId: string;
  retryCount: number;
}

class GlobalUploadQueue {
  private queue: UploadJob[] = [];
  private isProcessing: boolean = false;

  private readonly MAX_RETRIES = 5;
  private readonly BASE_WAIT_TIME = 2000;

  public add(jobData: Omit<UploadJob, 'retryCount'>) {
    this.queue.push({ ...jobData, retryCount: 0 });
    console.log(`[Queue] Job added. Pending: ${this.queue.length}`);
    this.processNext();
  }

  private async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const job = this.queue[0];

    console.log(`[Queue] Uploading: ${job?.fileName}...`);

    try {
      const fileId = await DriveHandler.uploadAndGetLink(
        job?.filePath||"",
        job?.mimeType||"",
        job?.folderId||"",
        job?.fileName||""
      );

      this.handleSuccess(job as UploadJob, fileId.shareLink);

    } catch (error: any) {
      const errorMsg = error.message || JSON.stringify(error);

      // Check for Rate Limits (403 or 429)
      if (
        errorMsg.includes('403') || 
        errorMsg.includes('429') || 
        errorMsg.includes('Rate Limit')
      ) {
        this.handleRateLimit(job as UploadJob);
      } else {
        this.handleFatalError(job as UploadJob, errorMsg);
      }
    }
  }

  private handleSuccess(job: UploadJob, fileId: string) {
    console.log(`[Queue] Upload Success: ${job.fileName} (ID: ${fileId})`);

    this.queue.shift(); 
    
    fs.unlink(job.filePath, (err) => {
        if(err) console.error("Failed to delete local file:", job.filePath);
    });

    this.isProcessing = false;
    setImmediate(() => this.processNext());
  }

  private handleRateLimit(job: UploadJob) {
    if (job.retryCount >= this.MAX_RETRIES) {
      console.error(`[Queue] Max retries reached. Dropping ${job.fileName}`);
      this.queue.shift();
      this.isProcessing = false;
      this.processNext();
      return;
    }

    job.retryCount++;
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
    this.isProcessing = false;
    this.processNext();
  }
}

export const UploadQueue = new GlobalUploadQueue();