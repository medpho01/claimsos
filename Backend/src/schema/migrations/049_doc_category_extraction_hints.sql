-- ============================================================================
-- Wave 9 follow-up — per-category extraction hints for the LLM extractor.
-- ============================================================================
-- The doc extractor (`Services/docExtractor.service.ts`) now reads
-- `master_options.description` for the doc_category code and threads it into
-- the user prompt as a "Category-specific guidance" block. This lets ops
-- encode layout / label / OCR quirks per document type without code changes.
--
-- Why this matters: many Indian-government and hospital documents lack
-- explicit field labels (e.g. an Aadhaar card has NO "Name:" prefix — the
-- name simply appears as a Devanagari line followed by its English
-- transliteration). Without a per-category hint the LLM frequently returns
-- empty {} on these, even when the OCR text is good. With the hint it
-- knows where to look.
--
-- Hints can be edited later in the Master Options UI — superadmin can
-- iterate on phrasing without a migration. This migration just seeds the
-- categories we know are problematic today.

BEGIN;

-- ─── Aadhaar Front ───────────────────────────────────────────────────────
-- Most common confusion sources: rotation, no "Name:" label, bilingual DOB.
UPDATE hospital.master_options SET description = $$
The Aadhaar front (issued by UIDAI, Government of India) has a fixed layout:

  - HEADER: "भारत सरकार / Government of India" with the Indian tricolour and Ashoka emblem.
  - NAME: appears immediately after the header as TWO lines with NO "Name:" label prefix:
      Line 1 — name in Devanagari (Hindi) script (e.g. "भूरी")
      Line 2 — same name transliterated in English (e.g. "Bhuri")
    Use the English line for `full_name`. If only Devanagari is OCR'd cleanly, transliterate using common Indian-name patterns.
  - DOB: labelled bilingually "जन्म तिथि / DOB : DD/MM/YYYY". Map to `date_of_birth` in ISO YYYY-MM-DD.
    Some older cards print only year — populate `year_of_birth` (number) in that case and leave `date_of_birth` null.
  - GENDER: labelled "पुरुष / Male" or "महिला / Female" (or "Other"). Map to enum: M / F / O.
  - AADHAAR NUMBER: 12-digit UID rendered as THREE GROUPS OF FOUR digits separated by spaces (e.g. "6978 2591 6544"). Strip the spaces when populating `aadhaar_number`.
  - QR code and photo are also present but not extracted.

Scans frequently arrive rotated 90/180/270°. If the OCR text reads as broken vertical fragments, the source is rotated — try harder to reconstruct fields from disjoint OCR tokens; do NOT return {} just because no field label is detectable. The 12-digit UID pattern (\d{4}\s\d{4}\s\d{4}) is the strongest anchor for orientation.
$$
WHERE category = 'doc_category' AND code = 'aadhaar_front';

-- ─── Aadhaar Back ────────────────────────────────────────────────────────
UPDATE hospital.master_options SET description = $$
The Aadhaar back (issued by UIDAI) carries the holder's address. Layout:

  - The 12-digit Aadhaar number is repeated at the bottom (same 4-4-4 grouped format).
  - The address block is preceded by either "S/O:" (son of), "D/O:" (daughter of), "W/O:" (wife of), or "C/O:" (care of) followed by the parent/spouse name and the address. Map the name following S/O / D/O / W/O / C/O to `parent_or_spouse_name`.
  - Address lines follow comma-separated: house/door number, street/locality, village/post, sub-district, district, state, then a 6-digit PIN code.
  - State name is one of the 28 Indian states / 8 UTs — use canonical English spelling for `state`.
  - The PIN code is exactly 6 digits, often appearing at the end of the address. Populate `pin_code`.
  - QR code is present but not extracted.
$$
WHERE category = 'doc_category' AND code = 'aadhaar_card';

-- ─── Ration Card ─────────────────────────────────────────────────────────
UPDATE hospital.master_options SET description = $$
Indian ration cards (issued by State Civil Supplies departments under PDS) vary widely by state, but share core elements:

  - Card number: alphanumeric, format varies by state (UP, MP, Bihar etc.) — extract verbatim into `ration_card_number`. Some legacy paper cards have no printed number; populate null in that case.
  - Card type (CRITICAL — drives eligibility): one of:
      APL (Above Poverty Line)
      BPL (Below Poverty Line)
      Antyodaya / AAY (Antyodaya Anna Yojana — poorest of the poor)
      Annapurna (for senior citizens)
    The card type is usually printed prominently as a colour band or text label. Pick the closest enum value.
  - Head of family: name printed at the top of the family-members table or labelled "Head" / "मुखिया" / "कर्ता".
  - Family members: tabular list with name, age, gender, relation. Concatenate into a comma-separated string for `family_members` (e.g. "Bhuri (72/F, SELF), Vahid (67/M, HUSBAND)").
  - FPS shop number: the Fair Price Shop assigned to the family — labelled "FPS No." / "उचित मूल्य दुकान संख्या".
  - State + district: usually printed in the header or as a stamp.
$$
WHERE category = 'doc_category' AND code = 'ration_card';

-- ─── PMJAY BIS Family Tree ───────────────────────────────────────────────
UPDATE hospital.master_options SET description = $$
PMJAY BIS (Beneficiary Identification System) Family Tree screenshots are taken from the PM-JAY portal during beneficiary verification. Layout:

  - PMJAY Beneficiary ID: long alphanumeric (often 24+ chars) labelled "PMJAY ID" or "बेनिफिशियरी आईडी". Map to `pmjay_beneficiary_id`. The same value may appear as "Household ID" — if present, populate `household_id` too (often identical to beneficiary ID for single-card households).
  - Head of family: the FIRST row of the family-tree table, marked as "HOF" / "Head".
  - Family members: every row in the family table; concatenate names comma-separated for `family_members`.
  - Total family size: the row count (or printed total). Populate `total_family_size` (number).
  - Eligibility status: printed as "Eligible" / "Not Eligible" / "Under Review" — map to enum.
  - State + district: often shown in the portal header or as filter chips.
  - The screenshot may include the PM-JAY logo and government colours; ignore those decorations.
$$
WHERE category = 'doc_category' AND code = 'pmjay_bis_family_tree';

-- ─── CT Scan Reports ─────────────────────────────────────────────────────
UPDATE hospital.master_options SET description = $$
CT scan reports follow a fairly standard radiology format:

  - Study date: printed near the top, often labelled "Date of Study" / "Date:" / "Examination Date". Map to ISO YYYY-MM-DD in `study_date`.
  - Body part / anatomy: the title of the report (e.g. "CT BRAIN", "HRCT CHEST", "CT KNEE — BOTH SIDES"). Use the most specific phrasing for `body_part`.
  - Clinical indication / referral diagnosis: short note describing why the scan was ordered (e.g. "C/O knee pain x 3 months").
  - Contrast: explicitly stated as "Non-contrast" / "Plain" / "IV contrast" / "Oral contrast". Map to enum: none / iv_contrast / oral_contrast / both.
  - Findings: longest free-text section describing what was seen on the scan, organ-by-organ. Copy verbatim (up to ~1000 chars).
  - Impression / Conclusion: the radiologist's interpretive summary at the end. Usually 1-5 sentences. Copy verbatim.
  - Ordering physician: doctor who requested the scan (often a surgeon or specialist).
  - Reporting radiologist: doctor who interpreted the scan and signed the report (usually printed at the bottom with a registration number).
$$
WHERE category = 'doc_category' AND code = 'ct_scan_reports';

COMMIT;
