import React from 'react';
import { Check, X, ExternalLink, FileText, Bell, ShieldCheck, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CategoryPill } from '@/components/intelligence/primitives';
import type { ClaimAction, ClaimActionKind } from '@/hooks/intelligence';

/**
 * Sprint 3, Wave 3C — ActionQueue sub-component.
 *
 * One row in Kratika's inbox table. Renders kind icon + payload preview,
 * the linked claim, the relative timestamp, and the Ack / Decline buttons.
 *
 * The Ack button branches on kind:
 *   - 'approval_request' → calls onAck with { decision: 'approved' }
 *   - everything else    → calls onAck with {} (acknowledged-as-seen)
 * The Decline button opens the DeclineDialog (parent-owned state).
 */
export interface ActionRowProps {
  action: ClaimAction;
  onAck: (id: string, response: Record<string, any>) => Promise<void> | void;
  onRequestDecline: (action: ClaimAction) => void;
  busy?: boolean;
  className?: string;
}

const KIND_ICON: Record<ClaimActionKind, React.ComponentType<{ className?: string }>> = {
  request_doc: FileText,
  notify_ops: Bell,
  approval_request: ShieldCheck,
};

const KIND_LABEL: Record<ClaimActionKind, string> = {
  request_doc: 'Document request',
  notify_ops: 'Ops notification',
  approval_request: 'Approval request',
};

function relTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export const ActionRow: React.FC<ActionRowProps> = ({
  action,
  onAck,
  onRequestDecline,
  busy = false,
  className,
}) => {
  const Icon = KIND_ICON[action.kind as ClaimActionKind] ?? Bell;
  const title = (action.payload?.title as string | undefined) ?? KIND_LABEL[action.kind as ClaimActionKind];
  const summary = (action.payload?.summary as string | undefined) ?? '';
  const deepLink = action.payload?.deep_link as string | undefined;
  const fixHint = action.payload?.fix_hint as string | undefined;

  const handleAck = async () => {
    const response =
      action.kind === 'approval_request' ? { decision: 'approved' } : {};
    await onAck(action.id, response);
  };

  return (
    <tr
      className={cn(
        'border-b border-slate-200 dark:border-slate-800',
        'hover:bg-slate-50 dark:hover:bg-slate-900/50',
        className,
      )}
    >
      <td className="px-3 py-3 align-top">
        <div className="flex items-start gap-2">
          <Icon className="size-4 mt-0.5 text-slate-500 dark:text-slate-400 shrink-0" aria-hidden />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CategoryPill category={KIND_LABEL[action.kind as ClaimActionKind] ?? action.kind} size="xs" />
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                {title}
              </span>
            </div>
            {summary && (
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">
                {summary}
              </p>
            )}
            {fixHint && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
                <span className="font-medium">Fix:</span> {fixHint}
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-3 align-top">
        {deepLink ? (
          <a
            href={deepLink}
            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink className="size-3" />
            {action.claim_id.slice(0, 8)}
          </a>
        ) : (
          <code className="text-xs text-slate-500 dark:text-slate-400">
            {action.claim_id.slice(0, 8)}
          </code>
        )}
      </td>
      <td className="px-3 py-3 align-top">
        <div className="text-xs text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
          <Clock className="size-3" />
          {relTime(action.created_at)}
        </div>
      </td>
      <td className="px-3 py-3 align-top">
        <div className="flex items-center gap-2 justify-end">
          <Button
            size="sm"
            variant="default"
            onClick={handleAck}
            disabled={busy}
            className="gap-1"
          >
            <Check className="size-3.5" />
            {action.kind === 'approval_request' ? 'Approve' : 'Ack'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRequestDecline(action)}
            disabled={busy}
            className="gap-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            <X className="size-3.5" />
            Decline
          </Button>
        </div>
      </td>
    </tr>
  );
};
