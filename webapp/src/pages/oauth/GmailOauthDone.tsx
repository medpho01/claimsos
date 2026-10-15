/**
 * Landing page for Google's OAuth redirect — the bridge back into the app.
 *
 * WHY A DEDICATED PAGE RATHER THAN REDIRECTING STRAIGHT TO SETTINGS
 *
 * Two problems, both of which this page exists to solve.
 *
 * 1. The backend used to redirect to `/settings/cashless`. That route does not
 *    exist — the real one is `/portal/:hospitalId/settings/cashless`. There is
 *    no catch-all route, so the user landed on a BLANK PAGE with no error and
 *    no success message. The toast handler in CashlessSettings never ran
 *    because the component never mounted. Google's redirect cannot know the
 *    hospital id on its own, so the backend now passes it through and this
 *    page puts it back into the path.
 *
 * 2. Consent opened in the SAME tab, so the app was torn down mid-flow and the
 *    user's place was lost. Connect now opens a popup; this page detects that
 *    it is the popup, hands the result to the opener, and closes itself. The
 *    original window never navigates.
 *
 * It must work BOTH ways. Popups get blocked, and the connect handler falls
 * back to a same-tab redirect when that happens — in which case `window.opener`
 * is null and this page forwards into the app by navigating, carrying the
 * status params so the settings page can show its toast exactly as before.
 *
 * Deliberately NOT behind PrivateRoute. Google sends the browser here directly;
 * putting an auth gate in front would race the session check against the
 * redirect and could bounce a returning user to /login with the result lost.
 * The page reads query parameters and forwards them — it holds no secret, and
 * the token exchange already happened server-side.
 */

import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/** Shape posted to the opener. `source` lets the listener ignore other noise. */
export interface GmailOauthMessage {
  source: 'claimos:gmail-oauth';
  status: 'success' | 'denied' | 'error';
  gmail_address?: string;
  reason?: string;
}

export const GMAIL_OAUTH_MESSAGE_SOURCE = 'claimos:gmail-oauth';

const GmailOauthDone: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // StrictMode double-invokes effects in development; without this the popup
  // posts twice and the user sees two toasts.
  const handled = useRef(false);

  const status = (searchParams.get('gmail_oauth_status') ?? 'error') as GmailOauthMessage['status'];
  const hospitalId = searchParams.get('hospital_id');
  const gmailAddress = searchParams.get('gmail_address') ?? undefined;
  const reason = searchParams.get('reason') ?? undefined;

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const isPopup = Boolean(window.opener) && window.opener !== window;

    if (isPopup) {
      const message: GmailOauthMessage = {
        source: GMAIL_OAUTH_MESSAGE_SOURCE,
        status,
        ...(gmailAddress ? { gmail_address: gmailAddress } : {}),
        ...(reason ? { reason } : {}),
      };
      try {
        // Target our own origin explicitly — never '*'. The message says
        // whether a mailbox connected and for whom; a wildcard would hand that
        // to whatever happened to be listening.
        window.opener.postMessage(message, window.location.origin);
      } catch {
        // Opener gone (user closed it mid-flow). Nothing to tell; fall through
        // and close anyway rather than stranding an orphan window.
      }
      window.close();
      return;
    }

    // Same-tab fallback. Rebuild the status params the settings page expects
    // and send the user to the route that actually exists.
    const next = new URLSearchParams();
    next.set('gmail_oauth_status', status);
    if (gmailAddress) next.set('gmail_address', gmailAddress);
    if (reason) next.set('reason', reason);

    navigate(
      hospitalId
        ? `/portal/${hospitalId}/settings/cashless?${next.toString()}`
        // No hospital id to route with — send them somewhere real with the
        // result attached rather than leaving them on this page.
        : `/?${next.toString()}`,
      { replace: true },
    );
  }, [status, hospitalId, gmailAddress, reason, navigate]);

  // Visible only for the instant before the popup closes, and for longer if
  // window.close() is refused (browsers block it for tabs they did not open).
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {status === 'success' ? 'Gmail connected — returning to ClaimOS…' : 'Returning to ClaimOS…'}
      </p>
      <p className="text-xs text-slate-400">You can close this window if it does not close itself.</p>
    </div>
  );
};

export default GmailOauthDone;
