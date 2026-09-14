#!/usr/bin/env node
/**
 * node-pg-migrate's ordering rules, in one place.
 *
 * WHY THIS EXISTS. Two scripts now reason about the ledger's ORDER —
 * reconcile-ledger.cjs (which stamps rows that are MISSING) and
 * repair-ledger-order.cjs (which fixes rows that are PRESENT but carry the
 * wrong run_on). Both have to agree, byte for byte, with what node-pg-migrate
 * itself does in `checkOrder`, because a disagreement does not fail loudly —
 * it blesses an ordering the migrator will then reject, or worse, declares a
 * broken ledger healthy.
 *
 * Copy-pasting these four functions into the second tool is precisely how the
 * production ledger got into its current state: independent stamping logic,
 * each locally reasonable, collectively inconsistent. So they live here once.
 *
 * Reference: node_modules/node-pg-migrate/dist/migration.js -> getNumericPrefix
 *            node_modules/node-pg-migrate/dist/runner.js:165-176 -> checkOrder
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

/**
 * Reproduce node-pg-migrate's numeric prefix EXACTLY. This is not the same as
 * lexical filename order and the difference is load-bearing: node-pg-migrate
 * sorts by getNumericPrefix(basename.split('_')[0]), and any prefix that is
 * not all digits (002b, 002c, 003b) falls back to 0 — so those files sort
 * BEFORE 001_add_s3_support.
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

/** Sort comparator: numeric prefix, then filename as the tiebreak. */
function migrationOrder(a, b) {
    const d = numericPrefix(a) - numericPrefix(b);
    if (d !== 0) return d;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Every migration on disk, in the order node-pg-migrate would run them. */
function discoverMigrations() {
    return fs.readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && !f.endsWith('_rollback.sql'))
        .map((f) => f.slice(0, -'.sql'.length))
        .sort(migrationOrder);
}

/**
 * Replay node-pg-migrate's checkOrder and return its first disagreement, or
 * null.
 *
 * The invariant is stricter than "applied names sort before pending ones": the
 * ledger read (ORDER BY run_on, id) must be an exact PREFIX of the file-ordered
 * list. A gap in the middle, an orphan row, or a correct name carrying the
 * wrong run_on all fail it, and all three produce the SAME error message.
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

module.exports = {
    MIGRATIONS_DIR,
    numericPrefix,
    migrationOrder,
    discoverMigrations,
    firstOrderMismatch,
};
