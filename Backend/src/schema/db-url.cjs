#!/usr/bin/env node
/**
 * Shared DATABASE_URL composition for every schema-layer CLI.
 *
 * node-pg-migrate expects a single DATABASE_URL connection string but the
 * ClaimOS .env exposes the discrete POSTGRES_* vars used by the runtime app.
 * run-migrations.cjs, run-seeds.cjs and reconcile-ledger.cjs all need the exact
 * same composition (including the RDS sslmode handling), so it lives here once
 * rather than being copy-pasted three ways and drifting.
 */
'use strict';

const path = require('path');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];

/**
 * Load Backend/.env so POSTGRES_* are available when invoked outside Docker.
 * Inside the container env vars are injected directly and this is a no-op.
 */
function loadDotenv() {
    try {
        require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
    } catch (_) {
        // dotenv is a runtime dep; if missing we just rely on the inherited env.
    }
}

/**
 * Compose DATABASE_URL from POSTGRES_* unless it is already set.
 *
 * @param {object} [opts]
 * @param {string} [opts.label] prefix used in error messages, e.g. '[run-seeds]'
 * @returns {string} the connection string (also written back to process.env)
 */
function resolveDatabaseUrl(opts) {
    const label = (opts && opts.label) || '[db-url]';

    if (process.env.DATABASE_URL) {
        return process.env.DATABASE_URL;
    }

    const user = encodeURIComponent(process.env.POSTGRES_USER || '');
    const pass = encodeURIComponent(process.env.POSTGRES_PASSWORD || '');
    const host = process.env.POSTGRES_HOST || 'localhost';
    const port = process.env.POSTGRES_PORT || '5432';
    const db   = process.env.POSTGRES_DB   || '';

    if (!user || !db) {
        console.error(
            `${label} POSTGRES_USER and POSTGRES_DB must be set (or DATABASE_URL provided).`
        );
        process.exit(1);
    }

    const auth = pass ? `${user}:${pass}` : user;

    // RDS (and most managed Postgres) reject unencrypted connections — add
    // SSL automatically for any non-local host. Default to `no-verify`:
    // - `require` makes the `pg` Node driver enforce CA-chain validation,
    //   which fails on RDS because Amazon's intermediate CA isn't in
    //   Node's bundled trust store (UNABLE_TO_GET_ISSUER_CERT_LOCALLY).
    // - `no-verify` keeps the transport encrypted but skips chain checks.
    //   Acceptable for migrations on a VPC-internal DB endpoint.
    // Operators can override via POSTGRES_SSLMODE if they bundle the
    // RDS CA (set to 'verify-full' once that's wired up).
    const sslmode = process.env.POSTGRES_SSLMODE
        || (LOCAL_HOSTS.includes(host) ? '' : 'no-verify');
    const sslSuffix = sslmode ? `?sslmode=${sslmode}` : '';

    process.env.DATABASE_URL = `postgres://${auth}@${host}:${port}/${db}${sslSuffix}`;
    return process.env.DATABASE_URL;
}

/**
 * `pg` Client config matching the composed URL. `sslmode=no-verify` is a libpq
 * spelling the node driver does not understand from the URL alone, so it is
 * translated into `ssl: { rejectUnauthorized: false }` here.
 */
function clientConfig(opts) {
    const connectionString = resolveDatabaseUrl(opts);
    const cfg = { connectionString };

    if (/[?&]sslmode=no-verify\b/.test(connectionString)) {
        cfg.ssl = { rejectUnauthorized: false };
    } else if (/[?&]sslmode=(require|prefer)\b/.test(connectionString)) {
        cfg.ssl = { rejectUnauthorized: false };
    }

    return cfg;
}

module.exports = { LOCAL_HOSTS, loadDotenv, resolveDatabaseUrl, clientConfig };
