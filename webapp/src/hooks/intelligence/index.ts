/**
 * Sprint W1-C — FE Hooks Foundation.
 *
 * Barrel export for the intelligence-layer hooks. Each hook handles its
 * own caching (module-level Map + react-query) and treats 404 as "endpoint
 * not live yet → return null/[]" so consumers can be wired in parallel
 * with the Wave 1 backend work.
 */

export { useClaimDossier } from './useClaimDossier';
export type {
  ClaimDossier,
  DossierAmount,
  DossierDocSection,
  DossierEventSummary,
  DossierInboundEmail,
  DossierOutboundSubmission,
  DossierActiveQuery,
  DossierPendingAction,
  DossierActiveAdjudication,
  DossierAiDraft,
  DossierKbPatternMatch,
} from './useClaimDossier';

export { useAdjudicationReport } from './useAdjudicationReport';
export type {
  AdjudicationReport,
  AdjudicationBlockingGap,
  AdjudicationWarning,
  AdjudicationPredictedOutcome,
  AdjudicationCitations,
} from './useAdjudicationReport';

export { useAiDrafts } from './useAiDrafts';
export type { AiDraft, AiDraftStatus } from './useAiDrafts';

export { useDocumentSections } from './useDocumentSections';
export type { DocumentSection, DocumentSectionStatus } from './useDocumentSections';

export { useClaimSections } from './useClaimSections';
export type { ClaimSection } from './useClaimSections';

export { useMasterOptions } from './useMasterOptions';
export type { MasterOption } from './useMasterOptions';

export { useActionQueue } from './useActionQueue';
export type { ClaimAction, ClaimActionKind, ClaimActionStatus } from './useActionQueue';

export { useStageRequirements } from './useStageRequirements';
export type { StageRequirement, StageRequirementsScope } from './useStageRequirements';

export { useKbPatterns } from './useKbPatterns';
export type { KbPattern, KbPatternStatus } from './useKbPatterns';

export { useCostMeter } from './useCostMeter';
export type { CostMeterData, CostMeterAlert, CostMeterPeriod } from './useCostMeter';

export { useEvalMetrics } from './useEvalMetrics';
export type {
  EvalMetricsData,
  EvalMetricsPeriod,
  EvalTaskBreakdown,
  EvalWeeklyPoint,
} from './useEvalMetrics';

export { useAiCorrections, useCorrectionStats } from './useAiCorrections';
export type {
  AiCorrectionRow,
  AiCorrectionSurface,
  CorrectionStats,
  CorrectionSurfaceCount,
} from './useAiCorrections';
