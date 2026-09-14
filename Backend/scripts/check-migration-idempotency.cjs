#!/usr/bin/env node
/**
 * Migration + seed idempotency guard.
 *
 * Makes idempotency a property the repo ENFORCES rather than a state it
 * happens to be in. Pure static analysis: node stdlib only, no database, no
 * dependencies, so it runs in seconds on every PR.
 *
 * Scans:
 *   Backend/src/schema/migrations/*.sql   (excluding *_rollback.sql)
 *   Backend/src/schema/seeds/ ** /*.sql   (excluding anything under _dev/)
 *
 * Usage:
 *   node scripts/check-migration-idempotency.cjs
 *   node scripts/check-migration-idempotency.cjs --json
 *   node scripts/check-migration-idempotency.cjs --fix        # R1 R2 R5 R6 R7
 *   node scripts/check-migration-idempotency.cjs --base origin/main   # enables R12b
 *   node scripts/check-migration-idempotency.cjs --write-baseline R13 --added-by "<who>"
 *
 * Exit codes:
 *   0 = clean
 *   1 = at least one violation, or a stale hand-written allowlist entry
 *
 * Suppression is ALWAYS an allowlist entry — file + line + rule + reason +
 * added_by, in migration-idempotency-allowlist.json. A `-- idempotent: …`
 * comment in the SQL suppresses nothing: comments are masked out before any
 * rule runs, precisely so a claim about a statement can never be mistaken for
 * a guard on it. Every suppressed violation is PRINTED on every run, so
 * accepted debt stays visible instead of going quiet.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'Backend', 'src', 'schema', 'migrations');
const SEEDS_DIR = path.join(REPO_ROOT, 'Backend', 'src', 'schema', 'seeds');
const ALLOWLIST_PATH = path.join(__dirname, 'migration-idempotency-allowlist.json');

const argv = process.argv.slice(2);
const WANT_JSON = argv.includes('--json');
const WANT_FIX = argv.includes('--fix');
const flagValue = (name) =>
    (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined) || undefined;
/** Rule to (re)baseline into the allowlist, e.g. --write-baseline R13. */
const WRITE_BASELINE = flagValue('--write-baseline') || null;
const BASELINE_ADDED_BY = flagValue('--added-by') || null;
const BASE_REF =
    (argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined) ||
    process.env.MIGRATION_BASE_REF ||
    null;

// ─────────────────────────────────────────────────────────────────────────────
// Pre-processing
//
// Everything below matches against a MASKED copy of the file in which comments
// and string literals have been replaced by spaces, character-for-character, so
// offsets (and therefore line numbers) are identical to the original. Without
// this the guard false-positives on real files: 038_kb_patterns.sql:27 has
// "ADD CONSTRAINT" inside a comment, and 069:16-20 has "DROP TABLE IF EXISTS" /
// "ADD CONSTRAINT" inside a rollback-instructions comment block.
//
// Dollar-quoted bodies are handled in two ways:
//   - a FUNCTION body (or any non-DO dollar string) is blanked — its contents
//     are data, not schema statements;
//   - a DO $$ … $$ body is RETAINED in `masked` and its range recorded in
//     `guarded`, because a statement inside a DO-block guard is exactly what
//     rules R4 and R9 are supposed to accept.
// `maskedAll` additionally blanks the DO bodies; it is what statement splitting
// uses so a semicolon inside plpgsql never splits a statement.
// ─────────────────────────────────────────────────────────────────────────────

