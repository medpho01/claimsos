#!/usr/bin/env node
/**
 * Ledger reconciliation — make hospital.pgmigrations reflect what the database
 * ACTUALLY has, evidence-based, idempotent, and auditable.
 *
 * Why this exists: production's schema was restored from a DUMP, not built by
 * `migrate:up`, and prod-bootstrap-final.sql then hand-stamped 65 names. The
 * ledger therefore does not describe reality — some applied migrations are
 * unstamped (066..073, the hand-applied 018 rename, doctor_share_tokens), and
 * the stamping block itself duplicates rows because hospital.pgmigrations was
 * created with only a SERIAL primary key, so its `ON CONFLICT DO NOTHING` can
 * never fire.
 *
 * This script NEVER stamps blindly. For every migration missing from the
 * ledger it runs that migration's `evidence` predicate from
 * ledger-manifest.json and classifies:
 *
 *   STAMP    evidence true  — already applied out-of-band, record it
 *   PENDING  evidence false — genuinely not applied, `migrate:up` will run it
 *   UNKNOWN  no manifest entry, or the evidence query errored — exit non-zero
 *
 * Usage (via package.json scripts):
 *   npm run db:reconcile-ledger:dry     # plan only, never writes
 *   npm run db:reconcile-ledger         # apply the STAMP rows
 *
 * Exit codes: 0 = clean, 1 = UNKNOWN entries, ORDER VIOLATION, or failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { loadDotenv, clientConfig } = require('./db-url.cjs');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');
const MANIFEST_PATH = path.resolve(__dirname, 'ledger-manifest.json');
const LOG = '[reconcile-ledger]';

// ── CLI ─────────────────────────────────────────────────────────────────────
function usage() {
    console.log(`Usage: node src/schema/reconcile-ledger.cjs (--dry-run | --apply)

  --dry-run   print the plan and exit without touching the ledger
  --apply     insert the STAMP rows (plus the de-dupe + unique index repair)

Exactly one of the two is mandatory — a production ledger is never mutated by
a bare invocation.`);
}

function parseArgs(argv) {
    const dryRun = argv.includes('--dry-run');
    const apply = argv.includes('--apply');
    const unknown = argv.filter((a) => a !== '--dry-run' && a !== '--apply');

    if (unknown.length) {
        console.error(`${LOG} unknown argument(s): ${unknown.join(' ')}`);
        usage();
        process.exit(1);
    }
    if (dryRun === apply) {
        console.error(`${LOG} pass exactly one of --dry-run or --apply.`);
        usage();
        process.exit(1);
    }
    return { dryRun, apply };
}

// ── Ordering ────────────────────────────────────────────────────────────────
/**
 * Reproduce node-pg-migrate's ordering EXACTLY. This is not the same as
 * lexical filename order and the difference is load-bearing: node-pg-migrate
 * sorts by getNumericPrefix(basename.split('_')[0]), and any prefix that is
 * not all digits (002b, 002c, 003b) falls back to 0 — so those files run
 * BEFORE 001_add_s3_support. Ties are broken by filename.
 *
 * See node_modules/node-pg-migrate/dist/migration.js -> getNumericPrefix.
 */
function numericPrefix(name) {
    const prefix = name.split('_')[0];
    if (prefix && /^\d+$/.test(prefix)) {
        if (prefix.length === 13) return Number(prefix);
        if (prefix.length === 17) {
            return Date.parse(
                `${prefix.slice(0, 4)}-${prefix.slice(4, 6)}-${prefix.slice(6, 8)}T`
                + `${prefix.slice(8, 10)}:${prefix.slice(10, 12)}:${prefix.slice(12, 14)}.${prefix.slice(14, 17)}Z`
            );
        }
    }
    return Number(prefix) || 0;
}

function migrationOrder(a, b) {
    const d = numericPrefix(a) - numericPrefix(b);
    if (d !== 0) return d;
    return a < b ? -1 : a > b ? 1 : 0;
}

function discoverMigrations() {
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && !f.endsWith('_rollback.sql'))
        .map((f) => f.slice(0, -'.sql'.length))
        .sort(migrationOrder);
}

