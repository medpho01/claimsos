import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  MinusCircle,
  AlertTriangle,
  AlertOctagon,
  RefreshCw,
  ThumbsUp,
  Flag,
  Send,
  Layers,
  FileText,
  Stethoscope,
  Gauge,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ReadinessGauge, CategoryPill } from '@/components/intelligence/primitives';
import {
  useStageAdjudication,
  type StageReview,
  type StageHypothesis,
  type StageRuleResult,
  type StageFeedbackLayer,
  type StageFeedbackRootCause,
  type SubmitFeedbackPayload,
} from '@/hooks/intelligence/useStageAdjudication';

/**
 * M7 — Stage Adjudication panel.
 *
 * Surfaces the stage-aware adjudication engine as the primary verdict
 * surface: resolved context, the recommended action, the 4-layer hypothesis
 * (documents → content → rules → readiness), and per-layer / per-rule
 * human-in-the-loop feedback controls. This is the loop the engine learns
 * from — a reviewer agrees or flags any layer or rule as wrong.
 */
export interface StageAdjudicationPanelProps {
  claimId: string;
  offline?: boolean;
}

const STATUS_TONE: Record<string, string> = {
  PASS: 'text-emerald-700 dark:text-emerald-300',
  FAIL: 'text-red-700 dark:text-red-300',
  SKIP: 'text-slate-500 dark:text-slate-400',
  WARN: 'text-amber-700 dark:text-amber-300',
  ERROR: 'text-fuchsia-700 dark:text-fuchsia-300',
};

const SEVERITY_TONE: Record<string, string> = {
  CRITICAL: 'text-red-700 dark:text-red-300',
  HIGH: 'text-red-700 dark:text-red-300',
  MEDIUM: 'text-amber-700 dark:text-amber-300',
  LOW: 'text-slate-600 dark:text-slate-300',
  INFO: 'text-slate-500 dark:text-slate-400',
};

const ACTION_META: Record<
  string,
  { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }
> = {
  file_now: {
    label: 'File now',
    tone: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
    icon: CheckCircle2,
  },
  review: {
    label: 'Human review',
    tone: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    icon: AlertTriangle,
  },
  request_doc: {
    label: 'Request documents',
    tone: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
    icon: AlertOctagon,
  },
};

function statusIcon(status: string): React.ComponentType<{ className?: string }> {
  switch (status) {
    case 'PASS':
      return CheckCircle2;
    case 'FAIL':
      return XCircle;
    case 'WARN':
      return AlertTriangle;
    case 'ERROR':
      return AlertOctagon;
    default:
      return MinusCircle;
  }
}

