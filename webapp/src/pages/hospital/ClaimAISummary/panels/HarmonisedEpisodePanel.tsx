import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  RefreshCw,
  Sparkles,
  AlertCircle,
  Code2,
  Copy,
  Check,
  Download,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  useHarmonisedEpisode,
  type HarmonisedEpisode,
  type HarmonisedProvenance,
} from '@/hooks/intelligence/useHarmonisedEpisode';
import { ProvenanceTag } from '../components/ProvenanceTag';
import { EditFieldModal, type EditFieldType } from '../components/EditFieldModal';

/**
 * Wave 9 — HarmonisedEpisodePanel.
 *
 * 8 collapsible sections mirroring the canonical medical_episode.v2 top
 * level. Each rendered field carries a provenance tag (LLM source) and a
 * pencil to invoke a correction. Backed by useHarmonisedEpisode.
 */
export interface HarmonisedEpisodePanelProps {
  claimId: string;
  /** Override the episode payload — used by the dev demo. */
  episodeOverride?: HarmonisedEpisode | null;
  /** Disable network calls — used by the dev demo. */
  offline?: boolean;
}

interface EditTarget {
  json_path: string;
  label: string;
  currentValue: any;
  fieldType: EditFieldType;
}

export const HarmonisedEpisodePanel: React.FC<HarmonisedEpisodePanelProps> = ({
  claimId,
  episodeOverride,
  offline = false,
}) => {
  const ep = useHarmonisedEpisode(offline ? null : claimId);
  const episode = episodeOverride !== undefined ? episodeOverride : ep.data;

  const [openSections, setOpenSections] = useState<Set<string>>(
    new Set(['meta', 'diagnosis', 'clinical_timeline']),
  );
  const toggle = (key: string) =>
    setOpenSections((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [showFullJson, setShowFullJson] = useState(false);
  const [copied, setCopied] = useState(false);

  const onSaveCorrection = async (newValue: any, reason: string) => {
    if (!editTarget) return;
    if (offline) return;
    await ep.applyCorrection({
      json_path: editTarget.json_path,
      human_value: newValue,
      reason: reason || undefined,
    });
  };

  const onRegenerate = async () => {
    if (offline) return;
    await ep.regenerate();
    setConfirmRegen(false);
  };

  if (!offline && ep.loading) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-4 w-1/3 bg-slate-200 dark:bg-slate-800 rounded animate-pulse" />
            <div className="h-3 w-2/3 bg-slate-100 dark:bg-slate-800/60 rounded animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  if (!offline && ep.error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
        <AlertCircle className="size-4 shrink-0 mt-0.5" />
        <div>
          <div className="font-medium">Could not load the harmonised episode.</div>
          <div className="text-xs mt-1">{String(ep.error.message)}</div>
        </div>
      </div>
    );
  }

  if (!episode) {
    return (
      <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
        <div className="mx-auto size-10 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
          <Sparkles className="size-5 text-indigo-600 dark:text-indigo-300" />
        </div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Not yet harmonised
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Click <span className="font-medium">Run AI Analysis</span> on the patient
          detail page to harmonise the documents into the canonical schema.
        </p>
      </div>
    );
  }

  const provenance = episode._provenance ?? {};

  return (
    <div className="space-y-3">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {episode.meta?.episode_id && (
            <>
              Episode <code className="font-mono">{episode.meta.episode_id}</code>
              {episode.meta?.last_updated_at && (
                <>
                  {' · '}updated {new Date(episode.meta.last_updated_at).toLocaleString()}
                </>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {confirmRegen ? (
            <>
              <span className="text-xs text-amber-700 dark:text-amber-300">
                This re-runs LLM extraction. Continue?
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRegen(false)}
                disabled={ep.isRegenerating}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={onRegenerate}
                disabled={ep.isRegenerating || offline}
                className="gap-1.5"
              >
                <RefreshCw
                  className={cn('size-3.5', ep.isRegenerating && 'animate-spin')}
                />
                Confirm regenerate
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowFullJson(true)}
                className="gap-1.5"
                title="View the raw canonical episode JSON"
              >
                <Code2 className="size-3.5" />
                View full JSON
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRegen(true)}
                className="gap-1.5"
              >
                <RefreshCw className="size-3.5" />
                Regenerate
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Section 1: Meta + Patient Context */}
      <Section
        title="Meta & Patient Context"
        sectionKey="meta"
        open={openSections.has('meta')}
        onToggle={toggle}
      >
        <FieldGrid>
          <HarmonisedField
            label="Episode type"
            value={episode.meta?.episode_type}
            jsonPath="/meta/episode_type"
            provenance={provenance['/meta/episode_type']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Subtype"
            value={episode.meta?.episode_subtype}
            jsonPath="/meta/episode_subtype"
            provenance={provenance['/meta/episode_subtype']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Category"
            value={episode.meta?.episode_category}
            jsonPath="/meta/episode_category"
            provenance={provenance['/meta/episode_category']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Verification status"
            value={episode.meta?.verification_status}
            jsonPath="/meta/verification_status"
            provenance={provenance['/meta/verification_status']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Name"
            value={[
              episode.patient_context?.first_name,
              episode.patient_context?.middle_name,
              episode.patient_context?.last_name,
            ]
              .filter(Boolean)
              .join(' ')}
            jsonPath="/patient_context/first_name"
            provenance={provenance['/patient_context/first_name']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="UHID"
            value={episode.patient_context?.uhid}
            jsonPath="/patient_context/uhid"
            provenance={provenance['/patient_context/uhid']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Age"
            value={
              episode.patient_context?.age != null
                ? `${episode.patient_context.age} ${episode.patient_context.age_unit ?? 'YRS'}`
                : undefined
            }
            jsonPath="/patient_context/age"
            provenance={provenance['/patient_context/age']}
            fieldType="number"
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Gender"
            value={episode.patient_context?.gender}
            jsonPath="/patient_context/gender"
            provenance={provenance['/patient_context/gender']}
            onEdit={setEditTarget}
          />
        </FieldGrid>
      </Section>

      {/* Section 2: Hospital Context */}
      <Section
        title="Hospital Context"
        sectionKey="hospital"
        open={openSections.has('hospital')}
        onToggle={toggle}
      >
        <FieldGrid>
          <HarmonisedField
            label="Hospital"
            value={episode.hospital_context?.name}
            jsonPath="/hospital_context/name"
            provenance={provenance['/hospital_context/name']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Type"
            value={episode.hospital_context?.type}
            jsonPath="/hospital_context/type"
            provenance={provenance['/hospital_context/type']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="IPD number"
            value={episode.hospital_context?.ipd_number}
            jsonPath="/hospital_context/ipd_number"
            provenance={provenance['/hospital_context/ipd_number']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Primary consultant"
            value={
              (episode.hospital_context?.treating_team as any)?.primary_consultant?.name
            }
            jsonPath="/hospital_context/treating_team/primary_consultant/name"
            provenance={
              provenance['/hospital_context/treating_team/primary_consultant/name']
            }
            onEdit={setEditTarget}
          />
        </FieldGrid>
      </Section>

      {/* Section 3: Insurance Context */}
      <Section
        title="Insurance Context"
        sectionKey="insurance"
        open={openSections.has('insurance')}
        onToggle={toggle}
      >
        <FieldGrid>
          <HarmonisedField
            label="Insurer"
            value={episode.insurance_context?.insurer_name}
            jsonPath="/insurance_context/insurer_name"
            provenance={provenance['/insurance_context/insurer_name']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="TPA"
            value={episode.insurance_context?.insurer_tpa}
            jsonPath="/insurance_context/insurer_tpa"
            provenance={provenance['/insurance_context/insurer_tpa']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Policy #"
            value={episode.insurance_context?.policy_number}
            jsonPath="/insurance_context/policy_number"
            provenance={provenance['/insurance_context/policy_number']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Sum insured"
            value={
              episode.insurance_context?.sum_insured?.amount != null
                ? `₹ ${episode.insurance_context.sum_insured.amount.toLocaleString('en-IN')}`
                : undefined
            }
            jsonPath="/insurance_context/sum_insured/amount"
            provenance={provenance['/insurance_context/sum_insured/amount']}
            fieldType="number"
            onEdit={setEditTarget}
          />
        </FieldGrid>
      </Section>

      {/* Section 4: Diagnosis */}
      <Section
        title="Diagnosis"
        sectionKey="diagnosis"
        open={openSections.has('diagnosis')}
        onToggle={toggle}
      >
        <div className="space-y-3">
          <FieldGrid>
            <HarmonisedField
              label="Primary diagnosis"
              value={episode.diagnosis?.primary_diagnosis?.diagnosis_name}
              jsonPath="/diagnosis/primary_diagnosis/diagnosis_name"
              provenance={provenance['/diagnosis/primary_diagnosis/diagnosis_name']}
              onEdit={setEditTarget}
            />
            <HarmonisedField
              label="ICD-10"
              value={episode.diagnosis?.primary_diagnosis?.icd_code}
              jsonPath="/diagnosis/primary_diagnosis/icd_code"
              provenance={provenance['/diagnosis/primary_diagnosis/icd_code']}
              onEdit={setEditTarget}
            />
            <HarmonisedField
              label="Certainty"
              value={episode.diagnosis?.primary_diagnosis?.certainty}
              jsonPath="/diagnosis/primary_diagnosis/certainty"
              provenance={provenance['/diagnosis/primary_diagnosis/certainty']}
              onEdit={setEditTarget}
            />
          </FieldGrid>
          {!!episode.diagnosis?.secondary_diagnosis?.length && (
            <SubHeading>Secondary</SubHeading>
          )}
          <BulletList
            items={(episode.diagnosis?.secondary_diagnosis ?? []).map(
              (d: any) =>
                `${d.diagnosis_name ?? '—'}${d.icd_code ? ` (${d.icd_code})` : ''}`,
            )}
          />
          {!!episode.diagnosis?.comorbidities?.length && (
            <SubHeading>Comorbidities</SubHeading>
          )}
          <BulletList
            items={(episode.diagnosis?.comorbidities ?? []).map(
              (d: any) => `${d.condition_name ?? '—'} (${d.status ?? 'UNKNOWN'})`,
            )}
          />
        </div>
      </Section>

      {/* Section 5: Clinical Timeline */}
      <Section
        title="Clinical Timeline"
        sectionKey="clinical_timeline"
        open={openSections.has('clinical_timeline')}
        onToggle={toggle}
      >
        <div className="space-y-2">
          {(episode.clinical_timeline ?? []).map((phase, idx) => (
            <PhaseCard key={idx} phase={phase} />
          ))}
          {!episode.clinical_timeline?.length && (
            <EmptyHint>No timeline phases recorded.</EmptyHint>
          )}
        </div>
      </Section>

      {/* Section 6: Stay Summary */}
      <Section
        title="Stay Summary"
        sectionKey="stay"
        open={openSections.has('stay')}
        onToggle={toggle}
      >
        <FieldGrid>
          <HarmonisedField
            label="Admitted"
            value={fmtDateTime(episode.stay_summary?.admission_datetime)}
            jsonPath="/stay_summary/admission_datetime"
            provenance={provenance['/stay_summary/admission_datetime']}
            fieldType="datetime-local"
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Discharged"
            value={fmtDateTime(episode.stay_summary?.discharge_datetime)}
            jsonPath="/stay_summary/discharge_datetime"
            provenance={provenance['/stay_summary/discharge_datetime']}
            fieldType="datetime-local"
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Total LOS"
            value={
              episode.stay_summary?.total_los
                ? `${episode.stay_summary.total_los.value} ${episode.stay_summary.total_los.unit}`
                : undefined
            }
            jsonPath="/stay_summary/total_los/value"
            provenance={provenance['/stay_summary/total_los/value']}
            fieldType="number"
            onEdit={setEditTarget}
          />
        </FieldGrid>
      </Section>

      {/* Section 7: Financial Summary */}
      <Section
        title="Financial Summary"
        sectionKey="financial"
        open={openSections.has('financial')}
        onToggle={toggle}
      >
        <FinancialBreakdown summary={episode.financial_summary} provenance={provenance} />
      </Section>

      {/* Section 8: Discharge Summary */}
      <Section
        title="Discharge Summary"
        sectionKey="discharge"
        open={openSections.has('discharge')}
        onToggle={toggle}
      >
        <FieldGrid>
          <HarmonisedField
            label="Discharge date"
            value={episode.discharge_summary?.discharge_date}
            jsonPath="/discharge_summary/discharge_date"
            provenance={provenance['/discharge_summary/discharge_date']}
            fieldType="date"
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Discharge type"
            value={episode.discharge_summary?.discharge_type}
            jsonPath="/discharge_summary/discharge_type"
            provenance={provenance['/discharge_summary/discharge_type']}
            onEdit={setEditTarget}
          />
          <HarmonisedField
            label="Condition"
            value={episode.discharge_summary?.discharge_condition}
            jsonPath="/discharge_summary/discharge_condition"
            provenance={provenance['/discharge_summary/discharge_condition']}
            onEdit={setEditTarget}
          />
        </FieldGrid>
        {episode.discharge_summary?.course_in_hospital && (
          <div className="mt-3">
            <SubHeading>Course in hospital</SubHeading>
            <p className="text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
              {episode.discharge_summary.course_in_hospital}
            </p>
          </div>
        )}
        {!!episode.discharge_summary?.follow_up_instructions?.length && (
          <div className="mt-3">
            <SubHeading>Follow-up</SubHeading>
            <BulletList items={episode.discharge_summary.follow_up_instructions} />
          </div>
        )}
      </Section>

      <EditFieldModal
        open={!!editTarget}
        label={editTarget?.label ?? ''}
        fieldPath={editTarget?.json_path}
        currentValue={editTarget?.currentValue}
        fieldType={editTarget?.fieldType ?? 'text'}
        onClose={() => setEditTarget(null)}
        onSave={onSaveCorrection}
        saving={ep.isApplyingCorrection}
      />

      <FullJsonModal
        open={showFullJson}
        episode={episode}
        copied={copied}
        onCopy={async () => {
          try {
            await navigator.clipboard.writeText(
              JSON.stringify(episode, null, 2),
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // Clipboard API may be unavailable in unsecured contexts —
            // fail silently; the user can still read the JSON inline.
          }
        }}
        onClose={() => setShowFullJson(false)}
      />
    </div>
  );
};

const FullJsonModal: React.FC<{
  open: boolean;
  episode: HarmonisedEpisode | null;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}> = ({ open, episode, copied, onCopy, onClose }) => {
  const json = React.useMemo(() => {
    if (!episode) return '';
    // Pretty-print the whole payload, including `_meta` + `_provenance`
    // (preserved by useHarmonisedEpisode). Reviewers asked to see exactly
    // what the LLM produced so they can spot extraction issues that the
    // section-by-section view collapses.
    return JSON.stringify(episode, null, 2);
  }, [episode]);

  const onDownload = () => {
    if (!json) return;
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `harmonised-episode-${episode?.meta?.episode_id ?? 'export'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl w-[92vw] h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <DialogTitle className="text-base flex items-center gap-2">
            <Code2 className="size-4" />
            Harmonised episode — full JSON
          </DialogTitle>
          <DialogDescription className="text-xs">
            The complete canonical <code className="font-mono">medical_episode.v2</code>{' '}
            payload, including provenance and pipeline metadata.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-auto bg-slate-50 dark:bg-slate-950 p-4">
          <pre className="text-[11px] font-mono leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
            {json || 'No episode payload yet.'}
          </pre>
        </div>
        <DialogFooter className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center">
          <Button
            size="sm"
            variant="ghost"
            onClick={onCopy}
            disabled={!json}
            className="gap-1.5"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDownload}
            disabled={!json}
            className="gap-1.5"
          >
            <Download className="size-3.5" />
            Download .json
          </Button>
          <Button size="sm" variant="outline" onClick={onClose} className="ml-auto">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ─── Sub-components ────────────────────────────────────────────────────────

const Section: React.FC<{
  title: string;
  sectionKey: string;
  open: boolean;
  onToggle: (k: string) => void;
  children: React.ReactNode;
}> = ({ title, sectionKey, open, onToggle, children }) => (
  <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
    <button
      type="button"
      onClick={() => onToggle(sectionKey)}
      className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40"
    >
      {open ? (
        <ChevronDown className="size-4 text-slate-400" />
      ) : (
        <ChevronRight className="size-4 text-slate-400" />
      )}
      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </span>
    </button>
    {open && <div className="px-4 pb-4">{children}</div>}
  </section>
);

const FieldGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">{children}</div>
);

const SubHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-2 mb-1">
    {children}
  </h4>
);

const EmptyHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-xs text-slate-500 dark:text-slate-400 italic">{children}</p>
);

const BulletList: React.FC<{ items: string[] }> = ({ items }) => {
  if (!items.length) return null;
  return (
    <ul className="text-xs text-slate-700 dark:text-slate-200 space-y-0.5 list-disc list-inside">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
};

interface HarmonisedFieldProps {
  label: string;
  value: any;
  jsonPath: string;
  provenance?: HarmonisedProvenance;
  fieldType?: EditFieldType;
  onEdit: (t: EditTarget) => void;
}

const HarmonisedField: React.FC<HarmonisedFieldProps> = ({
  label,
  value,
  jsonPath,
  provenance,
  fieldType = 'text',
  onEdit,
}) => {
  const display =
    value === undefined || value === null || value === ''
      ? '—'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  const empty = display === '—';
  return (
    <div className="flex items-start gap-2 py-1 border-b border-slate-100 dark:border-slate-800/60 last:border-0">
      <div className="w-36 shrink-0 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 pt-0.5">
        {label}
      </div>
      <div className="min-w-0 flex-1 flex items-center gap-1.5">
        <span
          className={cn(
            'text-sm truncate',
            empty
              ? 'text-slate-400 dark:text-slate-600 italic'
              : 'text-slate-900 dark:text-slate-100',
          )}
          title={display}
        >
          {display}
        </span>
        <ProvenanceTag provenance={provenance} />
        <button
          type="button"
          onClick={() =>
            onEdit({
              json_path: jsonPath,
              label,
              currentValue: value,
              fieldType,
            })
          }
          className="ml-auto text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 p-1 rounded"
          title="Edit"
          aria-label={`Edit ${label}`}
        >
          <Pencil className="size-3" />
        </button>
      </div>
    </div>
  );
};

const PhaseCard: React.FC<{ phase: any }> = ({ phase }) => {
  const [open, setOpen] = useState(false);
  const proc = phase.procedures_performed ?? [];
  const diag = phase.diagnostics_performed ?? [];
  const intv = phase.interventions ?? [];
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="size-3.5 text-slate-400" />
        ) : (
          <ChevronRight className="size-3.5 text-slate-400" />
        )}
        <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
          {phase.phase_number ? `${phase.phase_number}. ` : ''}
          {phase.phase_name ?? phase.phase_code}
        </span>
        <span className="text-[10px] text-slate-500 dark:text-slate-400 ml-2">
          {phase.location}
          {phase.duration &&
            ` · ${phase.duration.value} ${phase.duration.unit?.toLowerCase()}`}
        </span>
        {(proc.length || diag.length || intv.length) > 0 && (
          <span className="ml-auto text-[10px] text-slate-500 dark:text-slate-400">
            {proc.length ? `${proc.length} proc · ` : ''}
            {diag.length ? `${diag.length} dx · ` : ''}
            {intv.length ? `${intv.length} intv` : ''}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-xs">
          {phase.start_datetime && (
            <div className="text-slate-500 dark:text-slate-400">
              {fmtDateTime(phase.start_datetime)}
              {phase.end_datetime && ` → ${fmtDateTime(phase.end_datetime)}`}
            </div>
          )}
          {proc.length > 0 && (
            <div>
              <SubHeading>Procedures</SubHeading>
              <BulletList
                items={proc.map(
                  (p: any) =>
                    `${p.procedure_name}${p.laterality && p.laterality !== 'NA' ? ` (${p.laterality})` : ''}`,
                )}
              />
            </div>
          )}
          {diag.length > 0 && (
            <div>
              <SubHeading>Diagnostics</SubHeading>
              <BulletList
                items={diag.map(
                  (d: any) =>
                    `${d.diagnostic_meta?.test_name_raw ?? d.diagnostic_meta?.test_name_normalized ?? '—'}`,
                )}
              />
            </div>
          )}
          {intv.length > 0 && (
            <div>
              <SubHeading>Interventions</SubHeading>
              <BulletList
                items={intv
                  .slice(0, 6)
                  .map((i: any) => `${i.item ?? '—'}${i.dose ? ` · ${i.dose}` : ''}`)}
              />
              {intv.length > 6 && (
                <div className="text-[10px] text-slate-500 mt-1">
                  +{intv.length - 6} more
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const FinancialBreakdown: React.FC<{
  summary?: HarmonisedEpisode['financial_summary'];
  provenance: Record<string, HarmonisedProvenance>;
}> = ({ summary }) => {
  if (!summary) {
    return <EmptyHint>No financial summary yet.</EmptyHint>;
  }
  const breakdown = summary.breakdown ?? {};
  const rows: Array<{ label: string; value: number | undefined }> = [
    { label: 'Room charges', value: (breakdown as any)?.room_charges?.total_room_charges },
    {
      label: 'Professional fees',
      value: (breakdown as any)?.professional_fees?.total_professional_fees,
    },
    {
      label: 'Investigations',
      value: (breakdown as any)?.investigation_charges?.total_investigation_charges,
    },
    { label: 'Pharmacy', value: (breakdown as any)?.pharmacy_charges?.total_pharmacy_charges },
    { label: 'Procedures', value: (breakdown as any)?.procedure_charges?.total_procedure_charges },
    { label: 'Implants', value: (breakdown as any)?.implant_charges?.total_implant_cost },
    { label: 'Consumables', value: (breakdown as any)?.consumables?.total_consumables },
    { label: 'Other', value: (breakdown as any)?.other_charges?.total_other_charges },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-6">
        <KeyMetric
          label="Estimated total"
          value={summary.estimated_total_cost}
          currency={summary.currency}
        />
        <KeyMetric
          label="Actual total"
          value={summary.actual_total_cost}
          currency={summary.currency}
          emphasis
        />
        <KeyMetric
          label="Claimed"
          value={(summary.insurance_coverage as any)?.claimed_amount}
          currency={summary.currency}
        />
        <KeyMetric
          label="Approved"
          value={(summary.insurance_coverage as any)?.approved_amount}
          currency={summary.currency}
          tone="ok"
        />
      </div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((r) =>
            r.value == null ? null : (
              <tr key={r.label}>
                <td className="py-1.5 text-xs text-slate-600 dark:text-slate-300">
                  {r.label}
                </td>
                <td className="py-1.5 text-right text-sm tabular-nums text-slate-900 dark:text-slate-100">
                  ₹ {Number(r.value).toLocaleString('en-IN')}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
};

const KeyMetric: React.FC<{
  label: string;
  value?: number;
  currency?: string;
  emphasis?: boolean;
  tone?: 'ok' | 'default';
}> = ({ label, value, currency = 'INR', emphasis, tone = 'default' }) => (
  <div>
    <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div
      className={cn(
        'tabular-nums mt-0.5',
        emphasis ? 'text-lg font-semibold' : 'text-sm font-medium',
        tone === 'ok'
          ? 'text-emerald-700 dark:text-emerald-300'
          : 'text-slate-900 dark:text-slate-100',
      )}
    >
      {value == null
        ? '—'
        : `${currency === 'INR' ? '₹' : currency} ${value.toLocaleString('en-IN')}`}
    </div>
  </div>
);

const fmtDateTime = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

export default HarmonisedEpisodePanel;
