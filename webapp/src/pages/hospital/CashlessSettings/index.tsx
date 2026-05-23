import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Mail,
  Check,
  X,
  AlertCircle,
  RefreshCcw,
  Loader2,
  Inbox,
  Send,
  Plus,
  Globe,
} from 'lucide-react';
import { toast } from 'sonner';
import apiService from '@/services/api';
import { usePanelFleet } from '@/hooks/usePanelFleet';

/**
 * Insurance Interfaces — hospital admin's home for the communication
 * channels the hospital uses to reach insurers (and to receive their
 * replies). Today there's one interface kind that works: Email (Gmail
 * OAuth). Portal RPA interfaces ship in a later phase and are surfaced
 * here as "Coming Soon" placeholders.
 *
 * Lives at /portal/:hospitalId/settings/cashless (legacy route) and
 * embedded under Hospital Profile → Configuration → Insurance Interfaces.
 *
 * Architecture notes (see ADR ~2026-05-17):
 *   - An "interface" is a reusable comms channel. One Gmail mailbox serves
 *     all non-empanelled insurers; one portal eventually serves multiple
 *     empanelled insurers. Each interface is a first-class row in
 *     hospital.hospital_interfaces (migration 023). Discriminator: `kind`
 *     ('email' | 'portal').
 *   - Per-insurer linkage to an interface is implicit today (is_empanelled
 *     drives it). When the second interface lands we add an explicit
 *     channel_id attribute on (hospital × insurer).
 *
 * OAuth callback query params:
 *   ?gmail_oauth_status=success&gmail_address=...
 *   ?gmail_oauth_status=denied
 *   ?gmail_oauth_status=error&reason=...
 */

interface GmailStatus {
  connected: boolean;
  gmail_address?: string;
  scopes?: string[];
  token_expires_at?: number;
  watch_state?: {
    history_id?: string;
    watch_expires_at?: number;
    last_verified_at?: number;
    status?: string;
    last_error?: string;
  };
}

const fmtDateTime = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '—');

