/**
 * Synthetic landscape final bill with KNOWN ground truth.
 *
 * The regression gate needs a document where we know every one of the 196
 * printed cells exactly, so "tiled scores 99.5% and single scores 88%" is a
 * measurement rather than an anecdote. Real prod bills can't serve that
 * purpose: nobody has hand-keyed their 196 cells, and we can't commit PHI to
 * the repo.
 *
 * The bill is built as an SVG string and rasterised through sharp (librsvg is
 * compiled into sharp) — NO new dependency, and no headless browser. Shape
 * and density are copied from a real Indian hospital itemised final bill:
 * 3400x1400px, an 11-field header block, 18 rows x 11 columns with a long
 * particulars column and five money columns pushed to the right edge, and a
 * five-line totals block. The right-hand money columns are exactly where the
 * single-image path loses accuracy, which is the point.
 *
 * `degrade` then turns the pristine render into a realistic phone scan:
 * a small rotation (the deskew target), a light blur, and aggressive JPEG.
 * Defaults reproduce the degradation profile of the bill in
 * docs/proposals/EXTRACTION_LANDSCAPE_FIX.md.
 */

// ─── Public types ────────────────────────────────────────────────────────

export interface SyntheticBillGroundTruth {
  /** 11 header fields: bill_no, patient_name, uhid, ipd_no, admission_date, ... */
  header: Record<string, string>;
  /** 18 rows × 10 cells: particulars, code, date, qty, rate, gross, discount, net, tax_pct, payable. */
  rows: Array<Record<string, string>>;
  /** 5 totals: gross_total, discount_total, net_total, tax_total, payable_total. */
  totals: Record<string, string>;
  /** Total scored cells. 11 + 18*10 + 5 = 196 at defaults. */
  fieldCount: number;
}

export interface SyntheticBillOptions {
  /** Default 18. */
  rows?: number;
  /** Deterministic PRNG seed so ground truth is reproducible. Default 42. */
  seed?: number;
  /** Default 3400 × 1400 (a wide itemised final bill). */
  widthPx?: number;
  heightPx?: number;
  /** Phone-scan degradation. Defaults: skewDeg 1, blurSigma 0.8, jpegQuality 50. Pass null for a pristine render. */
  degrade?: { skewDeg?: number; blurSigma?: number; jpegQuality?: number } | null;
}

export interface SyntheticBillFixture {
  imageBytes: Buffer;
  mime: 'image/jpeg';
  widthPx: number;
  heightPx: number;
  groundTruth: SyntheticBillGroundTruth;
}

// ─── Deterministic PRNG ──────────────────────────────────────────────────

/** mulberry32 — small, fast, and reproducible across Node versions. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Realistic content pools ─────────────────────────────────────────────

const PARTICULARS = [
  'Room Rent - Semi Private Ward (AC)',
  'Nursing Charges - General Ward',
  'Consultant Visit - Dr. R. Deshmukh (Cardiology)',
  'ICU Charges - Level II Monitoring',
  'Inj. Piperacillin + Tazobactam 4.5gm',
  'Tab. Pantoprazole 40mg',
  'CBC with ESR and Peripheral Smear',
  'Serum Creatinine and Blood Urea',
  '2D Echocardiography with Colour Doppler',
  'Chest X-Ray PA View - Digital',
  'ECG 12 Lead with Reporting',
  'OT Charges - Minor Procedure',
  'Anaesthetist Charges - Spinal',
  'Surgeon Charges - Primary Procedure',
  'Physiotherapy Session - Chest',
  'Dressing Charges - Large Wound',
  'IV Set, Cannula and Consumables',
  'Oxygen Therapy - Per Hour',
  'Blood Sugar Random - Glucometer',
  'Ambulance Charges - Local Transfer',
  'Dietician Consultation',
  'Biomedical Waste Disposal Charges',
];

const CODE_PREFIX = ['HCP', 'SVC', 'PHR', 'LAB', 'RAD', 'OTP'];
const TAX_PCT = [0, 5, 12, 18];

function money(n: number): string {
  return n.toFixed(2);
}

/** SVG text is XML — escape or a stray & in a particulars string breaks the parse. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Generator ───────────────────────────────────────────────────────────

/**
 * Render a dense landscape itemised bill (18 rows × 11 columns) with KNOWN
 * ground truth, then optionally degrade it into a realistic phone scan.
 * Built as an SVG rasterised through sharp — NO new dependency.
 */
