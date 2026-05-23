import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import apiError from '../Utils/errorHandler.util.js';
import { encryptJson, decryptJson } from '../Utils/crypto.util.js';

/**
 * Gmail OAuth Service (hospital-wide)
 *
 * Manages the OAuth lifecycle for a hospital's Gmail account used for
 * sending pre-auth / discharge / claim emails and polling replies.
 *
 * Storage model (migration 023): tokens live on `hospital.hospital_interfaces`,
 * one row per (hospital × communication channel). For email:
 *   - kind                'email'
 *   - name                'Primary CEW Gmail' (default; first email interface
 *                          per hospital is the implicit choice today)
 *   - config              JSONB { gmail_address, history_id, poll_status }
 *   - secrets_encrypted   AES-GCM ciphertext of { access_token, refresh_token,
 *                                                 expires_at, scopes, token_type }
 *   - status              'active' | 'disconnected' | 'token_expired' | 'error' | 'pending'
 *   - last_polled_at, last_error
 *
 * Public API is unchanged from when state lived on panel_attributes — the
 * `getStoredCredentials` return shape, `updateWatchState` patch shape, and
 * `getAuthenticatedClient` signature are preserved so callers don't change.
 *
 * When IHX / MediAssist portal RPAs ship, those land as separate rows in
 * the same table (kind='portal').
 *
 * Environment:
 *   - GOOGLE_OAUTH_CLIENT_ID
 *   - GOOGLE_OAUTH_CLIENT_SECRET
 *   - GOOGLE_OAUTH_REDIRECT_URI
 *   - ENC_KEY (used by crypto.util)
 */

const DEFAULT_EMAIL_INTERFACE_NAME = 'Primary CEW Gmail';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

interface StoredOauthPayload {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms epoch
  scopes: string[];
  token_type?: string;
}

/**
 * Canonical status enum — matches hospital_interfaces.status column directly.
 * A10 (batch 1): we used to have a Gmail-specific GmailWatchState.status
 * (valid/expired/revoked/error/unknown) mapped at the service boundary to the
 * column enum. The double-vocabulary added cognitive overhead without value —
 * dropped in favour of the column enum being source of truth everywhere.
 */
export type InterfaceStatus =
  | 'active'         // healthy, OAuth valid, polling working
  | 'pending'        // first-poll baseline not yet captured
  | 'token_expired'  // access token refresh failed; reconnect required
  | 'disconnected'   // user revoked or admin disconnected
  | 'error';         // generic error state, see last_error for detail

interface GmailWatchState {
  history_id: string | null;
  watch_expires_at: number | null; // unused since Pub/Sub was dropped; kept null for FE shape stability
  last_verified_at: number | null;
  status: InterfaceStatus;
  last_error?: string | null;
}

