import type { PoolClient } from 'pg';
import { pool } from '../DB/db.js';

/**
 * Run `work` inside a real BEGIN/COMMIT transaction.
 *
 * Background: several multi-step write paths previously called
 * `pool.query(...)` repeatedly and faked rollback with a follow-up DELETE.
 * Each `pool.query` checks out its own connection, so the writes were never
 * part of a single transaction — a mid-stream failure left orphaned rows
 * (see REVIEW_BACKEND.md H4, H5, H12).
 *
 * Use this helper for any controller/service that performs >1 dependent
 * write. Pass the supplied `client` into every query so they all share the
 * same connection and the same transaction.
 *
 *   await withTransaction(async (client) => {
 *     await client.query('INSERT INTO ...');
 *     await client.query('INSERT INTO ...');
 *   });
 *
 * Any thrown error triggers ROLLBACK; the client is always released.
 */
export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Surface the original error; log the rollback failure so it isn't
      // silently swallowed (a failed ROLLBACK usually means the connection
      // is already broken, which pg will handle on release).
      console.error('[withTransaction] ROLLBACK failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export default withTransaction;