export async function generateSyntheticLandscapeBill(
  opts: SyntheticBillOptions = {},
): Promise<SyntheticBillFixture> {
  const rowCount = Math.max(1, opts.rows ?? 18);
  const seed = opts.seed ?? 42;
  const widthPx = opts.widthPx ?? 3400;
  const heightPx = opts.heightPx ?? 1400;
  const rnd = mulberry32(seed);

  // ── Header (11 fields) ────────────────────────────────────────────────
  const header: Record<string, string> = {
    bill_no: `FB/2026/${1000 + Math.floor(rnd() * 8999)}`,
    patient_name: 'Sunita Ramesh Kulkarni',
    uhid: `UH${100000 + Math.floor(rnd() * 899999)}`,
    ipd_no: `IPD-${20000 + Math.floor(rnd() * 9999)}`,
    admission_date: '2026-02-11',
    discharge_date: '2026-02-17',
    bill_date: '2026-02-17',
    ward: 'Semi Private - 2B',
    consultant: 'Dr. R. Deshmukh',
    tpa_name: 'Medi Assist Insurance TPA',
    policy_no: `P/181/${300000 + Math.floor(rnd() * 99999)}`,
  };

  // ── Rows (rowCount × 10 cells) ────────────────────────────────────────
  const rows: Array<Record<string, string>> = [];
  let grossTotal = 0;
  let discountTotal = 0;
  let netTotal = 0;
  let taxTotal = 0;
  let payableTotal = 0;

  for (let i = 0; i < rowCount; i++) {
    const particulars = PARTICULARS[i % PARTICULARS.length];
    const code = `${CODE_PREFIX[Math.floor(rnd() * CODE_PREFIX.length)]}${1000 + Math.floor(rnd() * 8999)}`;
    const day = 11 + (i % 7);
    const date = `2026-02-${String(day).padStart(2, '0')}`;
    const qty = 1 + Math.floor(rnd() * 8);
    const rate = Math.round((150 + rnd() * 18500) * 100) / 100;
    const gross = Math.round(qty * rate * 100) / 100;
    // A discount on roughly every third row — enough zeros to prove the
    // scorer distinguishes "0.00" from a dropped cell.
    const discount = rnd() < 0.34 ? Math.round(gross * (0.05 + rnd() * 0.1) * 100) / 100 : 0;
    const net = Math.round((gross - discount) * 100) / 100;
    const taxPct = TAX_PCT[Math.floor(rnd() * TAX_PCT.length)];
    const tax = Math.round(net * (taxPct / 100) * 100) / 100;
    const payable = Math.round((net + tax) * 100) / 100;

    grossTotal += gross;
    discountTotal += discount;
    netTotal += net;
    taxTotal += tax;
    payableTotal += payable;

    rows.push({
      particulars,
      code,
      date,
      qty: String(qty),
      rate: money(rate),
      gross: money(gross),
      discount: money(discount),
      net: money(net),
      tax_pct: String(taxPct),
      payable: money(payable),
    });
  }

  const totals: Record<string, string> = {
    gross_total: money(Math.round(grossTotal * 100) / 100),
    discount_total: money(Math.round(discountTotal * 100) / 100),
    net_total: money(Math.round(netTotal * 100) / 100),
    tax_total: money(Math.round(taxTotal * 100) / 100),
    payable_total: money(Math.round(payableTotal * 100) / 100),
  };

  const groundTruth: SyntheticBillGroundTruth = {
    header,
    rows,
    totals,
    fieldCount: Object.keys(header).length + rowCount * 10 + Object.keys(totals).length,
  };

  // ── Layout ────────────────────────────────────────────────────────────
  const margin = Math.round(widthPx * 0.022);
  const tableWidth = widthPx - margin * 2;

  // Fractional column widths — the five money columns sit hard right, which
  // is exactly the region a single downscaled image loses.
  const colSpec: Array<{ key: string; label: string; frac: number; align: 'start' | 'end' | 'middle' }> = [
    { key: 'sr', label: 'Sr', frac: 0.028, align: 'middle' },
    { key: 'particulars', label: 'Particulars', frac: 0.272, align: 'start' },
    { key: 'code', label: 'Code', frac: 0.072, align: 'start' },
    { key: 'date', label: 'Date', frac: 0.078, align: 'start' },
    { key: 'qty', label: 'Qty', frac: 0.04, align: 'end' },
    { key: 'rate', label: 'Rate', frac: 0.084, align: 'end' },
    { key: 'gross', label: 'Gross Amt', frac: 0.09, align: 'end' },
    { key: 'discount', label: 'Discount', frac: 0.084, align: 'end' },
    { key: 'net', label: 'Net Amt', frac: 0.09, align: 'end' },
    { key: 'tax_pct', label: 'Tax %', frac: 0.05, align: 'end' },
    { key: 'payable', label: 'Payable', frac: 0.112, align: 'end' },
  ];

  const cols = colSpec.map((c) => ({ ...c, width: c.frac * tableWidth }));
  let cursor = margin;
  const colX: Record<string, { left: number; right: number; align: string }> = {};
  for (const c of cols) {
    colX[c.key] = { left: cursor, right: cursor + c.width, align: c.align };
    cursor += c.width;
  }
  const tableRight = cursor;

  const headerBlockTop = Math.round(heightPx * 0.045);
  const headerLineH = Math.round(heightPx * 0.031);
  const tableTop = headerBlockTop + headerLineH * 5 + Math.round(heightPx * 0.03);
  const headRowH = Math.round(heightPx * 0.036);
  const bodyTop = tableTop + headRowH;
  const rowH = (heightPx * 0.9 - bodyTop - heightPx * 0.13) / rowCount;
  const fontBody = Math.max(14, Math.round(rowH * 0.46));
  const fontHead = Math.round(fontBody * 1.02);
  const fontTitle = Math.round(fontBody * 1.7);
  const fontMeta = Math.round(fontBody * 1.02);

  const parts: string[] = [];
  const FONT = "font-family='DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif'";

  parts.push(`<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="#ffffff"/>`);

  // Letterhead
  parts.push(
    `<text x="${margin}" y="${headerBlockTop}" ${FONT} font-size="${fontTitle}" font-weight="bold" fill="#111111">SAHYADRI MULTISPECIALITY HOSPITAL</text>`,
  );
  parts.push(
    `<text x="${tableRight}" y="${headerBlockTop}" ${FONT} font-size="${fontMeta}" text-anchor="end" fill="#111111">FINAL BILL / SUMMARY OF CHARGES</text>`,
  );

  // Header block — three columns of metadata, 11 fields total.
  const headerFields: Array<[string, string, string]> = [
    ['Bill No', 'bill_no', header.bill_no],
    ['Patient Name', 'patient_name', header.patient_name],
    ['UHID', 'uhid', header.uhid],
    ['IPD No', 'ipd_no', header.ipd_no],
    ['Admission Date', 'admission_date', header.admission_date],
    ['Discharge Date', 'discharge_date', header.discharge_date],
    ['Bill Date', 'bill_date', header.bill_date],
    ['Ward', 'ward', header.ward],
    ['Consultant', 'consultant', header.consultant],
    ['TPA', 'tpa_name', header.tpa_name],
    ['Policy No', 'policy_no', header.policy_no],
  ];
  const headerColW = tableWidth / 3;
  headerFields.forEach(([label, , value], idx) => {
    const col = idx % 3;
    const line = Math.floor(idx / 3);
    const x = margin + col * headerColW;
    const y = headerBlockTop + headerLineH * (line + 1.4);
    parts.push(
      `<text x="${x}" y="${y}" ${FONT} font-size="${fontMeta}" fill="#333333">${esc(label)}:</text>`,
    );
    parts.push(
      `<text x="${x + headerColW * 0.28}" y="${y}" ${FONT} font-size="${fontMeta}" font-weight="bold" fill="#000000">${esc(value)}</text>`,
    );
  });

  // Table header band
  parts.push(
    `<rect x="${margin}" y="${tableTop}" width="${tableWidth}" height="${headRowH}" fill="#e8e8e8" stroke="#555555" stroke-width="1.5"/>`,
  );
  for (const c of cols) {
    const box = colX[c.key];
    const tx = box.align === 'end' ? box.right - 10 : box.align === 'middle' ? (box.left + box.right) / 2 : box.left + 10;
    parts.push(
      `<text x="${tx}" y="${tableTop + headRowH * 0.7}" ${FONT} font-size="${fontHead}" font-weight="bold" text-anchor="${box.align}" fill="#000000">${esc(c.label)}</text>`,
    );
  }

  // Body rows + vertical rules
  rows.forEach((row, i) => {
    const top = bodyTop + i * rowH;
    const baseline = top + rowH * 0.68;
    if (i % 2 === 1) {
      parts.push(
        `<rect x="${margin}" y="${top}" width="${tableWidth}" height="${rowH}" fill="#f5f5f5"/>`,
      );
    }
    parts.push(
      `<line x1="${margin}" y1="${top}" x2="${tableRight}" y2="${top}" stroke="#bbbbbb" stroke-width="1"/>`,
    );

    const cells: Record<string, string> = { sr: String(i + 1), ...row };
    for (const c of cols) {
      const box = colX[c.key];
      const tx = box.align === 'end' ? box.right - 10 : box.align === 'middle' ? (box.left + box.right) / 2 : box.left + 10;
      parts.push(
        `<text x="${tx}" y="${baseline}" ${FONT} font-size="${fontBody}" text-anchor="${box.align}" fill="#000000">${esc(cells[c.key] ?? '')}</text>`,
      );
    }
  });

  const tableBottom = bodyTop + rowCount * rowH;
  parts.push(
    `<rect x="${margin}" y="${tableTop}" width="${tableWidth}" height="${tableBottom - tableTop}" fill="none" stroke="#555555" stroke-width="1.5"/>`,
  );
  for (const c of cols) {
    parts.push(
      `<line x1="${colX[c.key].left}" y1="${tableTop}" x2="${colX[c.key].left}" y2="${tableBottom}" stroke="#999999" stroke-width="1"/>`,
    );
  }

  // Totals block, right-aligned under the money columns.
  const totalRows: Array<[string, string]> = [
    ['Gross Total', totals.gross_total],
    ['Discount Total', totals.discount_total],
    ['Net Total', totals.net_total],
    ['Tax Total', totals.tax_total],
    ['TOTAL PAYABLE', totals.payable_total],
  ];
  const totalsLineH = Math.round(rowH * 0.98);
  totalRows.forEach(([label, value], idx) => {
    const y = tableBottom + totalsLineH * (idx + 1.1);
    const bold = idx === totalRows.length - 1;
    parts.push(
      `<text x="${colX.net.left - 12}" y="${y}" ${FONT} font-size="${fontBody}" text-anchor="end" font-weight="${bold ? 'bold' : 'normal'}" fill="#000000">${esc(label)}</text>`,
    );
    parts.push(
      `<text x="${colX.payable.right - 10}" y="${y}" ${FONT} font-size="${fontBody}" text-anchor="end" font-weight="${bold ? 'bold' : 'normal'}" fill="#000000">${esc(value)}</text>`,
    );
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}">${parts.join('')}</svg>`;

  // ── Rasterise (+ optional degradation) ────────────────────────────────
  const sharpMod: any = await import('sharp');
  const sharp = sharpMod?.default ?? sharpMod;

  // density 72 makes librsvg treat the SVG's user units as CSS px 1:1; the
  // explicit resize then pins the output to exactly widthPx x heightPx
  // regardless of the librsvg build sharp was compiled against (a 96-DPI
  // default silently rendered this bill at 4565px wide).
  const rasterised: Buffer = await sharp(Buffer.from(svg, 'utf8'), { density: 72 })
    .resize(widthPx, heightPx, { fit: 'fill' })
    .png()
    .toBuffer();

  const degrade =
    opts.degrade === null
      ? null
      : { skewDeg: 1, blurSigma: 0.8, jpegQuality: 50, ...(opts.degrade ?? {}) };

  if (degrade) {
    // Degrade AFTER rasterising — applying the rotation to the vector render
    // would let librsvg anti-alias it into clean glyphs and the skew would be
    // unrealistically tidy.
    let deg = sharp(rasterised);
    if (degrade.skewDeg) deg = deg.rotate(degrade.skewDeg, { background: '#ffffff' });
    if (degrade.blurSigma) deg = deg.blur(degrade.blurSigma);
    const imageBytes: Buffer = await deg.jpeg({ quality: degrade.jpegQuality ?? 50 }).toBuffer();
    const meta = await sharp(imageBytes).metadata();
    return {
      imageBytes,
      mime: 'image/jpeg',
      widthPx: Number(meta.width ?? widthPx),
      heightPx: Number(meta.height ?? heightPx),
      groundTruth,
    };
  }

  const imageBytes: Buffer = await sharp(rasterised).jpeg({ quality: 95 }).toBuffer();
  const meta = await sharp(imageBytes).metadata();
  return {
    imageBytes,
    mime: 'image/jpeg',
    widthPx: Number(meta.width ?? widthPx),
    heightPx: Number(meta.height ?? heightPx),
    groundTruth,
  };
}
