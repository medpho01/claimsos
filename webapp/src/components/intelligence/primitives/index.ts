/**
 * Intelligence Layer — Sprint 0 design primitives.
 *
 * Barrel export. Import primitives from here:
 *   import { ConfidenceBadge, CategoryPill, CitationLink, ReadinessGauge, EventRow }
 *     from '@/components/intelligence/primitives';
 */
export { ConfidenceBadge } from './ConfidenceBadge';
export type { ConfidenceBadgeProps } from './ConfidenceBadge';

export { CategoryPill } from './CategoryPill';
export type { CategoryPillProps, OntologyCategory } from './CategoryPill';

export { CitationLink } from './CitationLink';
export type { CitationLinkProps, CitationKind } from './CitationLink';

export { ReadinessGauge } from './ReadinessGauge';
export type { ReadinessGaugeProps } from './ReadinessGauge';

export { EventRow } from './EventRow';
export type { EventRowProps, EventRowCitation, EventTone } from './EventRow';
