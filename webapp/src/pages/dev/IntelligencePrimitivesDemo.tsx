import React, { useState } from 'react';
import {
  ConfidenceBadge,
  CategoryPill,
  CitationLink,
  ReadinessGauge,
  EventRow,
  CitationKind,
} from '@/components/intelligence/primitives';

/**
 * Visual reference page for Intelligence Layer Sprint 0 primitives.
 * Not wired into any route — open by temporarily mounting it during
 * design review.
 */

const Section: React.FC<{ title: string; children: React.ReactNode; note?: string }> = ({
  title,
  children,
  note,
}) => (
  <section className="space-y-3 border-t border-slate-200 dark:border-slate-800 pt-6 first:border-0 first:pt-0">
    <header>
      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
      {note && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">{note}</p>
      )}
    </header>
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      {children}
    </div>
  </section>
);

const SubLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">
    {children}
  </div>
);

const IntelligencePrimitivesDemo: React.FC = () => {
  const [lastOpened, setLastOpened] = useState<string>('');
  const onOpen = (kind: CitationKind, id: string) => setLastOpened(`${kind}:${id}`);

  const now = new Date();
  const min = (m: number) => new Date(now.getTime() - m * 60 * 1000);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        <header>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
            Intelligence Layer · Design Primitives
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Sprint 0 reference page. Variants of each primitive in both light and dark contexts.
          </p>
          {lastOpened && (
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
              Last citation opened: <span className="font-mono">{lastOpened}</span>
            </p>
          )}
        </header>

        {/* ConfidenceBadge */}
        <Section
          title="ConfidenceBadge"
          note="Tone-coloured plain text (chip-removal pattern). Hover for numeric %."
        >
          <div className="space-y-4">
            <div>
              <SubLabel>mode = "auto" (default)</SubLabel>
              <div className="flex flex-wrap items-center gap-4">
                <ConfidenceBadge confidence={0.94} />
                <ConfidenceBadge confidence={0.72} />
                <ConfidenceBadge confidence={0.41} />
              </div>
            </div>
            <div>
              <SubLabel>mode = "pct"</SubLabel>
              <div className="flex flex-wrap items-center gap-4">
                <ConfidenceBadge confidence={0.94} mode="pct" />
                <ConfidenceBadge confidence={0.72} mode="pct" />
                <ConfidenceBadge confidence={0.41} mode="pct" />
              </div>
            </div>
            <div>
              <SubLabel>mode = "bucket"</SubLabel>
              <div className="flex flex-wrap items-center gap-4">
                <ConfidenceBadge confidence={0.94} mode="bucket" />
                <ConfidenceBadge confidence={0.72} mode="bucket" />
                <ConfidenceBadge confidence={0.41} mode="bucket" />
              </div>
            </div>
            <div>
              <SubLabel>mode = "icon"</SubLabel>
              <div className="flex flex-wrap items-center gap-4">
                <ConfidenceBadge confidence={0.94} mode="icon" />
                <ConfidenceBadge confidence={0.72} mode="icon" />
                <ConfidenceBadge confidence={0.41} mode="icon" />
              </div>
            </div>
            <div>
              <SubLabel>size = "md"</SubLabel>
              <div className="flex flex-wrap items-center gap-4">
                <ConfidenceBadge confidence={0.94} size="md" />
                <ConfidenceBadge confidence={0.72} size="md" />
                <ConfidenceBadge confidence={0.41} size="md" />
              </div>
            </div>
            <div>
              <SubLabel>Inline in a sentence</SubLabel>
              <p className="text-sm text-slate-700 dark:text-slate-300">
                Predicted insurer outcome:&nbsp;
                <span className="font-medium">Approved with deduction</span>
                &nbsp;<ConfidenceBadge confidence={0.78} />.
              </p>
            </div>
          </div>
        </Section>

        {/* CategoryPill */}
        <Section
          title="CategoryPill"
          note="Ontology-coloured compact label. Becomes interactive when onClick is set."
        >
          <div className="space-y-4">
            <div>
              <SubLabel>Ontology palette (muted, size sm)</SubLabel>
              <div className="flex flex-wrap items-center gap-2">
                <CategoryPill category="Discharge Summary" ontologyCategory="doc_category" />
                <CategoryPill category="Pre-auth pending" ontologyCategory="stage" />
                <CategoryPill category="Missing investigation" ontologyCategory="deficiency_type" />
                <CategoryPill category="Non-medical expense" ontologyCategory="deduction_reason" />
                <CategoryPill category="Approved partial" ontologyCategory="insurer_outcome" />
                <CategoryPill category="Uncategorised" />
              </div>
            </div>
            <div>
              <SubLabel>Sizes</SubLabel>
              <div className="flex flex-wrap items-center gap-2">
                <CategoryPill category="xs" size="xs" ontologyCategory="doc_category" />
                <CategoryPill category="sm" size="sm" ontologyCategory="doc_category" />
                <CategoryPill category="md" size="md" ontologyCategory="doc_category" />
              </div>
            </div>
            <div>
              <SubLabel>muted = false (full saturation)</SubLabel>
              <div className="flex flex-wrap items-center gap-2">
                <CategoryPill category="Discharge Summary" ontologyCategory="doc_category" muted={false} />
                <CategoryPill category="Pre-auth pending" ontologyCategory="stage" muted={false} />
                <CategoryPill category="Missing investigation" ontologyCategory="deficiency_type" muted={false} />
                <CategoryPill category="Non-medical expense" ontologyCategory="deduction_reason" muted={false} />
                <CategoryPill category="Approved partial" ontologyCategory="insurer_outcome" muted={false} />
              </div>
            </div>
            <div>
              <SubLabel>Interactive (onClick)</SubLabel>
              <div className="flex flex-wrap items-center gap-2">
                <CategoryPill
                  category="Pre-auth pending"
                  ontologyCategory="stage"
                  onClick={() => setLastOpened('stage:pre_auth_pending')}
                />
                <CategoryPill
                  category="Missing investigation"
                  ontologyCategory="deficiency_type"
                  onClick={() => setLastOpened('def:missing_investigation')}
                />
                <CategoryPill
                  category="Approved partial"
                  ontologyCategory="insurer_outcome"
                  onClick={() => setLastOpened('outcome:approved_partial')}
                />
              </div>
            </div>
          </div>
        </Section>

        {/* CitationLink */}
        <Section
          title="CitationLink"
          note="Underlined, icon-prefixed link to evidence. Parent decides what to open."
        >
          <div className="space-y-4">
            <div>
              <SubLabel>Kinds (block size)</SubLabel>
              <div className="flex flex-wrap items-center gap-4">
                <CitationLink kind="rule" id="R-218" label="Rule R-218: Discharge required" onOpen={onOpen} />
                <CitationLink kind="pattern" id="P-44" label="Pattern P-44: Repeat ICU stays" onOpen={onOpen} />
                <CitationLink kind="case" id="C-9001" label="Case C-9001" onOpen={onOpen} />
                <CitationLink kind="event" id="E-2025-05-12" label="Doc uploaded 12 May" onOpen={onOpen} />
              </div>
            </div>
            <div>
              <SubLabel>inline = true (in body copy)</SubLabel>
              <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                We flagged this claim because&nbsp;
                <CitationLink kind="rule" id="R-218" label="R-218" inline onOpen={onOpen} />
                &nbsp;requires the discharge summary, and&nbsp;
                <CitationLink kind="pattern" id="P-44" label="P-44" inline onOpen={onOpen} />
                &nbsp;shows insurer queries for similar admissions. Compare with&nbsp;
                <CitationLink kind="case" id="C-9001" label="C-9001" inline onOpen={onOpen} />.
              </p>
            </div>
            <div>
              <SubLabel>Non-interactive (no onOpen)</SubLabel>
              <div className="flex flex-wrap items-center gap-4">
                <CitationLink kind="rule" id="R-001" label="Rule R-001 (read-only)" />
              </div>
            </div>
          </div>
        </Section>

        {/* ReadinessGauge */}
        <Section
          title="ReadinessGauge"
          note="Circular SVG ring. Same tone buckets as ConfidenceBadge (>=80 / 50–80 / <50)."
        >
          <div className="space-y-6">
            <div>
              <SubLabel>Tones</SubLabel>
              <div className="flex flex-wrap items-end gap-8">
                <ReadinessGauge score={92} />
                <ReadinessGauge score={64} />
                <ReadinessGauge score={28} />
              </div>
            </div>
            <div>
              <SubLabel>Sizes</SubLabel>
              <div className="flex flex-wrap items-end gap-8">
                <ReadinessGauge score={74} size={40} />
                <ReadinessGauge score={74} size={56} />
                <ReadinessGauge score={74} size={72} />
                <ReadinessGauge score={74} size={96} />
              </div>
            </div>
            <div>
              <SubLabel>With subtitle / custom label</SubLabel>
              <div className="flex flex-wrap items-end gap-8">
                <ReadinessGauge score={88} size={72} subtitle="14 of 15 docs" />
                <ReadinessGauge score={55} size={72} label="Awaiting docs" subtitle="8 of 15" />
                <ReadinessGauge score={20} size={72} label="Blocked" subtitle="No discharge" />
              </div>
            </div>
          </div>
        </Section>

        {/* EventRow */}
        <Section
          title="EventRow"
          note="Dense timeline row with left-rail time+icon and right content. Tone drives the left border."
        >
          <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-md border border-slate-200 dark:border-slate-800">
            <EventRow
              when={min(3)}
              actor="System"
              kind="info"
              title="Pre-auth submitted to Care Health"
              description="Cashless Everywhere request emailed with all required attachments."
              tone="info"
              citations={[
                { kind: 'rule', id: 'R-101', label: 'Care Health SOP §2.1' },
              ]}
              onCitationOpen={onOpen}
            />
            <EventRow
              when={min(45)}
              actor="Dr. Iyer"
              kind="document"
              title="Discharge summary uploaded"
              tone="success"
              citations={[
                { kind: 'event', id: 'E-12', label: 'Linked to admission #4521' },
              ]}
              onCitationOpen={onOpen}
            />
            <EventRow
              when={min(120)}
              actor="Care Health"
              kind="deficiency"
              title="Insurer queried — missing investigation report"
              description="Lipid profile and CBC required for cardiac admission."
              tone="warning"
              citations={[
                { kind: 'rule', id: 'R-218', label: 'R-218' },
                { kind: 'pattern', id: 'P-44', label: 'Repeat ICU pattern' },
              ]}
              onCitationOpen={onOpen}
              onClick={() => setLastOpened('event-row:click')}
            />
            <EventRow
              when={min(360)}
              actor="System"
              kind="warning"
              title="Predicted partial deduction"
              description="₹6,200 likely deducted as non-medical (room charges over plan limit)."
              tone="danger"
              citations={[
                { kind: 'case', id: 'C-9001', label: 'C-9001' },
                { kind: 'case', id: 'C-9102', label: 'C-9102' },
              ]}
              onCitationOpen={onOpen}
            >
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Children slot — could host an inline expansion, evidence table, or action buttons.
              </div>
            </EventRow>
            <EventRow
              when={min(60 * 26)}
              kind="approval"
              title="Pre-auth approved"
              tone="success"
            />
            <EventRow
              when={min(60 * 80)}
              kind="note"
              title="Generic event with unknown kind"
              description="Falls back to the Activity icon and default neutral tone."
            />
          </div>
        </Section>
      </div>
    </div>
  );
};

export default IntelligencePrimitivesDemo;
