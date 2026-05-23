import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Wand2,
  FolderOpen,
  Eye,
  Pencil,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  CategoryPill,
  ConfidenceBadge,
} from '@/components/intelligence/primitives';
import {
  useClaimDossier,
  useMasterOptions,
} from '@/hooks/intelligence';
import { useClaimSections } from '@/hooks/intelligence';
import type {
  DossierDocSection,
  ClaimSection,
} from '@/hooks/intelligence';
import { FixCategoryModal } from '../components/FixCategoryModal';
import { DocumentPreviewModal } from '../components/DocumentPreviewModal';
import { EditExtractedFieldModal } from '../components/EditExtractedFieldModal';
import { useDocumentCategoryCorrection } from '@/hooks/intelligence/useDocumentCategoryCorrection';
import { useExtractedFieldCorrection } from '@/hooks/intelligence/useExtractedFieldCorrection';
import { useIntelligenceStatus } from '@/hooks/intelligence/useIntelligenceStatus';

/**
 * Wave 9 — Documents panel for the Claim AI Summary page.
 *
 * Uses the claim dossier's `doc_sections_by_category` map as the authoritative
 * list of sections on this claim and groups them back into per-document rows.
 * The dossier doesn't carry file_name today, so we fall back to a stable
 * document_id prefix. When the backend ships a richer doc list we'll plumb
 * the file_name through without changing the component shape.
 */
export interface DocumentsPanelProps {
  claimId: string;
  /** Override the dossier — used by the dev demo to inject mock data. */
  dossierOverride?: any;
  /** Disable network calls — used by the dev demo. */
  offline?: boolean;
}

interface DocRow {
  documentId: string;
  fileName: string;
  sections: DossierDocSection[];
}

/**
 * A "logical document" row — one or more DocRows whose section category set
 * is identical. Built by `groupDocsByCategorySet()`. The display falls back
 * to the representative DocRow when `files.length === 1` so single-instance
 * docs look exactly as they did before this grouping was introduced.
 */
interface GroupedDocRow {
  /** Stable key for React + expand state. */
  key: string;
  /**
   * The "representative" DocRow used for top-line summary rendering
   * (file name / actions). For groups of size 1, this IS the row.
   */
  representative: DocRow;
  /**
   * All DocRows in this group — same number of categories AND the
   * same sorted category list. Length 1 = no dedupe happened; >1 = N
   * uploaded files merged into one display row, expandable.
   */
  files: DocRow[];
  /** Total section count across all member files. */
  totalSections: number;
  /** Sorted unique category list (shared by all files in the group). */
  categories: string[];
}

/**
 * Group files by their sorted category set. Files with identical category
 * lists collapse into one display row with a "×N" badge so the user sees
 * "implant sticker (×4)" instead of four separate near-identical rows.
 *
 * Why category-set keying:
 *   - Same category list ⇒ same logical document type with very high
 *     likelihood (4 photos of the same implant sticker all classify
 *     to [implant_sticker] only).
 *   - Files with DIFFERENT category sets stay separate even if they
 *     overlap on one category — e.g. an Aadhaar PDF with sections
 *     [health_id, ration_card, aadhaar_back] is its own row, distinct
 *     from a single-page Aadhaar back with [aadhaar_back] only.
 *
 * Files whose category set is empty (no sections classified yet) all
 * group together under the `__uncategorised__` key so they don't each
 * become their own throwaway row.
 */
function groupDocsByCategorySet(docs: DocRow[]): GroupedDocRow[] {
  const buckets = new Map<string, DocRow[]>();
  for (const d of docs) {
    const cats = Array.from(
      new Set(d.sections.map((s) => s.category).filter(Boolean) as string[]),
    ).sort();
    const key = cats.length === 0 ? '__uncategorised__' : cats.join('|');
    const bucket = buckets.get(key) ?? [];
    bucket.push(d);
    buckets.set(key, bucket);
  }
  const groups: GroupedDocRow[] = [];
  for (const [key, files] of Array.from(buckets)) {
    // Representative = first by file name (deterministic ordering so the
    // top-line file shown for a group is stable across re-renders).
    const sorted = [...files].sort((a, b) =>
      a.fileName.localeCompare(b.fileName),
    );
    const rep = sorted[0]!;
    const cats =
      key === '__uncategorised__'
        ? []
        : Array.from(
            new Set(rep.sections.map((s) => s.category).filter(Boolean) as string[]),
          ).sort();
    groups.push({
      key,
      representative: rep,
      files: sorted,
      totalSections: sorted.reduce((acc, f) => acc + f.sections.length, 0),
      categories: cats,
    });
  }
  // Display order: groups with the most files first (highlights the dedupe
  // wins), then alphabetical by representative file name.
  groups.sort((a, b) => {
    if (a.files.length !== b.files.length) return b.files.length - a.files.length;
    return a.representative.fileName.localeCompare(b.representative.fileName);
  });
  return groups;
}