const CashlessSettings: React.FC = () => {
  const { hospitalId } = useParams<{ hospitalId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [busy, setBusy] = useState(false);
  const [unmatchedCount, setUnmatchedCount] = useState<number | null>(null);
  const [outboxIssueCount, setOutboxIssueCount] = useState<number | null>(null);
  const [showAddInterface, setShowAddInterface] = useState(false);

  // Fleet drives "Used by N insurers" counts — same dataset that powers the
  // Panel Fleet table on the Panels tab. Cheaper than a bespoke endpoint and
  // already cached in the rest of the app via the same hook.
  const { fleet } = usePanelFleet(hospitalId || '');

  // Insurers that ride on the Email interface = those NOT empanelled.
  // Empanelled ones will eventually ride on portal RPA interfaces (Phase 6).
  // Migration 023 dropped the CEW pseudo-panel, so every fleet row is now
  // a real insurer/TPA and no skip-by-code is needed.
  const insurerCounts = useMemo(() => {
    let email = 0;
    let portal = 0;
    for (const p of fleet || []) {
      const empanelledAttr = (p.attributes || []).find(
        (a) => a.attribute_key === 'is_empanelled',
      );
      if (empanelledAttr?.value_boolean) portal += 1;
      else email += 1;
    }
    return { email, portal };
  }, [fleet]);

  // Surface OAuth callback feedback from query params
  useEffect(() => {
    const status = searchParams.get('gmail_oauth_status');
    if (status === 'success') {
      toast.success(
        `Gmail connected${
          searchParams.get('gmail_address') ? `: ${searchParams.get('gmail_address')}` : ''
        }`,
      );
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('gmail_oauth_status');
        next.delete('gmail_address');
        return next;
      });
    } else if (status === 'denied') {
      toast.error('Gmail OAuth was declined');
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('gmail_oauth_status');
        return next;
      });
    } else if (status === 'error') {
      toast.error(`Gmail OAuth error: ${searchParams.get('reason') ?? 'unknown'}`);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('gmail_oauth_status');
        next.delete('reason');
        return next;
      });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!hospitalId) return;
    const load = async () => {
      try {
        setLoadingStatus(true);
        const [statusRes, unmatchedRes, outboxRes] = await Promise.all([
          apiService.getGmailStatus(hospitalId),
          apiService.listUnmatchedInbound(hospitalId).catch(() => ({ data: { data: [] } })),
          apiService.listOutboxIssues(hospitalId).catch(() => ({ data: { data: [] } })),
        ]);
        setGmailStatus(statusRes.data?.data);
        setUnmatchedCount(unmatchedRes.data?.data?.length ?? 0);
        setOutboxIssueCount(outboxRes.data?.data?.length ?? 0);
      } catch (err: any) {
        toast.error(err?.response?.data?.error || 'Failed to load Gmail status');
      } finally {
        setLoadingStatus(false);
      }
    };
    load();
  }, [hospitalId]);

  const handleConnectGmail = async () => {
    if (!hospitalId) return;
    setBusy(true);
    try {
      const res = await apiService.initiateGmailOauth(hospitalId);
      const url = res.data?.data?.consent_url;
      if (url) {
        window.location.href = url;
      } else {
        toast.error('Could not get consent URL');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to initiate Gmail OAuth');
      setBusy(false);
    }
  };

  const handleVerify = async () => {
    if (!hospitalId) return;
    setBusy(true);
    try {
      const res = await apiService.verifyGmail(hospitalId);
      const { valid, gmail_address, error } = res.data?.data ?? {};
      if (valid) toast.success(`Gmail valid (${gmail_address})`);
      else toast.error(`Gmail invalid: ${error}`);
      const statusRes = await apiService.getGmailStatus(hospitalId);
      setGmailStatus(statusRes.data?.data);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Verify failed');
    } finally {
      setBusy(false);
    }
  };

  const handleForcePoll = async () => {
    if (!hospitalId) return;
    setBusy(true);
    try {
      const res = await apiService.forceGmailPoll(hospitalId);
      const r = res.data?.data ?? {};
      const summary =
        r.processed > 0
          ? `Polled — ${r.processed} new message(s) ingested`
          : r.skippedReason === 'first_poll_baseline'
          ? 'Baseline established; new messages will be picked up from next poll'
          : 'Polled — no new messages';
      toast.success(summary);
      const statusRes = await apiService.getGmailStatus(hospitalId);
      setGmailStatus(statusRes.data?.data);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Poll failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    if (!hospitalId) return;
    if (!window.confirm('Disconnect Gmail? Pre-auth email sending will stop until reconnected.')) {
      return;
    }
    setBusy(true);
    try {
      await apiService.revokeGmail(hospitalId);
      toast.success('Gmail disconnected');
      setGmailStatus({ connected: false });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Revoke failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6 space-y-4">
      {/* Breadcrumb intentionally removed — this component is embedded inside
          Hospital Profile (Configuration → Insurance Interfaces), and the
          parent page already renders the breadcrumb (Hospitals / <name> /
          Configuration). Rendering it again here was visually duplicate. */}

      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            Insurance Interfaces
          </h1>
          <p className="text-xs text-slate-500 max-w-2xl mt-1">
            Channels you use to communicate with insurers — for sending pre-auths, receiving
            queries, and tracking replies. One channel is shared across many insurers (one Gmail
            for every Cashless Everywhere insurer; one portal session for an empanelled group).
          </p>
        </div>
        <button
          onClick={() => setShowAddInterface(true)}
          className="h-9 px-3 bg-brand-600 hover:bg-brand-700 text-white rounded-md text-sm font-medium inline-flex items-center gap-2"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Interface
        </button>
      </div>

      {/* Connected interfaces — list of cards */}
      <div className="space-y-3">
        <EmailInterfaceCard
          loading={loadingStatus}
          status={gmailStatus}
          insurerCount={insurerCounts.email}
          busy={busy}
          onConnect={handleConnectGmail}
          onVerify={handleVerify}
          onForcePoll={handleForcePoll}
          onReconnect={handleConnectGmail}
          onRevoke={handleRevoke}
        />

        {/* Portal interfaces — Phase 6 placeholder. Shows count of empanelled
            insurers as a teaser so it's clear how this slot will be used. */}
        {insurerCounts.portal > 0 && (
          <div className="border border-dashed border-slate-300 dark:border-slate-700 rounded-lg p-4 bg-slate-50/50 dark:bg-slate-900/30">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-md bg-slate-200 dark:bg-slate-800 text-slate-500 flex items-center justify-center shrink-0">
                  <Globe className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Portal Interface
                    </h3>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                      Portal
                    </span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900">
                      Coming Soon
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {insurerCounts.portal} empanelled insurer{insurerCounts.portal === 1 ? '' : 's'}{' '}
                    will route through portal RPA once it ships. Today these are filed manually.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Operational queues — hospital-wide, not per-interface */}
      <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-2">
          Operational Queues
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Inbox className="h-4 w-4 text-slate-500" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Unmatched Inbound Emails
              </h3>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              Emails the system couldn't auto-link to a claim. Open and link manually.
            </p>
            <div className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
              {unmatchedCount ?? '—'}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {unmatchedCount === 0 ? 'All caught up' : 'pending'}
            </div>
          </div>

          <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Send className="h-4 w-4 text-slate-500" />
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                Outbox Issues
              </h3>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              Pre-auth emails stuck queued for &gt;5 minutes or failed to send.
            </p>
            <div className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
              {outboxIssueCount ?? '—'}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {outboxIssueCount === 0 ? 'All sent' : 'need attention'}
            </div>
          </div>
        </div>
      </div>

      {/* + Add Interface picker */}
      {showAddInterface && (
        <AddInterfaceDialog
          onClose={() => setShowAddInterface(false)}
          onPickEmail={() => {
            setShowAddInterface(false);
            // Connect Gmail = today's only "Add Email Interface" action.
            // The system supports one Gmail interface per hospital for now.
            handleConnectGmail();
          }}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Card components                                                     */
/* ------------------------------------------------------------------ */

interface EmailInterfaceCardProps {
  loading: boolean;
  status: GmailStatus | null;
  insurerCount: number;
  busy: boolean;
  onConnect: () => void;
  onVerify: () => void;
  onForcePoll: () => void;
  onReconnect: () => void;
  onRevoke: () => void;
}

const EmailInterfaceCard: React.FC<EmailInterfaceCardProps> = ({
  loading,
  status,
  insurerCount,
  busy,
  onConnect,
  onVerify,
  onForcePoll,
  onReconnect,
  onRevoke,
}) => {
  const connected = !!status?.connected;
  const pollActive = !!status?.watch_state?.history_id;

  return (
    <div className="bg-white border border-slate-200 dark:bg-slate-900 dark:border-slate-800 rounded-lg overflow-hidden">
      {/* Card header — name + kind badge + connection state */}
      <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={`h-9 w-9 rounded-md flex items-center justify-center shrink-0 ${
              connected
                ? 'bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-500'
            }`}
          >
            <Mail className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Primary Email Interface
              </h3>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                Email
              </span>
              {connected ? (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ok-50 dark:bg-ok-950 text-ok-700 dark:text-ok-300 border border-ok-200 dark:border-ok-900 inline-flex items-center gap-1">
                  <Check className="h-2.5 w-2.5" /> Active
                </span>
              ) : (
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900">
                  Not connected
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Reaches{' '}
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {insurerCount} insurer{insurerCount === 1 ? '' : 's'}
              </span>{' '}
              on the Cashless Everywhere route. Polls inbox every 2 minutes for replies.
            </p>
          </div>
        </div>
      </div>

      {/* Card body */}
      <div className="px-5 py-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading status…
          </div>
        ) : !connected ? (
          <div>
            <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-900 mb-4">
              <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-900 dark:text-amber-100">
                No Gmail account connected. Cashless Everywhere pre-auth sending is disabled until
                a hospital admin connects a Gmail account.
              </div>
            </div>
            <button
              onClick={onConnect}
              disabled={busy}
              className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-md text-sm font-medium inline-flex items-center gap-2 disabled:opacity-50"
            >
              <Mail className="h-3.5 w-3.5" />
              Connect Gmail
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-xs text-slate-500">Connected Account</div>
                <div className="font-medium text-slate-900 dark:text-slate-100 mt-0.5 inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-ok-600" />
                  {status?.gmail_address}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Access Token Expires</div>
                <div className="font-medium text-slate-900 dark:text-slate-100 mt-0.5">
                  {fmtDateTime(status?.token_expires_at)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Inbox Polling</div>
                <div className="font-medium mt-0.5 inline-flex items-center gap-1.5">
                  {pollActive ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-ok-600" />
                      Active (every 2m)
                    </>
                  ) : (
                    <>
                      <X className="h-3.5 w-3.5 text-amber-600" />
                      Awaiting first poll
                    </>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Last Polled</div>
                <div className="font-medium text-slate-900 dark:text-slate-100 mt-0.5">
                  {fmtDateTime(status?.watch_state?.last_verified_at)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Polling Status</div>
                <div className="font-medium text-slate-900 dark:text-slate-100 mt-0.5">
                  {status?.watch_state?.status ?? 'unknown'}
                </div>
              </div>
            </div>

            {status?.watch_state?.last_error && (
              <div className="p-2 rounded-md bg-danger-50 dark:bg-danger-950 border border-danger-200 dark:border-danger-900 text-xs text-danger-700 dark:text-danger-300">
                Last error: {status.watch_state.last_error}
              </div>
            )}

            <div className="flex items-center gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 flex-wrap">
              <button
                onClick={onVerify}
                disabled={busy}
                className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCcw className="h-3 w-3" />
                Verify
              </button>
              <button
                onClick={onForcePoll}
                disabled={busy}
                className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
                title="Polling runs automatically every 2m. Click to poll now (e.g. after a test reply)."
              >
                <Inbox className="h-3 w-3" />
                Poll inbox now
              </button>
              <button
                onClick={onReconnect}
                disabled={busy}
                className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Mail className="h-3 w-3" />
                Reconnect
              </button>
              <button
                onClick={onRevoke}
                disabled={busy}
                className="ml-auto px-3 py-1.5 text-sm border border-danger-300 dark:border-danger-700 text-danger-700 dark:text-danger-300 rounded-md hover:bg-danger-50 dark:hover:bg-danger-950 inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <X className="h-3 w-3" />
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* + Add Interface — kind picker                                       */
/* ------------------------------------------------------------------ */

interface AddInterfaceDialogProps {
  onClose: () => void;
  onPickEmail: () => void;
}

const AddInterfaceDialog: React.FC<AddInterfaceDialogProps> = ({ onClose, onPickEmail }) => {
  return (
    <div
      className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            Add Insurance Interface
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-xs text-slate-500">
            Pick the kind of channel you want to add. One channel is reusable across many insurers.
          </p>

          <button
            onClick={onPickEmail}
            className="w-full text-left p-4 border border-slate-200 dark:border-slate-700 rounded-md hover:border-brand-400 hover:bg-brand-50/40 dark:hover:bg-brand-950/20 transition-colors"
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-md bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-300 flex items-center justify-center shrink-0">
                <Mail className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <div className="font-medium text-slate-900 dark:text-slate-100">Email</div>
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                    Gmail OAuth
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Connect a Gmail mailbox to send pre-auth emails and poll replies for every
                  Cashless Everywhere insurer.
                </p>
              </div>
            </div>
          </button>

          <button
            disabled
            className="w-full text-left p-4 border border-dashed border-slate-200 dark:border-slate-700 rounded-md bg-slate-50/50 dark:bg-slate-900/30 cursor-not-allowed opacity-70"
            title="Portal RPA is on the roadmap (Phase 6)."
          >
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-md bg-slate-200 dark:bg-slate-800 text-slate-500 flex items-center justify-center shrink-0">
                <Globe className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-medium text-slate-700 dark:text-slate-200">Portal</div>
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900">
                    Coming Soon
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Wire up an empanelled insurer portal (IHX, Medi Assist, etc.) for automated
                  submission. Available in the next phase.
                </p>
              </div>
            </div>
          </button>
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default CashlessSettings;
