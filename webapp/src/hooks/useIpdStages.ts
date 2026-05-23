import { useEffect, useState } from 'react';
import apiService from '@/services/api';

/**
 * Shared cache of IPD lifecycle stages (master_options where
 * category='ipd_stage'). One fetch per page load, shared across:
 *   - PatientDetail header StagePicker
 *   - PatientDetail pipeline strip (windowed view)
 *   - PatientEdit form Stage dropdown
 *   - Any future surface that needs the same list
 *
 * Module-level cache because the list rarely changes mid-session and
 * superadmin edits in master_options would require a page reload anyway.
 */

export interface StageOption {
  code: string;
  label: string;
  sort_order: number;
}

// Module-level cache + de-duplicated in-flight promise.
let cached: StageOption[] | null = null;
let inflight: Promise<StageOption[]> | null = null;

async function fetchStages(): Promise<StageOption[]> {
  if (cached) return cached;
  if (!inflight) {
    inflight = apiService
      .getMasterOptionsByCategory('ipd_stage')
      .then((res) => {
        const rows = (res.data?.data ?? []) as any[];
        const list: StageOption[] = rows
          .filter((r) => r.is_active !== false)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((r) => ({
            code: r.code,
            label: r.label,
            sort_order: r.sort_order ?? 0,
          }));
        cached = list;
        return list;
      })
      .catch((err) => {
        inflight = null; // allow retry next call
        throw err;
      });
  }
  return inflight;
}

export function useIpdStages(): {
  stages: StageOption[];
  loading: boolean;
} {
  const [stages, setStages] = useState<StageOption[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetchStages()
      .then((list) => {
        if (!cancelled) {
          setStages(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { stages, loading };
}

/**
 * Window of stages around the current one, used for the pipeline strip.
 * Returns up to `count` items centered on `currentLabel`, clamped at the
 * edges so the strip is always the same width.
 *
 * Examples (count=5):
 *   current='Draft'                  → [Draft, Pre-auth Submitted, Pre-auth Queried, Pre-auth Query Responded, Pre-auth Approved]
 *   current='Pre-auth Approved'      → [Pre-auth Queried, Pre-auth Query Responded, Pre-auth Approved, Admitted, Enhancements Submitted]
 *   current='Claim Approved' (last)  → [Claim Filed, Claim Queried, Claim Query Responded, Claim Approved] (only 4 — at end)
 *   current=null                     → first `count` stages
 */
export function windowedStages(
  stages: StageOption[],
  currentLabel: string | null | undefined,
  count = 5,
): { window: StageOption[]; currentIndexInWindow: number } {
  if (stages.length === 0) return { window: [], currentIndexInWindow: -1 };
  const idx = currentLabel
    ? stages.findIndex((s) => s.label === currentLabel)
    : -1;
  const effectiveIdx = idx >= 0 ? idx : 0;
  const halfBefore = Math.floor((count - 1) / 2);
  const halfAfter = count - 1 - halfBefore;

  // Clamp the start so we always show `count` items when possible.
  let start = Math.max(0, effectiveIdx - halfBefore);
  let end = Math.min(stages.length, start + count);
  // If we're near the end, shift left so the window stays full.
  if (end - start < count && start > 0) {
    start = Math.max(0, end - count);
  }
  // Same for the start edge.
  if (end - start < count && end < stages.length) {
    end = Math.min(stages.length, start + count);
  }

  const window = stages.slice(start, end);
  const currentIndexInWindow = idx >= 0 ? idx - start : -1;
  return { window, currentIndexInWindow };
}
