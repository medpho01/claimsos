import { Worker } from 'worker_threads'
import fs from 'fs'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface UploadJob {
  filePath: string
  fileName: string
  mimeType: string
  folderId: string
  retryCount: number
}

class GlobalUploadQueue {
  private queue: UploadJob[] = []
  private isProcessing: boolean = false
  private worker: Worker | null = null

  private readonly MAX_RETRIES = 5
  private readonly BASE_WAIT_TIME = 2000

  constructor() {
    this.startWorker()
  }

  private startWorker() {
    const workerPath = path.resolve(
      __dirname,
      '../Workers/upload.worker.ts'
    )

    this.worker = new Worker(workerPath, {
      execArgv: ['--loader', 'ts-node/esm', '--no-warnings'],
    })

    console.log('[Queue] Worker thread spawned.')

    this.worker.on('error', (err) => {
      console.error('[Queue] Worker crashed!', err)
      this.restartWorker()
    })

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[Queue] Worker died with code ${code}. Restarting...`)
        this.restartWorker()
      }
    })

    this.worker.on('message', (msg) => {
      this.handleWorkerMessage(msg)
    })
  }

  private restartWorker() {
    this.worker = null
    this.isProcessing = false
    setTimeout(() => this.startWorker(), 1000)
  }

  public add(jobData: Omit<UploadJob, 'retryCount'>) {
    this.queue.push({ ...jobData, retryCount: 0 })
    this.processNext()
  }

  private processNext() {
    if (this.isProcessing || this.queue.length === 0 || !this.worker) return

    this.isProcessing = true
    const job = this.queue[0]

    console.log(`[Queue] Sending ${job?.fileName} to worker...`)

    this.worker.postMessage(job)
  }

  private handleWorkerMessage(msg: any) {
    const job = this.queue[0] // The job currently being processed
    if (!job) return

    if (msg.status === 'SUCCESS') {
      console.log(`[Queue] Uploaded: ${job.fileName}`)

      // Remove job from queue only on success
      this.queue.shift()
      fs.unlink(job.filePath, () => {}) // Cleanup

      this.isProcessing = false
      this.processNext()
    } else if (msg.status === 'RATE_LIMIT') {
      this.handleRateLimit(job)
    } else {
      // Fatal Error
      console.error(`[Queue] Failed: ${msg.error}`)
      this.queue.shift() // Remove failed job
      this.isProcessing = false
      this.processNext()
    }
  }

  private handleRateLimit(job: UploadJob) {
    if (job.retryCount >= this.MAX_RETRIES) {
      console.error(`[Queue] Max retries reached. Dropping ${job.fileName}`)
      this.queue.shift()
      this.isProcessing = false
      this.processNext()
      return
    }

    job.retryCount++
    const waitTime = this.BASE_WAIT_TIME * Math.pow(2, job.retryCount)

    console.warn(`[Queue] Rate Limit. Waiting ${waitTime / 1000}s...`)

    // We do NOT shift the queue. The job stays at index 0.
    // We just pause processing.
    setTimeout(() => {
      this.isProcessing = false // Unlock
      this.processNext() // Retry the same job (index 0)
    }, waitTime)
  }
}

export const UploadQueue = new GlobalUploadQueue()
