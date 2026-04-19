# Hospital Profile Management — Feature Specification & Implementation Plan

**Date:** April 2026  
**Status:** Design / Pre-implementation  
**Scope:** Backend (Node/TS), Webapp (React), Mobile (Flutter)

---

## Table of Contents

1. [Feature Overview](#1-feature-overview)
2. [Product Specification](#2-product-specification)
3. [Data Model & Database Migrations](#3-data-model--database-migrations)
4. [API Design](#4-api-design)
5. [Implementation Plan (Phased)](#5-implementation-plan-phased)
6. [Module Impact Analysis](#6-module-impact-analysis)
7. [Public Profile & Shareable Links](#7-public-profile--shareable-links)
8. [Portal Management & Cashless Everywhere](#8-portal-management--cashless-everywhere)
9. [Verified Badge System](#9-verified-badge-system)
10. [Open Questions & Decisions](#10-open-questions--decisions)

---

## 1. Feature Overview

### Problem Statement

The current `hospitals` table stores all hospital metadata in a flat JSONB `details` column with no structure, no history, no document categorization, and no concept of multi-panel empanelment relationships. As Finclarity expands from managing one portal (PMJAY) to all insurance portals for a hospital — plus Cashless Everywhere — the data model and product surface must scale accordingly.

### Goals

| Goal | Description |
|------|-------------|
| **Structured Hospital Profile** | Replace the JSONB blob with a normalized, versioned, queryable hospital profile |
| **Panel Empanelment Management** | Model the full relationship between a hospital and each insurance panel (contracts, MoUs, portal credentials, POC contacts, 2FA config) |
| **Public Shareable Profiles** | Allow hospitals to share a verified, branded profile page via a public link (for abroad insurers, referrals, etc.) |
| **Verified Badge** | Finclarity-issued verification badge on profiles where key documents have been validated |
| **Cashless Everywhere** | Active by default for all hospitals; manage its specific empanelment rules and claim flows |
| **Portal Management** | Centralize all insurance portal credentials, links, and auth mechanisms for a hospital |

---

## 2. Product Specification

### 2.1 Hospital Profile — Core Data

The hospital profile is split into logical sections matching the MediAssist empanelment form structure (and generalizable to any insurer's format):

#### Section A — Identity & Contact
| Field | Type | Notes |
|-------|------|-------|
| hospital_name | text | Official registered name |
| legal_name | text | Name as on PAN/GST |
| rohini_id | text | Rohini Health ID |
| hfr_id | text | Health Facility Registry |
| pan_number | text | PAN card |
| gst_number | text | GST registration |
| website | text | |
| email | text | Primary hospital email |
| phone | text | |
| established_year | int | |

#### Section B — Address
| Field | Type |
|-------|------|
| address_line1, address_line2 | text |
| city, district, state, pincode | text |
| latitude, longitude | decimal |
| google_maps_url | text |

#### Section C — Registration & Accreditations
Multi-valued: each accreditation is a separate record with issuing body, certificate number, issue date, expiry date, and document link.

Supported bodies: `State Govt`, `CGHS`, `Ministry of Health`, `JCI`, `NABH`, `NABL`, `ISO`, `Other`

#### Section D — Hospital Type & Specialties
| Field | Values |
|-------|--------|
| hospital_type | Single Specialty / Multi-Specialty / Nursing Home / Day Care Center |
| specialties | Array: OPHTHALMOLOGY, ORTHOPAEDICS, GENERAL SURGERY, ENT, VASCULAR SURGERY, NEUROSURGERY, CARDIOLOGY, OBSTETRICS & GYNECOLOGY, UROLOGY AND NEPHROLOGY, ONCOLOGY, GASTROENTEROLOGY, NEUROLOGY, RADIOLOGY, NEPHROLOGY, PULMONOLOGY, PLASTIC SURGERY, DERMATOLOGY, PSYCHIATRY, ENDOCRINOLOGY, RHEUMATOLOGY, HEMATOLOGY, BONE MARROW TRANSPLANT, ORGAN TRANSPLANT, Other |

#### Section E — Bed & Infrastructure Counts
| Facility | Fields |
|----------|--------|
| Beds | General Ward, Sharing, Private, Deluxe, Burns Unit |
| ICU | MICU, ICCU, NICU, PICU, NeuroICU, SICU |
| OT / Emergency | Emergency Room, Trauma, Minor OT, Major OT, Cath Lab |
| In-house | Blood Bank, Ambulance, Pharmacy, Defibrillator, O2 Supply |

#### Section F — Equipment
20+ equipment items (Ventilator, C-Arm, CT, MRI, PET CT, Angiography Machine, USG Machines, Echo Machine, TMT, Holter, IABP, Linear Accelerator, Brachytherapy, Gamma Knife, etc.) — each with a count field.

#### Section G — Services
Structured service offerings per specialty with equipment and capability flags:
- Cardiology, Gastroenterology, Neurology, ENT, Ophthalmology, Radiology

#### Section H — Lab Capabilities
Lab types with Yes/No: Hematology, Biochemistry, Pathology, Microbiology, Virology, Serology, Immunology, Histopathology, Cytology, Genetics, others.

#### Section I — Broad & Super Specialties
Array fields for: Broad Specialties (20+), Super Specialties (12+).

#### Section J — Room Rents
Room rent rates per room type (General, Sharing, Private, Deluxe, ICU/CCU, others).

#### Section K — Staff Counts
| Type | Field |
|------|-------|
| Resident Doctors | count |
| Specialist Doctors | count |
| Visiting Consultants | count |
| Nursing Staff | count |
| Paramedical Staff | count |

#### Section L — Compliance Checklist
18-item Yes/No compliance checklist:
- Hospital Infection Control Policy
- Medical Waste Management & Disposal System
- Hospital Information Management System
- Coding practices (ICD 09/10, CPT, PCS)
- Record Storage and Archiving
- Full Generator Back-up
- In-House Kitchen & Canteen
- Central Sterile Services Department
- Water Purification and Filtration
- Parking Capacity
- Central Gas Supply
- Housekeeping and Laundry Services
- TPA Online Connectivity Capability
- Gas Plant/Boiler/Sterilizers
- Fully Air-Conditioned
- Fire Protection System
- Lifts
- Ramp Availability

#### Section M — Key Contacts
Three contact groups, each with Name, Email, Phone:
- Institution Head
- Finance Head
- TPA Contact

#### Section N — Banking Details
- Cheque Payable Name, Bank Name, Branch, Address
- Account Number, IFSC Code, Account Type (Savings/Current)
- Name on PAN, PAN Number, MICR

---

### 2.2 Hospital Documents & Certifications

Documents are organized by category. Each document record links to an S3 file.

| Category | Examples |
|----------|---------|
| `registration` | State Govt registration cert, CGHS empanelment letter |
| `accreditation` | NABH certificate, JCI letter |
| `legal` | PAN card, GST certificate, trade license |
| `mou` | MoU with insurer (panel-specific) |
| `contract` | Rate contract (panel-specific) |
| `id_proof` | Owner/Director ID |
| `logo` | Hospital logo |
| `photo` | Hospital photos (exterior, wards, OT, ICU) |
| `brochure` | Hospital brochure |
| `other` | Anything else |

Each document has: `verified_by`, `verified_at`, `expiry_date`, `notes`.

---

### 2.3 Panel Empanelment Relationships

Each hospital-panel relationship (`hospital_panels`) is enriched with:

#### 2.3.1 Core Relationship Metadata
| Field | Type | Notes |
|-------|------|-------|
| empanelment_start_date | date | When hospital joined this panel |
| empanelment_end_date | date | Renewal/expiry date |
| empanelment_status | enum | active, expired, suspended, pending_renewal |
| empanelment_type | enum | cashless, reimbursement, both |
| provider_id | text | Hospital's ID in this panel's system |
| network_type | text | e.g., "Preferred Provider", "Standard" |

#### 2.3.2 Contacts on the Relationship
- **Hospital POC:** Name, designation, email, phone
- **Insurance POC (at the insurer's end):** Name, email, phone, region
- **Relationship Manager:** Name, email, phone

#### 2.3.3 Portal Access Configuration
| Field | Type | Notes |
|-------|------|-------|
| portal_name | text | e.g., "MediAssist Provider Portal" |
| portal_url | text | Login URL |
| portal_username | text | Encrypted |
| portal_password | text | Encrypted (AES-256) |
| auth_mechanism | enum | password_only, otp, password_and_otp, sso, certificate |
| two_fa_enabled | boolean | |
| two_fa_type | enum | sms_otp, email_otp, totp_app, none |
| two_fa_contact_type | enum | hospital_poc, finance_head, institution_head, custom |
| two_fa_contact_name | text | Name of person receiving OTP |
| two_fa_contact_phone | text | Phone receiving OTP |
| two_fa_contact_email | text | Email receiving OTP |
| portal_notes | text | Free-form notes |

#### 2.3.4 Contract & MoU Extracted Fields
When a contract or MoU document is uploaded to this empanelment, a `panel_documents` record is created. Key fields can be extracted (manually or via AI):

| Extracted Field | Examples |
|----------------|---------|
| effective_date | Start date of rate agreement |
| expiry_date | Renewal date |
| room_rent_general | ₹ per day |
| room_rent_icu | ₹ per day |
| package_rates | JSONB — procedure: rate |
| exclusions | JSONB — list of exclusions |
| payment_terms | Text — e.g., "30 days from discharge" |
| pre_auth_validity | Text — e.g., "7 days" |
| query_resolution_tat | Text |
| settlement_tat | Text |

---

### 2.4 Public Hospital Profile

A hospital can publish a public profile page at:

```
https://app.finclarity.in/h/{public_slug}
```

or via a unique token:

```
https://app.finclarity.in/profile/{share_token}
```

**Public profile displays:**
- Hospital name, logo, address, specialties, type
- Accreditations with verified badge indicators
- Bed counts (if opted in to share)
- Key contact (public contact only — not TPA/finance details)
- Verified badge (if verification is complete)
- Panels they're empanelled with (names only — no credentials)

**Privacy controls per hospital:**
- Toggle which sections are visible on public profile
- Share via link (time-limited token or permanent slug)
- Disable public profile entirely

---

### 2.5 Verified Badge System

| Verification Level | Requirements |
|-------------------|-------------|
| **Basic** | Hospital name, address, phone verified against Rohini/HFR |
| **Standard** | + Registration certificate uploaded and reviewed |
| **Premium** | + At least one accreditation (NABH/JCI/CGHS) verified |
| **Finclarity Verified** | + All key contacts confirmed + banking details validated |

Badge is issued by a Finclarity admin. Badge state: `pending`, `in_review`, `verified`, `revoked`.

---

### 2.6 Cashless Everywhere

Cashless Everywhere (CE) is a network that enables any hospital with a Rohini ID to process cashless claims from any insurer — bypassing traditional empanelment.

**Implementation:**
- CE is automatically activated for all hospitals with a valid Rohini ID
- A dedicated "Cashless Everywhere" panel record exists in the `panels` table
- CE does not require portal credentials or MoU — it works via a centralized gateway
- CE claims follow a separate flow: CE pre-auth → Finclarity gateway → insurer
- CE has its own fee structure and claim limits

**Hospital configuration for CE:**
- CE opted in by default; can opt out
- CE-specific POC contact (who receives CE-related notifications)
- CE portal URL (read-only — provided by CE network)
- CE hospital code (assigned by CE)

---

## 3. Data Model & Database Migrations

### 3.1 New Tables

#### `hospital_profile` — Structured profile replacing `hospitals.details` JSONB

```sql
-- Migration: 002_hospital_profile.sql

CREATE TABLE hospital_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  
  -- Section A: Identity
  legal_name TEXT,
  rohini_id TEXT,
  hfr_id TEXT,
  pan_number TEXT,
  gst_number TEXT,
  website TEXT,
  email TEXT,
  phone TEXT,
  established_year INT,
  
  -- Section B: Address (normalized out of JSONB)
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  district TEXT,
  state TEXT,
  pincode TEXT,
  latitude DECIMAL(9, 6),
  longitude DECIMAL(9, 6),
  google_maps_url TEXT,
  
  -- Section D: Hospital type
  hospital_type TEXT CHECK (hospital_type IN (
    'single_specialty', 'multi_specialty', 'nursing_home', 'day_care_center'
  )),
  specialties TEXT[] DEFAULT '{}',
  broad_specialties TEXT[] DEFAULT '{}',
  super_specialties TEXT[] DEFAULT '{}',
  
  -- Section E: Bed counts (JSONB for flexibility)
  beds JSONB DEFAULT '{}',
  -- Structure: { general_ward: 0, sharing: 0, private: 0, deluxe: 0, burns: 0 }
  
  icu_beds JSONB DEFAULT '{}',
  -- Structure: { micu: 0, iccu: 0, nicu: 0, picu: 0, neuro_icu: 0, sicu: 0 }
  
  ot_emergency JSONB DEFAULT '{}',
  -- Structure: { emergency_room: 0, trauma: 0, minor_ot: 0, major_ot: 0, cath_lab: 0 }
  
  -- Section F: Equipment (JSONB: equipment_name -> count)
  equipment JSONB DEFAULT '{}',
  
  -- Section G: Services (JSONB: specialty -> capability_flags)
  services JSONB DEFAULT '{}',
  
  -- Section H: Lab capabilities (JSONB: lab_type -> boolean)
  lab_capabilities JSONB DEFAULT '{}',
  
  -- Section J: Room rents (JSONB: room_type -> rate_per_day)
  room_rents JSONB DEFAULT '{}',
  
  -- Section K: Staff counts
  staff_counts JSONB DEFAULT '{}',
  -- Structure: { resident_doctors: 0, specialists: 0, visiting: 0, nursing: 0, paramedical: 0 }
  
  -- Section L: Compliance checklist (JSONB: item -> boolean)
  compliance_checklist JSONB DEFAULT '{}',
  
  -- In-house facilities (JSONB: facility -> boolean)
  in_house_facilities JSONB DEFAULT '{}',
  -- Structure: { blood_bank: false, ambulance: false, pharmacy: false, defibrillator: false, o2_supply: false }
  
  -- Section N: Banking details (encrypted at application layer)
  bank_details JSONB DEFAULT '{}',
  -- Structure: { cheque_name, bank_name, branch, address, account_number, ifsc, account_type, pan_name, pan_number, micr }
  
  -- Verification / Badge
  verification_level TEXT CHECK (verification_level IN (
    'none', 'basic', 'standard', 'premium', 'finclarity_verified'
  )) DEFAULT 'none',
  verification_status TEXT CHECK (verification_status IN (
    'not_submitted', 'pending', 'in_review', 'verified', 'revoked'
  )) DEFAULT 'not_submitted',
  verification_notes TEXT,
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  
  -- Public profile
  public_slug TEXT UNIQUE,
  is_public_profile_enabled BOOLEAN DEFAULT FALSE,
  public_profile_sections JSONB DEFAULT '{}',
  -- Which sections are visible: { identity: true, beds: false, contacts: false, ... }
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE (hospital_id)
);

CREATE INDEX idx_hospital_profile_hospital_id ON hospital_profile(hospital_id);
CREATE INDEX idx_hospital_profile_public_slug ON hospital_profile(public_slug) WHERE public_slug IS NOT NULL;
CREATE INDEX idx_hospital_profile_verification ON hospital_profile(verification_status, verification_level);
```

---

#### `hospital_certifications` — Accreditations & registrations

```sql
CREATE TABLE hospital_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  
  cert_type TEXT NOT NULL CHECK (cert_type IN (
    'state_govt', 'cghs', 'min_of_health', 'jci', 'nabh', 'nabl', 'iso', 'other'
  )),
  cert_name TEXT,                    -- e.g., "NABH Full Accreditation"
  issuing_body TEXT,
  certificate_number TEXT,
  issue_date DATE,
  expiry_date DATE,
  document_id UUID REFERENCES hospital_doc(id),  -- Link to uploaded cert document
  
  is_active BOOLEAN DEFAULT TRUE,
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ,
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_hospital_certs_hospital_id ON hospital_certifications(hospital_id);
CREATE INDEX idx_hospital_certs_expiry ON hospital_certifications(expiry_date) WHERE is_active = TRUE;
```

---

#### `hospital_key_contacts` — Institution head, finance, TPA, etc.

```sql
CREATE TABLE hospital_key_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  
  contact_type TEXT NOT NULL CHECK (contact_type IN (
    'institution_head', 'finance_head', 'tpa_contact', 'it_contact',
    'medical_superintendent', 'billing_manager', 'ceo', 'other'
  )),
  name TEXT NOT NULL,
  designation TEXT,
  email TEXT,
  phone TEXT,
  alternate_phone TEXT,
  is_primary BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT FALSE,   -- Show on public profile?
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_hospital_contacts_hospital_id ON hospital_key_contacts(hospital_id);
```

---

#### `panel_empanelments` — Enriched hospital-panel relationship

```sql
-- This extends (and eventually replaces) hospital_panels
-- For backward compat, initially create as separate table linked to hospital_panels

CREATE TABLE panel_empanelments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_panel_id UUID NOT NULL REFERENCES hospital_panels(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospitals(id),
  panel_id UUID NOT NULL REFERENCES panels(id),
  
  -- Empanelment Metadata
  empanelment_start_date DATE,
  empanelment_end_date DATE,
  empanelment_status TEXT CHECK (empanelment_status IN (
    'active', 'expired', 'suspended', 'pending_renewal', 'terminated'
  )) DEFAULT 'active',
  empanelment_type TEXT CHECK (empanelment_type IN (
    'cashless', 'reimbursement', 'both'
  )) DEFAULT 'cashless',
  provider_id TEXT,              -- Hospital's provider ID in this panel's system
  network_type TEXT,             -- e.g., "Preferred Provider"
  
  -- Hospital POC for this panel
  hospital_poc_name TEXT,
  hospital_poc_designation TEXT,
  hospital_poc_email TEXT,
  hospital_poc_phone TEXT,
  
  -- Insurance company POC
  insurer_poc_name TEXT,
  insurer_poc_email TEXT,
  insurer_poc_phone TEXT,
  insurer_poc_region TEXT,       -- e.g., "Central", "North"
  
  -- Relationship Manager
  rm_name TEXT,
  rm_email TEXT,
  rm_phone TEXT,
  
  -- Portal Access
  portal_name TEXT,
  portal_url TEXT,
  portal_username TEXT,          -- Encrypted at app layer
  portal_password_enc TEXT,      -- AES-256 encrypted
  auth_mechanism TEXT CHECK (auth_mechanism IN (
    'password_only', 'otp', 'password_and_otp', 'sso', 'certificate', 'none'
  )) DEFAULT 'password_only',
  two_fa_enabled BOOLEAN DEFAULT FALSE,
  two_fa_type TEXT CHECK (two_fa_type IN (
    'sms_otp', 'email_otp', 'totp_app', 'none'
  )) DEFAULT 'none',
  two_fa_contact_type TEXT CHECK (two_fa_contact_type IN (
    'hospital_poc', 'finance_head', 'institution_head', 'custom'
  )),
  two_fa_contact_name TEXT,
  two_fa_contact_phone TEXT,
  two_fa_contact_email TEXT,
  portal_notes TEXT,
  
  -- Extracted contract key fields (from most recent active contract)
  contract_effective_date DATE,
  contract_expiry_date DATE,
  contract_package_rates JSONB DEFAULT '{}',
  -- Structure: { "CABG": 120000, "Angioplasty": 150000, ... }
  contract_room_rents JSONB DEFAULT '{}',
  contract_exclusions JSONB DEFAULT '[]',
  contract_payment_terms TEXT,
  contract_pre_auth_validity TEXT,
  contract_query_resolution_tat TEXT,
  contract_settlement_tat TEXT,
  
  -- Additional metadata
  empanelment_notes TEXT,
  internal_tags TEXT[] DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE (hospital_panel_id)
);

CREATE INDEX idx_panel_empanelments_hospital ON panel_empanelments(hospital_id);
CREATE INDEX idx_panel_empanelments_panel ON panel_empanelments(panel_id);
CREATE INDEX idx_panel_empanelments_status ON panel_empanelments(empanelment_status);
CREATE INDEX idx_panel_empanelments_expiry ON panel_empanelments(empanelment_end_date) 
  WHERE empanelment_status = 'active';
```

---

#### `panel_documents` — Contracts, MoUs, and other per-panel documents

```sql
CREATE TABLE panel_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_empanelment_id UUID NOT NULL REFERENCES panel_empanelments(id) ON DELETE CASCADE,
  hospital_id UUID NOT NULL REFERENCES hospitals(id),
  panel_id UUID NOT NULL REFERENCES panels(id),
  
  doc_type TEXT NOT NULL CHECK (doc_type IN (
    'contract', 'mou', 'rate_card', 'empanelment_letter',
    'network_agreement', 'addendum', 'other'
  )),
  doc_name TEXT NOT NULL,
  
  -- S3 storage (same pattern as hospital_doc)
  s3_key TEXT,
  s3_bucket TEXT,
  file_name TEXT,
  file_size_bytes BIGINT,
  mime_type TEXT,
  
  is_active BOOLEAN DEFAULT TRUE,       -- Most recent active = current contract
  effective_date DATE,
  expiry_date DATE,
  
  -- AI/manual extraction status
  extraction_status TEXT CHECK (extraction_status IN (
    'pending', 'processing', 'completed', 'failed', 'not_applicable'
  )) DEFAULT 'not_applicable',
  extracted_fields JSONB DEFAULT '{}',  -- Raw extracted data before review
  extraction_reviewed BOOLEAN DEFAULT FALSE,
  extraction_reviewed_by UUID REFERENCES users(id),
  extraction_reviewed_at TIMESTAMPTZ,
  
  uploaded_by UUID REFERENCES users(id),
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_panel_docs_empanelment ON panel_documents(panel_empanelment_id);
CREATE INDEX idx_panel_docs_hospital ON panel_documents(hospital_id);
CREATE INDEX idx_panel_docs_type ON panel_documents(doc_type);
```

---

#### `public_share_tokens` — Shareable profile/patient links

```sql
CREATE TABLE public_share_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'hospital_profile', 'patient_summary', 'ipd_discharge_summary'
  )),
  resource_id UUID NOT NULL,          -- hospital_id, ipd_id, etc.
  
  -- Access control
  created_by UUID REFERENCES users(id),
  is_active BOOLEAN DEFAULT TRUE,
  expires_at TIMESTAMPTZ,             -- NULL = permanent link
  max_views INT,                      -- NULL = unlimited
  view_count INT DEFAULT 0,
  
  -- What's visible on this share
  visible_sections JSONB DEFAULT '{}',
  -- For hospital_profile: { identity, beds, contacts, certifications, panels }
  -- For patient_summary: { demographics, diagnosis, treatment, discharge }
  
  -- Tracking
  last_viewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_share_tokens_token ON public_share_tokens(token);
CREATE INDEX idx_share_tokens_resource ON public_share_tokens(resource_type, resource_id);
```

---

### 3.2 Modifications to Existing Tables

```sql
-- Migration: 002b_hospital_table_updates.sql

-- Add drive_folder_id nullable (currently NOT NULL — blocks S3-only flow)
ALTER TABLE hospitals ALTER COLUMN drive_folder_id DROP NOT NULL;

-- Add cashless_everywhere fields
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS ce_opted_in BOOLEAN DEFAULT TRUE;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS ce_hospital_code TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS ce_activated_at TIMESTAMPTZ;

-- Mark hospitals.details as deprecated (do not drop yet — backward compat)
COMMENT ON COLUMN hospitals.details IS 
  'DEPRECATED: Use hospital_profile table. Will be removed in migration 005.';

-- Add document category to hospital_doc
ALTER TABLE hospital_doc ADD COLUMN IF NOT EXISTS doc_category TEXT CHECK (doc_category IN (
  'registration', 'accreditation', 'legal', 'mou', 'contract',
  'id_proof', 'logo', 'photo', 'brochure', 'other'
)) DEFAULT 'other';

ALTER TABLE hospital_doc ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE;
ALTER TABLE hospital_doc ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE hospital_doc ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id);
ALTER TABLE hospital_doc ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- panels table: add Cashless Everywhere and type
ALTER TABLE panels ADD COLUMN IF NOT EXISTS panel_type TEXT CHECK (panel_type IN (
  'insurance', 'tpa', 'government', 'cashless_everywhere', 'other'
)) DEFAULT 'insurance';
ALTER TABLE panels ADD COLUMN IF NOT EXISTS is_system_panel BOOLEAN DEFAULT FALSE;
-- CE panel will have is_system_panel = TRUE

-- hospital_panels: soft deprecate in favor of panel_empanelments
-- (keep existing table, just add a link)
ALTER TABLE hospital_panels ADD COLUMN IF NOT EXISTS has_empanelment_record BOOLEAN DEFAULT FALSE;
```

---

### 3.3 Seed: Cashless Everywhere Panel

```sql
-- Run after migration 002b
INSERT INTO panels (id, name, panel_type, is_system_panel, created_at)
VALUES (
  gen_random_uuid(),
  'Cashless Everywhere',
  'cashless_everywhere',
  TRUE,
  NOW()
)
ON CONFLICT DO NOTHING;
```

---

### 3.4 Migration: Migrate Existing `hospitals.details` JSONB

```sql
-- Migration: 003_migrate_hospital_details.sql
-- Run AFTER 002_hospital_profile.sql

INSERT INTO hospital_profile (
  hospital_id,
  rohini_id,
  hfr_id,
  pan_number,
  website,
  email,
  phone,
  address_line1,
  city,
  district,
  state,
  pincode,
  hospital_type,
  specialties
)
SELECT
  h.id,
  h.details->>'rohini_id',
  h.details->>'hfr_id',
  h.details->>'pan_number',
  h.details->>'website',
  h.details->>'email',
  h.details->>'phone',
  h.details->>'address',
  h.details->>'city',
  h.details->>'district',
  h.details->>'state',
  h.details->>'pincode',
  CASE 
    WHEN h.details->>'hospital_type' IS NOT NULL 
    THEN lower(replace(h.details->>'hospital_type', ' ', '_'))
    ELSE NULL
  END,
  CASE 
    WHEN h.details->'specialties' IS NOT NULL 
    THEN ARRAY(SELECT jsonb_array_elements_text(h.details->'specialties'))
    ELSE '{}'
  END
FROM hospitals h
WHERE NOT EXISTS (
  SELECT 1 FROM hospital_profile hp WHERE hp.hospital_id = h.id
);
```

---

## 4. API Design

### 4.1 Hospital Profile Endpoints

```
GET    /api/v1/hospitals/:hospitalId/profile          — Get full profile
PUT    /api/v1/hospitals/:hospitalId/profile          — Update profile (full or partial sections)
PATCH  /api/v1/hospitals/:hospitalId/profile/section  — Update one section (body: { section, data })

GET    /api/v1/hospitals/:hospitalId/certifications   — List certifications
POST   /api/v1/hospitals/:hospitalId/certifications   — Add certification
PUT    /api/v1/hospitals/:hospitalId/certifications/:id
DELETE /api/v1/hospitals/:hospitalId/certifications/:id

GET    /api/v1/hospitals/:hospitalId/contacts         — List key contacts
POST   /api/v1/hospitals/:hospitalId/contacts         — Add contact
PUT    /api/v1/hospitals/:hospitalId/contacts/:id
DELETE /api/v1/hospitals/:hospitalId/contacts/:id
```

### 4.2 Panel Empanelment Endpoints

```
GET    /api/v1/hospitals/:hospitalId/empanelments              — List all empanelments
POST   /api/v1/hospitals/:hospitalId/empanelments              — Create empanelment record
GET    /api/v1/hospitals/:hospitalId/empanelments/:id          — Get full empanelment detail
PUT    /api/v1/hospitals/:hospitalId/empanelments/:id          — Update empanelment
DELETE /api/v1/hospitals/:hospitalId/empanelments/:id

-- Portal credentials (separate — for permission scoping)
GET    /api/v1/hospitals/:hospitalId/empanelments/:id/credentials   — Decrypt and return (admin only)
PUT    /api/v1/hospitals/:hospitalId/empanelments/:id/credentials

-- Panel documents
GET    /api/v1/hospitals/:hospitalId/empanelments/:id/documents
POST   /api/v1/hospitals/:hospitalId/empanelments/:id/documents/upload
DELETE /api/v1/hospitals/:hospitalId/empanelments/:id/documents/:docId
PUT    /api/v1/hospitals/:hospitalId/empanelments/:id/documents/:docId/extracted-fields
```

### 4.3 Public Profile & Share Token Endpoints

```
-- Public (no auth)
GET    /api/public/h/:slug                           — Get public hospital profile by slug
GET    /api/public/share/:token                      — Get shared resource by token

-- Authenticated (hospital or admin)
POST   /api/v1/hospitals/:hospitalId/profile/share   — Create share token
GET    /api/v1/hospitals/:hospitalId/profile/share   — List share tokens
DELETE /api/v1/hospitals/:hospitalId/profile/share/:tokenId

-- Admin verification
POST   /api/v1/admin/hospitals/:hospitalId/verify    — Submit for verification
PUT    /api/v1/admin/hospitals/:hospitalId/verify    — Update verification status
```

### 4.4 Cashless Everywhere Endpoints

```
GET    /api/v1/hospitals/:hospitalId/cashless-everywhere        — CE status & config
PUT    /api/v1/hospitals/:hospitalId/cashless-everywhere        — Update CE config
POST   /api/v1/hospitals/:hospitalId/cashless-everywhere/opt-out
POST   /api/v1/hospitals/:hospitalId/cashless-everywhere/opt-in
```

---

## 5. Implementation Plan (Phased)

### Phase 1 — Database & Backend Core (Weeks 1–2)

**Step 1.1 — Database migrations**
1. Write and test `002_hospital_profile.sql` locally
2. Write `002b_hospital_table_updates.sql` (ALTER TABLE changes)
3. Write `003_migrate_hospital_details.sql` (data migration)
4. Write `003b_cashless_everywhere_seed.sql`
5. Add rollback scripts for each migration
6. Fix critical bug: make `drive_folder_id` nullable

**Step 1.2 — Backend: Hospital Profile CRUD**
1. Create `hospital_profile.controller.ts`
2. Create `hospital_profile.service.ts` — handles section-level updates, Zod validation per section
3. Create `hospital_certifications.controller.ts`
4. Create `hospital_key_contacts.controller.ts`
5. Add routes to `index.ts` under `/api/v1/hospitals/:id/profile`
6. Middleware: hospital users can only update their own profile; admin/superadmin can update any

**Step 1.3 — Backend: Panel Empanelments**
1. Create `panel_empanelments.controller.ts`
2. Create encryption service for portal credentials (`portal_password_enc`) — use `aes-256-gcm` with key from environment
3. Add `PORTAL_CREDS_ENCRYPTION_KEY` to `.env`
4. Credential endpoint: decrypt only for admin role; hospital user sees masked password
5. Add routes under `/api/v1/hospitals/:id/empanelments`

**Step 1.4 — Backend: Panel Documents**
1. Extend upload pipeline (V2) to accept `empanelment_id` and `doc_type` params
2. Create `panel_documents.controller.ts`
3. On upload: create `panel_documents` record, set `extraction_status = 'pending'`
4. Add `doc_category` support to existing `hospital_doc` upload endpoint

### Phase 2 — Webapp UI (Weeks 3–4)

**Step 2.1 — Hospital Profile Page**
1. New route: `/portal/:hospitalId/profile`
2. Sectioned form using Tabs component (shadcn/ui): Identity → Address → Accreditations → Type & Specialties → Infrastructure → Staff → Compliance → Contacts → Banking
3. Auto-save on section blur (PATCH to `/profile/section`)
4. Profile completion progress bar (% of required fields filled)
5. Upload certifications inline with document preview

**Step 2.2 — Panel Empanelment Management**
1. New route: `/portal/:hospitalId/panels`
2. Panel card grid showing all empanelments with status badges
3. Empanelment detail drawer: contacts, portal access, contract info
4. Password visibility toggle with re-auth (enter password to reveal)
5. Upload contract/MoU directly on panel detail view

**Step 2.3 — Admin Views**
1. Hospital profile review page for admins
2. Verification workflow: checklist + approve/reject per section
3. Document viewer for certification verification
4. Badge assignment UI

### Phase 3 — Public Profiles & Shareable Links (Week 5)

**Step 3.1 — Public Profile Page**
1. New public route (outside PrivateRoute): `/h/:slug`
2. SSR-friendly React page (no auth required)
3. Show: logo, name, location, specialties, accreditations + verified badge, public contact
4. CE badge if hospital is CE-active
5. "Verified by Finclarity" stamp with verification level

**Step 3.2 — Share Token System**
1. Backend: `public_share_tokens` table CRUD
2. Token-based access: `/api/public/share/:token`
3. Webapp: "Share Profile" button in hospital portal
4. Share dialog: choose sections, set expiry, copy link
5. Patient summary share (for discharge summaries): generate per-IPD share link

**Step 3.3 — Cashless Everywhere**
1. CE panel auto-created for all hospitals on onboarding
2. CE status widget on hospital dashboard
3. Opt-out flow with confirmation

### Phase 4 — Contract Extraction & Portal Automation (Weeks 6–8)

**Step 4.1 — Document Extraction (Manual MVP)**
1. After contract upload: admin sees "Extract Key Fields" action
2. Admin fills in extracted fields form (effective date, room rents, package rates, payment terms)
3. System copies confirmed fields into `panel_empanelments.contract_*` columns
4. Future: integrate Claude API for AI extraction (out of scope for MVP)

**Step 4.2 — Renewal Alerts**
1. Cron job: daily check for empanelments expiring within 30/60/90 days
2. WhatsApp/email notification to hospital POC and Finclarity admin
3. Dashboard widget: "Upcoming Renewals"

**Step 4.3 — Portal Management Dashboard (Superadmin)**
1. Cross-hospital view: all portals grouped by panel/insurer
2. Status: credential last updated, last login, 2FA status
3. Export: generate empanelment status report per hospital

---

## 6. Module Impact Analysis

### 6.1 `hospitals` Controller (`hospitalContoller.ts`)

| Impact | Change Required |
|--------|----------------|
| `createHospital` | After DB insert, also create an empty `hospital_profile` record. Remove Drive folder creation or make it optional (fix `drive_folder_id` NOT NULL constraint). |
| `updateHospital` | Existing `details` JSONB update should also sync to `hospital_profile` (temporary bridge during migration). |
| `getHospital` | Enrich response with `hospital_profile` join. Old `details` field still returned for backward compat until migration is complete. |
| `addPatient` | Remove or isolate Drive folder creation — it must not block patient creation if Drive is unavailable. |
| Validation (Zod) | Current `hospitalDetailsSchema` (30+ fields) should be split per section and moved to `hospital_profile` validators. |

### 6.2 `hospital_panels` & Panel Management

| Impact | Change Required |
|--------|----------------|
| `createHospitalPanel` | After creation, auto-create a `panel_empanelments` record linked to it. Set `has_empanelment_record = TRUE` on `hospital_panels`. |
| Panel listing | Enrich panel list response with `panel_empanelments` data (status, expiry, portal name). |
| Panel detail | New endpoint returns full empanelment detail. |

### 6.3 Auth Middleware (`auth.middleware.ts`)

| Impact | Change Required |
|--------|----------------|
| `checkHospitalUserPermission` | Needs to allow hospital users to access `/profile` and `/empanelments` endpoints for their own hospital. |
| Credential endpoints | New middleware: `requireAdminForCredentials` — only admin/superadmin can decrypt portal passwords. |
| Public endpoints | New router group outside `verifyToken` middleware for `/api/public/*`. |

### 6.4 Upload Pipeline (V2)

| Impact | Change Required |
|--------|----------------|
| `POST /api/v2/uploads` | Add optional `empanelment_id` and `panel_doc_type` params. If present, create `panel_documents` record instead of `ipd_doc`. |
| `hospital_doc` upload | Add `doc_category` and `is_public` to upload request body. |
| Existing S3 key format | No change to IPD document keys. Panel docs use new key pattern: `panels/{panel_id}/{hospital_id}/{doc_type}/{ts}_{name}` |

### 6.5 Flutter Mobile App

| Impact | Change Required |
|--------|----------------|
| Hospital dashboard | Add "Profile Completion" indicator. |
| No new screens needed in Phase 1 | Panel management and profile editing is webapp-first. |
| Phase 3 | Add public profile share button in Flutter app. |
| Notifications | Add CE notification type to notification handler. |

### 6.6 Google Sheets Webhook

| Impact | Change Required |
|--------|----------------|
| None in Phase 1–2 | Hospital profile data is not synced to Sheets (Sheets is patient-level only). |
| Phase 4 potential | Consider pushing empanelment renewal alerts to a Sheets tracking tab. |

### 6.7 Notification System (WhatsApp/Bull)

| Impact | Change Required |
|--------|----------------|
| New notification types | `EMPANELMENT_EXPIRING_SOON`, `VERIFICATION_STATUS_CHANGED`, `CE_ACTIVATED` |
| Notification routing | Empanelment notifications go to `hospital_poc_phone` (from `panel_empanelments`), not the generic hospital phone. |
| Add to `NotificationBufferService` | Add new event types; ensure they are not subject to debounce (send immediately). |

### 6.8 Existing `hospital_doc` Table

| Impact | Change Required |
|--------|----------------|
| Add `doc_category` column (Migration 002b) | Backfill existing records with `doc_category = 'other'`. |
| Existing hospital doc APIs | No breaking changes; new fields are optional and additive. |
| Certification verification | When `verified_by` is set on a `hospital_certifications` record, update the linked `hospital_doc.verified_at` too. |

---

## 7. Public Profile & Shareable Links

### Architecture

```
Public URL: https://app.finclarity.in/h/pragati-medcity-bhopal

Request flow:
Browser → CloudFront → S3 static React bundle → React Router
→ renders PublicHospitalProfile component
→ fetches GET /api/public/h/:slug (no auth, no token)
→ backend returns only sections where is_public = TRUE
```

### Slug Generation
- Slug: `{kebab-case-hospital-name}-{city}` with uniqueness suffix if collision
- Example: `pragati-medcity-bhopal`, `pragati-medcity-bhopal-2`
- Hospital can also set a custom slug (validated unique, alphanumeric + hyphens only)

### Share Token vs Public Slug
| | Public Slug | Share Token |
|--|-------------|-------------|
| URL form | `/h/slug` | `/share/abc123xyz` |
| Persistence | Permanent | Can be time-limited |
| Auth | None | None (token is the auth) |
| Revocable | Only by disabling profile | Yes — delete token |
| Use case | Permanent public profile | Sharing specific data ad-hoc |
| Patient data | No | Yes (discharge summary) |

### Patient Data Sharing (Abroad Insurers)

For sharing patient data (e.g., for abroad insurer pre-approvals or second opinions):

- Only IPD-level summaries are shareable — not raw documents
- Share token is created per-IPD with explicit section selection
- Token expires after 7 days by default (configurable up to 90 days)
- Visible sections: demographics (name, DOB, gender), diagnosis, treatment summary, discharge summary
- PII masking option: share with name/DOB masked (just patient ID shown)
- Access log: every view logged with IP + timestamp

---

## 8. Portal Management & Cashless Everywhere

### Portal Credential Encryption

Portal passwords stored in `panel_empanelments.portal_password_enc` are encrypted at the application layer before DB write:

```typescript
// services/encryption.service.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(process.env.PORTAL_CREDS_KEY!, 'hex'); // 32 bytes

export function encryptCredential(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptCredential(ciphertext: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  const decipher = createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8');
}
```

**Key management:** `PORTAL_CREDS_KEY` is separate from `JWT_SECRET`. Store in AWS Secrets Manager or Parameter Store, not in `.env` in production.

### Cashless Everywhere Integration

CE operates differently from standard panel empanelments:

```
Standard Cashless: Hospital → TPA Portal → Pre-auth → Insurer
Cashless Everywhere: Hospital → CE Gateway → Rohini Lookup → Any Insurer
```

CE-specific configuration on `panel_empanelments` for the CE panel:
- `provider_id` = CE hospital code (assigned by CE network)
- `portal_url` = CE portal (read-only reference)
- `auth_mechanism` = `certificate` or `password_and_otp`
- No `contract_*` fields needed (CE has fixed rates from the network)
- `empanelment_type` = `cashless` only

On hospital creation: auto-create `hospital_panels` + `panel_empanelments` linking to the CE panel.

---

## 9. Verified Badge System

### Verification Workflow

```
Hospital submits → Finclarity admin reviews → Badge issued

States: not_submitted → pending → in_review → verified | revoked
```

### Admin Verification Checklist

For each level, admin must check these items:

**Basic Verification:**
- [ ] Hospital name matches Rohini database lookup
- [ ] Address is valid and geocoded
- [ ] Phone number verified (OTP or callback)

**Standard Verification (+ Basic):**
- [ ] State registration certificate uploaded and valid (not expired)
- [ ] PAN card uploaded and number matches legal name

**Premium Verification (+ Standard):**
- [ ] At least one NABH / JCI / CGHS certificate uploaded, verified, not expired
- [ ] Accreditation number cross-checked with issuing body

**Finclarity Verified (+ Premium):**
- [ ] All 3 key contacts (institution head, finance, TPA) confirmed reachable
- [ ] Banking details validated (cancelled cheque or bank statement)
- [ ] At least 1 active empanelment with a recognized insurer

### Badge Display Logic

```typescript
// Verification badge tiers
const BADGE_CONFIG = {
  finclarity_verified: { label: 'Finclarity Verified', color: 'gold',    icon: 'shield-check' },
  premium:             { label: 'Premium Verified',    color: 'blue',    icon: 'award' },
  standard:            { label: 'Standard Verified',   color: 'green',   icon: 'check-circle' },
  basic:               { label: 'Basic Verified',      color: 'gray',    icon: 'check' },
  none:                { label: null,                   color: null,      icon: null },
};
```

---

## 10. Open Questions & Decisions

| # | Question | Recommendation |
|---|----------|---------------|
| 1 | **AI extraction for contracts?** Should Phase 4 use Claude API to auto-extract rate cards from contract PDFs? | Yes — Claude Sonnet 4.6 can extract structured JSON from contract PDFs reliably. Implement as background job triggered after contract upload. |
| 2 | **Portal credential access control** — should hospital users see their own portal passwords, or admin-only? | Admin and superadmin only. Hospital user can see username but not password. Display masked "••••••••" with "Request credentials" flow. |
| 3 | **`hospitals.details` JSONB deprecation timeline** — when to drop? | Keep for 2 migrations (until all data confirmed in `hospital_profile`). Drop in migration 005 with a `NOT NULL` guard on `hospital_profile`. |
| 4 | **Public profile for all hospitals or opt-in?** | Default off, hospital opts in. Superadmin can force-enable for verified hospitals. |
| 5 | **Cashless Everywhere claim flow** — separate IPD type or flag on existing IPD? | Add `claim_network TEXT` column to `ipds` (values: `panel`, `cashless_everywhere`, `reimbursement`). Existing claims default to `panel`. |
| 6 | **Rohini ID as login identifier?** — hospitals currently log in by email. Should Rohini ID also work? | Add Rohini ID lookup in `auth.controller.ts`. Match `hospital_profile.rohini_id` → get `hospital_id` → login. |

---

*Document generated April 2026 — Finclarity / ClaimOS Hospital Profile Management v1.0*
