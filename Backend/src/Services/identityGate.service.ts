/**
 * Identity Gate (iter7 Stage 1) — upload-time patient-identity check.
 *
 * Problem: iter7 found that hospitals routinely upload multi-page PDFs
 * containing pages that belong to a DIFFERENT patient (Vahadur case:
 * "Mrs. Begum Faiz" consent form on pages 6-7 of an otherwise-Vahadur
 * 11-page bundle). The harmoniser catches some of this downstream
 * via the identity_gate + Fix 17 + Fix 22, but a lot of damage is
 * already done by the time we get there (extractor pulls wrong facts,
 * harmoniser blends them in, episode goes wrong).
 *
 * This service runs ONCE per uploaded file at upload time:
 *   1. Render first page to image (PDFs only — image uploads use the
 *      image itself)
 *   2. Single vision-LLM call: "extract patient name, DOB, UHID from
 *      this page"
 *   3. Fuzzy-compare against the ipds row's first_name + last_name
 *      (re-uses tokensOverlap from Fix 17)
 *
 * Output:
 *   { status: 'match' | 'mismatch' | 'inconclusive', observed, ... }
 *
 * The caller decides what to do on mismatch — for the initial
 * deployment we stash the warning on `ipd_doc.doc_metadata` and surface
 * it to the user as a non-blocking yellow banner. Hard rejection comes
 * after we've validated the false-positive rate in production.
 *
 * Cost note: each upload = 1 small Haiku call (~$0.002 / upload).
 * At 100 uploads/day per hospital × 50 hospitals = ~5k calls/day,
 * ~$10/day. Feature-flagged via env IDENTITY_GATE_ENABLED so we
 * can throttle.
 */
import * as fs from 'fs';
import { z } from 'zod';
import { getLlmClient } from './llm/factory.js';
import { tokensOverlap, normalisePatientName } from './harmonisation.service.js';
import { logger } from '../Utils/logger.js';

export type IdentityCheckStatus = 'match' | 'mismatch' | 'inconclusive' | 'skipped';

export interface IdentityCheckResult {
  status: IdentityCheckStatus;
  observed: {
    patient_name: string | null;
    dob: string | null;
    uhid: string | null;
    hospital_name: string | null;
  };
  expected: {
    first_name: string | null;
    last_name: string | null;
  };
  confidence: number | null;
  reasons: string[];
  cost_inr: number;
}

const IdentitySchema = z.object({
  patient_name: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  uhid: z.string().nullable(),
  hospital_name: z.string().nullable(),
  page_appears_blank_or_unreadable: z.boolean().optional(),
});

const SYSTEM_PROMPT = `You are a quality-control assistant for a medical-claims processing system.

Your job: look at a SINGLE PAGE from a medical document and pull out four pieces of identity metadata, NOTHING ELSE.

Output strict JSON with these fields:
  - patient_name: the patient's name as written on the page (verbatim, including honorifics if shown). null if not visible.
  - date_of_birth: DOB if visible, any format. null otherwise.
  - uhid: the hospital's UHID / MRN / patient registration number. null if not visible.
  - hospital_name: the hospital's name from the letterhead. null if no letterhead visible.
  - page_appears_blank_or_unreadable: true ONLY if the page is genuinely blank or so degraded you cannot read any text. false otherwise.

Rules:
  - Do NOT guess. If a field isn't visible, emit null.
  - Do NOT infer (don't deduce a hospital from a doctor's name).
  - The page might be a consent form, lab report, OT note, photo with watermark, identity card, etc. — handle all of them.
  - For consent forms signed BY a family member ON BEHALF of the patient, emit the PATIENT'S name in patient_name (not the signer).
  - For identity cards (Aadhaar, PMJAY card, ration card): emit the cardholder's name in patient_name; this may be a family member's card.
  - If multiple names appear on the page, emit the one that looks like the document's SUBJECT (largest, in a "Patient:" field, at the top).`;

const USER_PROMPT = `Extract the four identity fields from this page. Return JSON only, no prose.`;

/**
 * Run the identity check against an uploaded file.
 *
 *   file: { path, mime } — usually multer's destination + mimetype
 *   ipds: { id, first_name, last_name } — from the ipds row
 *
 * Returns 'skipped' when IDENTITY_GATE_ENABLED is off, or when the
 * file's mime isn't supported (we only handle images + PDFs).
 */
