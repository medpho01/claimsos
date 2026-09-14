#!/usr/bin/env tsx
/**
 * Re-validate a REJECTED harmonisation response against the current schema —
 * for ₹0.
 *
 * WHY THIS EXISTS. On 2026-09-14, fixing two schema mismatches on one claim
 * cost three paid runs (~₹81 of that claim's reasoning cap), because a
 * response that failed Zod validation was discarded entirely: `rawResponse`
 * lived only on the thrown error, nothing persisted it, and RecordReplayClient
 * records around a SUCCESSFUL extract. So the only way to test a schema fix
 * was to buy a fresh model response.
 *
 * harmonisation.service.ts now parks every rejected payload in S3. This script
 * reads one back and runs it through the CURRENT schema, so the
 * fix -> validate loop costs nothing and takes a second.
 *
 * Usage:
 *   npm run replay:harmonisation -- llm-rejected/harmonisation/<claim>/<file>.json
 *   npm run replay:harmonisation -- ./local-copy.json
 *
 * Exit codes: 0 = the current schema accepts it, 1 = still rejected (the
 * report tells you exactly which paths and what types arrived).
 */

import * as fs from 'node:fs';
import { ZodError } from 'zod';

import s3Service from '../Services/s3.service.js';
import {
  HarmonisedEpisodeSchema,
  HarmonisedEpisodePartial,
} from '../Services/llm/schemas/harmonisedEpisode.js';

const LOG = '[replay:harmonisation]';

/** The stored envelope written by preserveRejectedResponse(). */
interface Envelope {
  claim_id?: string;
  prompt_version?: string;
  rejected_at?: string;
  validation_error?: string;
  raw_response?: string;
}

/**
 * Pull the JSON object out of the model's text. The model may wrap it in a
 * ```json fence or add prose either side, which is why the production path
 * has its own extractor — mirrored here so replay sees the same bytes the
 * validator saw.
 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function reportZod(label: string, err: ZodError): void {
  console.error(`${LOG} ✗ ${label} REJECTS it — ${err.issues.length} issue(s):`);
  for (const issue of err.issues.slice(0, 20)) {
    const path = issue.path.join('.') || '<root>';
    const extra =
      issue.code === 'invalid_type'
        ? ` (expected ${(issue as any).expected}, received ${(issue as any).received})`
        : '';
    console.error(`${LOG}     ${path}: ${issue.message}${extra}`);
  }
  if (err.issues.length > 20) {
    console.error(`${LOG}     … and ${err.issues.length - 20} more`);
  }
}

async function load(ref: string): Promise<string> {
  if (fs.existsSync(ref)) return fs.readFileSync(ref, 'utf8');
  console.log(`${LOG} fetching s3://${ref}`);
  return (await s3Service.download(ref)).toString('utf8');
}

async function main(): Promise<number> {
  const ref = process.argv[2];
  if (!ref) {
    console.error(`${LOG} usage: npm run replay:harmonisation -- <s3-key|file>`);
    console.error(`${LOG} the key is printed in the failed row's error_message`);
    console.error(`${LOG}   as [raw_response=...], and in the worker log.`);
    return 1;
  }

  let envelope: Envelope;
  try {
    envelope = JSON.parse(await load(ref));
  } catch (err) {
    console.error(`${LOG} could not read ${ref}: ${(err as Error).message}`);
    return 1;
  }

  if (!envelope.raw_response) {
    console.error(`${LOG} no raw_response in the envelope — nothing to replay.`);
    return 1;
  }

  console.log(`${LOG} claim ${envelope.claim_id ?? '<unknown>'}, `
    + `prompt ${envelope.prompt_version ?? '<unknown>'}, `
    + `rejected ${envelope.rejected_at ?? '<unknown>'}`);
  if (envelope.validation_error) {
    console.log(`${LOG} original error: ${envelope.validation_error.split('\n')[0]}`);
  }
  console.log('');

  const parsed = extractJson(envelope.raw_response);
  if (parsed === null) {
    console.error(`${LOG} ✗ no parseable JSON in the stored response — this was `
      + 'never a schema problem; the model returned unusable text.');
    return 1;
  }

  try {
    HarmonisedEpisodeSchema.parse(parsed);
    console.log(`${LOG} ✓ the CURRENT full schema ACCEPTS this response.`);
    console.log(`${LOG}   Re-running the claim will now succeed on this payload.`);
    return 0;
  } catch (err) {
    if (err instanceof ZodError) reportZod('full schema', err);
    else throw err;
  }

  // The service falls back to the partial schema, so report that too: it is
  // the difference between a 'failed' run and a usable 'partial' one.
  try {
    HarmonisedEpisodePartial.parse(parsed);
    console.log('');
    console.log(`${LOG} ~ the PARTIAL schema accepts it — a re-run would persist `
      + "status='partial' rather than failing outright.");
    return 1;
  } catch (err) {
    if (err instanceof ZodError) {
      console.log('');
      reportZod('partial schema', err);
    } else throw err;
  }

  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${LOG} ✗ ${err?.message ?? err}`);
    process.exit(1);
  });
