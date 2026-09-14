#!/usr/bin/env node
/**
 * Repair the ORDER of hospital.pgmigrations — rewrite run_on so the ledger
 * node-pg-migrate reads is an exact prefix of file order.
 *
 * WHY THIS EXISTS. reconcile-ledger.cjs fixes the ledger's CONTENTS: rows that
 * are missing for migrations the database demonstrably already has. It cannot
 * fix the other failure mode, and on 2026-09-14 production hit exactly that:
 *
 *   86 already present, 0 to stamp, 0 pending, 0 unknown, 0 orphan
 *   ORDER VIOLATION at ledger position 7: node-pg-migrate expects
 *   "001_add_s3_support" there but the ledger reads
 *   "013_create_cashless_everywhere_tables"
 *
 * Every row was present. Nothing to stamp. But `migrate:up` still aborted,
 * because prod-bootstrap-final.sql hand-stamped 65 names in an order of its
 * own choosing, and node-pg-migrate loads the ledger with `ORDER BY run_on, id`
 * and compares it POSITIONALLY against the files on disk. A correct name
 * carrying the wrong timestamp breaks it exactly as hard as a missing row —
 * and permanently, since no future migration can ever repair a prefix.
 *
 * That is what kept the compose `migrate` service exiting 1 on every deploy,
 * which is how production ran for hours on an un-migrated schema.
 *
 * WHAT IT DOES. Assigns every applied row a new run_on, strictly increasing in
 * file order, anchored at the ledger's existing earliest timestamp. Distinct
 * values throughout, so the `id` tiebreak never decides anything.
 *
 * WHAT IT REFUSES TO DO. run_on is bookkeeping, but a ledger is not a thing to
 * guess at, so this script only touches one that is otherwise healthy:
 *   - an ORPHAN row (in the ledger, no file on disk) -> refuse; restoring the
 *     file or deleting the row is a human decision.
 *   - a DUPLICATE name -> refuse; migration 075 de-duplicates, run it first.
 *   - a PENDING migration sitting BEFORE an applied one -> refuse; that is a
 *     genuine gap, which is reconcile-ledger.cjs's job, not this one.
 *   - a projected order that still fails checkOrder -> refuse, and write
 *     nothing.
 * Pending migrations at the END are fine and expected — checkOrder only
 * requires that the applied rows form a prefix.
 *
 * Before writing, --apply prints the UPDATE statements that restore the
 * previous timestamps. Copy them somewhere before answering yes.
 *
 * Usage:
 *   npm run db:repair-ledger-order:dry    # print the plan, write nothing
 *   npm run db:repair-ledger-order        # apply it
 *
 * Exit codes: 0 = clean (or already correct), 1 = refused or failed.
 */
'use strict';

const { loadDotenv, clientConfig } = require('./db-url.cjs');
const { discoverMigrations, firstOrderMismatch } = require('./migration-order.cjs');

const LOG = '[repair-ledger-order]';

// Spacing between consecutive stamps. One second is plenty to keep every value
// distinct while leaving the ledger's overall footprint recognisable.
const STEP_MS = 1000;

