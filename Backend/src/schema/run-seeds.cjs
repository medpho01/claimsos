#!/usr/bin/env node
/**
 * Seed runner — checksum-versioned, idempotent, transactional.
 *
 * Seeds are deliberately NOT migrations. Migrations are append-only DDL matched
 * by name and never re-run; seed data is a *desired current state* that must be
 * re-asserted whenever the catalog changes (a new doc_category, a corrected
 * field schema). A sha256 ledger gives that without ever renumbering a
 * migration: change a file's bytes and the next run re-applies just that file.
 *
 * Usage (via package.json scripts):
 *   npm run seed
 *   npm run seed:dry
 *   node src/schema/run-seeds.cjs --only 020_document_field_schemas --force
 *
 * Exit codes: 0 = success / nothing to do, 1 = any failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadDotenv, clientConfig } = require('./db-url.cjs');

const SEEDS_DIR = path.resolve(__dirname, 'seeds');
const LOCK_KEY = 'claimsos_seeds';
const LOG = '[run-seeds]';

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const opts = { dryRun: false, force: false, only: null };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--only') { opts.only = argv[i + 1]; i += 1; }
        else if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
        else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
        else {
            console.error(`${LOG} unknown argument: ${a}`);
            usage();
            process.exit(1);
        }
    }
    if (opts.only === undefined || opts.only === '') {
        console.error(`${LOG} --only requires a seed name`);
        process.exit(1);
    }
    return opts;
}

function usage() {
    console.log(`Usage: node src/schema/run-seeds.cjs [--dry-run] [--force] [--only <seed_name>]

  --dry-run          print the plan (new / apply / unchanged) and touch nothing
  --force            re-apply every seed even when its checksum is unchanged
  --only <name>      restrict to one seed, by basename without the .sql suffix`);
}

// ── Discovery ───────────────────────────────────────────────────────────────
/**
 * Every .sql under seeds/, lexically ordered. Anything beneath a `_dev/`
 * segment is skipped: those are destructive developer-only scripts
 * (cleanup_pragati_hospital.sql wipes a hospital) and must never run as part
 * of a bootstrap.
 */
function discoverSeeds(dir, prefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const found = [];
    for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (entry.name === '_dev') continue;
            found.push(...discoverSeeds(path.join(dir, entry.name), rel));
            continue;
        }
        if (!entry.name.endsWith('.sql')) continue;
        if (rel.split('/').includes('_dev')) continue;
        found.push({
            seedName: entry.name.slice(0, -'.sql'.length),
            relPath: rel,
            absPath: path.join(dir, entry.name),
        });
    }
    return found;
}

