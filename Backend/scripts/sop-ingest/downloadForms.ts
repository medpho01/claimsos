/**
 * Pre-Auth PDF Downloader
 *
 * Downloads the 42 pre-auth PDF templates from their SOP source URLs
 * (krbusinesssolutions.in), uploads them to our S3 bucket, probes
 * AcroForm presence, and updates the preauth_form_templates table.
 *
 * One-time + idempotent: only processes rows where s3_key IS NULL.
 * Re-run safely after migrations 013/016 land.
 *
 * Usage:
 *   pnpm tsx Backend/scripts/sop-ingest/downloadForms.ts
 *
 * Environment:
 *   AWS_REGION, S3_BUCKET, DB_* — same as the main backend.
 *
 * Requires `pdf-lib` in dependencies (added to package.json for AcroForm probe).
 */

import { pool } from '../../src/DB/db.js';
import S3Service from '../../src/Services/s3.service.js';
import { logger } from '../../src/Utils/logger.js';
import { PDFDocument } from 'pdf-lib';

interface FormRow {
  id: string;
  name: string;
  code: string;
  source_url: string | null;
  s3_key: string | null;
}

async function fetchPdf(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function probePdf(buffer: Buffer): Promise<{
  isAcroform: boolean;
  pageCount: number;
  fieldNames: string[];
}> {
  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    return {
      isAcroform: fields.length > 0,
      pageCount: pdfDoc.getPageCount(),
      fieldNames: fields.map(f => f.getName()),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'pdf probe failed; treating as non-AcroForm');
    return { isAcroform: false, pageCount: 0, fieldNames: [] };
  }
}

async function processOne(form: FormRow): Promise<{
  status: 'ok' | 'skipped' | 'failed';
  reason?: string;
  s3Key?: string;
}> {
  if (form.s3_key) {
    return { status: 'skipped', reason: 's3_key already populated' };
  }
  if (!form.source_url) {
    return { status: 'skipped', reason: 'no source_url' };
  }

  try {
    logger.info({ code: form.code, url: form.source_url }, 'downloading PDF');
    const buffer = await fetchPdf(form.source_url);

    const probe = await probePdf(buffer);
    logger.info(
      {
        code: form.code,
        sizeBytes: buffer.length,
        pages: probe.pageCount,
        isAcroform: probe.isAcroform,
        fieldCount: probe.fieldNames.length,
      },
      'PDF probed'
    );

    const s3Key = `preauth-forms/${form.code}.pdf`;
    await S3Service.upload(s3Key, buffer, 'application/pdf');

    // Initialise field_map with the field names → null mappings, so the
    // analyst can fill them in via UI/JSON later.
    const initialFieldMap: Record<string, null> = {};
    for (const name of probe.fieldNames) {
      initialFieldMap[name] = null;
    }

    await pool.query(
      `UPDATE hospital.preauth_form_templates
         SET s3_key = $1,
             file_size_bytes = $2,
             page_count = $3,
             is_acroform = $4,
             field_map = CASE
               WHEN field_map = '{}'::jsonb THEN $5::jsonb
               ELSE field_map
             END,
             updated_at = NOW()
       WHERE id = $6`,
      [
        s3Key,
        buffer.length,
        probe.pageCount,
        probe.isAcroform,
        JSON.stringify(initialFieldMap),
        form.id,
      ]
    );

    return { status: 'ok', s3Key };
  } catch (err) {
    const reason = (err as Error).message;
    logger.error({ err, code: form.code }, 'download/upload failed');
    return { status: 'failed', reason };
  }
}

async function main() {
  const startedAt = Date.now();

  const rowsRes = await pool.query<FormRow>(
    `SELECT id, name, code, source_url, s3_key
       FROM hospital.preauth_form_templates
       WHERE is_active = TRUE
       ORDER BY code`
  );

  logger.info({ totalForms: rowsRes.rowCount }, 'starting PDF download run');

  let okCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const failures: { code: string; reason: string }[] = [];

  for (const form of rowsRes.rows) {
    const result = await processOne(form);
    switch (result.status) {
      case 'ok':
        okCount++;
        break;
      case 'skipped':
        skippedCount++;
        break;
      case 'failed':
        failedCount++;
        failures.push({ code: form.code, reason: result.reason ?? 'unknown' });
        break;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  logger.info(
    {
      okCount,
      skippedCount,
      failedCount,
      elapsedMs,
    },
    'PDF download run complete'
  );

  if (failures.length > 0) {
    logger.warn({ failures }, 'failures detected — retry after investigating');
  }

  await pool.end();
}

main().catch(async err => {
  logger.error({ err }, 'downloadForms fatal');
  await pool.end();
  process.exit(1);
});
