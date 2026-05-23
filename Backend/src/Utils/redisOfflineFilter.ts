/**
 * Production-readiness #3 — single source of truth for swallowing ioredis
 * connection-failure noise.
 *
 * The Bull queues (notification, pdfGeneration, sheetSync, driveBackup) all
 * configure `enableOfflineQueue: false`, which is correct for a server that
 * shouldn't memory-buffer jobs while Redis is dead. The trade-off is that
 * every queue operation against a disconnected Redis rejects with one of:
 *
 *   - `ECONNREFUSED` (initial connection)
 *   - "Stream isn't writeable and enableOfflineQueue options is false"
 *     (subsequent writes after the socket dies)
 *   - "Connection is closed"
 *   - "Redis is already connecting" / "Connection is connecting"
 *
 * Without filtering, each one becomes an `unhandledRejection` and spams the
 * logs every few seconds. The old notification.queue.ts handler only caught
 * ECONNREFUSED — the others got through.
 *
 * Call `installRedisOfflineFilter()` once from index.ts. Idempotent (uses a
 * module-level guard) so importing this from any Worker file is safe too.
 */
import { logger } from './logger.js'

const OFFLINE_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /Stream isn'?t writeable/i,
  /Connection is closed/i,
  /Connection is already closed/i,
  /Redis is already connecting/i,
  /Connection is connecting/i,
]

let installed = false

function isRedisOfflineError(reason: unknown): boolean {
  if (!reason) return false
  const message =
    typeof reason === 'string'
      ? reason
      : ((reason as any).message ?? '') + ' ' + ((reason as any).code ?? '')
  return OFFLINE_PATTERNS.some((re) => re.test(message))
}

export function installRedisOfflineFilter(): void {
  if (installed) return
  installed = true

  process.on('unhandledRejection', (reason: unknown) => {
    if (isRedisOfflineError(reason)) {
      // Surface once at debug so a `LOG_LEVEL=debug` run can still see them.
      logger.debug({ err: reason }, 'Redis offline — swallowed unhandled rejection')
      return
    }
    logger.error({ err: reason }, 'Unhandled promise rejection')
  })

  process.on('uncaughtException', (err: Error) => {
    if (isRedisOfflineError(err)) {
      logger.debug({ err }, 'Redis offline — swallowed uncaught exception')
      return
    }
    logger.error({ err }, 'Uncaught exception')
    // Crash on anything else — let the process supervisor restart us.
    process.exit(1)
  })
}
