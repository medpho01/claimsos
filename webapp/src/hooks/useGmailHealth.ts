import { useEffect, useState } from 'react';
import apiService from '@/services/api';

/**
 * Lightweight Gmail health check for in-context indicators (P8).
 *
 * Fetches /hospitals/:id/gmail-oauth/status once per page load (per hospital)
 * and surfaces a simple traffic-light state. Used by the green/amber/red dot
 * on the Filings tab so ops can spot Gmail problems before clicking Send.
 *
 * NOT meant to replace the full Insurance Interfaces page — that's the rich
 * surface for managing the connection. This is just the cheap "is it alive?"
 * signal patient-detail pages need.
 */

export type GmailHealth =
  | { state: 'loading' }
  | { state: 'unconnected' }
  | { state: 'healthy';  gmailAddress: string; lastPolledAt: number | null }
  | { state: 'warning';  gmailAddress: string; reason: string }
  | { state: 'down';     gmailAddress?: string; reason: string };

// Module-level cache keyed by hospitalId — one fetch per hospital per page.
const cache = new Map<string, GmailHealth>();
const inflight = new Map<string, Promise<GmailHealth>>();

async function fetchHealth(hospitalId: string): Promise<GmailHealth> {
  if (cache.has(hospitalId)) return cache.get(hospitalId)!;
  if (inflight.has(hospitalId)) return inflight.get(hospitalId)!;
  const p = (async () => {
    try {
      const res = await apiService.getGmailStatus(hospitalId);
      const data = res.data?.data ?? {};
      if (!data.connected) {
        const h: GmailHealth = { state: 'unconnected' };
        cache.set(hospitalId, h);
        return h;
      }
      const status = data.watch_state?.status ?? 'pending';
      const lastError = data.watch_state?.last_error ?? null;
      const gmailAddress = data.gmail_address ?? '';
      const lastPolledAt = data.watch_state?.last_verified_at ?? null;
      let h: GmailHealth;
      if (status === 'active') {
        h = { state: 'healthy', gmailAddress, lastPolledAt };
      } else if (status === 'pending') {
        h = { state: 'warning', gmailAddress, reason: 'Waiting for first poll baseline' };
      } else if (status === 'token_expired') {
        h = { state: 'down', gmailAddress, reason: 'Token expired — reconnect required' };
      } else if (status === 'disconnected') {
        h = { state: 'down', gmailAddress, reason: 'Gmail disconnected' };
      } else {
        h = { state: 'down', gmailAddress, reason: lastError || `Status: ${status}` };
      }
      cache.set(hospitalId, h);
      return h;
    } catch (err: any) {
      const h: GmailHealth = { state: 'down', reason: err?.message ?? 'fetch failed' };
      cache.set(hospitalId, h);
      return h;
    } finally {
      inflight.delete(hospitalId);
    }
  })();
  inflight.set(hospitalId, p);
  return p;
}

export function useGmailHealth(hospitalId: string | undefined | null): GmailHealth {
  const [health, setHealth] = useState<GmailHealth>(
    hospitalId && cache.has(hospitalId) ? cache.get(hospitalId)! : { state: 'loading' },
  );
  useEffect(() => {
    if (!hospitalId) return;
    let cancelled = false;
    fetchHealth(hospitalId).then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
  }, [hospitalId]);
  return health;
}

/** Force-refresh after Connect/Reconnect/Disconnect actions. */
export function invalidateGmailHealth(hospitalId: string): void {
  cache.delete(hospitalId);
}