function maskSql(src) {
    const n = src.length;
    const out = src.split('');
    const guarded = [];

    const blank = (a, b) => {
        for (let k = a; k < b && k < n; k++) {
            if (out[k] !== '\n') out[k] = ' ';
        }
    };

    let i = 0;
    while (i < n) {
        const c = src[i];

        // -- line comment
        if (c === '-' && src[i + 1] === '-') {
            let j = src.indexOf('\n', i);
            if (j === -1) j = n;
            blank(i, j);
            i = j;
            continue;
        }

        // /* block comment */ (Postgres nests these)
        if (c === '/' && src[i + 1] === '*') {
            let depth = 1;
            let j = i + 2;
            while (j < n && depth > 0) {
                if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
                else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
                else j++;
            }
            blank(i, j);
            i = j;
            continue;
        }

        // 'string literal' (with '' escapes)
        if (c === "'") {
            let j = i + 1;
            while (j < n) {
                if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
                if (src[j] === "'") { j++; break; }
                j++;
            }
            blank(i, j);
            i = j;
            continue;
        }

        // "quoted identifier" — kept verbatim: identifiers are what R3/R9 match on
        if (c === '"') {
            let j = i + 1;
            while (j < n) {
                if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue; }
                if (src[j] === '"') { j++; break; }
                j++;
            }
            i = j;
            continue;
        }

        // $$ … $$ / $tag$ … $tag$
        if (c === '$') {
            const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 64));
            if (m) {
                const tag = m[0];
                const bodyStart = i + tag.length;
                const close = src.indexOf(tag, bodyStart);
                const bodyEnd = close === -1 ? n : close;
                const regionEnd = close === -1 ? n : close + tag.length;

                const before = src.slice(Math.max(0, i - 80), i).replace(/\s+$/, '');
                const isDoBlock = /\bDO\s*(?:LANGUAGE\s+[A-Za-z_"]+)?$/i.test(before);

                if (isDoBlock) {
                    guarded.push({ start: i, end: regionEnd });
                } else {
                    blank(bodyStart, bodyEnd);
                }
                i = regionEnd;
                continue;
            }
        }

        i++;
    }

    const masked = out.join('');
    const allArr = out.slice();
    for (const g of guarded) {
        for (let k = g.start; k < g.end && k < n; k++) {
            if (allArr[k] !== '\n') allArr[k] = ' ';
        }
    }

    return { masked, maskedAll: allArr.join(''), guarded };
}

function lineStarts(src) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