export async function checkIdentity(opts: {
  file: { path: string; mime: string };
  ipds: { id: string; first_name: string | null; last_name: string | null; hospital_id?: string | null };
}): Promise<IdentityCheckResult> {
  const expected = {
    first_name: opts.ipds.first_name,
    last_name: opts.ipds.last_name,
  };
  const empty: IdentityCheckResult = {
    status: 'skipped',
    observed: { patient_name: null, dob: null, uhid: null, hospital_name: null },
    expected,
    confidence: null,
    reasons: [],
    cost_inr: 0,
  };

  if (process.env.IDENTITY_GATE_ENABLED === 'false') {
    return { ...empty, reasons: ['IDENTITY_GATE_ENABLED=false'] };
  }

  // For now, support images directly. PDFs need a pdf-to-png render
  // first — deferred to a follow-up since the bundle classifier
  // already has that capability and we can reuse it.
  const mime = opts.file.mime.toLowerCase();
  const isImage = mime.startsWith('image/');
  const isPdf = mime === 'application/pdf';
  if (!isImage && !isPdf) {
    return { ...empty, reasons: [`unsupported_mime: ${mime}`] };
  }
  if (isPdf) {
    return { ...empty, reasons: ['pdf_render_not_yet_wired'] };
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(opts.file.path);
  } catch (e: any) {
    logger.warn({ err: e?.message, path: opts.file.path }, 'identityGate: read failed');
    return { ...empty, status: 'inconclusive', reasons: [`file_read_error: ${e?.message ?? e}`] };
  }

  try {
    const client = getLlmClient();
    const res = await client.extract({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: USER_PROMPT,
      schema: IdentitySchema,
      documents: [{ kind: 'image', data: bytes, mime }],
      promptVersion: 'identity_gate.v1',
      taskName: 'identityGate.checkUpload',
      tier: 'standard',
      claimId: opts.ipds.id,
      hospitalId: opts.ipds.hospital_id ?? undefined,
    });

    const obs = res.data;
    if (obs.page_appears_blank_or_unreadable) {
      return {
        ...empty,
        status: 'inconclusive',
        observed: {
          patient_name: obs.patient_name,
          dob: obs.date_of_birth,
          uhid: obs.uhid,
          hospital_name: obs.hospital_name,
        },
        confidence: res.confidence,
        reasons: ['page_blank_or_unreadable'],
        cost_inr: res.costInr ?? 0,
      };
    }

    // No name extracted at all — can't make a determination.
    if (!obs.patient_name || obs.patient_name.trim().length === 0) {
      return {
        ...empty,
        status: 'inconclusive',
        observed: {
          patient_name: null,
          dob: obs.date_of_birth,
          uhid: obs.uhid,
          hospital_name: obs.hospital_name,
        },
        confidence: res.confidence,
        reasons: ['no_patient_name_on_page'],
        cost_inr: res.costInr ?? 0,
      };
    }

    // Run the fuzzy match
    const canonicalTokens = normalisePatientName(
      `${expected.first_name ?? ''} ${expected.last_name ?? ''}`,
    );
    const observedTokens = normalisePatientName(obs.patient_name);
    const reasons: string[] = [];

    if (canonicalTokens.length === 0) {
      return {
        ...empty,
        status: 'inconclusive',
        observed: {
          patient_name: obs.patient_name,
          dob: obs.date_of_birth,
          uhid: obs.uhid,
          hospital_name: obs.hospital_name,
        },
        confidence: res.confidence,
        reasons: ['no_canonical_name_on_ipds_row'],
        cost_inr: res.costInr ?? 0,
      };
    }

    const overlap = tokensOverlap(canonicalTokens, observedTokens);
    if (!overlap) {
      reasons.push(
        `name_mismatch: observed="${obs.patient_name}" vs expected="${[expected.first_name, expected.last_name].filter(Boolean).join(' ')}"`,
      );
    }
    return {
      status: overlap ? 'match' : 'mismatch',
      observed: {
        patient_name: obs.patient_name,
        dob: obs.date_of_birth,
        uhid: obs.uhid,
        hospital_name: obs.hospital_name,
      },
      expected,
      confidence: res.confidence,
      reasons,
      cost_inr: res.costInr ?? 0,
    };
  } catch (e: any) {
    logger.warn({ err: e?.message, claim_id: opts.ipds.id }, 'identityGate: LLM call failed');
    return {
      ...empty,
      status: 'inconclusive',
      reasons: [`llm_error: ${e?.message ?? e}`],
    };
  }
}
