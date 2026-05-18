import React, { useState } from 'react';
import {
  DocumentSectionViewer,
  SectionExtractionPanel,
  SectionBoundaryEditor,
} from '@/components/intelligence/DocumentSections';
import type { DocumentSection } from '@/hooks/intelligence/useDocumentSections';

/**
 * Wave 2D dev page — DocumentSectionViewer + SectionExtractionPanel +
 * SectionBoundaryEditor.
 *
 * Not routed. Mount temporarily for visual review.
 */

const mockSections: DocumentSection[] = [
  {
    id: 'sec-1',
    document_id: 'doc-demo',
    page_start: 1,
    page_end: 2,
    category: 'discharge_summary',
    classification_confidence: 0.94,
    status: 'classified',
    extracted_fields: {
      patient_name: 'Suresh Kumar',
      admission_date: '2026-05-12',
      discharge_date: '2026-05-15',
      primary_diagnosis: 'Acute appendicitis',
      total_bill_inr: 87500,
      icu_days: 0,
      surgery_performed: true,
    },
  },
  {
    id: 'sec-2',
    document_id: 'doc-demo',
    page_start: 3,
    page_end: 4,
    category: 'final_bill',
    classification_confidence: 0.78,
    status: 'reviewed',
    reviewed_by: 'kratika@finclarity',
    reviewed_at: new Date(Date.now() - 86400_000).toISOString(),
    extracted_fields: {
      bill_number: 'FB-2026-00891',
      bill_date: '2026-05-15',
      gross_amount: 92340,
      tax_amount: 4840,
      discount_amount: 0,
      net_amount: 87500,
    },
  },
  {
    id: 'sec-3',
    document_id: 'doc-demo',
    page_start: 5,
    page_end: 6,
    category: 'investigation_report',
    classification_confidence: 0.52,
    status: 'pending',
    extracted_fields: {
      report_type: 'CBC',
      reported_on: '2026-05-13',
      abnormalities_noted: 'Mild leukocytosis',
    },
  },
  {
    id: 'sec-4',
    document_id: 'doc-demo',
    page_start: 7,
    page_end: 7,
    category: 'unknown',
    classification_confidence: 0.31,
    status: 'rejected',
    extracted_fields: {},
  },
];

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-5 first:border-0 first:pt-0">
    <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
    <div className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      {children}
    </div>
  </section>
);

const DocumentSectionsDemo: React.FC = () => {
  const [lastSaved, setLastSaved] = useState<string>('');
  const [reclassifyLog, setReclassifyLog] = useState<string>('');

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <header>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">
            Intelligence Layer · Document Sections
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Wave 2D visual reference. Mock sections cover the full status spectrum.
          </p>
          {lastSaved && (
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
              Last save: <span className="font-mono">{lastSaved}</span>
            </p>
          )}
          {reclassifyLog && (
            <p className="text-xs text-slate-600 dark:text-slate-300">{reclassifyLog}</p>
          )}
        </header>

        <Section title="DocumentSectionViewer — full list with expand">
          <DocumentSectionViewer
            documentId="doc-demo"
            sectionsOverride={mockSections}
            onSaveSection={(next) => setLastSaved(`${next.id} @ ${new Date().toLocaleTimeString()}`)}
          />
        </Section>

        <Section title="SectionExtractionPanel — standalone">
          <SectionExtractionPanel
            section={mockSections[0]}
            onSave={(next) =>
              setLastSaved(`${next.id} @ ${new Date().toLocaleTimeString()}`)
            }
          />
        </Section>

        <Section title="SectionBoundaryEditor — standalone">
          <SectionBoundaryEditor
            section={mockSections[2]}
            siblings={mockSections}
            onSplit={(p) => setReclassifyLog(`split sec-3 at page ${p}`)}
            onMerge={(id) => setReclassifyLog(`merge sec-3 into ${id}`)}
            onReclassify={(c) => setReclassifyLog(`reclassify sec-3 → ${c}`)}
          />
        </Section>
      </div>
    </div>
  );
};

export default DocumentSectionsDemo;
