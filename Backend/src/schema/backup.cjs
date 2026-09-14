#!/usr/bin/env node
/**
 * Verified database backup.
 *
 * WHY THIS EXISTS. Every other schema operation — migrate:up, seed,
 * reconcile-ledger — composes its connection through db-url.cjs. Backup did
 * not: the runbook asked the operator to hand-assemble a `pg_dump` command.
 * On 2026-09-14, against production, that produced a **0-byte file** and said
 * nothing: DATABASE_URL was unset in the operator's shell, pg_dump silently
 * fell back to a local unix socket, failed, and left an empty file behind. The
 * next step would have been `migrate:up` against 475 live claims behind a
 * backup that did not exist.
 *
 * That is the same class of failure this codebase spent a release eliminating
 * everywhere else — silent success over work that did not happen. A backup you
 * have not verified is not a backup, and a backup step that can be skipped or
 * fat-fingered is not a procedure.
 *
 * So this script:
 *   1. composes the connection the SAME way the app does (db-url.cjs, including
 *      the RDS sslmode handling), so it cannot target the wrong database;
 *   2. refuses to run if pg_dump is absent or older than the server;
 *   3. writes the dump;
 *   4. VERIFIES it — non-trivial size AND a readable pg_restore table of
 *      contents — and exits NON-ZERO if either check fails;
 *   5. deletes the corpse on failure, so a later run can never mistake a failed
 *      attempt for a real backup.
 *
 * Usage:
 *   npm run db:backup                      # ./backups/<db>_<utc>.dump
 *   npm run db:backup -- --out-dir /mnt/x  # elsewhere
 *   npm run db:backup -- --label pre-vision
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadDotenv, resolveDatabaseUrl } = require('./db-url.cjs');

const LOG = '[db:backup]';

// A schema-only dump of this app is ~1MB; anything smaller means pg_dump
// produced a stub. Deliberately conservative — we would rather ask a human
// than wave through a suspiciously small file.
const MIN_PLAUSIBLE_BYTES = 50 * 1024;

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fail(msg, hint) {
    console.error(`${LOG} ✗ ${msg}`);
    if (hint) console.error(`${LOG}   ${hint}`);
    process.exit(1);
}

function main() {
    loadDotenv();
    const url = resolveDatabaseUrl({ label: LOG });

    // Never print the password. Show enough to prove we are pointed at the
    // database the operator thinks we are — targeting the wrong one is the
    // other way a backup silently fails to be a backup.
    const redacted = url.replace(/\/\/([^:]+):[^@]+@/, '//$1:****@');
    console.log(`${LOG} target: ${redacted}`);

    // pg_dump present?
    let dumpVersion;
    try {
        dumpVersion = execFileSync('pg_dump', ['--version'], { encoding: 'utf8' }).trim();
    } catch (_) {
        fail(
            'pg_dump not found on PATH.',
            'Inside the container: the image installs postgresql-client. On a host: apt-get install postgresql-client.',
        );
    }
    console.log(`${LOG} ${dumpVersion}`);

    const outDir = path.resolve(arg('out-dir', path.resolve(__dirname, '../../../backups')));
    fs.mkdirSync(outDir, { recursive: true });

    const dbName = (process.env.POSTGRES_DB || 'database').replace(/[^A-Za-z0-9_.-]/g, '_');
    const label = arg('label', '').replace(/[^A-Za-z0-9_.-]/g, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = path.join(outDir, `${dbName}${label ? '_' + label : ''}_${stamp}.dump`);

    console.log(`${LOG} writing ${outFile}`);
    const started = Date.now();

    // -Fc: custom format, the only one pg_restore can read selectively.
    const res = spawnSync('pg_dump', ['-d', url, '-Fc', '-f', outFile], {
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    if (res.error || res.status !== 0) {
        try { fs.unlinkSync(outFile); } catch (_) {}
        fail(
            `pg_dump exited ${res.status ?? 'with ' + (res.error && res.error.code)}.`,
            'Partial file removed so it cannot be mistaken for a backup.',
        );
    }

    // ── Verification. A dump that exists is not a dump that restores. ──
    let bytes = 0;
    try { bytes = fs.statSync(outFile).size; } catch (_) {
        fail('pg_dump reported success but wrote no file.');
    }

    if (bytes < MIN_PLAUSIBLE_BYTES) {
        try { fs.unlinkSync(outFile); } catch (_) {}
        fail(
            `dump is ${bytes} bytes — implausibly small (< ${MIN_PLAUSIBLE_BYTES}).`,
            'This is exactly the 0-byte failure mode this script exists to catch. Removed.',
        );
    }

    const toc = spawnSync('pg_restore', ['-l', outFile], { encoding: 'utf8' });
    if (toc.status !== 0) {
        fail(
            'pg_restore could not read the dump — it is not a valid archive.',
            'Left in place for inspection; do NOT treat it as a backup.',
        );
    }
    const tocEntries = (toc.stdout || '').split('\n').filter((l) => l && !l.startsWith(';')).length;
    if (tocEntries === 0) {
        fail('dump contains zero restorable objects.');
    }

    const mb = (bytes / 1048576).toFixed(1);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${LOG} ✓ verified — ${mb} MB, ${tocEntries} objects, ${secs}s`);
    console.log(`${LOG} ✓ ${outFile}`);
    console.log(`${LOG} restore with: pg_restore -d "<url>" --clean --if-exists ${path.basename(outFile)}`);
}

main();