// ── Ledger ordering model ───────────────────────────────────────────────────
/**
 * The run_on a stamped name must carry.
 *
 * node-pg-migrate loads the ledger with `ORDER BY run_on, id` and compares it
 * POSITIONALLY against the file-ordered migration list, so a name that belongs
 * EARLY in file order but carries a LATE run_on (what a plain NOW() produces)
 * permanently breaks `migrate:up` with "Not run migration X is preceding
 * already run migration Y". Each stamp therefore inherits its timestamp from
 * the EARLIEST ledger row that FOLLOWS it in file order, minus one second —
 * the same shape as the genesis stamp at run-migrations.cjs:139. NOW() is the
 * fallback only when nothing already in the ledger follows it.
 *
 * Stamps that resolve to the same anchor get identical run_on values and are
 * then ordered among themselves by `id`, which increases in file order because
 * `toStamp` is built by walking `expected`. And because the follower set of an
 * earlier name is a superset of a later name's, the anchors are themselves
 * non-decreasing in file order — so interleaved stamps keep correct relative
 * order without any extra bookkeeping.
 *
 * This MUST stay in lockstep with the INSERT in main(): the safety check below
 * validates the ordering this function predicts, so a divergence would bless an
 * ordering we never actually write.
 */
function stampRunOn(name, expected, ledgerByName, now) {
    const idx = expected.indexOf(name);
    let anchor = null;
    for (let i = idx + 1; i < expected.length; i += 1) {
        const row = ledgerByName.get(expected[i]);
        if (row && (anchor === null || row.run_on < anchor)) anchor = row.run_on;
    }
    return new Date((anchor === null ? now.getTime() : anchor.getTime()) - 1000);
}

/**
 * Rebuild the ledger node-pg-migrate will READ after this run — the surviving
 * rows plus the rows we are about to stamp — in its own `ORDER BY run_on, id`.
 */
function projectLedgerOrder(ledgerByName, toStamp, expected, now) {
    const existing = [...ledgerByName.values()];
    const maxId = existing.reduce((m, r) => Math.max(m, r.id), 0);
    const projected = existing.map((r) => ({ name: r.name, runOn: r.run_on, id: r.id }));

    toStamp.forEach((name, i) => {
        projected.push({
            name,
            runOn: stampRunOn(name, expected, ledgerByName, now),
            id: maxId + 1 + i,
        });
    });

    projected.sort((a, b) => (a.runOn - b.runOn) || (a.id - b.id));
    return projected.map((r) => r.name);
}

/**
 * Replay node-pg-migrate's checkOrder (node_modules/node-pg-migrate/dist/
 * runner.js:165-176) and return its first disagreement, or null.
 *
 * The invariant is stricter than "applied names sort before pending ones": the
 * ledger read must be an exact PREFIX of the file-ordered list. A gap in the
 * middle, an orphan row, or a correct name carrying the wrong run_on all fail.
 */
function firstOrderMismatch(runNames, expected) {
    const len = Math.min(runNames.length, expected.length);
    for (let i = 0; i < len; i += 1) {
        if (runNames[i] !== expected[i]) {
            return { index: i, expected: expected[i], actual: runNames[i] };
        }
    }
    return null;
}

// ── Reporting ───────────────────────────────────────────────────────────────
function pad(s, n) { return (s + ' '.repeat(n)).slice(0, n); }

