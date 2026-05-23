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
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      logger.warn({ oauthError }, 'Gmail OAuth declined or errored');
      return res.redirect(
        `${process.env.FRONTEND_URL ?? ''}/settings/cashless?gmail_oauth_status=denied`
      );
    }
    if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing code or state' });
    }
    const result = await gmailAuthService.handleCallback(code, state);
    // Redirect back to the FE with success indicator
    const fe = process.env.FRONTEND_URL ?? '';
    res.redirect(
      `${fe}/settings/cashless?gmail_oauth_status=success&gmail_address=${encodeURIComponent(
        result.gmail_address
      )}`
    );
  } catch (error: any) {
    logger.error({ err: error }, 'gmailOauthCallback failed');
    const fe = process.env.FRONTEND_URL ?? '';
    res.redirect(
      `${fe}/settings/cashless?gmail_oauth_status=error&reason=${encodeURIComponent(
        error.message ?? 'unknown'
      )}`
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
