import { PDFDocument } from 'pdf-lib';
import { pool } from '../DB/db.js';
import { logger } from '../Utils/logger.js';
import apiError from '../Utils/errorHandler.util.js';
import S3Service from './s3.service.js';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Pre-Auth PDF Fill Service
 *
 * Fills the AcroForm fields of a pre-auth PDF template using data sourced
 * from the IPD record + harmonised claim context + hospital profile.
 *
 * Inputs:
 *   - preauth_form_template_id  → fetch blank PDF from S3 + field_map
 *   - claim context (patient, hospital, panel, doctor, treatment)
 *
 * Output:
 *   - filled PDF buffer
 *   - S3 key where the filled PDF was uploaded
 *
 * Field map shape (preauth_form_templates.field_map):
 *   {
 *     "f_patient_name":    "patient.full_name",
 *     "f_age":             "patient.age",
 *     "f_admission_date":  "ipd.admitted_at",
 *     "f_estimated_cost":  "claim.estimated_amount",
 *     "f_hospital_name":   "hospital.name",
 *     "f_provider_code":   "panel.hospital_provider_code",
 *     ...
 *   }
 *
 * The right side is a dot-path that this service resolves against the
 * `context` object passed by the caller.
 *
 * Unknown paths leave the field blank — they're surfaced as warnings so
 * the analyst knows the field_map needs updating.
 */

interface FillContext {
  // The shape is intentionally loose — caller assembles whatever fields
  // their PDF needs. Most pre-auth forms care about:
  patient?: {
    full_name?: string;
    first_name?: string;
    last_name?: string;
    age?: number | string;
    gender?: string;
    dob?: string;
    phone?: string;
    address?: string;
    policy_no?: string;
    member_id?: string;
    [k: string]: any;
  };
  ipd?: {
    admitted_at?: string;
    admission_type?: string;
    treating_doctor?: string;
    provisional_diagnosis?: string;
    estimated_cost?: number | string;
    [k: string]: any;
  };
  hospital?: {
    name?: string;
    rohini?: string;
    cea?: string;
    address?: string;
    phone?: string;
    [k: string]: any;
  };
  panel?: {
    name?: string;
    hospital_provider_code?: string;
    [k: string]: any;
  };
  doctor?: {
    name?: string;
    nmc_number?: string;
    [k: string]: any;
  };
  claim?: {
    claim_no?: string;
    estimated_amount?: number | string;
    [k: string]: any;
  };
  [k: string]: any;
}

interface FillResult {
  buffer: Buffer;
  s3Key: string;
  fieldsFilled: number;
  fieldsTotal: number;
  warnings: string[];      // missing paths, unknown PDF fields, etc.
}

