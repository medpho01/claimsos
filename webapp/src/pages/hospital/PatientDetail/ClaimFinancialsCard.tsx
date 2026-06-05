import React from 'react';
import { IndianRupee, Sparkles } from 'lucide-react';
import { useClaimFinancials, type FinancialStage } from '@/hooks/intelligence/useClaimFinancials';

/**
 * Claim Financials — read-only summary for the Overview tab.
 *   - Claimed amounts are entered by the admin in Edit patient.
 *   - Approved amounts are extracted from the insurer email + confirmed on
 *     draft apply (shows a "from email" marker + extraction confidence).
 *   - Deduction = claimed − approved (server-derived), highlighted when > 0.
 */
const fmt = (v: number | string | null | undefined): string =>
  v == null || v === '' ? '—' : '₹' + Number(v).toLocaleString('en-IN');

const ClaimFinancialsCard: React.FC<{ claimId: string }> = ({ claimId }) => {
  const fin = useClaimFinancials(claimId);
  const f = fin.data;

  const StageRow: React.FC<{ stage: FinancialStage; label: string }> = ({ stage, label }) => {
    const claimed = stage === 'preauth' ? f?.preauth_claimed_amount : f?.final_claimed_amount;
    const approved = stage === 'preauth' ? f?.preauth_approved_amount : f?.final_approved_amount;
    const deduction = stage === 'preauth' ? f?.preauth_deduction : f?.final_deduction;
    const conf = stage === 'preauth' ? f?.preauth_approved_confidence : f?.final_approved_confidence;
    const fromEmail =
      (stage === 'preauth' ? f?.preauth_approved_source_inbound_id : f?.final_approved_source_inbound_id) != null;
    const dedNum = deduction == null ? null : Number(deduction);
    return (
      <div className="grid grid-cols-12 items-center gap-2 py-2 border-b border-slate-100 dark:border-slate-800 last:border-0">
        <div className="col-span-3 text-xs font-medium text-slate-700 dark:text-slate-200">{label}</div>
        <Cell label="Claimed" value={fmt(claimed)} />
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Approved</div>
          <div className="flex items-center gap-1 text-xs font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
            {fmt(approved)}
            {fromEmail && (
              <span
                title={`Extracted from insurer email${conf != null ? ` · ${Math.round(Number(conf) * 100)}% confidence` : ''}`}
                className="inline-flex items-center gap-0.5 text-[9px] text-indigo-500"
              >
                <Sparkles className="size-2.5" />
                {conf != null ? `${Math.round(Number(conf) * 100)}%` : 'email'}
              </span>
            )}
          </div>
        </div>
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Deduction</div>
          <div
            className={`text-xs font-semibold tabular-nums ${
              dedNum != null && dedNum > 0 ? 'text-red-600 dark:text-red-300' : 'text-slate-500'
            }`}
          >
            {dedNum != null && dedNum > 0 ? fmt(dedNum) : '—'}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center gap-2 mb-2">
        <IndianRupee className="size-4 text-brand-600" />
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Claim Financials</h3>
        <span className="ml-auto text-[10px] text-slate-400">
          Claimed amounts: edit in Edit patient · Approved: read from insurer emails
        </span>
      </div>
      <StageRow stage="preauth" label="Pre-auth" />
      <StageRow stage="final" label="Settlement" />
    </div>
  );
};

const Cell: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="col-span-3">
    <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-xs font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
  </div>
);

export default ClaimFinancialsCard;
