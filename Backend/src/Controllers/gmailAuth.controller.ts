import { Request, Response } from 'express';
import gmailAuthService from '../Services/gmailAuth.service.js';
import { logger } from '../Utils/logger.js';

/**
 * Gmail OAuth Controller — endpoints for the Cashless Everywhere Gmail
 * onboarding flow.
 *
 *   POST   /api/v1/hospitals/:hospitalId/gmail-oauth/initiate
 *   GET    /api/v1/oauth/gmail/callback                         (Google redirects here)
 *   GET    /api/v1/hospitals/:hospitalId/gmail-oauth/status
 *   POST   /api/v1/hospitals/:hospitalId/gmail-oauth/verify
 *   POST   /api/v1/hospitals/:hospitalId/gmail-oauth/revoke
 */

/** POST /api/v1/hospitals/:hospitalId/gmail-oauth/initiate */
export const initiateGmailOauth = async (req: Request, res: Response) => {
  try {
    const { hospitalId } = req.params;
    if (!hospitalId) {
      return res.status(400).json({ success: false, error: 'hospitalId is required' });
    }
    const { url } = await gmailAuthService.getConsentUrl(hospitalId);
    res.status(200).json({
      success: true,
      data: { consent_url: url },
      message: 'Redirect the hospital admin to consent_url',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'initiateGmailOauth failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to initiate Gmail OAuth',
    });
  }
};

/**
 * GET /api/v1/oauth/gmail/callback?code=...&state=...
 * Google redirects here after consent. NOT under /:hospitalId — hospital
 * comes from the `state` param we sent in initiate.
 *
 * Auth NOT required on this route (it's a Google redirect). Identity is
 * trusted via the OAuth code exchange.
 */
export const gmailOauthCallback = async (req: Request, res: Response) => {
  // Build the FE landing URL. Every path through this handler goes through
  // here so none of them can drift back to a route that does not exist.
  //
  // It lands on /oauth/gmail/done, NOT /settings/cashless. The settings page
  // actually lives at /portal/:hospitalId/settings/cashless, and the old
  // redirect omitted the prefix — with no catch-all route in the SPA that
  // produced a BLANK PAGE with neither error nor success. Google cannot know
  // the hospital id, so we pass it through and the landing page puts it back
  // into the path (or hands the result to the opener, when consent ran in a
  // popup).
  const landing = (
    params: Record<string, string | undefined>,
  ): string => {
    const fe = (process.env.FRONTEND_URL ?? '').replace(/\/+$/, '');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) qs.set(k, v);
    }
    return `${fe}/oauth/gmail/done?${qs.toString()}`;
  };

  // The hospital id travels in `state`, which Google echoes back on the error
  // paths too — so a declined consent can still return the user to the right
  // hospital's settings page instead of dumping them at the app root.
  const hospitalFromState = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.hospital_id === 'string' ? parsed.hospital_id : undefined;
    } catch {
      return undefined;
    }
  };

  const { code, state, error: oauthError } = req.query;

  try {
    if (oauthError) {
      logger.warn({ oauthError }, 'Gmail OAuth declined or errored');
      return res.redirect(
        landing({ gmail_oauth_status: 'denied', hospital_id: hospitalFromState(state) }),
      );
    }
    if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
      // Previously a raw 400 JSON body — a dead end in a browser tab, and the
      // one case a user cannot act on. Send them back to the app with a
      // readable reason like every other failure here.
      logger.warn({ hasCode: Boolean(code), hasState: Boolean(state) }, 'Gmail OAuth callback missing code/state');
      return res.redirect(
        landing({
          gmail_oauth_status: 'error',
          reason: 'Google did not return an authorisation code. Please try connecting again.',
          hospital_id: hospitalFromState(state),
        }),
      );
    }

    const result = await gmailAuthService.handleCallback(code, state);
    res.redirect(
      landing({
        gmail_oauth_status: 'success',
        gmail_address: result.gmail_address,
        hospital_id: result.hospital_id,
      }),
    );
  } catch (error: any) {
    logger.error({ err: error }, 'gmailOauthCallback failed');
    res.redirect(
      landing({
        gmail_oauth_status: 'error',
        reason: error?.message ?? 'unknown',
        hospital_id: hospitalFromState(state),
      }),
    );
  }
};

/** GET /api/v1/hospitals/:hospitalId/gmail-oauth/status */
export const getGmailStatus = async (req: Request, res: Response) => {
  try {
    const { hospitalId } = req.params;
    if (!hospitalId) {
      return res.status(400).json({ success: false, error: 'hospitalId is required' });
    }
    const stored = await gmailAuthService.getStoredCredentials(hospitalId);
    res.status(200).json({
      success: true,
      data: stored
        ? {
            connected: true,
            gmail_address: stored.gmail_address,
            scopes: stored.payload.scopes,
            token_expires_at: stored.payload.expires_at,
            watch_state: stored.watch_state,
          }
        : { connected: false },
      message: 'Gmail status fetched',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'getGmailStatus failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to fetch Gmail status',
    });
  }
};

/** POST /api/v1/hospitals/:hospitalId/gmail-oauth/verify */
export const verifyGmail = async (req: Request, res: Response) => {
  try {
    const { hospitalId } = req.params;
    if (!hospitalId) {
      return res.status(400).json({ success: false, error: 'hospitalId is required' });
    }
    const result = await gmailAuthService.verify(hospitalId);
    res.status(200).json({
      success: result.valid,
      data: result,
      message: result.valid ? 'Gmail credentials valid' : 'Gmail credentials invalid',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'verifyGmail failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to verify Gmail',
    });
  }
};

/** POST /api/v1/hospitals/:hospitalId/gmail-oauth/revoke */
export const revokeGmail = async (req: Request, res: Response) => {
  try {
    const { hospitalId } = req.params;
    if (!hospitalId) {
      return res.status(400).json({ success: false, error: 'hospitalId is required' });
    }
    await gmailAuthService.revoke(hospitalId);
    res.status(200).json({
      success: true,
      message: 'Gmail credentials revoked',
    });
  } catch (error: any) {
    logger.error({ err: error }, 'revokeGmail failed');
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to revoke Gmail',
    });
  }
};
