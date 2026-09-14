/**
 * The single import surface for the vision-first document engine.
 *
 * ocr.service.ts and docExtractor.service.ts import from HERE
 * (`./extractor/index.js`) and nothing else under this directory, so the
 * internal module layout can change without touching either service.
 *
 * NOTE: deterministicExtractors.ts and postValidators.ts keep their existing
 * deep-import paths. They are deliberately NOT re-exported here —
 * docExtractor.service.ts already imports them directly and must not be
 * forced to change those lines.
 */

export * from './visionTypes.js';
export * from './deskew.js';
export * from './imageTiler.js';
export * from './lineItems.js';
export * from './visionRead.js';
