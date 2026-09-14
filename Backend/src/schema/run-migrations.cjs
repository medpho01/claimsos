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
 *
 * Escape hatch:
 *   npm run migrate:up -- --no-preflight   (skip the genesis stamp, see below)
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const { loadDotenv, resolveDatabaseUrl, clientConfig } = require('./db-url.cjs');

loadDotenv();
resolveDatabaseUrl({ label: '[run-migrations]' });

const migrationsDir = path.resolve(__dirname, 'migrations');

// Forward all CLI args after the action verb to node-pg-migrate.
//
// IMPORTANT: the migrations dir also contains manual *_rollback.sql helpers
// (e.g. 002b_hospital_table_updates_rollback.sql). node-pg-migrate globs every
// .sql file as a FORWARD migration, so without excluding them it (a) trips the
// order-check ("not run migration …_rollback is preceding already run …") and
// (b) would execute the rollback SQL as an "up" migration and damage the
// schema. Ignore them unless the caller already passed their own pattern.
const rawArgs = process.argv.slice(2);
const skipPreflight = rawArgs.includes('--no-preflight');
const forwarded = rawArgs.filter((a) => a !== '--no-preflight');
const hasIgnore = forwarded.includes('--ignore-pattern') || forwarded.includes('-i');
const args = [
    ...forwarded,
    ...(hasIgnore ? [] : ['--ignore-pattern', '.*_rollback\\.sql']),
    '-m', migrationsDir,
    '-j', 'sql',
    '--schema', 'hospital',
    '--create-schema',
];

const bin = path.resolve(__dirname, '../../node_modules/.bin/node-pg-migrate');

function spawnMigrator() {
    const child = spawn(bin, args, { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => process.exit(code == null ? 1 : code));
    child.on('error', (err) => {
        console.error('[run-migrations] failed to spawn node-pg-migrate:', err.message);
        process.exit(1);
    });
}

/**
 * PRE-FLIGHT GENESIS STAMP.
 *
 * 000_genesis.sql is a NEW migration that sorts BEFORE every migration
 * production has already run. node-pg-migrate performs an order check before
 * applying anything, so against production's ledger (stamped 001..073, no
 * 000_genesis) it aborts with:
 *
 *   "Not run migration 000_genesis is preceding already run migration
 *    001_add_s3_support"
 *
 * — exactly the class of failure documented above for the _rollback helpers.
 *
 * Stamping without running is provably safe: a NON-EMPTY ledger means 001+
 * already ran, and 001 ALTERs ipd_doc and attaches a trigger that calls
 * update_modified_column(), so both the genesis tables and the genesis
 * function demonstrably exist. (Every genesis statement is guarded anyway, so
 * a future decision to actually execute it would also be safe.)
 *
 * On a fresh database the ledger is absent or empty, we stamp nothing, and
 * 000_genesis runs for real.
 *
 * The whole block is wrapped in try/catch so a connection failure falls
 * through to node-pg-migrate's own error reporting rather than masking it.
 */
async function preflightGenesisStamp() {
    let Client;
    try {
        ({ Client } = require('pg'));
    } catch (_) {
        // pg is a runtime dep; if it is somehow missing, let node-pg-migrate speak.
        return;
    }

    const client = new Client(clientConfig({ label: '[run-migrations]' }));

    try {
        await client.connect();

        const ledger = await client.query(
            "SELECT to_regclass('hospital.pgmigrations') AS oid"
        );
        if (!ledger.rows[0] || ledger.rows[0].oid === null) {
            console.log('[run-migrations] fresh database — genesis will be applied');
            return;
        }

        const count = await client.query('SELECT count(*)::int AS n FROM hospital.pgmigrations');
        if (count.rows[0].n === 0) {
            console.log('[run-migrations] fresh database — genesis will be applied');
            return;
        }

        const present = await client.query(
            'SELECT 1 FROM hospital.pgmigrations WHERE name = $1 LIMIT 1',
            ['000_genesis']
        );
        if (present.rowCount > 0) {
            return;
        }

        await client.query('BEGIN');
        try {
            // run_on MUST predate every existing row.
            //
            // node-pg-migrate's checkOrder (node_modules/node-pg-migrate/dist/
            // runner.js:165-176) loads the ledger with
            // `ORDER BY run_on, id` and compares it POSITIONALLY against the
            // file list. 000_genesis is position 0 in the file list, so a
            // NOW() stamp — which sorts it LAST, after every row prod already
            // has — makes runNames[0] = '002b_fixed' while migrations[0] =
            // '000_genesis', and every `migrate:up` then dies with
            // "Not run migration 000_genesis is preceding already run
            // migration 002b_fixed". Stamping one second before the oldest
            // existing row puts it first, which is where the file order says
            // it belongs. (id is the ORDER BY tiebreaker only, and ours is the
            // highest, so run_on has to carry this on its own.)
            await client.query(
                `INSERT INTO hospital.pgmigrations (name, run_on)
                 SELECT $1::varchar,
                        COALESCE(
                            (SELECT min(run_on) FROM hospital.pgmigrations),
                            NOW()
                        ) - INTERVAL '1 second'
                 WHERE NOT EXISTS (
                     SELECT 1 FROM hospital.pgmigrations WHERE name = $1::varchar
                 )`,
                ['000_genesis']
            );
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }

        console.warn(
            `[run-migrations] WARN pre-existing schema detected (${count.rows[0].n} migrations ` +
            'stamped); stamping 000_genesis as already-applied. Genesis objects are present by ' +
            'construction (001+ depend on them). Run `npm run db:reconcile-ledger:dry` to audit ' +
            'the full ledger.'
        );
    } catch (err) {
        console.warn(
            '[run-migrations] pre-flight genesis check skipped:',
            err && err.message ? err.message : err
        );
    } finally {
        // Always release the client before spawning node-pg-migrate so the two
        // never hold overlapping connections against a small RDS pool.
        try { await client.end(); } catch (_) { /* already closed */ }
    }
}

const verb = forwarded.find((a) => !a.startsWith('-'));

if (verb === 'up' && !skipPreflight) {
    preflightGenesisStamp().then(spawnMigrator, spawnMigrator);
} else {
    spawnMigrator();
}
