import Queue from 'bull'
import { Worker } from 'worker_threads'
import path, { dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * PDF Generation Queue (BE H20)
 *
 * Moves the existing worker-thread PDF generation logic out of the HTTP
 * request path. Controllers enqueue a job and return 202 Accepted with a
 * job id; the queue worker spawns the existing `downloadImages.worker.js`
 * worker thread in the background.
 *
 * Status can be polled via `getPdfJobStatus(jobId)`.
 *
 * Mirrors `notification.queue.ts` / `driveBackup.queue.ts` patterns for
 * Redis config + error handling.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface PdfGenerationJob {
    patientId: string
    folderId: string
    hospitalId: string
    panelId: string
    requestedBy?: string
}

export interface PdfJobStatus {
    state: 'queued' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' | 'stuck' | 'unknown'
    progress?: number
    failedReason?: string
    /** Reserved for future S3-backed result URL. */
    resultUrl?: string | null
}

/** Stub queue used when Redis is unavailable so app boot doesn't crash. */
const stubQueue: any = {
    add: async () => ({ id: 'stub' }),
    process: () => {},
    on: () => stubQueue,
    getJob: async () => null,
}

function runDownloadImagesWorker(data: PdfGenerationJob): Promise<void> {
    return new Promise((resolve, reject) => {
        const workerPath = path.resolve(
            __dirname,
            './downloadImages.worker.js'
        )

        const worker = new Worker(workerPath, {
            workerData: {
                folderId: data.folderId,
                patientId: data.patientId,
                hospitalId: data.hospitalId,
                panelId: data.panelId,
            },
            execArgv: ['--loader', 'ts-node/esm', '--no-warnings'],
        })

        worker.on('message', (msg: any) => {
            if (msg?.status === 'success') resolve()
            else reject(new Error(msg?.error || 'PDF worker failed'))
        })

        worker.on('error', reject)
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`PDF worker exited with code ${code}`))
        })
    })
}

function createQueue(): Queue.Queue<PdfGenerationJob> | typeof stubQueue {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
    const url = new URL(redisUrl)

    const q = new Queue<PdfGenerationJob>('pdf-generation', {
        redis: {
            host: url.hostname,
            port: parseInt(url.port || '6379'),
            retryStrategy: (times: number) => {
                if (times >= 1) return null
                return 500
            },
            enableOfflineQueue: false,
        } as any,
        defaultJobOptions: {
            attempts: 2,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: { age: 60 * 60, count: 200 },
            removeOnFail: { age: 24 * 60 * 60, count: 200 },
        },
    })

    q.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED') {
            console.warn('[PdfGenerationQueue] Redis not available — PDF generation queue disabled.')
        }
    })

    q.process(1, async (job: Queue.Job<PdfGenerationJob>) => {
        const { patientId, requestedBy } = job.data
        console.log(`[PdfGenerationQueue] Processing job ${job.id} for patient ${patientId} (requestedBy=${requestedBy ?? 'n/a'})`)
        await job.progress(5)
        await runDownloadImagesWorker(job.data)
        await job.progress(100)
        console.log(`[PdfGenerationQueue] ✓ Job ${job.id} completed for patient ${patientId}`)
        return { ok: true, patientId }
    })

    q.on('completed', (job) => console.log(`[PdfGenerationQueue] Job ${job.id} completed`))
    q.on('failed', (job, err) => console.error(`[PdfGenerationQueue] Job ${job?.id} failed:`, err?.message))

    return q
}

const pdfGenerationQueue = createQueue()

export async function enqueuePdfJob(payload: PdfGenerationJob): Promise<{ jobId: string }> {
    const job = await pdfGenerationQueue.add(payload)
    return { jobId: String(job?.id ?? 'stub') }
}

export async function getPdfJobStatus(jobId: string): Promise<PdfJobStatus> {
    if (!pdfGenerationQueue || typeof (pdfGenerationQueue as any).getJob !== 'function') {
        return { state: 'unknown' }
    }
    const job = await (pdfGenerationQueue as Queue.Queue<PdfGenerationJob>).getJob(jobId)
    if (!job) return { state: 'unknown' }

    const state = (await job.getState()) as PdfJobStatus['state']
    const progress = (await job.progress()) as number | undefined
    return {
        state,
        progress: typeof progress === 'number' ? progress : undefined,
        failedReason: (job as any).failedReason || undefined,
        resultUrl: null,
    }
}

export default pdfGenerationQueue