function sha256OfFile(absPath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/** Rough row count for the ledger — sum of every statement's rowCount. */
function countRows(results) {
    const list = Array.isArray(results) ? results : [results];
    return list.reduce((n, r) => n + (r && typeof r.rowCount === 'number' ? r.rowCount : 0), 0);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs(process.argv.slice(2));

    loadDotenv();

    if (!fs.existsSync(SEEDS_DIR)) {
        console.error(`${LOG} seeds directory not found: ${SEEDS_DIR}`);
        process.exit(1);
    }

    let seeds = discoverSeeds(SEEDS_DIR, '');
    if (opts.only) {
        seeds = seeds.filter((s) => s.seedName === opts.only);
        if (seeds.length === 0) {
            console.error(`${LOG} no seed named "${opts.only}" under ${SEEDS_DIR}`);
            process.exit(1);
        }
    }
    if (seeds.length === 0) {
        console.log(`${LOG} 0 applied, 0 unchanged, 0 failed (no seed files)`);
        return 0;
    }

    let Client;
    try {
        ({ Client } = require('pg'));
    } catch (err) {
        console.error(`${LOG} the "pg" package is required:`, err.message);
        process.exit(1);
    }

    const client = new Client(clientConfig({ label: LOG }));

    try {
        await client.connect();
    } catch (err) {
        console.error(`${LOG} could not connect to Postgres: ${err.message}`);
        console.error(`${LOG} check POSTGRES_HOST / POSTGRES_PORT / POSTGRES_DB (or DATABASE_URL).`);
        process.exit(1);
    }

    let locked = false;
    let applied = 0;
    let unchanged = 0;

    try {
        // Two containers in a scaled-out deploy must not interleave seeders.
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
        locked = true;

        // Defensive: migration 075 creates this, but `npm run seed` must work
        // on a database where 075 has not landed yet.
        await client.query(`
            CREATE SCHEMA IF NOT EXISTS hospital;
            CREATE TABLE IF NOT EXISTS hospital.seed_applications (
              seed_name     TEXT PRIMARY KEY,
              checksum      TEXT        NOT NULL,
              applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              rows_affected INTEGER     NOT NULL DEFAULT 0
            );
        `);

        const ledger = await client.query('SELECT seed_name, checksum FROM hospital.seed_applications');
        const recorded = new Map(ledger.rows.map((r) => [r.seed_name, r.checksum]));

        for (const seed of seeds) {
            const checksum = sha256OfFile(seed.absPath);
            const known = recorded.get(seed.seedName);
            const isNew = known === undefined;
            const changed = !isNew && known !== checksum;
            const willApply = opts.force || isNew || changed;

            if (opts.dryRun) {
                const verb = !willApply ? 'unchanged'
                    : isNew ? 'new      '
                    : changed ? 'apply    '
                    : 'force    ';
                console.log(`${LOG} ${verb}  ${seed.relPath}  ${checksum.slice(0, 12)}`);
                if (willApply) applied += 1; else unchanged += 1;
                continue;
            }

            if (!willApply) {
                console.log(`${LOG} = unchanged  ${seed.relPath}`);
                unchanged += 1;
                continue;
            }

            const sql = fs.readFileSync(seed.absPath, 'utf8');
            let rows = 0;

            await client.query('BEGIN');
            try {
                // The runner owns the transaction; seed files never BEGIN/COMMIT.
                await client.query('SET LOCAL search_path TO hospital, public');
                rows = countRows(await client.query(sql));
                await client.query(
                    `INSERT INTO hospital.seed_applications
                         (seed_name, checksum, applied_at, rows_affected)
                     VALUES ($1, $2, NOW(), $3)
                     ON CONFLICT (seed_name) DO UPDATE
                        SET checksum      = EXCLUDED.checksum,
                            applied_at    = NOW(),
                            rows_affected = EXCLUDED.rows_affected`,
                    [seed.seedName, checksum, rows]
                );
                await client.query('COMMIT');
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (_) { /* connection may be gone */ }
                console.error(`${LOG} FAILED  ${seed.relPath}`);
                console.error(`${LOG}   ${err.message}`);
                if (err.position) console.error(`${LOG}   at character ${err.position}`);
                if (err.detail) console.error(`${LOG}   detail: ${err.detail}`);
                if (err.hint) console.error(`${LOG}   hint: ${err.hint}`);
                // Stop immediately: later seeds may depend on this one.
                console.error(`${LOG} ${applied} applied, ${unchanged} unchanged, 1 failed`);
                return 1;
            }

            console.log(`${LOG} + applied    ${seed.relPath}  (${rows} rows)`);
            applied += 1;
        }

        if (opts.dryRun) {
            console.log(`${LOG} dry run — ${applied} would apply, ${unchanged} unchanged, nothing written`);
            return 0;
        }

        console.log(`${LOG} ${applied} applied, ${unchanged} unchanged, 0 failed`);
        return 0;
    } finally {
        if (locked) {
            try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); } catch (_) { /* noop */ }
        }
        try { await client.end(); } catch (_) { /* already closed */ }
    }
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`${LOG} unexpected failure:`, err && err.stack ? err.stack : err);
        process.exit(1);
    }
);
