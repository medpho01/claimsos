#!/usr/bin/env node
/**
 * Migration runner shim.
 *
 * node-pg-migrate expects a single DATABASE_URL connection string but the
 * ClaimOS .env exposes the discrete POSTGRES_* vars used by the runtime app.
 * This shim composes DATABASE_URL from those vars (if not already set) and
 * then execs node-pg-migrate with the rest of the CLI args forwarded.
 *
 * Usage (via package.json scripts):
 *   npm run migrate:up
 *   npm run migrate:down
 *   npm run migrate:create -- my_migration_name
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

// Load .env from the Backend root so POSTGRES_* are available when invoked
// outside Docker. Inside the container env vars are injected directly and
// this is a no-op.
try {
    require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
} catch (_) {
    // dotenv is a runtime dep; if missing we'll just rely on the inherited env.
}

if (!process.env.DATABASE_URL) {
    const user = encodeURIComponent(process.env.POSTGRES_USER || '');
    const pass = encodeURIComponent(process.env.POSTGRES_PASSWORD || '');
    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = process.env.POSTGRES_PORT || '5432';
    const db   = process.env.POSTGRES_DB   || '';

    if (!user || !db) {
        console.error(
            '[run-migrations] POSTGRES_USER and POSTGRES_DB must be set (or DATABASE_URL provided).'
        );
        process.exit(1);
    }

    const auth = pass ? `${user}:${pass}` : user;
    process.env.DATABASE_URL = `postgres://${auth}@${host}:${port}/${db}`;
}

const migrationsDir = path.resolve(__dirname, 'migrations');

// Forward all CLI args after the action verb to node-pg-migrate.
const args = [
    ...process.argv.slice(2),
    '-m', migrationsDir,
    '-j', 'sql',
    '--schema', 'hospital',
    '--create-schema',
];

const bin = path.resolve(__dirname, '../../node_modules/.bin/node-pg-migrate');

const child = spawn(bin, args, { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
child.on('error', (err) => {
    console.error('[run-migrations] failed to spawn node-pg-migrate:', err.message);
    process.exit(1);
});