function usage() {
    console.log(`Usage: node src/schema/repair-ledger-order.cjs (--dry-run | --apply)

  --dry-run   print the plan and exit without touching the ledger
  --apply     rewrite run_on for every applied migration, in file order

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

function iso(d) { return new Date(d).toISOString(); }

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    loadDotenv();

    let Client;
    try {
        ({ Client } = require('pg'));
    } catch (err) {
        console.error(`${LOG} the "pg" package is required:`, err.message);
        return 1;
    }

    const client = new Client(clientConfig({ label: LOG }));
    await client.connect();

    try {
        const expected = discoverMigrations();

        // The ledger EXACTLY as node-pg-migrate reads it.
        const { rows: ledger } = await client.query(
            'SELECT id, name, run_on FROM hospital.pgmigrations ORDER BY run_on, id'
        );

        if (ledger.length === 0) {
            console.log(`${LOG} ledger is empty — nothing to reorder.`);
            return 0;
        }

        const currentOrder = ledger.map((r) => r.name);
        const onDisk = new Set(expected);
        const seen = new Map();
        for (const r of ledger) seen.set(r.name, (seen.get(r.name) || 0) + 1);

        // ── Refusal gates. Each names a different repair, none of them this one.
        const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([n]) => n);
        if (duplicates.length) {
            console.error(`${LOG} refusing: ${duplicates.length} duplicated name(s) in the ledger `
                + `(${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ', …' : ''}).`);
            console.error(`${LOG}   fix: apply migration 075_seed_ledger, which de-duplicates and `
                + 'adds pgmigrations_name_uniq.');
            return 1;
        }

        const orphans = currentOrder.filter((n) => !onDisk.has(n));
        if (orphans.length) {
            console.error(`${LOG} refusing: ${orphans.length} orphan row(s) with no file on disk `
                + `(${orphans.join(', ')}).`);
            console.error(`${LOG}   fix: restore the migration file, or delete the row by hand. `
                + 'Reordering cannot resolve a name that does not exist.');
            return 1;
        }

        // Applied rows must form a PREFIX of file order. A pending migration in
        // the MIDDLE is a genuine gap — node-pg-migrate cannot fill one, and no
        // amount of re-timestamping changes that.
        const appliedSet = new Set(currentOrder);
        const target = expected.filter((n) => appliedSet.has(n));
        const prefix = expected.slice(0, target.length);
        const gapAt = prefix.findIndex((n) => !appliedSet.has(n));
        if (gapAt !== -1) {
            console.error(`${LOG} refusing: "${prefix[gapAt]}" is PENDING but later migrations are `
                + 'already applied — a gap in the middle of the ledger.');
            console.error(`${LOG}   fix: npm run db:reconcile-ledger:dry — if its effects are `
                + 'already present it can be stamped; otherwise this needs a human.');
            return 1;
        }

        const pendingTail = expected.filter((n) => !appliedSet.has(n));
        if (pendingTail.length) {
            console.log(`${LOG} ${pendingTail.length} migration(s) pending at the tail `
                + `(${pendingTail.slice(0, 3).join(', ')}${pendingTail.length > 3 ? ', …' : ''}) `
                + '— expected, and not an ordering problem.');
        }

        // ── Already correct? Then say so and change nothing.
        const before = firstOrderMismatch(currentOrder, expected);
        if (!before) {
            console.log(`${LOG} ledger already matches file order across all ${ledger.length} `
                + 'row(s) — nothing to repair.');
            return 0;
        }
        console.log(`${LOG} order breaks at position ${before.index}: expected `
            + `"${before.expected}", ledger reads "${before.actual}".`);

        // ── The plan. Anchor at the earliest existing stamp; step from there.
        const anchor = ledger.reduce(
            (min, r) => (r.run_on < min ? r.run_on : min), ledger[0].run_on
        );
        const byName = new Map(ledger.map((r) => [r.name, r]));
        const plan = target.map((name, i) => ({
            id: byName.get(name).id,
            name,
            from: byName.get(name).run_on,
            to: new Date(anchor.getTime() + i * STEP_MS),
            wasAt: currentOrder.indexOf(name),
            nowAt: i,
        }));

        // ── Verify the plan BEFORE writing it. Rebuild the ledger this run
        // would leave behind and replay checkOrder against it. Every run_on is
        // distinct by construction, so `id` never breaks a tie — but sort on it
        // anyway, because that is what node-pg-migrate does.
        const projected = [...plan]
            .sort((a, b) => (a.to - b.to) || (a.id - b.id))
            .map((r) => r.name);
        const after = firstOrderMismatch(projected, expected);
        if (after) {
            console.error(`${LOG} refusing: the computed plan STILL breaks at position `
                + `${after.index} (expected "${after.expected}", got "${after.actual}"). `
                + 'This is a bug in the plan, not in your database — nothing was written.');
            return 1;
        }

        const moved = plan.filter((r) => r.wasAt !== r.nowAt);
        console.log(`${LOG} ${plan.length} row(s) to restamp, ${moved.length} of which change `
            + `position. New stamps run ${iso(plan[0].to)} → ${iso(plan[plan.length - 1].to)}.`);
        console.log('');
        for (const r of moved.slice(0, 20)) {
            console.log(`${LOG}   ${String(r.wasAt).padStart(3)} → ${String(r.nowAt).padStart(3)}  `
                + `${r.name.padEnd(52)} ${iso(r.from)} → ${iso(r.to)}`);
        }
        if (moved.length > 20) {
            console.log(`${LOG}   … and ${moved.length - 20} more`);
        }
        console.log('');
        console.log(`${LOG} after this, checkOrder passes — migrate:up runs without `
            + '--no-check-order.');

        if (opts.dryRun) {
            console.log(`${LOG} dry run — nothing written.`);
            return 0;
        }

        // ── Restore script, printed BEFORE the write. Files created inside the
        // container do not survive it, so this goes to stdout deliberately:
        // copy it somewhere before you walk away.
        console.log('');
        console.log(`${LOG} ── restore script (copy this before continuing) ──`);
        console.log('BEGIN;');
        for (const r of plan) {
            console.log(`UPDATE hospital.pgmigrations SET run_on = '${iso(r.from)}' WHERE id = ${r.id};`);
        }
        console.log('COMMIT;');
        console.log(`${LOG} ── end restore script ──`);
        console.log('');

        await client.query('BEGIN');
        try {
            for (const r of plan) {
                await client.query(
                    'UPDATE hospital.pgmigrations SET run_on = $1 WHERE id = $2',
                    [r.to, r.id]
                );
            }

            // Re-read INSIDE the transaction and re-check. If the database
            // disagrees with the projection for any reason, roll back rather
            // than commit a ledger we have not verified.
            const { rows: after2 } = await client.query(
                'SELECT name FROM hospital.pgmigrations ORDER BY run_on, id'
            );
            const mismatch = firstOrderMismatch(after2.map((r) => r.name), expected);
            if (mismatch) {
                await client.query('ROLLBACK');
                console.error(`${LOG} post-write verification FAILED at position ${mismatch.index} `
                    + `(expected "${mismatch.expected}", got "${mismatch.actual}") — rolled back, `
                    + 'ledger unchanged.');
                return 1;
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }

        console.log(`${LOG} ✓ ${plan.length} row(s) restamped and verified in file order.`);
        console.log(`${LOG} ✓ next step: docker compose run --rm --no-deps migrate; echo "exit=$?"`);
        return 0;
    } finally {
        await client.end();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(`${LOG} ✗ ${err.message}`);
        process.exit(1);
    });
