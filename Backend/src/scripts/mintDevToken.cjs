#!/usr/bin/env node
/**
 * Mint a short-lived LOCAL-DEV superadmin token for smoke testing.
 *
 * WHY: the adjudication smoke test drives the real HTTP surface, and most of
 * those endpoints are superadmin-gated. Testing them needs a bearer token.
 *
 * NO PASSWORD IS INVOLVED. This signs a token with the LOCAL dev
 * ACCESS_TOKEN_SECRET for a superadmin row that already exists, exactly as an
 * integration-test fixture would. Nobody's credentials are read, typed or
 * transmitted, and the token never leaves this machine.
 *
 * REFUSES TO RUN AGAINST A NON-LOCAL DATABASE. A token minted against
 * production would be a real credential for a real account, which is a
 * different thing entirely from a test fixture.
 *
 * Usage:
 *   node src/scripts/mintDevToken.cjs            # prints the token
 *   node src/scripts/mintDevToken.cjs > /tmp/sa.tok
 */
'use strict';

require('dotenv').config();
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];

(async () => {
  const host = process.env.POSTGRES_HOST || 'localhost';
  if (!LOCAL_HOSTS.includes(host)) {
    console.error(
      `[mint-dev-token] refusing: POSTGRES_HOST is "${host}", not a local database.\n` +
      '  This mints a real credential for a real account. It is a local test\n' +
      '  fixture only. Run it against localhost, or not at all.',
    );
    process.exit(1);
  }
  if (!process.env.ACCESS_TOKEN_SECRET) {
    console.error('[mint-dev-token] ACCESS_TOKEN_SECRET is not set in Backend/.env');
    process.exit(1);
  }

  const client = new Client({
    host: 'localhost', // never host.docker.internal — this runs on the host
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      // `users` lives in the hospital schema; the app's pool sets a search_path
      // that this standalone client does not inherit.
      "SELECT id, role FROM hospital.users WHERE role = 'superadmin' LIMIT 1",
    );
    if (!rows[0]) {
      console.error('[mint-dev-token] no superadmin user exists in this database');
      process.exit(1);
    }
    // Two hours: long enough for a smoke run, short enough that a forgotten
    // token in /tmp is not a standing key.
    process.stdout.write(
      jwt.sign({ id: rows[0].id, role: rows[0].role }, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '2h',
      }),
    );
  } finally {
    await client.end();
  }
})().catch((err) => {
  console.error('[mint-dev-token]', err.message);
  process.exit(1);
});