function printTable(rows) {
    const w = Math.max(4, ...rows.map((r) => r.name.length));
    console.log(`${LOG} ${pad('name', w)}  ${pad('ledger', 8)}  ${pad('evidence', 9)}  action`);
    console.log(`${LOG} ${'-'.repeat(w)}  ${'-'.repeat(8)}  ${'-'.repeat(9)}  ------`);
    for (const r of rows) {
        console.log(`${LOG} ${pad(r.name, w)}  ${pad(r.ledger, 8)}  ${pad(r.evidence, 9)}  ${r.action}`);
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs(process.argv.slice(2));

    loadDotenv();

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } catch (err) {
        console.error(`${LOG} could not read ${MANIFEST_PATH}: ${err.message}`);
        return 1;
    }
    const evidenceByName = new Map((manifest.entries || []).map((e) => [e.name, e.evidence]));

    let Client;
    try {
        ({ Client } = require('pg'));
    } catch (err) {
        console.error(`${LOG} the "pg" package is required:`, err.message);
        return 1;
    }

    const client = new Client(clientConfig({ label: LOG }));
    try {
        await client.connect();
    } catch (err) {
        console.error(`${LOG} could not connect to Postgres: ${err.message}`);
        return 1;
    }

    try {
        // node-pg-migrate's exact ledger shape.
        await client.query(`
            CREATE SCHEMA IF NOT EXISTS hospital;
            CREATE TABLE IF NOT EXISTS hospital.pgmigrations (
              id     SERIAL PRIMARY KEY,
              name   VARCHAR(255) NOT NULL,
              run_on TIMESTAMP    NOT NULL
            );
        `);

        // ── Step 3: de-duplicate, then add the missing unique index. ────────
        // This is the fix for prod-bootstrap-final.sql:1192, whose
        // `ON CONFLICT DO NOTHING` can never fire because `name` has no unique
        // index — so every re-run of that script duplicated all 65 rows.
        // This DELETE is the only one the script is ever allowed to issue.
        const dupCount = await client.query(`
            SELECT count(*)::int AS n
              FROM hospital.pgmigrations a
              JOIN hospital.pgmigrations b ON a.name = b.name AND a.id > b.id
        `);
        if (dupCount.rows[0].n > 0) {
            if (opts.apply) {
                const del = await client.query(`
                    DELETE FROM hospital.pgmigrations a
                     USING hospital.pgmigrations b
                     WHERE a.id > b.id AND a.name = b.name
                `);
                console.log(`${LOG} removed ${del.rowCount} duplicate ledger row(s)`);
            } else {
                console.log(`${LOG} ${dupCount.rows[0].n} duplicate ledger row(s) would be removed`);
            }
        }
        if (opts.apply) {
            await client.query(
                'CREATE UNIQUE INDEX IF NOT EXISTS pgmigrations_name_uniq ON hospital.pgmigrations (name)'
            );
        }

        // ── Steps 4-6: classify. ────────────────────────────────────────────
        const expected = discoverMigrations();
        const ledgerRows = await client.query(
            'SELECT id, name, run_on FROM hospital.pgmigrations ORDER BY run_on, id'
        );
        // Collapse duplicates the way Step 3 does (lowest id survives) so
        // --dry-run and --apply reason about the same post-repair ledger.
        const ledgerByName = new Map();
        for (const r of ledgerRows.rows) {
            const prev = ledgerByName.get(r.name);
            if (!prev || r.id < prev.id) ledgerByName.set(r.name, r);
        }
        const inLedger = new Set(ledgerByName.keys());

        const rows = [];
        const toStamp = [];
        let unknown = 0;

        for (const name of expected) {
            if (inLedger.has(name)) {
                rows.push({ name, ledger: 'present', evidence: '-', action: 'none' });
                continue;
            }

            const sql = evidenceByName.get(name);
            if (!sql) {
                rows.push({ name, ledger: 'MISSING', evidence: 'no entry', action: 'UNKNOWN' });
                unknown += 1;
                continue;
            }

            let result;
            try {
                // Probes run in autocommit — each is its own transaction, so a
                // predicate that references a table which does not exist yet
                // fails on its own without poisoning the session.
                const r = await client.query(sql);
                result = r.rows.length ? Object.values(r.rows[0])[0] : null;
            } catch (err) {
                rows.push({ name, ledger: 'MISSING', evidence: 'ERROR', action: 'UNKNOWN' });
                console.error(`${LOG}   evidence query failed for ${name}: ${err.message}`);
                unknown += 1;
                continue;
            }

            if (result === true) {
                rows.push({ name, ledger: 'MISSING', evidence: 'true', action: 'STAMP' });
                toStamp.push(name);
            } else {
                rows.push({ name, ledger: 'MISSING', evidence: 'false', action: 'PENDING' });
            }
        }

        // ── Step 6: orphan ledger rows (warn only, NEVER delete). ───────────
        const onDisk = new Set(expected);
        const orphans = [...inLedger].filter((n) => !onDisk.has(n)).sort();

        printTable(rows);
        console.log('');
        for (const o of orphans) {
            console.warn(`${LOG} ORPHAN: ledger row "${o}" matches no file on disk `
                + '(possibly a migration from another branch — never deleted automatically)');
        }

        // ── Step 8: ORDER SAFETY CHECK. ─────────────────────────────────────
        // node-pg-migrate refuses to run when the ledger it reads
        // (`ORDER BY run_on, id`) is not an exact PREFIX of the file-ordered
        // migration list — checkOrder compares the two POSITIONALLY. Comparing
        // PENDING names against the applied SET only catches one of the three
        // ways that invariant breaks (a genuine gap); it is blind to an orphan
        // row and to a correctly-named row carrying the wrong run_on, which is
        // precisely the failure a NOW() stamp creates. So instead of
        // approximating the rule, rebuild the ledger this run will leave behind
        // and replay checkOrder against it.
        const now = new Date();
        const baselineMismatch = firstOrderMismatch(
            projectLedgerOrder(ledgerByName, [], expected, now), expected
        );
        const projectedMismatch = firstOrderMismatch(
            projectLedgerOrder(ledgerByName, toStamp, expected, now), expected
        );
        const orderViolations = projectedMismatch ? 1 : 0;

        if (projectedMismatch) {
            const { index, expected: want, actual } = projectedMismatch;
            console.error(`${LOG} ORDER VIOLATION at ledger position ${index}: node-pg-migrate `
                + `expects "${want}" there but the ledger reads "${actual}" — migrate:up will `
                + `abort with "Not run migration ${want} is preceding already run migration `
                + `${actual}".`);

            // Name the cause, because the three look identical from the error.
            if (!onDisk.has(actual)) {
                console.error(`${LOG}   cause: ORPHAN ledger row "${actual}" has no file on disk; `
                    + 'restore the migration file or remove the row by hand.');
            } else if (!inLedger.has(want) && !toStamp.includes(want)) {
                console.error(`${LOG}   cause: ${want} is PENDING but a later migration is already `
                    + 'applied; node-pg-migrate cannot fill a gap in the middle of the ledger.');
            } else {
                console.error(`${LOG}   cause: "${actual}" carries a run_on that sorts it ahead of `
                    + `"${want}"; the ledger rows were stamped out of file order.`);
            }

            if (baselineMismatch && baselineMismatch.index < index) {
                console.error(`${LOG}   note: stamping advances the first mismatch from position `
                    + `${baselineMismatch.index} to ${index}, but does not clear it.`);
            }
        } else if (baselineMismatch) {
            console.log(`${LOG} order repaired: the ledger currently breaks at position `
                + `${baselineMismatch.index} ("${baselineMismatch.actual}" where `
                + `"${baselineMismatch.expected}" is expected); after stamping it matches file `
                + 'order.');
        }

        const counts = rows.reduce((acc, r) => {
            acc[r.action] = (acc[r.action] || 0) + 1;
            return acc;
        }, {});
        console.log(`${LOG} ${counts.none || 0} already present, ${counts.STAMP || 0} to stamp, `
            + `${counts.PENDING || 0} pending, ${counts.UNKNOWN || 0} unknown, ${orphans.length} orphan`);

        if (unknown > 0) {
            console.error(`${LOG} ${unknown} migration(s) have no usable evidence predicate — `
                + 'add an entry to src/schema/ledger-manifest.json for each.');
        }

        if (opts.dryRun) {
            console.log(`${LOG} dry run — nothing written.`);
            return unknown > 0 || orderViolations > 0 ? 1 : 0;
        }

        if (orderViolations > 0) {
            console.error(`${LOG} refusing to apply while order violations stand.`);
            return 1;
        }

        if (toStamp.length === 0) {
            console.log(`${LOG} nothing to stamp.`);
            return unknown > 0 ? 1 : 0;
        }

        await client.query('BEGIN');
        try {
            // toStamp is in file order (it was built by walking `expected`),
            // which the SERIAL id then preserves as the ORDER BY tiebreaker.
            for (const name of toStamp) {
                const followers = expected.slice(expected.indexOf(name) + 1);
                // run_on is deliberately NOT NOW(): see stampRunOn() above. The
                // anchor subquery only ever sees rows that are already in the
                // ledger — the stamps still queued behind this one all sort
                // AFTER `name` in file order, so they cannot be its followers.
                const res = await client.query(
                    `INSERT INTO hospital.pgmigrations (name, run_on)
                     SELECT $1::varchar,
                            COALESCE(
                                (SELECT min(run_on) FROM hospital.pgmigrations
                                  WHERE name = ANY($2::varchar[])),
                                NOW()
                            ) - INTERVAL '1 second'
                      WHERE NOT EXISTS (SELECT 1 FROM hospital.pgmigrations WHERE name = $1::varchar)
                     RETURNING run_on`,
                    [name, followers]
                );
                const stampedAt = res.rows.length ? res.rows[0].run_on.toISOString() : '(already present)';
                console.log(`${LOG} stamped ${name} @ ${stampedAt}`);
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(`${LOG} stamping failed, rolled back: ${err.message}`);
            return 1;
        }

        console.log(`${LOG} ${toStamp.length} row(s) inserted.`);
        return unknown > 0 ? 1 : 0;
    } finally {
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