export const DocumentsPanel: React.FC<DocumentsPanelProps> = ({
  claimId,
  dossierOverride,
  offline = false,
}) => {
  const dossier = useClaimDossier(offline ? null : claimId);
  const categoryMaster = useMasterOptions(offline ? null : 'doc_category');
  const correction = useDocumentCategoryCorrection();
  // Pull authoritative counters from the status endpoint — the dossier
  // ships section_ids only, not extracted_fields flags, so client-side
  // summary math is inaccurate. The status endpoint already aggregates
  // these correctly (incl. no_schema sections as terminal).
  const status = useIntelligenceStatus(offline ? null : claimId);
  // Section listing joined to ipd_doc — gives us real document_id +
  // file_name so the preview modal can target the actual source file.
  const claimSections = useClaimSections(offline ? null : claimId);

  const data = dossierOverride ?? dossier.data;

  // ─── Force-refetch sections when the AI run finishes ─────────────────
  // useClaimSections has a long staleTime (5min) so it doesn't refetch
  // automatically while the AI run is in flight. Without this effect, the
  // user has to hit Refresh manually after an AI run to see updated
  // documents. We track is_pending across renders: when it transitions
  // from true → false, that's "AI just completed" — at that moment we
  // invalidate the sections cache so the next render reads fresh data.
  // Also fires when the run cursor exists and is terminal on first load.
  const prevIsPendingRef = useRef<boolean | null>(null);
  useEffect(() => {
    const cur = status.data?.is_pending ?? null;
    const prev = prevIsPendingRef.current;
    prevIsPendingRef.current = cur;
    if (prev === true && cur === false) {
      // Transition: pending → not pending. Workers just finished writing
      // sections; refetch so the table shows the canonical final state
      // without requiring a manual page refresh.
      claimSections.refetch();
    }
  }, [status.data?.is_pending, claimSections]);

  // Count duplicates separately so the header can show "X duplicates
  // identified". Filter the main view to CANONICAL sections only —
  // duplicate sections (section_dedup_of != null) AND sections under
  // duplicate files (doc_dedup_of != null) are hidden from the table.
  // The user explicitly asked for "only unique documents in the AI
  // Summary > Documents tab" — this is the implementation of that.
  const duplicateCount = useMemo(() => {
    if (!claimSections.data) return { sections: 0, files: 0 };
    const dupFileIds = new Set<string>();
    let dupSections = 0;
    for (const s of claimSections.data as ClaimSection[]) {
      if (s.section_dedup_of) dupSections++;
      if (s.doc_dedup_of && s.document_id) dupFileIds.add(s.document_id);
    }
    return { sections: dupSections, files: dupFileIds.size };
  }, [claimSections.data]);

  const docs: DocRow[] = useMemo(() => {
    // Preferred path: use the section listing endpoint which carries the
    // real ipd_doc.id and file_name. Sections that haven't been classified
    // yet have category=null — bucket those under "uncategorised" so the
    // row still shows up and the user can preview the source.
    if (claimSections.data.length > 0) {
      const byDoc: Record<string, DocRow> = {};
      claimSections.data.forEach((s: ClaimSection) => {
        // CANONICAL-ONLY FILTER (Wave 12 user requirement):
        //   - Skip sections that point at a canonical (section_dedup_of)
        //   - Skip sections under files marked as whole-file duplicates
        //     (doc_dedup_of)
        // Both are surfaced in the "duplicates identified" header so the
        // user knows they exist but they don't clutter the main table.
        if (s.section_dedup_of) return;
        if (s.doc_dedup_of) return;

        const docKey = s.document_id ?? 'unknown';
        if (!byDoc[docKey]) {
          byDoc[docKey] = {
            documentId: docKey,
            fileName:
              s.file_name ??
              `doc_${String(docKey).slice(0, 8)}${guessExtFromMime(s.mime_type)}`,
            sections: [],
          };
        }
        byDoc[docKey].sections.push({
          id: s.id,
          document_id: docKey,
          category: s.category ?? 'uncategorised',
          classification_confidence: s.classification_confidence,
          page_start: s.page_start ?? 1,
          page_end: s.page_end ?? s.page_start ?? 1,
          status: (s.status as any) ?? 'auto',
          // Surface the full extracted_fields JSON the controller now
          // ships inline — feeds the per-section "View JSON" expand. The
          // separate /documents/:id/sections endpoint that SectionRow
          // used to hit was never built; threading it through the
          // claim-sections listing avoids the broken second roundtrip.
          extracted_fields: s.extracted_fields ?? null,
          // extractor_model tells the UI WHY extracted_fields might be
          // empty: 'no_schema' = ontology gap (action: define a schema),
          // 'standard' + {} = LLM ran but couldn't read (action: review
          // source). Carried through as a free-form string on the
          // section object (DossierDocSection is open via `[k: string]: any`).
          extractor_model: s.extractor_model ?? null,
          // extraction_confidence may carry a reserved _validation_errors
          // sub-object with reasons like 'verhoeff_failed' for fields that
          // failed deterministic invariants (Aadhaar checksum, PIN format).
          // The SectionRow surfaces these per-field so reviewers know
          // exactly which OCR'd digits to verify against the source.
          extraction_confidence: s.extraction_confidence ?? null,
        } as any);
      });
      return Object.values(byDoc).map((d) => ({
        ...d,
        sections: [...d.sections].sort(
          (a, b) => (a.page_start ?? 0) - (b.page_start ?? 0),
        ),
      }));
    }

    // No fallback. The dossier's `doc_sections_by_category` was the
    // legacy data source from pre-Wave-9 when the sections endpoint
    // didn't exist yet. We kept it as a safety net — but it had a
    // toxic side-effect:
    //
    //   - The dossier projector fires from event-sourced state and
    //     refreshes FAST when the AI run completes.
    //   - useClaimSections has staleTime=5min and won't auto-refetch
    //     until invalidated.
    //
    // So in the few seconds right after Run AI completes, dossier had
    // section_ids but claimSections was still cached empty → fallback
    // fired → fabricated rows like "doc_07c9c5c4.pdf" (synthesized
    // from section_id slice) appeared in the Documents tab. Refresh
    // forced both queries to re-fetch, fallback didn't fire, real
    // rows replaced the fake ones — hence the user-visible "data
    // changes after refresh" bug (reported May 20, 2026 on Mohd
    // Aslam's claim).
    //
    // Fix: the sections endpoint is now the SOLE source of truth. When
    // it's empty, render the empty state — don't fabricate names from
    // section_ids. An invalidation effect below (see useEffect on
    // status.data?.is_pending) forces a refetch the moment the AI run
    // completes, so the empty window is sub-second.
    return [];
  }, [claimSections.data]);

  // Collapse uploaded files with identical category lists into one row.
  // Vahid's claim is the canonical example: 19 file rows → ~13 grouped
  // rows after merging 4 implant-sticker photos, 5 patient-photo-GPS,
  // 2 implant-bills, 2 pharmacy-bills, etc. Reviewers think of "an
  // implant sticker" as one logical document, not four.
  const groupedDocs: GroupedDocRow[] = useMemo(
    () => groupDocsByCategorySet(docs),
    [docs],
  );

  const summary = useMemo(() => {
    // docCount is now the count of LOGICAL document groups (post-dedupe),
    // matching the table reality. The underlying file count is shown in
    // a sub-stat below so the user still sees the raw upload total.
    const docCount = groupedDocs.length;
    const fileCount = docs.length;
    // Prefer the status endpoint's authoritative numbers (it counts
    // extractor_model='no_schema' rows as terminal). Fall back to
    // client-side math when the endpoint hasn't responded yet.
    const sd = status.data;
    if (sd) {
      return {
        docCount,
        fileCount,
        sectionCount: sd.sections.total,
        categorised: sd.sections.classified,
        extracted: sd.sections.extracted,
      };
    }
    const sectionCount = docs.reduce((acc, d) => acc + d.sections.length, 0);
    const categorised = docs.reduce(
      (acc, d) =>
        acc + d.sections.filter((s) => s.status !== 'pending' && !!s.category).length,
      0,
    );
    const extracted = docs.reduce(
      (acc, d) => acc + d.sections.filter((s) => s.status === 'reviewed').length,
      0,
    );
    return { docCount, fileCount, sectionCount, categorised, extracted };
  }, [docs, groupedDocs.length, status.data]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [fixTarget, setFixTarget] = useState<{
    sectionId: string;
    currentCategory: string;
    documentName: string;
  } | null>(null);

  const [previewTarget, setPreviewTarget] = useState<{
    documentId: string;
    fileName: string;
    pageHint?: string;
    category?: string;
  } | null>(null);

  const categoryLabel = (code: string): string => {
    const found = categoryMaster.data.find((o) => o.code === code);
    return found?.label ?? code;
  };

  const onFixSave = async (newCategory: string, reason: string) => {
    if (!fixTarget) return;
    await correction.mutateAsync({
      sectionId: fixTarget.sectionId,
      new_category: newCategory,
      reason,
    });
  };

  // Loading state: covers both the dossier query (legacy callers) and the
  // sections query (the authoritative source now). Either one in flight
  // means we don't yet know the truth — show a skeleton instead of an
  // empty state that the user might misread as "no documents".
  if (!offline && (dossier.loading || claimSections.loading)) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading documents…
      </div>
    );
  }

  // "AI run is actively processing" — distinct empty state. Tells the
  // user the table is intentionally empty *right now* and will populate
  // shortly. Without this branch, the generic "No documents uploaded
  // yet" would render while the run is mid-flight, which is misleading.
  if (!docs.length && status.data?.is_pending) {
    return (
      <div className="rounded-lg border border-brand-200 dark:border-brand-800 bg-brand-50/40 dark:bg-brand-900/20 p-10 text-center space-y-3">
        <div className="mx-auto size-10 rounded-full bg-brand-100 dark:bg-brand-800/40 flex items-center justify-center">
          <Wand2 className="size-5 text-brand-600 dark:text-brand-300" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            AI analysis in progress…
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Documents will appear here once classification + extraction
            complete. This usually takes 1-3 minutes per document.
          </p>
        </div>
      </div>
    );
  }

  if (!docs.length) {
    return (
      <div className="rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-10 text-center space-y-3">
        <div className="mx-auto size-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
          <FolderOpen className="size-5 text-slate-500 dark:text-slate-400" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            No documents uploaded yet
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Upload IPD documents to kick off the OCR + classifier pipeline.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary strip.
        * "Documents" = post-dedupe count of LOGICAL document groups
        * (after collapsing files with identical category sets). When
        * dedupe actually merged anything, also show the raw file
        * count so reviewers can see how much was collapsed — e.g.
        * "13 (from 19 files)" lets them tell at a glance that 6
        * near-duplicates were folded together.
        */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex items-center gap-5 text-sm">
        <Stat
          label="Documents"
          value={summary.docCount}
          hint={
            summary.fileCount > summary.docCount
              ? `from ${summary.fileCount} files`
              : undefined
          }
        />
        <Divider />
        <Stat label="Sections" value={summary.sectionCount} />
        <Divider />
        <Stat label="Categorised" value={summary.categorised} tone="ok" />
        <Divider />
        <Stat label="Extracted" value={summary.extracted} tone="ok" />
        {(duplicateCount.sections > 0 || duplicateCount.files > 0) && (
          <>
            <Divider />
            <Stat
              label="Duplicates identified"
              value={duplicateCount.sections + duplicateCount.files}
              tone="default"
              hint={
                duplicateCount.files > 0
                  ? `${duplicateCount.files} file${duplicateCount.files === 1 ? '' : 's'}, ${duplicateCount.sections} section${duplicateCount.sections === 1 ? '' : 's'} — hidden`
                  : `${duplicateCount.sections} section${duplicateCount.sections === 1 ? '' : 's'} hidden`
              }
            />
          </>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/40 text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <tr>
              <th className="text-left px-4 py-2 w-6"></th>
              <th className="text-left px-4 py-2">File</th>
              <th className="text-left px-4 py-2">Sections</th>
              <th className="text-left px-4 py-2">Categories</th>
              <th className="text-left px-4 py-2">Confidence</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {groupedDocs.map((g) => {
              // For single-file groups the row behaves exactly as before:
              // expand reveals the per-section list. For multi-file
              // groups expand reveals each member file with its own
              // per-section list rendered inline (two-level visual
              // nesting but only one expansion level to click).
              const d = g.representative;
              const isMerged = g.files.length > 1;
              const open = expanded.has(g.key);
              // For merged groups the row's "sections" badge sums across
              // every member file so the count matches the table reality.
              const visibleSections = isMerged
                ? g.totalSections
                : d.sections.length;
              // Only average over sections that actually have a confidence
              // score — placeholder rows synthesised from bare section_ids
              // carry classification_confidence: null and would drag the
              // mean toward 0 (rendering as "Low" → false failure signal).
              //
              // IMPORTANT: pg returns NUMERIC columns as strings (preserves
              // precision), so the raw confidence values arrive as e.g.
              // "0.95" not 0.95. A naive `typeof === 'number'` filter
              // therefore rejected ALL real values and the column rendered
              // as "—" on every row. Coerce + validate explicitly.
              // Confidence aggregates across EVERY section in EVERY
              // member file of the group — so a "×4" implant sticker
              // group's badge reflects the mean across all 4 files,
              // not just the representative.
              const allSections = g.files.flatMap((f) => f.sections);
              const scored = allSections
                .map((s) => {
                  const n =
                    typeof s.classification_confidence === 'number'
                      ? s.classification_confidence
                      : s.classification_confidence == null
                        ? NaN
                        : Number(s.classification_confidence);
                  return Number.isFinite(n) ? n : null;
                })
                .filter((n): n is number => n !== null && n > 0);
              const avgConf: number | null = scored.length
                ? scored.reduce((acc, n) => acc + n, 0) / scored.length
                : null;
              const uniqueCategories = g.categories.length > 0
                ? g.categories
                : Array.from(
                    new Set(d.sections.map((s) => s.category).filter(Boolean)),
                  );
              return (
                <React.Fragment key={g.key}>
                  <tr
                    className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30 cursor-pointer"
                    onClick={() => toggleRow(g.key)}
                  >
                    <td className="px-4 py-3 text-slate-400">
                      {open ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </td>
                    <td className="px-4 py-3 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="size-4 shrink-0 text-slate-500" />
                        <span className="truncate text-slate-900 dark:text-slate-100">
                          {d.fileName}
                        </span>
                        {isMerged && (
                          <span
                            className="shrink-0 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:text-slate-300"
                            title={`${g.files.length} files share this category set — expand to see each file`}
                          >
                            ×{g.files.length}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-200 tabular-nums">
                      {visibleSections}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {uniqueCategories.slice(0, 3).map((c) => (
                          <CategoryPill
                            key={c}
                            category={categoryLabel(c)}
                            ontologyCategory="doc_category"
                            size="xs"
                          />
                        ))}
                        {uniqueCategories.length > 3 && (
                          <span className="text-[10px] text-slate-500">
                            +{uniqueCategories.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <ConfidenceBadge confidence={avgConf} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-xs"
                          title={
                            isMerged
                              ? `Preview the representative file. Expand the row to preview the other ${g.files.length - 1} file${g.files.length - 1 === 1 ? '' : 's'} individually.`
                              : undefined
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            // For merged groups, preview the representative
                            // file only — opening N modals at once is hostile.
                            // Users who need a specific file in the group
                            // can expand the row and hit Preview on that
                            // file's section list.
                            setPreviewTarget({
                              documentId: d.documentId,
                              fileName: d.fileName,
                              category: uniqueCategories[0]
                                ? categoryLabel(uniqueCategories[0])
                                : undefined,
                            });
                          }}
                        >
                          <Eye className="size-3.5" />
                          View
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Decision tree:
                            //   - merged group (×N) → always expand so
                            //     the user can pick WHICH file's section
                            //     to fix (different files may share a
                            //     category set but the wrong-classification
                            //     usually lives in one specific file).
                            //   - single-file, single-section → fix
                            //     directly (no disclosure needed).
                            //   - single-file, multi-section → expand
                            //     so the user picks WHICH section. Picking
                            //     sections[0] silently was the source of
                            //     "I corrected it but the other category
                            //     is still showing" — that first section
                            //     was already correct, a *different*
                            //     section in the same doc held the wrong
                            //     category.
                            if (!isMerged && d.sections.length === 1) {
                              const only = d.sections[0]!;
                              setFixTarget({
                                sectionId: only.id,
                                currentCategory: only.category,
                                documentName: d.fileName,
                              });
                            } else {
                              setExpanded((cur) => {
                                const next = new Set(cur);
                                next.add(g.key);
                                return next;
                              });
                            }
                          }}
                          title={
                            isMerged
                              ? `${g.files.length} files × ${g.totalSections} sections — expand to pick which to re-classify`
                              : d.sections.length === 1
                                ? 'Re-classify this document'
                                : `${d.sections.length} sections — expand to pick which one to re-classify`
                          }
                        >
                          <Wand2 className="size-3.5" />
                          Fix category
                          {visibleSections > 1 && (
                            <span className="ml-1 text-[10px] text-slate-400">
                              ({visibleSections})
                            </span>
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-slate-50/40 dark:bg-slate-950/40">
                      <td />
                      <td colSpan={5} className="px-4 py-3 space-y-3">
                        {/* Single-file groups render the existing per-section
                          * list directly. Merged groups (×N) render one
                          * SectionsList PER member file, with a thin file-
                          * name header so the user can target a specific
                          * file's section when fixing categories or
                          * previewing the original. */}
                        {g.files.map((f, idx) => (
                          <div key={f.documentId} className="space-y-2">
                            {isMerged && (
                              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                                <FileText className="size-3.5 shrink-0" />
                                <span className="truncate font-medium text-slate-700 dark:text-slate-300">
                                  {f.fileName}
                                </span>
                                <span className="text-[10px] text-slate-400">
                                  ({f.sections.length} section
                                  {f.sections.length === 1 ? '' : 's'})
                                </span>
                                {idx === 0 && (
                                  <span
                                    className="text-[10px] rounded bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5"
                                    title="The file shown on the collapsed row"
                                  >
                                    representative
                                  </span>
                                )}
                              </div>
                            )}
                            <SectionsList
                              sections={f.sections}
                              categoryLabel={categoryLabel}
                              documentName={f.fileName}
                              onFix={(s) =>
                                setFixTarget({
                                  sectionId: s.id,
                                  currentCategory: s.category,
                                  documentName: f.fileName,
                                })
                              }
                              onPreview={(s) =>
                                setPreviewTarget({
                                  documentId: f.documentId,
                                  fileName: f.fileName,
                                  pageHint:
                                    s.page_start === s.page_end
                                      ? String(s.page_start)
                                      : `${s.page_start}–${s.page_end}`,
                                  category: categoryLabel(s.category),
                                })
                              }
                              offline={offline}
                            />
                          </div>
                        ))}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <FixCategoryModal
        open={!!fixTarget}
        sectionId={fixTarget?.sectionId ?? ''}
        currentCategory={fixTarget?.currentCategory}
        documentName={fixTarget?.documentName}
        onClose={() => setFixTarget(null)}
        onSave={onFixSave}
        saving={correction.isPending}
      />

      <DocumentPreviewModal
        open={!!previewTarget}
        documentId={previewTarget?.documentId ?? null}
        fileName={previewTarget?.fileName}
        pageHint={previewTarget?.pageHint}
        category={previewTarget?.category}
        onClose={() => setPreviewTarget(null)}
      />
    </div>
  );
};

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Map machine reason codes from the post-extraction validators to
 * human-readable phrases. The codes are stable contract from
 * `Backend/Services/extractedFieldValidators.ts`; we deliberately don't
 * surface them raw because "verhoeff_failed" is meaningless to a non-
 * engineer reviewer.
 */
const humaniseValidationReason = (reason: string): string => {
  switch (reason) {
    case 'verhoeff_failed':
      return 'checksum mismatch — likely an OCR digit error (9↔0, 6↔0 are common). Compare against the source image.';
    case 'wrong_length_or_chars':
      return 'wrong length or contains non-digit characters.';
    case 'wrong_length':
      return 'wrong length for this field.';
    case 'reserved_leading_digit':
      return 'starts with 0 or 1 (UIDAI reserves those — likely an OCR error).';
    case 'invalid_pin_zone':
      return 'first digit is 0 or 9 (India Post reserves those — likely an OCR error).';
    case 'not_string':
      return 'value isn’t a string.';
    default:
      return reason.replace(/_/g, ' ');
  }
};

const guessExtFromMime = (mime: string | null | undefined): string => {
  if (!mime) return '.pdf';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('tiff')) return '.tiff';
  if (mime.includes('webp')) return '.webp';
  return '';
};

const Stat: React.FC<{
  label: string;
  value: number;
  tone?: 'ok' | 'default';
  /** Small secondary line under the value, e.g. "from 19 files". */
  hint?: string;
}> = ({ label, value, tone = 'default', hint }) => (
  <div>
    <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
      {label}
    </div>
    <div
      className={cn(
        'text-lg font-semibold tabular-nums leading-tight',
        tone === 'ok'
          ? 'text-emerald-700 dark:text-emerald-300'
          : 'text-slate-900 dark:text-slate-100',
      )}
    >
      {value}
    </div>
    {hint && (
      <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
        {hint}
      </div>
    )}
  </div>
);

const Divider: React.FC = () => (
  <div className="h-8 w-px bg-slate-200 dark:bg-slate-700" />
);

interface SectionsListProps {
  sections: DossierDocSection[];
  categoryLabel: (c: string) => string;
  documentName: string;
  onFix: (s: DossierDocSection) => void;
  onPreview: (s: DossierDocSection) => void;
  offline: boolean;
}

const SectionsList: React.FC<SectionsListProps> = ({
  sections,
  categoryLabel,
  onFix,
  onPreview,
  offline,
}) => {
  return (
    <div className="space-y-2">
      {sections.map((s) => (
        <SectionRow
          key={s.id}
          section={s}
          categoryLabel={categoryLabel}
          onFix={() => onFix(s)}
          onPreview={() => onPreview(s)}
          offline={offline}
        />
      ))}
    </div>
  );
};

const SectionRow: React.FC<{
  section: DossierDocSection;
  categoryLabel: (c: string) => string;
  onFix: () => void;
  onPreview: () => void;
  offline: boolean;
}> = ({ section, categoryLabel, onFix, onPreview, offline }) => {
  const [open, setOpen] = useState(false);
  // The extracted_fields JSON is shipped inline with the claim-sections
  // listing now (intelligenceStatus.controller#getSections), so it's
  // already on the section object passed in. No second roundtrip.
  // We previously called useDocumentSections(documentId), but the
  // /documents/:id/sections endpoint it targets was never built —
  // it 404'd silently, the hook returned [], full=undefined, and the
  // pre block fell through to "No extracted fields yet." even for
  // sections that had real (or {}) extracted payloads.
  const extracted: Record<string, any> | null =
    (section as any).extracted_fields ?? null;
  const extractorModel: string | null =
    (section as any).extractor_model ?? null;
  const extractionConfidence: Record<string, any> | null =
    (section as any).extraction_confidence ?? null;
  // Pull out the reserved _validation_errors sub-object — keyed by
  // field_key, value is a short reason code ('verhoeff_failed' etc.).
  // Mapped to human-friendly text below.
  const validationErrors: Record<string, string> =
    (extractionConfidence?._validation_errors as Record<string, string>) ?? {};
  const hasValidationErrors = Object.keys(validationErrors).length > 0;
  // Three distinct empty-state cases — all show extracted_fields={} in
  // the DB but mean very different things to the reviewer:
  //
  //   1. noSchema (extractor_model='no_schema')
  //        The ontology has no field_schema for this category.
  //        Action: superadmin should add a schema in Master Options.
  //
  //   2. extractorTriedButEmpty (extractor_model='standard' AND fields={})
  //        The LLM ran but couldn't read anything from the OCR text —
  //        usually a rotated scan, low-quality image, or a document that
  //        genuinely doesn't carry the requested fields.
  //        Action: reviewer should check the source image and manually
  //        enter the values if needed.
  //
  //   3. pending (extractor_model=null AND fields=null)
  //        The extractor hasn't run yet.
  const isEmpty =
    extracted !== null &&
    typeof extracted === 'object' &&
    Object.keys(extracted).length === 0;
  const noSchema = isEmpty && extractorModel === 'no_schema';
  const extractorTriedButEmpty =
    isEmpty && extractorModel !== null && extractorModel !== 'no_schema';
  void offline; // formerly used to gate the network call we just removed

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-slate-500 dark:text-slate-400 tabular-nums w-14 shrink-0">
          p.{section.page_start}
          {section.page_end !== section.page_start && `–${section.page_end}`}
        </span>
        <CategoryPill
          category={categoryLabel(section.category)}
          ontologyCategory="doc_category"
          size="xs"
        />
        <ConfidenceBadge confidence={section.classification_confidence} mode="auto" />
        <span className="text-slate-500 dark:text-slate-400 ml-2">{section.status}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] gap-1"
            onClick={onPreview}
          >
            <Eye className="size-3" />
            Source
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Hide JSON' : 'View JSON'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] gap-1"
            onClick={onFix}
          >
            <Wand2 className="size-3" />
            Fix
          </Button>
        </div>
      </div>
      {open && (
        <div className="mt-2">
          {noSchema && (
            <div className="text-[10px] text-slate-500 dark:text-slate-400 mb-1 italic">
              No field schema defined for category{' '}
              <code className="font-mono">{section.category}</code> —
              extraction was skipped by design. Add a schema in Master
              Options to enable structured pulls for this category.
            </div>
          )}
          {extractorTriedButEmpty && (
            <div className="text-[10px] text-amber-700 dark:text-amber-300 mb-1 italic">
              Extractor ran but couldn&apos;t pull any fields. Common
              causes: rotated scan, low OCR quality, or a document
              that doesn&apos;t carry the schema&apos;s expected fields.
              Click <em>Source</em> to inspect the image; use{' '}
              <em>Fix category</em> if the classification was wrong.
            </div>
          )}
          {hasValidationErrors && (
            <div className="text-[10px] text-amber-700 dark:text-amber-300 mb-1 px-2 py-1.5 rounded bg-amber-50/60 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/60">
              <div className="font-medium not-italic mb-0.5">
                Verify the following — fields failed automatic validation:
              </div>
              <ul className="list-disc pl-4">
                {Object.entries(validationErrors).map(([key, reason]) => (
                  <li key={key}>
                    <code className="font-mono">{key}</code>:{' '}
                    {humaniseValidationReason(reason)}
                    {extracted?.[key] !== undefined && (
                      <>
                        {' '}— captured as{' '}
                        <code className="font-mono">
                          {String(extracted[key])}
                        </code>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Editable extracted-field list. Replaces the previous plain
              <pre> dump — each entry can now be clicked to override
              the LLM's value (via /document-sections/:id/fields/:key).
              Corrected values get a green ring + "(corrected)" tag and
              survive future re-extractions. */}
          {extracted && Object.keys(extracted).length > 0 ? (
            <ExtractedFieldList
              sectionId={section.id}
              category={section.category}
              fields={extracted}
              perFieldConfidence={extractionConfidence ?? {}}
              correctedFields={
                Array.isArray(extractionConfidence?._corrected_fields)
                  ? (extractionConfidence!._corrected_fields as string[])
                  : []
              }
            />
          ) : (
            <pre
              className={cn(
                'max-h-64 overflow-auto rounded bg-slate-50 dark:bg-slate-950',
                'border border-slate-200 dark:border-slate-800 p-2 text-[11px] font-mono',
                'text-slate-700 dark:text-slate-200 whitespace-pre-wrap',
              )}
            >
              {extracted
                ? JSON.stringify(extracted, null, 2)
                : 'Extraction hasn’t run for this section yet.'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Per-field editable list ──────────────────────────────────────────────

interface ExtractedFieldListProps {
  sectionId: string;
  category: string;
  fields: Record<string, any>;
  perFieldConfidence: Record<string, any>;
  correctedFields: string[];
}

/**
 * Two-column key/value table over `extracted_fields`. Each row has a
 * pencil icon — clicking opens the EditExtractedFieldModal for that
 * single field. The list is read off the same `extracted_fields` blob
 * that's already loaded by useClaimSections; correction invalidates
 * the query and the row re-renders with the new value.
 */
const ExtractedFieldList: React.FC<ExtractedFieldListProps> = ({
  sectionId,
  category,
  fields,
  perFieldConfidence,
  correctedFields,
}) => {
  const correction = useExtractedFieldCorrection();
  const [editTarget, setEditTarget] = React.useState<{
    fieldKey: string;
    currentValue: unknown;
  } | null>(null);

  // Filter out reserved keys from the confidence map when looking up
  // per-field numbers (e.g. don't render _validation_errors as a field).
  const validationErrors =
    (perFieldConfidence?._validation_errors as Record<string, string>) ?? {};

  const entries = Object.entries(fields);

  const onSave = async (newValue: unknown, reason: string) => {
    if (!editTarget) return;
    await correction.mutateAsync({
      sectionId,
      fieldKey: editTarget.fieldKey,
      new_value: newValue,
      reason,
    });
  };

  return (
    <>
      <div className="rounded border border-slate-200 dark:border-slate-800 overflow-hidden">
        <table className="w-full text-[11px]">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {entries.map(([k, v]) => {
              const isCorrected = correctedFields.includes(k);
              const conf =
                typeof perFieldConfidence?.[k] === 'number'
                  ? perFieldConfidence[k]
                  : null;
              const validationErr = validationErrors[k];
              return (
                <tr key={k} className="hover:bg-slate-50/60 dark:hover:bg-slate-900/60">
                  <td className="px-2 py-1.5 align-top w-1/3 font-mono text-slate-600 dark:text-slate-300">
                    {k}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <div
                      className={cn(
                        'font-mono text-slate-800 dark:text-slate-200 break-words whitespace-pre-wrap',
                        isCorrected && 'ring-1 ring-emerald-300 dark:ring-emerald-700 rounded px-1 -mx-1',
                      )}
                    >
                      {v === null || v === undefined
                        ? <span className="italic text-slate-400">empty</span>
                        : typeof v === 'object'
                          ? JSON.stringify(v)
                          : String(v)}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-400">
                      {conf != null && (
                        <span>
                          conf {Math.round(conf * 100)}%
                        </span>
                      )}
                      {validationErr && (
                        <span className="text-amber-600 dark:text-amber-400">
                          {validationErr}
                        </span>
                      )}
                      {isCorrected && (
                        <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                          corrected
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 align-top text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setEditTarget({ fieldKey: k, currentValue: v })}
                      className="inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
                      title="Override this field"
                    >
                      <Pencil className="size-3" />
                      Edit
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <EditExtractedFieldModal
        open={!!editTarget}
        sectionId={sectionId}
        fieldKey={editTarget?.fieldKey ?? ''}
        currentValue={editTarget?.currentValue}
        category={category}
        onClose={() => setEditTarget(null)}
        onSave={onSave}
        saving={correction.isPending}
      />
    </>
  );
};

export default DocumentsPanel;