function lineOf(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

function inGuarded(guarded, offset) {
    return guarded.some((g) => offset >= g.start && offset < g.end);
}

/** The DO $$ … $$ region containing `offset`, or null. */
function guardedRegionAt(guarded, offset) {
    return guarded.find((g) => offset >= g.start && offset < g.end) || null;
}

/**
 * True when `offset` sits lexically INSIDE an `IF … THEN … END IF` inside the
 * DO-block region, i.e. a condition actually governs the statement.
 *
 * Merely being in a DO block that mentions `IF` somewhere is not a guard: a
 * block can perfectly well run an unconditional DELETE and then RAISE NOTICE
 * inside an `IF`. Nesting depth is counted (ELSIF does not open a new block),
 * which is as far as a static, dependency-free checker can honestly go — it
 * does not evaluate what the condition tests.
 */
function inIfBlock(regionText, offsetInRegion) {
    const re = /\bEND\s+IF\b|\bELSIF\b|\bIF\b/gi;
    let depth = 0;
    let m;
    while ((m = re.exec(regionText)) !== null) {
        if (m.index >= offsetInRegion) break;
        const tok = m[0].replace(/\s+/g, ' ').toUpperCase();
        if (tok === 'END IF') depth = Math.max(0, depth - 1);
        else if (tok === 'IF') depth++;
    }
    return depth > 0;
}

/** Single-line, length-capped excerpt of the original statement. */
function excerpt(src, offset, maxLen = 90) {
    let end = src.indexOf(';', offset);
    if (end === -1) end = src.length;
    const raw = src.slice(offset, Math.min(end, offset + 400));
    const flat = raw.replace(/\s+/g, ' ').trim();
    return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
}

/**
 * True for `UPDATE t SET col = <v> … WHERE … col IS NULL …` — a backfill that
 * converges, because the statement falsifies its own predicate: the row it just
 * filled no longer matches, so a replay touches nothing. That is a REAL guard
 * (the predicate does the work), not an assertion about one, which is why R13
 * accepts it.
 *
 * At least ONE column the statement writes must be the column required to be
 * NULL. `SET code = … WHERE name IS NULL` does not qualify: it overwrites
 * whatever an operator has since put in `code`, every single run.
 */
function isNullBackfill(stmt) {
    const setM = /\bSET\b/i.exec(stmt);
    if (!setM) return false;
    const rest = stmt.slice(setM.index + setM[0].length);
    const whereM = /\bWHERE\b/i.exec(rest);
    if (!whereM) return false;

    const assigns = rest.slice(0, whereM.index);
    const where = rest.slice(whereM.index);
    // Multi-column `SET (a, b) = (…)` — not parsed, so not accepted.
    if (/^\s*\(/.test(assigns)) return false;

    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < assigns.length; i++) {
        const ch = assigns[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(assigns.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(assigns.slice(start));

    const cols = [];
    for (const p of parts) {
        const m = /^\s*([A-Za-z_"][A-Za-z0-9_"]*)\s*=/.exec(p);
        if (!m) return false;
        cols.push(baseName(m[1]));
    }
    if (cols.length === 0) return false;

    return cols.some((c) => new RegExp(`\\b${c}\\s+IS\\s+NULL\\b`, 'i').test(where));
}

/** Base (unqualified, unquoted, lowercased) name — hospital."Foo" -> foo. */
function baseName(ident) {
    const last = ident.split('.').pop();
    return last.replace(/"/g, '').toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules
//
// Each rule pushes { file, line, rule, statement, suggestion, offset, insert? }.
// `insert` is present only for the mechanically fixable rules (R1 R2 R5 R6 R7)
// and describes a pure text insertion into the ORIGINAL source.
// ─────────────────────────────────────────────────────────────────────────────

const RULES = {
    R1: 'CREATE TABLE without IF NOT EXISTS',
    R2: 'CREATE INDEX without IF NOT EXISTS',
    R3: 'CREATE TRIGGER without a preceding DROP TRIGGER IF EXISTS',
    R4: 'DROP without IF EXISTS (outside a guarded DO-block)',
    R5: 'CREATE VIEW without OR REPLACE',
    R6: 'CREATE FUNCTION without OR REPLACE',
    R7: 'CREATE EXTENSION without IF NOT EXISTS',
    R8: 'ADD COLUMN without IF NOT EXISTS',
    R9: 'ADD CONSTRAINT without a guard',
    R10: 'seed INSERT without ON CONFLICT',
    R11: 'seed contains DDL or explicit transaction control',
    R12: 'migration filename collides with, or renames, a released migration',
    R13: 'migration UPDATE/DELETE of live data without a real guard',
};

const FIXABLE = new Set(['R1', 'R2', 'R5', 'R6', 'R7']);

function scanSqlFile(relPath, src, kind) {
    const { masked, maskedAll, guarded } = maskSql(src);
    const starts = lineStarts(src);
    const found = [];

    const push = (rule, offset, suggestion, insert) => {
        found.push({
            file: relPath,
            line: lineOf(starts, offset),
            rule,
            statement: excerpt(src, offset),
            suggestion,
            offset,
            insert,
        });
    };

    const scan = (re, fn) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(masked)) !== null) {
            fn(m);
            if (m.index === re.lastIndex) re.lastIndex++;
        }
    };

    if (kind === 'migration') {
        // R1 — CREATE TABLE
        scan(
            /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/gi,
            (m) => {
                push('R1', m.index, 'CREATE TABLE IF NOT EXISTS …', {
                    at: m.index + m[0].length,
                    text: 'IF NOT EXISTS ',
                });
            }
        );

        // R2 — CREATE [UNIQUE] INDEX [CONCURRENTLY]
        scan(
            /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS\b)(?=[A-Za-z_"])/gi,
            (m) => {
                push('R2', m.index, 'CREATE INDEX IF NOT EXISTS …', {
                    at: m.index + m[0].length,
                    text: 'IF NOT EXISTS ',
                });
            }
        );

        // R3 — CREATE TRIGGER <name> … ON <table>, needs an earlier
        //      DROP TRIGGER IF EXISTS <same name> ON <same table>.
        const drops = [];
        scan(
            /\bDROP\s+TRIGGER\s+IF\s+EXISTS\s+([A-Za-z0-9_."]+)\s+ON\s+([A-Za-z0-9_."]+)/gi,
            (m) => {
                drops.push({
                    trigger: baseName(m[1]),
                    table: baseName(m[2]),
                    offset: m.index,
                });
            }
        );
        scan(
            /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([A-Za-z0-9_."]+)\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\b[\s\S]{0,400}?\bON\s+([A-Za-z0-9_."]+)/gi,
            (m) => {
                const trigger = baseName(m[1]);
                const table = baseName(m[2]);
                const paired = drops.some(
                    (d) => d.trigger === trigger && d.table === table && d.offset < m.index
                );
                if (!paired) {
                    push(
                        'R3',
                        m.index,
                        `prepend: DROP TRIGGER IF EXISTS ${m[1]} ON ${m[2]};`
                    );
                }
            }
        );

        // R4 — DROP <object> without IF EXISTS, outside a guarded DO-block
        scan(
            /\bDROP\s+(TABLE|INDEX|MATERIALIZED\s+VIEW|VIEW|TRIGGER|TYPE|SEQUENCE|FUNCTION|CONSTRAINT|COLUMN|SCHEMA)\s+(?!IF\s+EXISTS\b)(?=[A-Za-z_"])/gi,
            (m) => {
                if (inGuarded(guarded, m.index)) return;
                push('R4', m.index, `DROP ${m[1].toUpperCase()} IF EXISTS …`);
            }
        );

        // R5 — CREATE VIEW (materialized views cannot take OR REPLACE, so they
        //      are out of scope for this rule by construction).
        scan(
            /\bCREATE\s+(?!OR\s+REPLACE\b)(?!MATERIALIZED\b)(?:TEMP(?:ORARY)?\s+|RECURSIVE\s+)*VIEW\b/gi,
            (m) => {
                const at = m.index + /\bCREATE\s+/i.exec(m[0])[0].length;
                push('R5', m.index, 'CREATE OR REPLACE VIEW …', {
                    at,
                    text: 'OR REPLACE ',
                });
            }
        );

        // R6 — CREATE FUNCTION
        scan(/\bCREATE\s+(?!OR\s+REPLACE\b)FUNCTION\b/gi, (m) => {
            const at = m.index + /\bCREATE\s+/i.exec(m[0])[0].length;
            push('R6', m.index, 'CREATE OR REPLACE FUNCTION …', {
                at,
                text: 'OR REPLACE ',
            });
        });

        // R7 — CREATE EXTENSION
        scan(/\bCREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS\b)/gi, (m) => {
            push('R7', m.index, 'CREATE EXTENSION IF NOT EXISTS …', {
                at: m.index + m[0].length,
                text: 'IF NOT EXISTS ',
            });
        });

        // R8 — ADD COLUMN
        scan(/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/gi, (m) => {
            if (inGuarded(guarded, m.index)) return;
            push('R8', m.index, 'ADD COLUMN IF NOT EXISTS …');
        });

        // R9 — ADD CONSTRAINT: accepted inside a DO-block guard, or when the
        //      same file already dropped that constraint name defensively.
        const droppedConstraints = new Set();
        scan(/\bDROP\s+CONSTRAINT\s+IF\s+EXISTS\s+([A-Za-z0-9_."]+)/gi, (m) => {
            droppedConstraints.add(baseName(m[1]));
        });
        scan(/\bADD\s+CONSTRAINT\s+([A-Za-z0-9_."]+)/gi, (m) => {
            if (inGuarded(guarded, m.index)) return;
            if (droppedConstraints.has(baseName(m[1]))) return;
            push(
                'R9',
                m.index,
                `wrap in a conrelid-scoped DO $$ … IF NOT EXISTS (SELECT 1 FROM pg_constraint …) … END $$; ` +
                `or prepend DROP CONSTRAINT IF EXISTS ${m[1]};`
            );
        });

        // R13 — DATA mutation, not DDL shape.
        //
        // R1–R9 only prove a migration can be re-RUN without a DDL error; they
        // say nothing about what a re-run DOES to rows that already exist. A
        // re-run is not hypothetical: prod's hospital.pgmigrations came from a
        // dump, so any name missing from that ledger is replayed on the next
        // deploy. An UPDATE or DELETE replayed against live, operator-edited
        // rows is silent, un-audited data loss.
        //
        // A `-- idempotent: …` COMMENT is an assertion, not a guard, and is
        // invisible here by construction (comments are masked out before any
        // rule runs). The only things this rule accepts are:
        //
        //   1. a DO $$ … IF … THEN … END $$ wrapper — a real runtime condition,
        //      not a claim about one; or
        //   2. an explicit NOT EXISTS / WHERE NOT predicate on the statement
        //      itself, i.e. the statement no-ops on the second run; or
        //   3. a converging NULL backfill — every column written is also
        //      required to be NULL (see isNullBackfill).
        //
        // Anything else needs a reviewed entry in
        // scripts/migration-idempotency-allowlist.json (file + line + rule +
        // reason + added_by). A comment cannot suppress it.
        const mutations = [
            { re: /\bDELETE\s+FROM\b/gi, verb: 'DELETE' },
            // Requires a target relation between UPDATE and SET, which is what
            // separates a real statement from `ON CONFLICT … DO UPDATE SET`,
            // `ON UPDATE CASCADE` and `AFTER UPDATE ON …`.
            {
                re: /\bUPDATE\s+(?:ONLY\s+)?[A-Za-z_"][A-Za-z0-9_."]*\s+SET\b/gi,
                verb: 'UPDATE',
            },
        ];
        for (const { re, verb } of mutations) {
            scan(re, (m) => {
                // Predicate = this statement, up to its terminating semicolon.
                let end = masked.indexOf(';', m.index);
                if (end === -1) end = masked.length;
                const stmt = masked.slice(m.index, end);

                // 2. self-guarding predicate
                if (/\bNOT\s+EXISTS\b/i.test(stmt) || /\bWHERE\s+NOT\b/i.test(stmt)) return;
                if (verb === 'UPDATE' && isNullBackfill(stmt)) return;

                // 1. DO-block wrapper — the statement must be INSIDE the
                //    IF … THEN … END IF, not merely in a block that has one.
                const region = guardedRegionAt(guarded, m.index);
                if (region) {
                    const body = masked.slice(region.start, region.end);
                    if (inIfBlock(body, m.index - region.start)) return;
                }

                push(
                    'R13',
                    m.index,
                    `this ${verb} rewrites live rows on every replay — wrap it in ` +
                    `DO $$ BEGIN IF … THEN … END IF; END $$; or add a NOT EXISTS / WHERE NOT ` +
                    `predicate that makes the second run a no-op. A "-- idempotent:" comment ` +
                    `is not a guard; if the mutation genuinely cannot be guarded, add a ` +
                    `reviewed entry to scripts/migration-idempotency-allowlist.json`
                );
            });
        }
    }

    if (kind === 'seed') {
        // Statement splitting uses maskedAll so a ';' inside plpgsql cannot
        // split a statement in half.
        let cursor = 0;
        for (let i = 0; i <= maskedAll.length; i++) {
            const isEnd = i === maskedAll.length;
            if (!isEnd && maskedAll[i] !== ';') continue;
            const stmtStart = cursor;
            const stmtMasked = maskedAll.slice(cursor, i);
            cursor = i + 1;
            const trimmed = stmtMasked.trim();
            if (!trimmed) continue;
            const leadOffset = stmtStart + (stmtMasked.length - stmtMasked.trimStart().length);

            // R11 — no DDL, no explicit transaction control (the runner owns it)
            if (/^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END)\b\s*$/i.test(trimmed)) {
                push(
                    'R11',
                    leadOffset,
                    'remove it — run-seeds.cjs wraps each seed file in its own transaction'
                );
                continue;
            }
            const ddl = /^(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT)\b/i.exec(trimmed);
            if (ddl) {
                push(
                    'R11',
                    leadOffset,
                    `move this ${ddl[1].toUpperCase()} into src/schema/migrations/ — seeds are data only`
                );
                continue;
            }

            // R10 — every INSERT must converge, never duplicate
            if (/\bINSERT\s+INTO\b/i.test(trimmed) && !/\bON\s+CONFLICT\b/i.test(trimmed)) {
                const m = /\bINSERT\s+INTO\b/i.exec(stmtMasked);
                push(
                    'R10',
                    stmtStart + m.index,
                    'add ON CONFLICT (…) DO UPDATE SET … (or DO NOTHING for additive rows)'
                );
            }
        }
    }

    return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// R12 — filename safety (migrations only)
//
// A rename silently RE-RUNS the file on prod, because hospital.pgmigrations
// matches migrations by name. This is the single most dangerous thing a
// contributor can do here, so it gets its own rule.
// ─────────────────────────────────────────────────────────────────────────────

function checkFilenames(migrationFiles) {
    const found = [];
    const seen = new Map();

    for (const f of migrationFiles) {
        const key = path.basename(f, '.sql').toLowerCase();
        if (seen.has(key)) {
            found.push({
                file: path.relative(REPO_ROOT, f),
                line: 1,
                rule: 'R12',
                statement: path.basename(f),
                suggestion: `duplicates ${path.relative(REPO_ROOT, seen.get(key))} — migration names must be unique`,
                offset: 0,
            });
        } else {
            seen.set(key, f);
        }
    }

    if (!BASE_REF) return { found, baseChecked: false };

    // Renamed or deleted migrations, relative to the merge base.
    let out;
    try {
        out = execFileSync(
            'git',
            ['diff', '--name-status', '--find-renames', `${BASE_REF}...HEAD`, '--', 'Backend/src/schema/migrations'],
            { cwd: REPO_ROOT, encoding: 'utf8' }
        );
    } catch (err) {
        return { found, baseChecked: false, baseError: err.message.split('\n')[0] };
    }

    for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const status = parts[0];
        if (/^R/.test(status)) {
            found.push({
                file: parts[2],
                line: 1,
                rule: 'R12',
                statement: `${parts[1]} -> ${parts[2]}`,
                suggestion:
                    'restore the original filename — prod matches hospital.pgmigrations by name, so a rename re-runs the migration',
                offset: 0,
            });
        } else if (status === 'D' && /_rollback\.sql$/.test(parts[1]) === false) {
            found.push({
                file: parts[1],
                line: 1,
                rule: 'R12',
                statement: `deleted ${parts[1]}`,
                suggestion:
                    'restore the file — migrations are append-only; deleting one breaks from-scratch bring-up and node-pg-migrate ordering',
                offset: 0,
            });
        }
    }

    return { found, baseChecked: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// File discovery
// ─────────────────────────────────────────────────────────────────────────────

function listMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql') && !f.endsWith('_rollback.sql'))
        .sort()
        .map((f) => path.join(MIGRATIONS_DIR, f));
}

function listSeeds(dir = SEEDS_DIR, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // `_dev/` holds destructive, developer-only helpers. run-seeds.cjs
            // skips them, so the guard must skip them too or they are flagged
            // forever with no legal fix.
            if (entry.name === '_dev') continue;
            listSeeds(full, acc);
        } else if (entry.isFile() && entry.name.endsWith('.sql')) {
            acc.push(full);
        }
    }
    return acc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist
// ─────────────────────────────────────────────────────────────────────────────

function loadAllowlist() {
    if (!fs.existsSync(ALLOWLIST_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
    if (!Array.isArray(raw.entries)) {
        throw new Error(`${path.relative(REPO_ROOT, ALLOWLIST_PATH)}: "entries" must be an array`);
    }
    for (const e of raw.entries) {
        for (const field of ['file', 'line', 'rule', 'reason', 'added_by']) {
            if (e[field] === undefined) {
                throw new Error(
                    `${path.relative(REPO_ROOT, ALLOWLIST_PATH)}: entry is missing "${field}" — every exception must be attributable`
                );
            }
        }
        if (e.baseline !== undefined && typeof e.baseline !== 'boolean') {
            throw new Error(
                `${path.relative(REPO_ROOT, ALLOWLIST_PATH)}: ${e.file}:${e.line} "baseline" must be a boolean`
            );
        }
    }
    return raw.entries;
}

function allowKey(e) {
    return `${e.file}::${e.line}::${e.rule}`;
}

/**
 * Rewrite the allowlist so every CURRENT violation of `rule` is an explicit,
 * attributable entry marked `"baseline": true`.
 *
 * Why this exists: R13 was introduced against 85 already-released migrations.
 * Line-numbered suppressions for files other people are editing rot instantly,
 * and hand-transcribing dozens of entries is how a suppression list stops being
 * reviewed. Entries written here keep any reason already recorded for the same
 * file+rule, so re-running after a migration edit re-anchors the line numbers
 * without discarding the review.
 *
 * A baseline entry is DEBT, not absolution: it is printed on every run, and it
 * never suppresses a NEW violation — a mutation added to an already-baselined
 * file lands on a line that has no entry.
 */
function writeBaseline(rule, violations, existingEntries, addedBy) {
    const keep = existingEntries.filter((e) => e.rule !== rule);
    const priorReason = new Map();
    for (const e of existingEntries) {
        if (e.rule === rule && e.reason) priorReason.set(`${e.file}::${e.rule}`, e.reason);
    }

    const fresh = violations
        .filter((v) => v.rule === rule)
        .map((v) => ({
            file: v.file,
            line: v.line,
            rule: v.rule,
            baseline: true,
            reason:
                priorReason.get(`${v.file}::${v.rule}`) ||
                `pre-existing ${rule} debt recorded when the rule was introduced — this statement ` +
                `rewrites live rows on replay and has not been guarded yet`,
            added_by: addedBy,
        }));

    const raw = fs.existsSync(ALLOWLIST_PATH)
        ? JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
        : { version: 1, entries: [] };
    raw.entries = [...keep, ...fresh].sort((a, b) =>
        a.file === b.file ? a.line - b.line || a.rule.localeCompare(b.rule) : a.file.localeCompare(b.file)
    );
    fs.writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(raw, null, 2)}\n`);
    return fresh.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// --fix
// ─────────────────────────────────────────────────────────────────────────────

function applyFixes(violationsByFile) {
    let fixedCount = 0;
    const touched = [];
    for (const [rel, list] of violationsByFile) {
        const fixable = list.filter((v) => FIXABLE.has(v.rule) && v.insert);
        if (fixable.length === 0) continue;
        const abs = path.join(REPO_ROOT, rel);
        let src = fs.readFileSync(abs, 'utf8');
        // Apply back-to-front so earlier offsets stay valid.
        for (const v of [...fixable].sort((a, b) => b.insert.at - a.insert.at)) {
            src = src.slice(0, v.insert.at) + v.insert.text + src.slice(v.insert.at);
            fixedCount++;
        }
        fs.writeFileSync(abs, src);
        touched.push(rel);
    }
    return { fixedCount, touched };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
    const migrations = listMigrations();
    const seeds = listSeeds();

    let violations = [];

    for (const f of migrations) {
        const rel = path.relative(REPO_ROOT, f);
        violations.push(...scanSqlFile(rel, fs.readFileSync(f, 'utf8'), 'migration'));
    }
    for (const f of seeds) {
        const rel = path.relative(REPO_ROOT, f);
        violations.push(...scanSqlFile(rel, fs.readFileSync(f, 'utf8'), 'seed'));
    }

    const nameCheck = checkFilenames(migrations);
    violations.push(...nameCheck.found);

    violations.sort((a, b) =>
        a.file === b.file ? a.line - b.line || a.rule.localeCompare(b.rule) : a.file.localeCompare(b.file)
    );

    // Allowlist filtering + stale-suppression detection.
    let allowlist;
    try {
        allowlist = loadAllowlist();
    } catch (err) {
        console.error(`[lint:migrations] ${err.message}`);
        process.exit(1);
    }
    if (WRITE_BASELINE) {
        if (!RULES[WRITE_BASELINE]) {
            console.error(
                `[lint:migrations] --write-baseline: unknown rule "${WRITE_BASELINE}" (expected one of ${Object.keys(RULES).join(', ')})`
            );
            process.exit(1);
        }
        if (!BASELINE_ADDED_BY) {
            console.error(
                '[lint:migrations] --write-baseline requires --added-by "<who is accepting this debt>" — an unattributable suppression is not reviewable.'
            );
            process.exit(1);
        }
        const written = writeBaseline(WRITE_BASELINE, violations, allowlist, BASELINE_ADDED_BY);
        console.log(
            `[lint:migrations] wrote ${written} ${WRITE_BASELINE} baseline entr(ies) to ` +
            `${path.relative(REPO_ROOT, ALLOWLIST_PATH)}. Review every "reason" before committing.`
        );
        process.exit(0);
    }

    const matchedAllow = new Set();
    const suppressed = [];
    const active = [];
    for (const v of violations) {
        const key = allowKey(v);
        const hit = allowlist.find((e) => allowKey(e) === key);
        if (hit) {
            matchedAllow.add(key);
            suppressed.push({
                ...v,
                reason: hit.reason,
                added_by: hit.added_by,
                baseline: hit.baseline === true,
            });
        } else {
            active.push(v);
        }
    }
    // A hand-written suppression that no longer matches anything is rot and
    // FAILS the build. A `baseline` entry that no longer matches means somebody
    // actually guarded the statement — the outcome this rule exists to produce —
    // so it is reported for removal without failing, which is what lets the
    // migration owner land a guard without also having to edit this script's
    // allowlist in the same change.
    const stale = allowlist.filter((e) => !matchedAllow.has(allowKey(e)));
    const staleManual = stale.filter((e) => e.baseline !== true);
    const staleBaseline = stale.filter((e) => e.baseline === true);

    if (WANT_FIX) {
        const byFile = new Map();
        for (const v of active) {
            if (!byFile.has(v.file)) byFile.set(v.file, []);
            byFile.get(v.file).push(v);
        }
        const { fixedCount, touched } = applyFixes(byFile);
        console.log(
            `[lint:migrations] --fix applied ${fixedCount} mechanical fix(es) across ${touched.length} file(s).`
        );
        for (const t of touched) console.log(`   fixed  ${t}`);
        console.log('[lint:migrations] re-run without --fix to verify.');
        process.exit(0);
    }

    const ok = active.length === 0 && staleManual.length === 0;

    if (WANT_JSON) {
        console.log(
            JSON.stringify(
                {
                    ok,
                    scanned: { migrations: migrations.length, seeds: seeds.length },
                    violations: active.map(({ offset, insert, ...rest }) => rest),
                    suppressed: suppressed.map(({ offset, insert, ...rest }) => rest),
                    stale_allowlist_entries: staleManual,
                    resolved_baseline_entries: staleBaseline,
                    filename_base_checked: nameCheck.baseChecked,
                },
                null,
                2
            )
        );
        process.exit(ok ? 0 : 1);
    }

    for (const v of active) {
        console.log(
            `${v.file}:${v.line}  [${v.rule}]  ${v.statement}  -> ${v.suggestion}`
        );
    }

    // Accepted debt is printed, never merely counted — an invisible suppression
    // is the exact failure mode (`-- idempotent:` comments) this rule exists to
    // stop.
    for (const s of suppressed) {
        console.log(
            `${s.file}:${s.line}  [ALLOWLISTED ${s.rule}${s.baseline ? ' baseline' : ''}]  ${s.statement}  -> ${s.reason} (${s.added_by})`
        );
    }

    for (const s of staleManual) {
        console.log(
            `${s.file}:${s.line}  [STALE-ALLOWLIST]  no ${s.rule} violation here any more  -> remove this entry from ${path.relative(REPO_ROOT, ALLOWLIST_PATH)}`
        );
    }

    for (const s of staleBaseline) {
        console.log(
            `${s.file}:${s.line}  [BASELINE RESOLVED]  the ${s.rule} debt here is guarded now  -> drop this entry from ${path.relative(REPO_ROOT, ALLOWLIST_PATH)} (or re-run --write-baseline ${s.rule})`
        );
    }

    console.log('');
    console.log(
        `[lint:migrations] scanned ${migrations.length} migration(s) + ${seeds.length} seed(s); ` +
        `${active.length} violation(s), ${suppressed.length} allowlisted ` +
        `(${suppressed.filter((s) => s.baseline).length} baseline), ${staleManual.length} stale allowlist entr(ies), ` +
        `${staleBaseline.length} resolved baseline entr(ies).`
    );
    if (!nameCheck.baseChecked) {
        console.log(
            '[lint:migrations] R12 rename/delete detection skipped — pass --base <ref> (or set MIGRATION_BASE_REF) to enable it.'
        );
    }
    if (active.length > 0) {
        const byRule = new Map();
        for (const v of active) byRule.set(v.rule, (byRule.get(v.rule) || 0) + 1);
        console.log('');
        for (const [rule, count] of [...byRule].sort()) {
            console.log(`   ${rule} × ${count} — ${RULES[rule]}`);
        }
        console.log('');
        console.log(
            '   R1/R2/R5/R6/R7 are mechanical: `node scripts/check-migration-idempotency.cjs --fix` rewrites them in place.'
        );
        if (byRule.has('R13')) {
            console.log(
                '   R13 is NOT mechanical: guard the statement, or add a reviewed allowlist entry.\n' +
                '   A "-- idempotent: …" comment does not suppress it — comments are masked out before the rules run.'
            );
        }
    }

    process.exit(ok ? 0 : 1);
}

main();
