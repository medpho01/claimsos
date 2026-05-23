/**
 * Structured logger for the ClaimOS backend.
 *
 * Wraps pino with:
 *  - PII redaction (emails, phones, names, tokens, auth headers)
 *  - Dev-friendly pretty output when NODE_ENV !== 'production'
 *  - Level configurable via LOG_LEVEL env (defaults to 'info')
 *
 * Usage:
 *   import { logger } from '../Utils/logger.js'
 *   logger.info({ userId, role }, 'got user')
 *   logger.error({ err }, 'failed to load patient')
 *
 * Do NOT log raw request bodies, user rows, or password fields — the
 * redaction list catches common keys, but new shapes will leak PII.
 * Pass only the specific fields you need.
 *
 * Addresses BE-review item M2 (PII in logs) and L5 (debug noise).
 */

import pino, { type LoggerOptions } from 'pino'

const isProd = process.env.NODE_ENV === 'production'

// Paths to scrub. Pino supports wildcards at one level (`*.field`) and
// deep wildcards via `*.field` repeated. We list both the top-level and
// common nested locations (req.body, req.headers, res, user, patient, …).
const redactPaths = [
  // Auth / secrets
  'password',
  'token',
  'accessToken',
  'refreshToken',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.token',
  'req.body.accessToken',
  'req.body.refreshToken',

  // PII
  'email',
  'phone',
  'firstName',
  'lastName',
  '*.email',
  '*.phone',
  '*.firstName',
  '*.lastName',
  'req.body.email',
  'req.body.phone',
  'req.body.firstName',
  'req.body.lastName',
]

const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
    remove: false,
  },
  base: {
    service: '24eleven-backend',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
}

const devTransport = isProd
  ? undefined
  : {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
          singleLine: false,
        },
      },
    }

export const logger = pino({ ...baseOptions, ...(devTransport ?? {}) })

export default logger