class GmailAuthService {
  private getOauthClient(): OAuth2Client {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new apiError(
        500,
        'Gmail OAuth env not configured (GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REDIRECT_URI)'
      );
    }
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Step 1: Hospital admin clicks "Connect Gmail" → returns the Google consent URL.
   * State param carries the hospital_id so the callback knows where to store
   * the resulting tokens.
   */
  async getConsentUrl(hospitalId: string): Promise<{ url: string }> {
    const client = this.getOauthClient();
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_SCOPES,
      state: JSON.stringify({ hospital_id: hospitalId }),
    });
    return { url };
  }

  /**
   * Step 2: Google redirects back with ?code= and ?state=. Exchange the code
   * for tokens, fetch the user's email, persist on hospital_interfaces.
   */
  async handleCallback(
    code: string,
    stateJson: string
  ): Promise<{ hospital_id: string; gmail_address: string }> {
    let parsed: { hospital_id: string };
    try {
      parsed = JSON.parse(stateJson);
    } catch {
      throw new apiError(400, 'Invalid OAuth state parameter');
    }
    const hospitalId = parsed.hospital_id;
    if (!hospitalId) {
      throw new apiError(400, 'Missing hospital_id in OAuth state');
    }

    const client = this.getOauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new apiError(
        400,
        'Google did not return a refresh_token. ' +
          'Have the user revoke the existing grant first and retry.'
      );
    }

    client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const gmailAddress = profile.data.emailAddress ?? '';
    if (!gmailAddress) {
      throw new apiError(500, 'Could not read Gmail address from OAuth profile');
    }

    const payload: StoredOauthPayload = {
      access_token: tokens.access_token ?? '',
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expiry_date ?? Date.now() + 60 * 60 * 1000,
      scopes: (tokens.scope ?? '').split(' ').filter(Boolean),
      token_type: tokens.token_type ?? 'Bearer',
    };

    await this.upsertEmailInterface(hospitalId, gmailAddress, payload);

    logger.info({ hospitalId, gmailAddress }, 'Gmail OAuth granted');
    return { hospital_id: hospitalId, gmail_address: gmailAddress };
  }

  /**
   * Create or refresh the email interface row for this hospital.
   * Resets history_id to NULL so the next poll re-baselines (so we don't
   * try to resume from a stale cursor against fresh credentials).
   */
  private async upsertEmailInterface(
    hospitalId: string,
    gmailAddress: string,
    payload: StoredOauthPayload
  ): Promise<void> {
    const encrypted = encryptJson(payload);
    await pool.query(
      `INSERT INTO hospital.hospital_interfaces
         (hospital_id, kind, name, status, config, secrets_encrypted, last_polled_at, last_error)
       VALUES ($1, 'email', $2, 'pending',
               jsonb_build_object('gmail_address', $3::text), $4, NULL, NULL)
       ON CONFLICT (hospital_id, name) DO UPDATE
         SET status            = 'pending',
             config            = COALESCE(hospital_interfaces.config, '{}'::jsonb)
                                  || jsonb_build_object('gmail_address', EXCLUDED.config->>'gmail_address')
                                  - 'history_id',
             secrets_encrypted = EXCLUDED.secrets_encrypted,
             last_polled_at    = NULL,
             last_error        = NULL`,
      [hospitalId, DEFAULT_EMAIL_INTERFACE_NAME, gmailAddress, encrypted]
    );
  }

  /**
   * Fetch the stored OAuth payload (decrypted) for a hospital. Returns null
   * if no email interface has been connected.
   *
   * Return shape is preserved from the prior implementation so the FE's
   * Insurance Interfaces page consumes the same response unchanged.
   */
  async getStoredCredentials(hospitalId: string): Promise<{
    gmail_address: string;
    payload: StoredOauthPayload;
    watch_state: GmailWatchState;
  } | null> {
    const res = await pool.query(
      `SELECT id, status, config, secrets_encrypted, last_polled_at, last_error
         FROM hospital.hospital_interfaces
        WHERE hospital_id = $1
          AND kind = 'email'
        ORDER BY created_at ASC
        LIMIT 1`,
      [hospitalId]
    );
    if ((res.rowCount ?? 0) === 0) return null;
    const row = res.rows[0]!;

    const gmailAddress: string | null = row.config?.gmail_address ?? null;
    if (!gmailAddress || !row.secrets_encrypted) return null;

    let payload: StoredOauthPayload;
    try {
      payload = decryptJson<StoredOauthPayload>(row.secrets_encrypted);
    } catch (err) {
      logger.error({ err, hospitalId }, 'failed to decrypt Gmail OAuth payload');
      return null;
    }

    const watchState: GmailWatchState = {
      history_id: row.config?.history_id ?? null,
      watch_expires_at: null, // Pub/Sub dropped — kept null for FE shape stability
      last_verified_at: row.last_polled_at
        ? new Date(row.last_polled_at).getTime()
        : null,
      status: (row.status as InterfaceStatus) ?? 'pending',
      last_error: row.last_error ?? null,
    };

    return { gmail_address: gmailAddress, payload, watch_state: watchState };
  }

  /**
   * Return an authenticated OAuth2 client. Refreshes the access token if
   * within 5 minutes of expiry and persists the new payload.
   */
  async getAuthenticatedClient(hospitalId: string): Promise<OAuth2Client> {
    const stored = await this.getStoredCredentials(hospitalId);
    if (!stored) {
      throw new apiError(400, 'Gmail not connected for this hospital');
    }

    const client = this.getOauthClient();
    client.setCredentials({
      access_token: stored.payload.access_token,
      refresh_token: stored.payload.refresh_token,
      expiry_date: stored.payload.expires_at,
      token_type: stored.payload.token_type ?? 'Bearer',
      scope: stored.payload.scopes.join(' '),
    });

    const expiringSoon = stored.payload.expires_at < Date.now() + 5 * 60 * 1000;
    if (expiringSoon) {
      try {
        const refreshed = await client.refreshAccessToken();
        const newCreds = refreshed.credentials;
        const newPayload: StoredOauthPayload = {
          access_token: newCreds.access_token ?? stored.payload.access_token,
          refresh_token: newCreds.refresh_token ?? stored.payload.refresh_token,
          expires_at: newCreds.expiry_date ?? Date.now() + 60 * 60 * 1000,
          scopes: (newCreds.scope ?? stored.payload.scopes.join(' '))
            .split(' ')
            .filter(Boolean),
          token_type: newCreds.token_type ?? stored.payload.token_type ?? 'Bearer',
        };
        await this.persistRefreshedPayload(hospitalId, newPayload);
        client.setCredentials(newCreds);
        logger.info({ hospitalId }, 'Gmail access token refreshed');
      } catch (err) {
        logger.error({ err, hospitalId }, 'Gmail token refresh failed');
        await this.updateWatchState(hospitalId, {
          status: 'error',
          last_error: (err as Error).message,
        });
        throw new apiError(401, 'Gmail token refresh failed; reconnect required');
      }
    }
    return client;
  }

  /**
   * Persist a refreshed OAuth payload — keeps everything else (gmail_address,
   * history_id, status) untouched.
   */
  private async persistRefreshedPayload(
    hospitalId: string,
    payload: StoredOauthPayload
  ): Promise<void> {
    const encrypted = encryptJson(payload);
    await pool.query(
      `UPDATE hospital.hospital_interfaces
          SET secrets_encrypted = $1
        WHERE hospital_id = $2
          AND kind = 'email'`,
      [encrypted, hospitalId]
    );
  }

  /**
   * Update poll state — accepts a partial GmailWatchState patch.
   *   history_id        → config.history_id (JSONB merge)
   *   last_verified_at  → last_polled_at (TIMESTAMPTZ)
   *   status            → status column (with enum mapping)
   *   last_error        → last_error column
   *
   * Returns the merged GmailWatchState for the caller (preserves the
   * previous service's contract).
   */
  async updateWatchState(
    hospitalId: string,
    patch: Partial<GmailWatchState>
  ): Promise<GmailWatchState> {
    // Build the SET clause dynamically — only update fields the caller passed.
    const sets: string[] = [];
    const params: any[] = [hospitalId];
    let i = 2;

    if (patch.history_id !== undefined) {
      sets.push(
        `config = CASE WHEN $${i}::text IS NULL
                       THEN config - 'history_id'
                       ELSE COALESCE(config, '{}'::jsonb) || jsonb_build_object('history_id', $${i}::text)
                  END`
      );
      params.push(patch.history_id);
      i++;
    }
    if (patch.last_verified_at !== undefined) {
      sets.push(`last_polled_at = $${i}::timestamptz`);
      params.push(patch.last_verified_at ? new Date(patch.last_verified_at) : null);
      i++;
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i}`);
      params.push(patch.status); // canonical enum — no mapping needed (A10)
      i++;
    }
    if (patch.last_error !== undefined) {
      sets.push(`last_error = $${i}`);
      params.push(patch.last_error ?? null);
      i++;
    }

    if (sets.length > 0) {
      await pool.query(
        `UPDATE hospital.hospital_interfaces
            SET ${sets.join(', ')}
          WHERE hospital_id = $1
            AND kind = 'email'`,
        params
      );
    }

    // Return the resulting merged state so callers can log / verify
    const fresh = await this.getStoredCredentials(hospitalId);
    return (
      fresh?.watch_state ?? {
        history_id: null,
        watch_expires_at: null,
        last_verified_at: null,
        status: 'pending',
      }
    );
  }

  /**
   * Ping Gmail to verify the credentials still work. Updates watch state.
   */
  async verify(hospitalId: string): Promise<{
    valid: boolean;
    gmail_address?: string;
    error?: string;
  }> {
    try {
      const client = await this.getAuthenticatedClient(hospitalId);
      const gmail: gmail_v1.Gmail = google.gmail({ version: 'v1', auth: client });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const address = profile.data.emailAddress ?? '';
      await this.updateWatchState(hospitalId, {
        status: 'active',
        last_verified_at: Date.now(),
        last_error: null,
      });
      return { valid: true, gmail_address: address };
    } catch (err) {
      const errorMessage = (err as Error).message;
      await this.updateWatchState(hospitalId, {
        status: 'error',
        last_error: errorMessage,
        last_verified_at: Date.now(),
      });
      return { valid: false, error: errorMessage };
    }
  }

  /**
   * Revoke at Google + delete the interface row entirely.
   * A fresh reconnect creates a new row via upsertEmailInterface.
   */
  async revoke(hospitalId: string): Promise<void> {
    const stored = await this.getStoredCredentials(hospitalId);
    if (stored) {
      try {
        const client = this.getOauthClient();
        client.setCredentials({ refresh_token: stored.payload.refresh_token });
        await client.revokeCredentials();
      } catch (err) {
        logger.warn({ err, hospitalId }, 'Gmail revoke at Google failed; clearing local anyway');
      }
    }

    await pool.query(
      `DELETE FROM hospital.hospital_interfaces
        WHERE hospital_id = $1
          AND kind = 'email'`,
      [hospitalId]
    );
    logger.info({ hospitalId }, 'Gmail credentials revoked + interface deleted');
  }
}

export default new GmailAuthService();
