/**
 * Sprint 3, Wave 3C — ActionQueue page (Kratika's inbox).
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ ROUTE MOUNT TODO                                                     ║
 * ║                                                                      ║
 * ║ This page is NOT yet wired into the route tree. Intended route:      ║
 * ║   /hospital/actions                                                  ║
 * ║                                                                      ║
 * ║ Mount in webapp/src/routes/index.tsx once the BE                     ║
 * ║ /api/claim-actions endpoints are mounted on the express app          ║
 * ║ (claimActions.routes.ts carries the integration TODO for that).      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Layout:
 *   - Filter bar: status (pending/all) + kind (all/request_doc/notify_ops/approval_request)
 *   - Sortable table of actions
 *   - Per-row Ack / Decline (decline opens DeclineDialog)
 *
 * Empty / loading / error states all render the same shell so the table
 * header stays stable while the inbox loads.
 */

import React, { useMemo, useState } from 'react';
import { Inbox, RefreshCw, Filter } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useActionQueue,
  type ClaimAction,
  type ClaimActionKind,
  type ClaimActionStatus,
} from '@/hooks/intelligence';

import { ActionRow } from './ActionRow';
import { DeclineDialog } from './DeclineDialog';

interface ActionQueueProps {
  /** Filter the queue to a specific user. Defaults to "all" (server-side). */
  userId?: string;
  /** Inject mock data for the dev demo page. */
  itemsOverride?: ClaimAction[];
  /** Skip network calls. */
  offline?: boolean;
}

type StatusFilter = 'pending' | 'all';
type KindFilter = 'all' | ClaimActionKind;

export const ActionQueue: React.FC<ActionQueueProps> = ({
  userId,
  itemsOverride,
  offline = false,
}) => {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const queue = useActionQueue(
    offline ? { userId: undefined, status: statusFilter } : { userId, status: statusFilter },
  );

  // Decline dialog state — only one row can be in the decline flow at a time.
  const [declineTarget, setDeclineTarget] = useState<ClaimAction | null>(null);

  const items: ClaimAction[] = useMemo(() => {
    const list = itemsOverride ?? queue.data ?? [];
    if (kindFilter === 'all') return list;
    return list.filter((a) => a.kind === kindFilter);
  }, [itemsOverride, queue.data, kindFilter]);

  const handleAck = async (id: string, response: Record<string, any>) => {
    if (offline) return;
    await queue.ackAction(id, response);
  };

  const handleDeclineConfirm = async (reason: string) => {
    if (!declineTarget || offline) return;
    await queue.declineAction(declineTarget.id, reason);
    setDeclineTarget(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
              <Inbox className="size-3.5" />
              Action queue
            </div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {items.length === 0 ? 'No pending actions' : `${items.length} pending action${items.length === 1 ? '' : 's'}`}
            </h1>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => queue.refetch()}
            disabled={queue.loading}
            className="gap-1"
          >
            <RefreshCw className={queue.loading ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>
      </header>

      {/* Filter bar */}
      <div className="max-w-6xl mx-auto px-6 pt-4 flex items-center gap-3">
        <Filter className="size-4 text-slate-400" />
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-[160px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending only</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
        <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as KindFilter)}>
          <SelectTrigger className="w-[200px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            <SelectItem value="request_doc">Document requests</SelectItem>
            <SelectItem value="notify_ops">Ops notifications</SelectItem>
            <SelectItem value="approval_request">Approval requests</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="max-w-6xl mx-auto px-6 py-4">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-950/50">
              <tr className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <th className="px-3 py-2 text-left font-medium">Action</th>
                <th className="px-3 py-2 text-left font-medium">Claim</th>
                <th className="px-3 py-2 text-left font-medium">When</th>
                <th className="px-3 py-2 text-right font-medium">Response</th>
              </tr>
            </thead>
            <tbody>
              {queue.loading && !itemsOverride ? (
                <tr>
                  <td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    Loading…
                  </td>
                </tr>
              ) : queue.error ? (
                <tr>
                  <td colSpan={4} className="px-3 py-10 text-center text-sm text-red-600 dark:text-red-400">
                    {queue.error.message}
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    Inbox zero. 🎉
                  </td>
                </tr>
              ) : (
                items.map((action) => (
                  <ActionRow
                    key={action.id}
                    action={action}
                    onAck={handleAck}
                    onRequestDecline={(a) => setDeclineTarget(a)}
                    busy={queue.acking || queue.declining}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <DeclineDialog
        open={declineTarget !== null}
        onOpenChange={(open) => !open && setDeclineTarget(null)}
        onConfirm={handleDeclineConfirm}
        actionTitle={
          declineTarget
            ? (declineTarget.payload?.title as string | undefined) ?? declineTarget.kind
            : undefined
        }
      />
    </div>
  );
};

// Helper so the hook can be re-used in the dev demo without re-typing.
export type { ClaimActionStatus };
export default ActionQueue;