export const StageAdjudicationPanel: React.FC<StageAdjudicationPanelProps> = ({
  claimId,
  offline = false,
}) => {
  const engine = useStageAdjudication(offline ? null : claimId);
  const review = engine.data;

  // hypotheses are ordered updated_at DESC; allow switching stage when >1.
  const hypotheses = review?.adjudication.hypotheses ?? [];
  const [stageSel, setStageSel] = useState<string | null>(null);
  const primary: StageHypothesis | null = useMemo(() => {
    if (hypotheses.length === 0) return null;
    if (stageSel != null) {
      return hypotheses.find((h) => h.stage === stageSel) ?? hypotheses[0];
    }
    // default: prefer the one matching the resolved context stage
    const ctxStage = review?.context?.stage;
    return (
      (ctxStage && hypotheses.find((h) => h.stage === ctxStage)) ||
      hypotheses[0]
    );
  }, [hypotheses, stageSel, review?.context?.stage]);

  if (!offline && engine.loading) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading stage adjudication…
      </div>
    );
  }

  if (!review || hypotheses.length === 0 || !primary) {
    return (
      <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
        <div className="mx-auto size-10 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
          <Layers className="size-5 text-indigo-600 dark:text-indigo-300" />
        </div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Stage adjudication not run yet
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
          The stage-aware engine resolves the claim context, picks stage-scoped
          rules, and produces a 4-layer hypothesis you can give feedback on.
        </p>
        <Button
          onClick={() => !offline && void engine.evaluate()}
          disabled={engine.isEvaluating || offline}
          className="gap-2"
        >
          <RefreshCw className={cn('size-3.5', engine.isEvaluating && 'animate-spin')} />
          Run stage adjudication
        </Button>
      </div>
    );
  }

  const l1 = primary.layer1_documents;
  const l2 = primary.layer2_content;
  const l3 = primary.layer3_rules ?? [];
  const l4 = primary.layer4_readiness;
  const ctx = review.context;
  const action = l4?.recommended_action ?? 'review';
  const actionMeta = ACTION_META[action] ?? ACTION_META.review;
  const ActionIcon = actionMeta.icon;
  const score = l4?.readiness_score ?? 0;

  return (
    <div className="space-y-3">
      {/* ── Header: context + recommended action + gauge ─────────────────── */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <div className="flex items-start gap-5">
          <ReadinessGauge
            score={typeof score === 'number' ? score : 0}
            size={96}
            subtitle={l4?.rule_set ?? 'Stage engine'}
            label={
              action === 'file_now'
                ? 'Ready'
                : action === 'request_doc'
                  ? 'Blocked'
                  : 'Review'
            }
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Resolved context
              </span>
              {primary.resolver_version && (
                <span className="text-[10px] font-mono text-slate-400">
                  {primary.resolver_version}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <ContextChip label="Scheme" value={ctx?.scheme} />
              <ContextChip label="Route" value={ctx?.route} />
              <ContextChip
                label="Insurer"
                value={(l4?.context as any)?.insurer ?? ctx?.insurer_panel_id}
              />
              <ContextChip label="Stage" value={primary.stage || ctx?.stage} highlight />
              <ContextChip label="Case" value={ctx?.case_type} />
            </div>

            {/* Recommended action banner */}
            <div
              className={cn(
                'mt-3 inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium',
                actionMeta.tone,
              )}
            >
              <ActionIcon className="size-4" />
              Recommended: {actionMeta.label}
            </div>

            {/* readiness flags */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(l4?.blocking ?? []).map((b) => (
                <FlagChip key={`b-${b}`} text={b} tone="bad" prefix="blocking" />
              ))}
              {(l4?.abstained ?? []).map((b) => (
                <FlagChip key={`a-${b}`} text={b} tone="warn" prefix="abstained" />
              ))}
              {(l4?.errored ?? []).map((b) => (
                <FlagChip key={`e-${b}`} text={b} tone="error" prefix="errored" />
              ))}
              {(l4?.warnings ?? []).map((b) => (
                <FlagChip key={`w-${b}`} text={b} tone="warn" prefix="warning" />
              ))}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => !offline && void engine.evaluate()}
              disabled={engine.isEvaluating || offline}
              className="gap-1.5"
            >
              <RefreshCw className={cn('size-3.5', engine.isEvaluating && 'animate-spin')} />
              Re-run engine
            </Button>
            {hypotheses.length > 1 && (
              <select
                value={primary.stage}
                onChange={(e) => setStageSel(e.target.value)}
                className="text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-slate-700 dark:text-slate-200"
              >
                {hypotheses.map((h) => (
                  <option key={h.stage} value={h.stage}>
                    {h.stage || '(legacy/any)'}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* ── Decision bar — the human commits a verdict on the recommendation ─ */}
      <DecisionBar
        stage={primary.stage}
        recommendedAction={action}
        actionLabel={actionMeta.label}
        review={review}
        engine={engine}
        offline={offline}
      />

      {/* ── Layer 1 — Documents ──────────────────────────────────────────── */}
      <LayerCard
        icon={FileText}
        title="Layer 1 · Documents"
        subtitle="What document categories the engine sees on this claim"
        layer="documents"
        stage={primary.stage}
        review={review}
        engine={engine}
        offline={offline}
      >
        {(l1?.present_categories?.length ?? 0) > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {l1!.present_categories!.map((c) => (
              <CategoryPill
                key={c}
                category={c}
                ontologyCategory="doc_category"
                size="xs"
              />
            ))}
          </div>
        ) : (
          <EmptyNote>No categorised documents resolved.</EmptyNote>
        )}
      </LayerCard>

      {/* ── Layer 2 — Content ────────────────────────────────────────────── */}
      <LayerCard
        icon={Stethoscope}
        title="Layer 2 · Content"
        subtitle="Extracted fields + cross-document identity the rules read from"
        layer="content"
        stage={primary.stage}
        review={review}
        engine={engine}
        offline={offline}
      >
        <ContentSummary l2={l2} />
      </LayerCard>

      {/* ── Layer 3 — Rules ──────────────────────────────────────────────── */}
      <LayerCard
        icon={Layers}
        title="Layer 3 · Rules"
        subtitle="Stage-scoped rule outcomes — agree or flag any one as wrong"
        layer="rules"
        stage={primary.stage}
        review={review}
        engine={engine}
        offline={offline}
        hideLayerFeedback
      >
        {l3.length === 0 ? (
          <EmptyNote>
            {l4?.no_kinded_rules
              ? 'Selected rule set carries no deterministic rules.'
              : 'No rules evaluated for this stage.'}
          </EmptyNote>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 -mx-1">
            {l3.map((r) => (
              <RuleRow
                key={r.ruleId}
                rule={r}
                stage={primary.stage}
                review={review}
                engine={engine}
                offline={offline}
              />
            ))}
          </ul>
        )}
      </LayerCard>

      {/* ── Layer 4 — Readiness ──────────────────────────────────────────── */}
      <LayerCard
        icon={Gauge}
        title="Layer 4 · Readiness"
        subtitle="The overall recommendation derived from the rule outcomes"
        layer="readiness"
        stage={primary.stage}
        review={review}
        engine={engine}
        offline={offline}
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <MiniStat label="Score" value={score == null ? '—' : `${score}`} />
          <MiniStat label="Action" value={actionMeta.label} />
          <MiniStat label="Blocking" value={`${l4?.blocking?.length ?? 0}`} tone="bad" />
          <MiniStat
            label="Abstained / Errored"
            value={`${(l4?.abstained?.length ?? 0) + (l4?.errored?.length ?? 0)}`}
            tone="warn"
          />
        </div>
      </LayerCard>

      {/* ── Feedback recorded so far ─────────────────────────────────────── */}
      {review.feedback.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <h4 className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
            Feedback recorded ({review.feedback.length})
          </h4>
          <ul className="space-y-1.5">
            {review.feedback.map((f) => (
              <li
                key={f.id}
                className="text-xs flex items-start gap-2 text-slate-600 dark:text-slate-300"
              >
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                    f.verdict === 'agree'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                      : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
                  )}
                >
                  {f.verdict}
                </span>
                <span className="font-mono text-[11px] text-slate-500 shrink-0">
                  [{f.layer}
                  {f.target_ref ? `:${f.target_ref}` : ''}]
                </span>
                <span className="min-w-0">
                  {f.notes || (f.root_cause ? `root cause: ${f.root_cause}` : '—')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

// ─── Decision bar — reviewer commits a verdict on the engine recommendation ──

const DECISION_REF = '__decision__';
const DECISION_LABEL: Record<string, string> = {
  approve: 'Approved to file',
  decline: 'Declined',
  file_anyway: 'Filed with override',
};

interface DecisionBarProps {
  stage: string;
  recommendedAction: string;
  actionLabel: string;
  review: StageReview;
  engine: ReturnType<typeof useStageAdjudication>;
  offline: boolean;
}

const DecisionBar: React.FC<DecisionBarProps> = ({
  stage,
  recommendedAction,
  actionLabel,
  review,
  engine,
  offline,
}) => {
  // feedback is ordered created_at DESC → first decision row is the latest.
  const last = review.feedback.find(
    (f) => f.layer === 'readiness' && f.target_ref === DECISION_REF,
  );
  const lastDecision =
    last && (last.corrected_value as any)?.decision
      ? ((last.corrected_value as any).decision as string)
      : null;

  const [mode, setMode] = useState<'idle' | 'decline' | 'file_anyway'>('idle');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const record = async (
    decision: 'approve' | 'decline' | 'file_anyway',
    verdict: 'agree' | 'disagree' | 'correct',
    why?: string,
  ) => {
    if (offline) return;
    setBusy(true);
    try {
      await engine.submitFeedback({
        layer: 'readiness',
        targetRef: DECISION_REF,
        stage: stage || null,
        verdict,
        correctedValue: { decision, reason: why ?? null },
        notes: `Decision: ${decision.toUpperCase()}${why ? ` — ${why}` : ''}`,
      });
      setMode('idle');
      setReason('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Reviewer decision
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-300 mt-0.5">
            Engine recommends{' '}
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {actionLabel}
            </span>
            . Record your call:
          </div>
        </div>

        {lastDecision && mode === 'idle' && (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium',
              lastDecision === 'approve'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                : lastDecision === 'decline'
                  ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
                  : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
            )}
          >
            <CheckCircle2 className="size-3.5" />
            {DECISION_LABEL[lastDecision] ?? lastDecision}
          </span>
        )}

        <div className="flex items-center gap-2">
          <Button
            onClick={() => void record('approve', 'agree')}
            disabled={busy || offline}
            className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            Approve to file
          </Button>
          <Button
            variant="ghost"
            onClick={() => setMode(mode === 'decline' ? 'idle' : 'decline')}
            disabled={busy || offline}
            className="gap-1.5 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
          >
            <XCircle className="size-4" />
            Decline
          </Button>
          <Button
            variant="ghost"
            onClick={() => setMode(mode === 'file_anyway' ? 'idle' : 'file_anyway')}
            disabled={busy || offline}
            className="gap-1.5 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40"
          >
            <Send className="size-4" />
            File anyway
          </Button>
        </div>
      </div>

      {mode !== 'idle' && (
        <div
          className={cn(
            'mt-3 rounded-md border p-3 space-y-2',
            mode === 'decline'
              ? 'border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20'
              : 'border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20',
          )}
        >
          <div className="text-xs font-medium text-slate-700 dark:text-slate-200">
            {mode === 'decline'
              ? 'Reason for declining'
              : 'Reason for filing despite the engine recommendation'}
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder={
              mode === 'decline'
                ? 'Why is this claim not fileable? (e.g. wrong patient identity on KYC)'
                : 'Clinical urgency, partial approval acceptable, etc.'
            }
            className="w-full text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-slate-700 dark:text-slate-200"
          />
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setMode('idle'); setReason(''); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              className={cn(
                'h-7 text-xs gap-1.5 text-white',
                mode === 'decline' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700',
              )}
              disabled={busy || offline || reason.trim().length < 5}
              onClick={() =>
                mode === 'decline'
                  ? void record('decline', 'disagree', reason.trim())
                  : void record('file_anyway', 'correct', reason.trim())
              }
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {mode === 'decline' ? 'Confirm decline' : 'File now'}
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
        Records your decision for audit + model training. Does not transmit the claim to the insurer.
      </div>
    </div>
  );
};

// ─── Layer card with optional layer-level feedback ───────────────────────────

interface LayerCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  layer: StageFeedbackLayer;
  stage: string;
  review: StageReview;
  engine: ReturnType<typeof useStageAdjudication>;
  offline: boolean;
  hideLayerFeedback?: boolean;
  children: React.ReactNode;
}

const LayerCard: React.FC<LayerCardProps> = ({
  icon: Icon,
  title,
  subtitle,
  layer,
  stage,
  review,
  engine,
  offline,
  hideLayerFeedback,
  children,
}) => {
  const existing = review.feedback.find(
    (f) => f.layer === layer && !f.target_ref,
  );
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="flex items-start gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <Icon className="size-4 mt-0.5 text-indigo-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        </div>
        {!hideLayerFeedback && (
          <FeedbackControl
            layer={layer}
            targetRef={null}
            stage={stage}
            existingVerdict={existing?.verdict}
            engine={engine}
            offline={offline}
          />
        )}
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
};

// ─── Rule row with per-rule feedback ─────────────────────────────────────────

interface RuleRowProps {
  rule: StageRuleResult;
  stage: string;
  review: StageReview;
  engine: ReturnType<typeof useStageAdjudication>;
  offline: boolean;
}

const RuleRow: React.FC<RuleRowProps> = ({ rule, stage, review, engine, offline }) => {
  const [open, setOpen] = useState(false);
  const Icon = statusIcon(rule.status);
  const existing = review.feedback.find(
    (f) => f.layer === 'rules' && f.target_ref === rule.ruleId,
  );

  return (
    <li className="px-1">
      <div className="flex items-center gap-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-3 min-w-0 flex-1 text-left"
        >
          {open ? (
            <ChevronDown className="size-3.5 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 text-slate-400 shrink-0" />
          )}
          <Icon className={cn('size-4 shrink-0', STATUS_TONE[rule.status] ?? '')} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
              {rule.ruleId}
              <span className="ml-2 text-[10px] font-mono text-slate-400">
                {rule.kind}
              </span>
            </div>
            {rule.message && (
              <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                {rule.message}
              </div>
            )}
          </div>
        </button>
        {typeof rule.confidence === 'number' && (
          <span className="text-[10px] font-mono text-slate-400 shrink-0">
            conf {rule.confidence.toFixed(2)}
          </span>
        )}
        <span
          className={cn(
            'text-[10px] uppercase tracking-wide font-medium shrink-0',
            SEVERITY_TONE[rule.severity] ?? 'text-slate-500',
          )}
        >
          {rule.severity}
        </span>
        <FeedbackControl
          layer="rules"
          targetRef={rule.ruleId}
          stage={stage}
          existingVerdict={existing?.verdict}
          engine={engine}
          offline={offline}
          compact
        />
      </div>

      {open && (
        <div className="pl-11 pr-2 pb-3 space-y-2 text-xs">
          {rule.message && (
            <p className="text-slate-700 dark:text-slate-200">{rule.message}</p>
          )}
          {rule.evidence && (
            <div>
              <h5 className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
                Evidence
              </h5>
              <pre className="rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2 text-[11px] font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap max-h-56 overflow-auto">
                {JSON.stringify(rule.evidence, null, 2)}
              </pre>
            </div>
          )}
          <div className="text-[11px] text-slate-400">
            impact: {rule.impact ?? '—'}
          </div>
        </div>
      )}
    </li>
  );
};

// ─── Feedback control (agree / flag-wrong inline form) ───────────────────────

interface FeedbackControlProps {
  layer: StageFeedbackLayer;
  targetRef: string | null;
  stage: string;
  existingVerdict?: string;
  engine: ReturnType<typeof useStageAdjudication>;
  offline: boolean;
  compact?: boolean;
}

const ROOT_CAUSES: StageFeedbackRootCause[] = [
  'rules',
  'documents',
  'content',
  'context',
  'none',
];

const FeedbackControl: React.FC<FeedbackControlProps> = ({
  layer,
  targetRef,
  stage,
  existingVerdict,
  engine,
  offline,
  compact,
}) => {
  const [flagging, setFlagging] = useState(false);
  const [notes, setNotes] = useState('');
  const [rootCause, setRootCause] = useState<StageFeedbackRootCause>('rules');
  const [saved, setSaved] = useState<string | null>(existingVerdict ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async (payload: SubmitFeedbackPayload) => {
    if (offline) return;
    setBusy(true);
    try {
      await engine.submitFeedback(payload);
      setSaved(payload.verdict);
      setFlagging(false);
      setNotes('');
    } finally {
      setBusy(false);
    }
  };

  if (saved && !flagging) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 text-[11px] font-medium shrink-0',
          saved === 'agree'
            ? 'text-emerald-700 dark:text-emerald-300'
            : 'text-red-700 dark:text-red-300',
        )}
      >
        {saved === 'agree' ? (
          <ThumbsUp className="size-3.5" />
        ) : (
          <Flag className="size-3.5" />
        )}
        {saved === 'agree' ? 'Agreed' : 'Flagged'}
        <button
          type="button"
          onClick={() => setFlagging(true)}
          className="ml-1 text-[10px] text-slate-400 hover:underline"
        >
          edit
        </button>
      </span>
    );
  }

  if (!flagging) {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          disabled={busy || offline}
          onClick={() =>
            void submit({ layer, targetRef, stage: stage || null, verdict: 'agree' })
          }
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-slate-500 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-300"
          title="Agree with this"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ThumbsUp className="size-3.5" />}
          {!compact && 'Agree'}
        </button>
        <button
          type="button"
          disabled={busy || offline}
          onClick={() => setFlagging(true)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-slate-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40 dark:hover:text-red-300"
          title="Flag as wrong"
        >
          <Flag className="size-3.5" />
          {!compact && 'Flag'}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full mt-2 rounded-md border border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-950/20 p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Root cause
        </span>
        <select
          value={rootCause}
          onChange={(e) => setRootCause(e.target.value as StageFeedbackRootCause)}
          className="text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-slate-700 dark:text-slate-200"
        >
          {ROOT_CAUSES.map((rc) => (
            <option key={rc} value={rc}>
              {rc}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder="What's wrong? (e.g. this name mismatch is a wrong Aadhaar attachment, not the patient)"
        className="w-full text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-slate-700 dark:text-slate-200"
      />
      <div className="flex items-center gap-2 justify-end">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => {
            setFlagging(false);
            setNotes('');
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs gap-1.5"
          disabled={busy || offline}
          onClick={() =>
            void submit({
              layer,
              targetRef,
              stage: stage || null,
              verdict: 'disagree',
              rootCause,
              notes: notes.trim() || null,
            })
          }
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Flag className="size-3.5" />}
          Submit flag
        </Button>
      </div>
    </div>
  );
};

// ─── small helpers ───────────────────────────────────────────────────────────

const ContextChip: React.FC<{
  label: string;
  value?: string | null;
  highlight?: boolean;
}> = ({ label, value, highlight }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] border',
      highlight
        ? 'border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200'
        : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-200',
    )}
  >
    <span className="text-slate-400 dark:text-slate-500">{label}:</span>
    <span className="font-medium">{value || '—'}</span>
  </span>
);

const FlagChip: React.FC<{
  text: string;
  tone: 'bad' | 'warn' | 'error';
  prefix: string;
}> = ({ text, tone, prefix }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium',
      tone === 'bad' && 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
      tone === 'warn' &&
        'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      tone === 'error' &&
        'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/50 dark:text-fuchsia-300',
    )}
  >
    <span className="opacity-60">{prefix}</span>
    {text}
  </span>
);

const MiniStat: React.FC<{
  label: string;
  value: string;
  tone?: 'bad' | 'warn' | 'default';
}> = ({ label, value, tone = 'default' }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div
      className={cn(
        'text-base font-semibold tabular-nums',
        tone === 'bad' && 'text-red-700 dark:text-red-300',
        tone === 'warn' && 'text-amber-700 dark:text-amber-300',
        tone === 'default' && 'text-slate-900 dark:text-slate-100',
      )}
    >
      {value}
    </div>
  </div>
);

const EmptyNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-xs text-slate-400 dark:text-slate-500 italic">{children}</p>
);

const ContentSummary: React.FC<{ l2: StageHypothesis['layer2_content'] }> = ({
  l2,
}) => {
  if (!l2) return <EmptyNote>No extracted content resolved.</EmptyNote>;
  const fieldCats = Object.entries(l2.fields_by_category ?? {});
  const names = l2.names;
  return (
    <div className="space-y-3">
      {/* identity / names — where the cross-document name check reads from */}
      {names && (
        <div>
          <h5 className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
            Identity (names by source)
          </h5>
          <pre className="rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2 text-[11px] font-mono text-slate-700 dark:text-slate-200 whitespace-pre-wrap max-h-40 overflow-auto">
            {JSON.stringify(names, null, 2)}
          </pre>
        </div>
      )}
      {fieldCats.length > 0 && (
        <div>
          <h5 className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">
            Extracted fields by category
          </h5>
          <div className="flex flex-wrap gap-1.5">
            {fieldCats.map(([cat, fields]) => (
              <span
                key={cat}
                className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-2 py-0.5 text-[11px] text-slate-700 dark:text-slate-200"
              >
                <span className="font-medium">{cat}</span>
                <span className="text-slate-400">
                  {Object.keys(fields ?? {}).length}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default StageAdjudicationPanel;