function resolvePath(context: FillContext, path: string): unknown {
  if (!path) return undefined;
  const parts = path.split('.');
  let cur: any = context;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

class PreauthPdfFillService {
  /**
   * Fetch the blank template PDF from S3 + the field_map from the DB.
   */
  private async loadTemplate(templateId: string): Promise<{
    pdfBuffer: Buffer;
    fieldMap: Record<string, string | null>;
    isAcroform: boolean;
    name: string;
    code: string;
  }> {
    const result = await pool.query(
      `SELECT name, code, s3_key, field_map, is_acroform
         FROM hospital.preauth_form_templates
        WHERE id = $1 AND is_active = TRUE
        LIMIT 1`,
      [templateId]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new apiError(404, `Pre-auth form template ${templateId} not found`);
    }
    const row = result.rows[0]!;
    if (!row.s3_key) {
      throw new apiError(
        400,
        `Pre-auth form ${row.code} has not been downloaded to S3 yet. ` +
          `Run Backend/scripts/sop-ingest/downloadForms.ts.`
      );
    }
    // Image-based PDFs (Medi Assist's scanned form, e.g.) are handled
    // gracefully: we attach the blank PDF as-is. Hospital staff fills it
    // manually + signs + scans before sending. Image-overlay rendering
    // (text drawn at coordinates) is a later upgrade once the analyst
    // produces a coordinate map.
    const pdfBuffer = await this.downloadFromS3(row.s3_key);
    return {
      pdfBuffer,
      fieldMap: row.field_map ?? {},
      isAcroform: !!row.is_acroform,
      name: row.name,
      code: row.code,
    };
  }

  private async downloadFromS3(key: string): Promise<Buffer> {
    const region = process.env.AWS_REGION;
    const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;
    if (!region || !bucket) {
      throw new apiError(500, 'AWS_REGION / AWS_S3_BUCKET not configured');
    }
    const client = new S3Client({ region });
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!response.Body) {
      throw new apiError(500, `Empty body fetching s3://${bucket}/${key}`);
    }
    // @ts-expect-error — Body is a Node Readable stream in this runtime
    const chunks: Uint8Array[] = [];
    // @ts-expect-error — iterating Readable
    for await (const chunk of response.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  /**
   * The main entry point. Loads the template, fills the AcroForm fields
   * from `context`, uploads the filled PDF to S3, returns the buffer + key.
   */
  async fill(
    templateId: string,
    context: FillContext,
    options: { outputS3Prefix?: string; flatten?: boolean } = {}
  ): Promise<FillResult> {
    const { pdfBuffer, fieldMap, name, code, isAcroform } = await this.loadTemplate(templateId);

    const warnings: string[] = [];
    let fieldsFilled = 0;
    const fieldsTotal = Object.keys(fieldMap).length;

    // Fast path for image-based PDFs: skip the form-fill entirely, upload
    // the blank PDF as the "filled" output. Hospital staff fills + signs
    // by hand. Warn so the UI knows to surface a "please complete by hand"
    // message.
    if (!isAcroform) {
      warnings.push(
        `Form is image-based (not an AcroForm) — attaching blank template for manual completion`
      );
      const prefix = options.outputS3Prefix ?? 'preauth-filled';
      const timestamp = Date.now();
      const random = Math.floor(Math.random() * 1e9);
      const s3Key = `${prefix}/${code}_${timestamp}_${random}.pdf`;
      await S3Service.upload(s3Key, pdfBuffer, 'application/pdf');
      logger.info(
        { templateId, templateCode: code, s3Key, isAcroform: false },
        `pre-auth PDF attached as-is (image-based form: ${name})`
      );
      return { buffer: pdfBuffer, s3Key, fieldsFilled: 0, fieldsTotal: 0, warnings };
    }

    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const form = pdfDoc.getForm();

    for (const [pdfFieldName, dataPath] of Object.entries(fieldMap)) {
      if (!dataPath) {
        warnings.push(`field_map for '${pdfFieldName}' is null — analyst needs to map it`);
        continue;
      }

      const rawValue = resolvePath(context, dataPath);
      if (rawValue == null || rawValue === '') {
        warnings.push(`path '${dataPath}' is empty for field '${pdfFieldName}'`);
        continue;
      }

      const stringValue = stringify(rawValue);

      try {
        // Try as text first; if that fails, try checkbox.
        const field = form.getField(pdfFieldName);
        const fieldType = field.constructor.name;
        switch (fieldType) {
          case 'PDFTextField':
            form.getTextField(pdfFieldName).setText(stringValue);
            fieldsFilled++;
            break;
          case 'PDFCheckBox': {
            const cb = form.getCheckBox(pdfFieldName);
            const truthy = ['true', 'yes', 'y', '1', 'on'].includes(
              stringValue.toLowerCase()
            );
            if (truthy) cb.check();
            else cb.uncheck();
            fieldsFilled++;
            break;
          }
          case 'PDFDropdown':
            form.getDropdown(pdfFieldName).select(stringValue);
            fieldsFilled++;
            break;
          case 'PDFRadioGroup':
            form.getRadioGroup(pdfFieldName).select(stringValue);
            fieldsFilled++;
            break;
          default:
            warnings.push(`field '${pdfFieldName}' has unsupported type ${fieldType}`);
        }
      } catch (err) {
        warnings.push(
          `field '${pdfFieldName}' could not be filled: ${(err as Error).message}`
        );
      }
    }

    if (options.flatten) {
      form.flatten();
    }

    const filledBytes = await pdfDoc.save();
    const filledBuffer = Buffer.from(filledBytes);

    // Upload to S3
    const prefix = options.outputS3Prefix ?? 'preauth-filled';
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1e9);
    const s3Key = `${prefix}/${code}_${timestamp}_${random}.pdf`;

    await S3Service.upload(s3Key, filledBuffer, 'application/pdf');

    logger.info(
      {
        templateId,
        templateCode: code,
        fieldsFilled,
        fieldsTotal,
        warnings: warnings.length,
        s3Key,
      },
      `pre-auth PDF filled (${name})`
    );

    return {
      buffer: filledBuffer,
      s3Key,
      fieldsFilled,
      fieldsTotal,
      warnings,
    };
  }
}

export default new PreauthPdfFillService();
