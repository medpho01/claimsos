import Queue from 'bull'

/**
 * Google Sheets Sync Queue (BE M5)
 *
 * Moves the previously-blocking `await fetch(sheetURL, ...)` Google Apps
 * Script calls out of the HTTP request path. Controllers call
 * `enqueueSheetSync(...)` fire-and-forget; the worker performs the actual
 * POST with a sane 10s timeout and up to 3 retries with exponential backoff.
 *
 * Mirrors `notification.queue.ts` / `driveBackup.queue.ts` patterns for
 * Redis config + error handling.
 */

export interface SheetSyncJob {
    sheetUrl: string
    /** The full JSON payload posted to the Google Apps Script. Includes secret. */
    body: Record<string, any>
    /** Optional label for log lines (controller name / action). */
    source?: string
}

/** Stub queue used when Redis is unavailable so app boot doesn't crash. */
const stubQueue: any = {
    add: async () => ({ id: 'stub' }),
    process: () => {},
    on: () => stubQueue,
}

const REQUEST_TIMEOUT_MS = 10_000

async function postToSheet(sheetUrl: string, body: Record<string, any>): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
        const response = await fetch(sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            redirect: 'follow',
            signal: controller.signal,
        })
        if (!response.ok) {
            throw new Error(`Sheet webhook responded with status ${response.status}`)
        }
    } finally {
        clearTimeout(timer)
    }
}

function createQueue(): Queue.Queue<SheetSyncJob> | typeof stubQueue {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
    const url = new URL(redisUrl)

    const q = new Queue<SheetSyncJob>('sheet-sync', {
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
            attempts: 3,
            backoff: { type: 'exponential', delay: 2_000 },
            timeout: REQUEST_TIMEOUT_MS + 5_000,
            removeOnComplete: { age: 60 * 60, count: 500 },
            removeOnFail: { age: 24 * 60 * 60, count: 500 },
        },
    })

    q.on('error', (err: Error) => {
        if ((err as any).code === 'ECONNREFUSED') {
            console.warn('[SheetSyncQueue] Redis not available — Google Sheets sync disabled.')
        }
    })

    q.process(5, async (job: Queue.Job<SheetSyncJob>) => {
        const { sheetUrl, body, source } = job.data
        const action = body?.action || 'unknown'
        const id = body?.id || 'n/a'
        console.log(`[SheetSyncQueue] Job ${job.id} (${source ?? 'unknown'}/${action}) for id=${id} attempt=${job.attemptsMade + 1}`)
        await postToSheet(sheetUrl, body)
        console.log(`[SheetSyncQueue] ✓ Job ${job.id} (${source ?? 'unknown'}/${action}) for id=${id} completed`)
    })

    q.on('completed', (job) => console.log(`[SheetSyncQueue] Job ${job.id} completed`))
    q.on('failed', (job, err) => console.error(`[SheetSyncQueue] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err?.message))

    return q
}

const sheetSyncQueue = createQueue()

/**
 * Fire-and-forget Sheets sync. Caller does NOT await the actual webhook call.
 * The Redis add itself is awaited so the job is durably enqueued, but errors
 * (including Redis being down) are swallowed: stale sheet data is preferred
 * over a broken response to the user.
 */
export async function enqueueSheetSync(payload: SheetSyncJob): Promise<void> {
    try {
        await sheetSyncQueue.add(payload)
    } catch (err: any) {
        console.warn('[SheetSyncQueue] Failed to enqueue sheet sync (continuing):', err?.message)
    }
}

export default sheetSyncQueue
