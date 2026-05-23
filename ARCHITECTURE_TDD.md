# ClaimOS — Technical Design Document (TDD) & Architecture Review

> **Version:** 1.0 — April 2026
> **Scope:** Full end-to-end review: Backend (Node/TS), Webapp (React), Mobile App (Flutter), Database (PostgreSQL)

---

## Table of Contents
1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Technology Stack](#3-technology-stack)
4. [Database Design](#4-database-design)
5. [Backend Architecture](#5-backend-architecture)
6. [API Reference Summary](#6-api-reference-summary)
7. [File Storage Architecture](#7-file-storage-architecture)
8. [Authentication & RBAC](#8-authentication--rbac)
9. [Background Workers & Queues](#9-background-workers--queues)
10. [Frontend (Flutter Mobile App)](#10-frontend-flutter-mobile-app)
11. [Webapp (React SPA)](#11-webapp-react-spa)
12. [Infrastructure & Deployment](#12-infrastructure--deployment)
13. [Code Review Findings](#13-code-review-findings)
14. [Gap Analysis](#14-gap-analysis)
15. [Recommended Enhancements](#15-recommended-enhancements)

---

## 1. System Overview

**ClaimOS** (also referenced internally as `24eleven-backend`) is a Hospital Insurance Claims Management Platform. It serves as an end-to-end system for managing IPD (In-Patient Department) patients, capturing medical documents, tracking insurance claims status, and syncing data to Google Sheets and WhatsApp groups.

### Core Actors
| Actor | Description |
|---|---|
| **Superadmin** | System operator. Full visibility. Manages hospitals, panels, admins. |
| **Admin** | Field agent. Manages one or more hospitals. Granular permissions (view/edit/discharge). |
| **Hospital User** | Bedside staff. Scoped to their hospital's specific panels. Uploads documents. |

### Core Business Flows
1. Hospital onboarded → linked to insurance Panel(s) → assigned Google Drive folder + WhatsApp group + Google Sheet
2. Patient admitted → IPD record created → Google Drive subfolder created → Sheet row added
3. Hospital staff uploads documents (discharge slips, OT notes, etc.) → S3 upload → WhatsApp notification
4. Claim data tracked against IPD (claim amount, status, settlement)
5. Admin views all docs, manages patient data, generates PDFs
6. Superadmin audits entire system

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLIENTS                                        │
│                                                                         │
│  ┌───────────────────┐  ┌─────────────────┐  ┌──────────────────────┐  │
│  │  Flutter Mobile   │  │  React Webapp   │  │  (Future: API       │  │
│  │  App (Android/iOS)│  │  (hospital/admin│  │   Consumers)        │  │
│  │                   │  │  /superadmin)   │  │                      │  │
│  └─────────┬─────────┘  └────────┬────────┘  └──────────┬───────────┘  │
└────────────│────────────────────│───────────────────────│──────────────┘
             │                    │                         │
             │  HTTPS / JWT Bearer Auth                     │
             ▼                    ▼                         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    BACKEND (Express 5 / Node.js / TypeScript)            │
│                    Port: 8000  —  Docker Container                       │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  API Routes (/api/v1/* and /api/v2/*)                           │    │
│  │  auth | patient | user | uploads | admin | audit | hospitals    │    │
│  │  hospital-docs | claims | doctors                               │    │
│  └──────────────────────────┬──────────────────────────────────────┘    │
│                             │                                            │
│  ┌──────────────────────────▼──────────────────────────────────────┐    │
│  │  Auth Middleware (JWT verify + DB role check)                   │    │
│  │  Roles: superadmin | admin | hospital                           │    │
│  └──────────────────────────┬──────────────────────────────────────┘    │
│                             │                                            │
│  ┌──────────────────────────▼──────────────────────────────────────┐    │
│  │  Controllers (Business Logic + DB Queries via pg pool)          │    │
│  └──────────────────────────┬──────────────────────────────────────┘    │
│                             │                                            │
│  ┌────────────────┐  ┌──────▼───────────┐  ┌─────────────────────────┐ │
│  │ UploadQueue    │  │  S3 Service      │  │  NotificationBuffer     │ │
│  │ (in-memory +  │  │  (AWS SDK v3)    │  │  (debounce batching)    │ │
│  │  disk persist) │  │  CloudFront CDN  │  └──────────┬──────────────┘ │
│  └───────┬────────┘  └──────────────────┘             │               │
│          │                                             ▼               │
│  ┌───────▼───────────────────────────────────────────────────────────┐  │
│  │  Bull / Redis Queues                                              │  │
│  │  - notification.queue (WhatsApp via UltraMsg)                    │  │
│  │  - drive-backup.queue (DISABLED — legacy)                        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
             │                              │
             ▼                              ▼
    ┌─────────────────┐          ┌────────────────────────┐
    │  PostgreSQL DB  │          │  AWS S3                │
    │  (hospital      │          │  + CloudFront CDN      │
    │   schema)       │          │  + Lambda@Edge         │
    └─────────────────┘          │  (webp conversion)     │
                                 └────────────────────────┘
                                          │
                                 ┌────────▼───────────────┐
                                 │  Google Drive (legacy  │
                                 │  backup — disabled)    │
                                 └────────────────────────┘
             │
             ▼
    ┌─────────────────────┐    ┌──────────────────────┐
    │  Redis (Bull queue) │    │  UltraMsg WhatsApp   │
    │  Port 6379          │    │  API (notifications) │
    └─────────────────────┘    └──────────────────────┘
             │
             ▼
    ┌─────────────────────┐
    │  Google Sheets      │
    │  (via Webhook URL)  │
    └─────────────────────┘
```

---

## 3. Technology Stack

### Backend
| Layer | Technology | Version |
|---|---|---|
| Runtime | Node.js | LTS |
| Language | TypeScript | ^5.9 |
| Framework | Express | ^5.2 |
| Database | PostgreSQL (via `pg`) | ^8.16 |
| ORM | Raw SQL (no ORM) | — |
| Queue | Bull + Redis | ^4.16 |
| File Storage | AWS S3 SDK v3 | ^3.984 |
| CDN | AWS CloudFront (signed URLs) | — |
| Auth | JWT (jsonwebtoken) + bcryptjs | — |
| Validation | Zod (partial) | ^4.3 |
| Metrics | prom-client (Prometheus) | ^15.1 |
| Image Processing | sharp, Ghostscript (GS) | — |
| Notifications | UltraMsg (WhatsApp) | — |
| Containerization | Docker + Docker Compose | — |

### Webapp
| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript (CRA + CRACO) |
| Routing | React Router v6 |
| HTTP Client | Axios (with interceptors) |
| UI Library | shadcn/ui + Tailwind CSS |
| Animations | Framer Motion |
| Notifications | Sonner (toasts) |
| PDF Generation | jsPDF (pdfGenerator service) |
| Build | CRACO (CRA override) |
| Containerization | Docker + nginx |

### Mobile App (Flutter)
| Layer | Technology |
|---|---|
| Framework | Flutter ^3.10 / Dart |
| HTTP Client | Dio ^5.9 (with interceptors) |
| Auth Storage | flutter_secure_storage |
| Camera | camera plugin |
| Gallery | photo_manager |
| Image Compression | flutter_image_compress |
| PDF Viewer | flutter_pdfview + pdfx |
| Location | geolocator + geocoding |
| Connectivity | connectivity_plus |
| Env Config | envied (env vars at compile time) |

### Infrastructure
| Component | Technology |
|---|---|
| DB | PostgreSQL (external, not Dockerized) |
| Cache/Queue | Redis 7 (Alpine, Docker) |
| Backend | Docker container |
| Webapp | Docker + nginx |
| File Storage | AWS S3 (`ap-south-1`) |
| CDN | AWS CloudFront (`d1m5dbrg9f4c2a.cloudfront.net`) |
| Version Control | Git |

---

## 4. Database Design

### Schema: `hospital` (search_path)

#### Entity Relationship Overview
```
users ──< hospital_assignments >── hospitals ──< hospital_panels >── panels
  │                                    │
  └──< hospital_users                  └──< ipds >── claims
                                           │
                                           └──< ipd_doc

hospitals ──< doctors ──< doctor_doc
hospitals ──< hospital_doc
```

### Table Definitions

#### `users`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | uuid_generate_v4() |
| first_name | VARCHAR(255) | NOT NULL |
| last_name | VARCHAR(255) | |
| username | VARCHAR(255) | UNIQUE NOT NULL |
| password | VARCHAR(255) | bcrypt hash |
| email | VARCHAR(255) | UNIQUE NOT NULL |
| phone | CHAR(10) | |
| is_active | BOOLEAN | DEFAULT TRUE |
| role | VARCHAR(255) | 'superadmin', 'admin', 'hospital' |
| last_login | TIMESTAMP TZ | |
| created_at / updated_at | TIMESTAMP TZ | auto-managed trigger |

#### `user_refresh_tokens`
| Column | Type | Notes |
|---|---|---|
| user_id | UUID FK → users | ON DELETE CASCADE |
| token_hash | VARCHAR(255) | bcrypt hash of refresh token |
| expires_at | TIMESTAMP TZ | NOT NULL |
| created_at | TIMESTAMP TZ | |

> One token per user (upsert pattern). No per-device support.

#### `hospitals`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | VARCHAR(255) | NOT NULL |
| city | VARCHAR(255) | |
| drive_folder_id | VARCHAR | NOT NULL — legacy, Drive being deprecated |
| details | JSONB | Structured hospital metadata |
| created_at / updated_at | TIMESTAMP TZ | |

**`details` JSONB schema** (validated via Zod on update):
`address, locality, region, state, district, pinCode, totalBeds, specialities, typeOfCare, ownership, validFromDate, hfrId, rohiniId, registrationNumber, registeringAuthority, panNumber, discountDeclaration, contactPersonName, contactNumber, hospitalEmail, tpaCoordinatorName/Contact/Email, cmoName/Contact/Email`

#### `panels` (Master Insurance Panels)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | VARCHAR(255) | e.g., 'PMJAY', 'ESI', 'CGHS' |
| created_at / updated_at | TIMESTAMP TZ | |

#### `hospital_panels` (Hospital ↔ Panel Linking)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| hospital_id | UUID FK → hospitals | CASCADE |
| panel_id | UUID FK → panels | CASCADE |
| whatsapp_group_id | VARCHAR(255) | UltraMsg group for notifications |
| sheet_id | VARCHAR(255) | Google Sheet ID for this panel |
| sheet_name | VARCHAR(255) | Sheet tab name |
| drive_folder_id | VARCHAR(255) | Panel-level Drive folder |
| contact | CHAR(10) | TPA contact number |

#### `hospital_assignments` (Admin ↔ Hospital with Permissions)
| Column | Type | Notes |
|---|---|---|
| hospital_id | UUID FK → hospitals | CASCADE |
| admin_id | UUID FK → users | CASCADE |
| assigned_by | UUID FK → users | SET NULL |
| can_view | BOOLEAN | DEFAULT TRUE |
| can_edit | BOOLEAN | DEFAULT FALSE |
| can_discharge | BOOLEAN | DEFAULT FALSE |
| assigned_at | TIMESTAMP TZ | |
| role | TEXT[] | Array of role labels |

> **NOTE:** Code references `is_active` on this table but it does NOT exist in the schema — a critical bug.

#### `hospital_users` (Hospital Staff Membership)
| Column | Type | Notes |
|---|---|---|
| hospital_id | UUID FK → hospitals | CASCADE |
| user_id | UUID FK → users | CASCADE |
| role | TEXT[] | Mixed: 'admin' string OR panel UUID strings |

> **Design Anti-Pattern:** `role[]` stores both a special string 'admin' and actual panel UUIDs. This makes queries like `$1 = ANY(role::uuid[])` error when 'admin' is in the array.

#### `ipds` (In-Patient Departments — Patients)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| first_name | VARCHAR(255) | NOT NULL |
| last_name | VARCHAR(255) | |
| phone | CHAR(10) | |
| admission_type | VARCHAR(255) | 'conservative', 'surgical' |
| admitted_at | TIMESTAMP TZ | |
| discharged_at | TIMESTAMP TZ | NULL = still admitted |
| stay | JSONB | Unused — purpose TBD |
| hospital_id | UUID FK → hospitals | CASCADE |
| drive_folder_id | VARCHAR(255) | Per-patient Drive folder (legacy) |
| is_active | BOOLEAN | DEFAULT TRUE — soft delete |
| beneficiary_id | VARCHAR(255) | PMJAY beneficiary number |
| panel_id | UUID FK → panels | SET NULL |
| hospital_panel_id | UUID FK → hospital_panels | SET NULL |
| created_at / updated_at | TIMESTAMP TZ | |

**Indexes:** hospital_id, panel_id, phone, admitted_at, is_active, composite(hospital_id, panel_id, is_active, discharged_at)

#### `claims`
| Column | Type | Notes |
|---|---|---|
| ipd_id | UUID PK FK → ipds | 1:1 with IPD |
| treatment_plan | TEXT | Procedure description |
| latest_status | TEXT | e.g., 'pending', 'approved', 'rejected' |
| claim_amount | DOUBLE PRECISION | Claimed amount |
| claim_approved | DOUBLE PRECISION | Approved amount |
| incentive | DOUBLE PRECISION | |
| deduction | DOUBLE PRECISION | |
| deduction_reason | TEXT | |
| claim_settled | DOUBLE PRECISION | Final settled amount |
| claim_settled_date | DATE | |
| created_at / updated_at | TIMESTAMP TZ | |

#### `ipd_doc` (Patient Documents)
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| ipd_id | UUID FK → ipds | CASCADE |
| drive_link | TEXT | Legacy Drive URL |
| s3_key | VARCHAR(500) | S3 object key |
| s3_link | TEXT | Full S3 HTTPS URL |
| type | VARCHAR(255) | Category: discharge_slip, investigations, treatment, icps, others, surgical_*, etc. |
| summary | TEXT | Medical summary |
| file_name | VARCHAR(500) | Original filename |
| file_size | INTEGER | Bytes |
| mime_type | VARCHAR(100) | |
| storage_provider | VARCHAR(10) | DEFAULT 's3' |
| drive_backup_status | VARCHAR(20) | 'pending', 'processing', 'completed', 'failed', 'skipped' |
| drive_backup_attempts | INT | DEFAULT 0 |
| drive_backup_error | TEXT | |
| doc_description | TEXT | |
| doc_metadata | JSON | |
| created_at / updated_at | TIMESTAMP TZ | |

**S3 Key Pattern:** `uploads/{hospital_id}/{panel_id}/{patient_id}/{doc_type}/{ts}_{rand}_{name}.webp` (images) or `{hospital_id}/{panel_id}/{patient_id}/{doc_type}/{ts}_{rand}_{name}` (PDFs)

#### `doctors`
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| hospital_id | UUID FK → hospitals | CASCADE |
| first_name | VARCHAR(255) | NOT NULL |
| last_name / age / speciality / phone / years_of_exp | various | |

#### `doctor_doc`
Similar to `ipd_doc` but for doctor credentials. Includes `name` (custom document label).

#### `hospital_doc`
Hospital-level documents (TPA agreements, accreditation). Includes `panel_id` for panel-specific docs.

#### `system_settings` (from migration 001)
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| setting_key | VARCHAR(100) | UNIQUE |
| setting_value | TEXT | |
| description | TEXT | |
| updated_at | TIMESTAMP TZ | |

> Seeded with: `s3_parallel_uploads=5`, `storage_provider=both`, `primary_storage_read=s3`, `s3_enable_parallel=true`. **Currently never read in code.**

---

## 5. Backend Architecture

### Project Structure
```
Backend/src/
├── app.ts                    # Express app setup (CORS, body-parser)
├── index.ts                  # Server entry: DB connect, routes mount, Prometheus
├── Controllers/              # Business logic + raw SQL
│   ├── auth.controller.ts    # Login, signup, token refresh
│   ├── patient.controller.ts # IPD CRUD, pagination, discharge, toggle
│   ├── claims.controller.ts  # Claim upsert + Sheet sync
│   ├── uploads.controller.ts # V1 Drive uploads (legacy)
│   ├── v2/uploads.controller.ts # V2 S3 uploads (current)
│   ├── admin.controller.ts   # Admin/hospital assignments, stats
│   ├── hospitalContoller.ts  # Hospital, panel, user management
│   ├── hospitalDocs.controller.ts # Hospital-level docs (S3)
│   ├── doctors.controller.ts # Doctor CRUD + docs
│   ├── audit.controller.ts   # Audit log queries
│   └── user.controller.ts    # User management
├── Routes/                   # Route → controller wiring + middleware
├── Middlewares/
│   ├── auth.middleware.ts    # JWT + role checks (multiple variants)
│   └── multer.middleware.ts  # File upload config (disk storage → temp/)
├── Services/
│   ├── s3.service.ts         # AWS S3 + CloudFront signer
│   ├── uploadQueue.service.ts # In-memory FIFO upload queue + disk persist
│   ├── notificationBuffer.service.ts # Batch WhatsApp debounce
│   ├── ultraMsg.service.ts   # UltraMsg WhatsApp API wrapper
│   ├── driveUploader.service.ts # Google Drive SDK (legacy)
│   ├── pdfConverter.service.ts # PDF generation helper
│   ├── audit.service.ts      # Audit log writer (commented out)
│   └── startup.service.ts    # Drive backup recovery on boot
├── Workers/
│   ├── notification.queue.ts # Bull queue: WhatsApp send jobs
│   ├── driveBackup.queue.ts  # Bull queue: Drive backup (DISABLED)
│   ├── downloadImages.worker.ts # Worker thread: batch image download
│   └── gsCompress.worker.ts  # Ghostscript PDF compression
├── DB/db.ts                  # pg Pool singleton
├── Utils/
│   ├── asyncHandler.util.ts  # Async error wrapper
│   ├── apiResponse.util.ts   # Standardized response shape
│   ├── errorHandler.util.ts  # ApiError class
│   ├── tokens.util.ts        # JWT token generators
│   ├── indianTime.util.ts    # IST timestamp helper
│   └── fileName.util.ts      # File/folder name generators
└── schema/
    ├── schema.sql            # Full DB schema
    └── migrations/001_add_s3_support.sql
```

### Request Lifecycle
```
HTTP Request
   → Prometheus timer start
   → CORS check (whitelist)
   → Body parser (JSON/multipart)
   → Route match
   → Auth Middleware (JWT verify → DB user fetch → role check)
   → [Optional] checkAdminPermission (per-patient DB permission check)
   → Controller.method (asyncHandler wraps try/catch)
      → DB query via pool
      → External service calls (S3, Drive, Sheet webhook)
      → Queue job if needed
   → apiResponse JSON
   → Prometheus timer end
```

### Response Format
All API responses follow:
```json
{
  "statusCode": 200,
  "data": { ... },
  "message": "Success message"
}
```

---

## 6. API Reference Summary

### Authentication — `/api/v1/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/login` | None | Login with username+password → returns accessToken + refreshToken |
| POST | `/signup` | checkAuth | Create user (superadmin/admin/hospital) |
| POST | `/refreshAccessToken` | None | Rotate access token using refresh token |

### Patients (IPD) — `/api/v1/patient`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/addPatient` | checkHospital | Add new patient, create Drive folder, sync to Sheet |
| GET | `/getAllPatients` | checkAuth | Fetch ALL patients (no pagination) — role-scoped |
| GET | `/getPatients` | checkAuth | Paginated patients, filterable by panel/hospital/status/search |
| GET | `/getTabCounts` | checkAuth | Count patients by status (all/active/admitted/discharged/deactivated) |
| GET | `/getActivePatients` | checkAuth | Active patients only |
| PATCH | `/:id` | checkHospital + checkPatientEditAccess | Update patient + upsert claims + sync Sheet |
| PATCH | `/:id/discharge` | checkAuth | Discharge patient + sync Sheet |
| PATCH | `/:id/toggle-active` | checkAuth | Activate/deactivate patient |
| DELETE | `/:id` | checkAuth | Hard delete patient (**broken** — checks `hospital_id = userId`) |

### Uploads V1 — `/api/v1/uploads` (Legacy)
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/upload` | checkHospitalUserPermission | Queue files to UploadQueue (→ S3 via queue) |
| POST | `/uploadDischargePhotos` | checkHospital | Queue discharge category files |
| POST | `/admin/upload` | checkHospital | Admin upload with category |
| GET | `/admin/photos/:patientId` | checkHospital | List photos from Drive (legacy) |
| DELETE | `/admin/file/:fileId` | checkSuperAdminOrAdmin | Delete photo (Drive — disabled) |
| GET | `/proxy/:fileId` | None | Stream file from Drive |
| GET | `/generatePDF/:patientId` | checkSuperAdminOrAdmin | Download/stitch images → PDF via worker |
| POST | `/renameFileHospital` | checkHospital | Rename files in DB |
| GET | `/getDocumentCounts/:patientId` | checkAuth | File counts from Drive |

### Uploads V2 — `/api/v2/uploads` (Current)
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/photos` | checkHospital | Upload to S3 in parallel chunks (5x), record in DB, notify WhatsApp |
| GET | `/photos/:patientId` | checkAuth | Get all docs with CloudFront presigned URLs |
| GET | `/photos/:patientId/meta` | checkAuth | Get doc metadata only (no URL gen) |
| DELETE | `/photos` | checkAuth | Batch delete from S3 + DB |
| GET | `/getFileCounts/:patientId` | checkAuth | Count per category |
| GET | `/proxy/:fileId` | checkAuth | Proxy S3 download (bypass CORS) |
| GET | `/admin/backup-status` | checkSuperAdminOrAdmin | Drive backup queue status (disabled) |
| POST | `/admin/retry-failed` | checkSuperAdminOrAdmin | Retry failed Drive backups (disabled) |

### Hospitals — `/api/v1/hospitals`
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/addHospital` | checkSuperAdmin | Creates Drive folder |
| GET | `/getAllHospitals` | checkAuth | All hospital entities |
| GET | `/:hospitalId` | checkAuth | Single hospital |
| PATCH | `/updateHospital/:hospitalId` | checkSuperAdmin | Updates with Zod validation |
| POST | `/addPanel` | checkHospital | Link panel to hospital + Drive folder |
| POST | `/panel/create` | checkSuperAdmin | Create master panel type |
| GET | `/panel/all` | checkAuth | All master panels |
| GET | `/:hospitalId/panels` | checkHospital | Hospital's linked panels |
| GET | `/:hospitalId/panels/details` | checkSuperAdmin | Panel details with counts |
| GET | `/:hospitalId/users` | checkHospital | Hospital staff list |
| PATCH | `/:hospitalId/users/:userId/role` | checkSuperAdminOrAdmin | Update user panel access |
| GET | `/my-hospital` | checkHospital | Current user's hospital info |
| GET | `/getPanelsSummary/:hospitalId` | checkHospital | Panel stats (admitted/discharged) |
| GET | `/getHospitalsByAdmin/:adminId` | checkAuth | Hospitals for an admin |

### Admin — `/api/v1/admin`
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/admins` | checkSuperAdmin | All admin users |
| POST | `/assign-hospital` | checkSuperAdmin | Assign hospital to admin |
| DELETE | `/remove-assignment` | checkSuperAdmin | Remove assignment |
| PATCH | `/update-permissions` | checkSuperAdmin | Update can_view/edit/discharge |
| GET | `/admin/:adminId/hospitals` | checkSuperAdminOrAdmin | Admin's hospitals |
| GET | `/admin/:adminId/patients` | checkSuperAdminOrAdmin | Admin's accessible patients |
| GET | `/stats` | checkSuperAdmin | System-wide stats dashboard |
| GET | `/hospitals` | checkSuperAdmin | All hospital users |

### Claims — `/api/v1/claims`
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/addClaim` | checkSuperAdminOrAdmin | Upsert claim, sync to Sheet |

### Doctors — `/api/v1/doctors`
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/hospital/:hospitalId` | checkAuth | All doctors for hospital |
| POST | `/` | checkAuth | Add doctor |
| PATCH | `/:id` | checkAuth | Update doctor |
| DELETE | `/:id` | checkAuth | Delete doctor + S3 docs |
| POST | `/:id/docs` | checkAuth | Upload credentials to S3 |
| GET | `/:id/docs` | checkAuth | Get doctor docs with presigned URLs |
| DELETE | `/docs/:docId` | checkAuth | Delete doctor doc from S3 |
| GET | `/docs/proxy/:docId` | checkAuth | Proxy S3 download |

### Hospital Docs — `/api/v1/hospital-docs`
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/upload` | checkAuth | Upload hospital docs to S3 |
| GET | `/:hospitalId` | checkAuth | Get docs (filterable by category/panelId) |
| DELETE | `/:id` | checkAuth | Delete from S3 + DB |
| GET | `/proxy/:fileId` | checkAuth | Proxy S3 download |

### System
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health/live` | None | Kubernetes liveness probe |
| GET | `/health/ready` | None | Kubernetes readiness probe (DB check) |
| GET | `/api/v1/health` | None | Full system health (CPU/RAM/uptime) |
| GET | `/metrics` | None | Prometheus metrics endpoint |
| GET | `/api/v1/version` | None | App version from env |

---

## 7. File Storage Architecture

### Dual Storage Transition (Drive → S3)
The system underwent a migration from Google Drive as primary storage to AWS S3. Drive is now in a "disabled" state throughout the codebase but the infrastructure code remains.

```
Current State (S3-only mode):
  Upload → multer (temp disk) → Ghostscript compress (PDFs) → S3 upload → CloudFront presigned URL → DB record
  
Legacy State (Drive mode):
  Upload → multer (temp disk) → UploadQueue → Drive upload → DB record (drive_link)
  
Planned (Dual mode — from migration comments):
  Upload → S3 (primary) → DB record → Bull queue → Drive backup (from S3)
```

### S3 Key Structure
```
Images:   uploads/{hospital_id}/{panel_id}/{patient_id}/{doc_type}/{ts}_{rand}_{filename}.webp
PDFs:     {hospital_id}/{panel_id}/{patient_id}/{doc_type}/{ts}_{rand}_{filename}
Doctors:  {hospital_id}/doctors/{doctor_id}/{filename}
Hosp Doc: {hospital_id}/hospital_docs/{panel_id|general}/{doc_type}/{filename}
```

### CloudFront CDN
- Distribution: `d1m5dbrg9f4c2a.cloudfront.net`
- Signed URLs via RSA key pair (1-hour expiry)
- Lambda@Edge presumably handles webp conversion for images in the `uploads/` prefix

### Image Processing Pipeline
1. File received by multer (saved to `temp/`)
2. If PDF: Ghostscript compression (`gsCompress.worker.ts`)
3. Read file buffer
4. Upload to S3 with `ServerSideEncryption: 'AES256'`
5. Delete temp file
6. DB insert with `drive_backup_status = 'skipped'`
7. Generate CloudFront presigned URL for response

---

## 8. Authentication & RBAC

### JWT Token Flow
```
Login → [access_token (short-lived JWT) + refresh_token (random UUID)] returned
      → refresh_token bcrypt-hashed → stored in user_refresh_tokens (one per user)
      → access_token: { id, userName, iat, exp } via ACCESS_TOKEN_SECRET
      → refresh_token: { expiresAt: 30 days }

Refresh → decode (NOT verify) old access_token to get userId
        → fetch token_hash from DB
        → bcrypt.compare(refreshToken, token_hash)
        → generate new access_token
```

### Auth Middleware Variants
| Middleware | Allowed Roles |
|---|---|
| `checkAuth` | Any authenticated user |
| `checkHospital` | hospital, admin, superadmin |
| `checkSuperAdmin` | superadmin only |
| `checkAdmin` | admin only |
| `checkSuperAdminOrAdmin` | superadmin, admin |
| `checkPatientViewAccess` | All roles + panel access check for hospital users |
| `checkAdminPermission(perm)` | Superadmin always, admin checks DB permission flag |
| `checkHospitalUserPermission` | superadmin always, hospital users check panel role |
| `checkPatientEditAccess` | Composes above two |

### Permission Matrix
| Action | superadmin | admin | hospital |
|---|---|---|---|
| Create hospital | ✓ | — | — |
| View all hospitals | ✓ | assigned only | own only |
| Add patient | ✓ | assigned + can_edit | own panel only |
| View patients | ✓ | assigned + can_view | own panel only |
| Discharge patient | ✓ | assigned + can_discharge | ✓ |
| Toggle patient active | ✓ | assigned + can_edit | ✗ |
| Upload docs | ✓ | ✓ | own patients |
| View docs | ✓ | ✓ | own patients |
| Delete docs | ✓ | ✓ | — |
| Manage admins | ✓ | — | — |
| Create panels | ✓ | — | — |

---

## 9. Background Workers & Queues

### UploadQueue (Custom In-Memory FIFO)
- **Location:** `Services/uploadQueue.service.ts`
- **Purpose:** V1 upload path. Serialized FIFO queue for uploading files to S3
- **Persistence:** JSON file (`queue_state.json`) — loaded on startup, saved after every mutation
- **Retry logic:** Max 5 retries with exponential backoff (2s base, ×2 per retry)
- **Current role:** Handles V1 `/uploads/upload` endpoint
- **Issue:** Single-threaded, processes one file at a time (no concurrency)

### NotificationBufferService (In-Memory Debounce)
- **Location:** `Services/notificationBuffer.service.ts`
- **Purpose:** Batch WhatsApp notifications per patient upload session
- **Logic:** Collects files per `groupId:patientId` key, debounces with 60s timer, flushes immediately when upload completes
- **Flush:** Enqueues to Redis `notification.queue`

### NotificationQueue (Bull/Redis)
- **Location:** `Workers/notification.queue.ts`
- **Purpose:** Send WhatsApp messages via UltraMsg
- **Config:** 3 attempts, exponential backoff (5s base), auto-remove on complete

### DriveBackupQueue (Bull/Redis — DISABLED)
- **Location:** `Workers/driveBackup.queue.ts`
- **Purpose:** Back up S3 files to Google Drive (now disabled)
- **Config:** 8 attempts, exponential backoff (3s base)
- **State:** Queue still initialized (connects to Redis) but no jobs are enqueued

### DownloadImages Worker (Worker Thread)
- **Location:** `Workers/downloadImages.worker.ts`
- **Purpose:** Download patient photos and stitch into PDF
- **Invoked by:** `uploads.controller.ts:generatePDFs`

### GSCompress Worker
- **Location:** `Workers/gsCompress.worker.ts`
- **Purpose:** Ghostscript PDF compression before S3 upload
- **Invoked by:** Both UploadQueue and V2 uploadPhotos

---

## 10. Frontend (Flutter Mobile App)

### App Structure
```
lib/
├── main.dart                    # App entry, auth check, nav keys
├── env/env.dart                 # API base URL (envied compile-time injection)
├── models/patients.model.dart   # Patient data model
├── screens/
│   ├── login.screen.dart        # Login form
│   ├── patient_list.screen.dart # Patient list with search
│   ├── patient_details.screen.dart # Patient info + actions
│   ├── patient_form.screen.dart # Add/edit patient form
│   ├── camera.screen.dart       # Camera capture UI
│   ├── gallery.screen.dart      # Photo gallery selection
│   ├── imagePreview.screen.dart # Preview before upload
│   ├── category_uploads.screen.dart # Upload to specific doc category
│   ├── discharge_conservative_doc.screen.dart # Conservative discharge docs
│   ├── discharge_surgical.screen.dart # Surgical discharge docs
│   ├── view_photos.screen.dart  # View uploaded admission photos
│   ├── view_discharge_docs.screen.dart # View discharge category docs
│   ├── connectivity_wrapper.screen.dart # Offline handling
│   └── offline.screen.dart      # Offline state UI
├── services/
│   ├── api_service.dart         # Dio client + JWT refresh interceptor
│   ├── auth_service.dart        # Login/logout/token management
│   ├── image_processor.dart     # EXIF, compression, resize
│   ├── upload_service.dart      # Multipart upload with progress
│   ├── location_service.dart    # GPS coordinates on photo capture
│   └── version_check.service.dart # Force-update prompts
├── widgets/
│   ├── empty_state.dart         # Empty list placeholder
│   ├── loading_skeleton.dart    # Shimmer skeleton loader
│   ├── pdf_viewer.dart          # In-app PDF viewer
│   └── upload_progress_dialog.dart # Upload progress UI
└── utils/toast_utils.dart       # SnackBar helpers
```

### Key Mobile Features
- JWT token auto-refresh via Dio interceptor
- Secure token storage (`flutter_secure_storage`)
- Camera capture with EXIF stripping and compression
- Gallery multi-select with preview
- Document categorization (admission / discharge types)
- Separate discharge flows: Conservative (discharge_slip, investigations, treatment, icps, others) and Surgical (surgical_discharge_slip, ot_notes_and_photos, post_op_photo, post_op_reports, implant_invoice)
- Connectivity-aware (offline screen)
- Force update via version check service
- In-app PDF viewing

---

## 11. Webapp (React SPA)

### App Structure
```
webapp/src/
├── App.tsx                       # BrowserRouter + role-based PrivateRoute
├── context/
│   ├── AuthContext.tsx           # User auth state, login/logout
│   └── UploadContext.tsx         # Global upload queue state
├── pages/
│   ├── auth/LoginPage.tsx        # Login form
│   ├── superadmin/
│   │   ├── SuperAdminPage.tsx    # Hospital list + master panels
│   │   └── HospitalDetailsPage/ # Hospital drill-down
│   │       ├── index.tsx         # Main page
│   │       ├── components/       # AddDoctor, AddPatient, Breadcrumb, etc.
│   │       ├── hooks/            # useHospitalData, usePatientActions
│   │       └── utils/formatters.ts
│   ├── admin/AdminDashboardPage.tsx # Admin view (hospitals assigned to admin)
│   ├── hospital/
│   │   ├── Layout/index.tsx      # Persistent sidebar layout for hospital portal
│   │   ├── Dashboard/index.tsx   # Hospital overview stats
│   │   ├── Panels/index.tsx      # Panel list for hospital
│   │   ├── PanelDetails/index.tsx # Patient list in a panel
│   │   └── Users/index.tsx       # Hospital staff management
│   └── panels/
│       ├── index.tsx             # Panel patients page
│       └── components/PatientTable.tsx
├── components/
│   ├── modals/
│   │   ├── PatientPhotosModal/   # Complex modal: photo gallery + upload
│   │   │   ├── index.tsx
│   │   │   ├── components/       # ClaimsFields, IPDFields, PhotoGrid, UploadQueuePanel, Lightbox
│   │   │   └── hooks/            # useLocalDragDrop, usePhotoUpload, usePhotosData
│   │   ├── AddHospitalModal.tsx
│   │   ├── AddPanelModal.tsx
│   │   ├── AddUserModal.tsx
│   │   ├── AssignmentModal.tsx
│   │   ├── LinkPanelModal.tsx
│   │   └── PatientModal.tsx
│   └── ui/                       # shadcn/ui component overrides
├── services/
│   ├── api.ts                    # ApiService class: all HTTP calls + token refresh
│   └── pdfGenerator.ts          # Client-side PDF generation (jsPDF)
├── features/
│   ├── dashboard/DashboardOverview.tsx
│   └── panels/MasterPanelManagement.tsx
└── types/index.ts                # Shared TypeScript types
```

### Routes
| Path | Component | Roles |
|---|---|---|
| `/login` | LoginPage | Public |
| `/dashboard` | AdminDashboardPage | admin |
| `/superadmin` | SuperAdminPage | superadmin |
| `/hospital/:hospitalId` | HospitalDetailsPage | all |
| `/hospital/:hospitalId/panel/:panelId` | PanelPatientsPage | all |
| `/portal/:hospitalId` | HospitalPortalLayout | hospital, admin, superadmin |
| `/portal/:hospitalId/panels` | HospitalPanelsPage | hospital, admin, superadmin |
| `/portal/:hospitalId/users` | HospitalUsersPage | hospital, admin, superadmin |
| `/portal/:hospitalId/panel/:panelId` | HospitalPanelDetails | hospital, admin, superadmin |

---

## 12. Infrastructure & Deployment

### Docker Compose
```yaml
services:
  backend:   port ${BACKEND_PORT:-6001}:8000   # Node.js API
  webapp:    port ${WEBAPP_PORT:-5001}:80       # React served via nginx
  redis:     port 6379                          # Bull queues + persistence
```

PostgreSQL is **not** in Docker Compose — expected as an external managed service.

### Nginx (Webapp)
- Serves React SPA as static files
- All routes → `/index.html` (SPA fallback)
- Presumably reverse-proxies `/api/*` to backend

### Required Environment Variables (Backend)
```
PORT, NODE_ENV, APP_VERSION
CORS_ORIGIN
ACCESS_TOKEN_SECRET
DATABASE_URL (or PG connection vars)
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET
CLOUDFRONT_PRIVATE_KEY, CLOUDFRONT_KEY_PAIR_ID
GOOGLE_DRIVE_ROOT_ID, PARENT
GOOGLE_SHEET_SECRET_TOKEN, GOOGLE_SHEET_WEBHOOK_URL
REDIS_URL
ULTRAMSG_TOKEN, ULTRAMSG_INSTANCE_ID (inferred)
```

---

## 13. Code Review Findings

### Critical Bugs

#### CB-1: Broken `deletePatient` ownership check
**File:** `Controllers/patient.controller.ts:1011`
```typescript
const checkOwnership = await pool.query(
  'SELECT id FROM ipds WHERE id = $1 AND hospital_id = $2',
  [id, userId]  // BUG: uses userId as hospital_id — will never match
)
```
**Fix:** Should use the patient's actual `hospital_id` from a prior DB lookup, or check via `hospital_users`.

#### CB-2: `jwt.decode()` used for refresh token validation
**File:** `Controllers/auth.controller.ts:171`
```typescript
const decodedOldToken = jwt.decode(oldAccessToken)  // NOT jwt.verify()
```
`jwt.decode()` does not validate the signature. An attacker can forge a token to extract any `userId`. Should use `jwt.verify()` with the secret (ignoring expiry is acceptable here via `ignoreExpiration`).

#### CB-3: `hospital_assignments.is_active` column doesn't exist
**File:** `Controllers/patient.controller.ts:1073`, `Controllers/admin.controller.ts:130`
```typescript
// "WHERE ... AND is_active = true" on hospital_assignments — column doesn't exist
```
Will throw PostgreSQL error at runtime for togglePatientActiveStatus and getHospitalAdmins.

#### CB-4: `getAdminPatients` references non-existent `folder_id` column
**File:** `Controllers/admin.controller.ts:159`
```sql
p.folder_id  -- should be p.drive_folder_id
```

### Security Issues

#### S-1: No rate limiting on login endpoint
Any brute-force attack on `/api/v1/auth/login` will succeed unhindered. Should add `express-rate-limit`.

#### S-2: CORS `!origin` allows all server-side requests
**File:** `app.ts:19`
```typescript
if (!origin || whitelist.indexOf(origin) !== -1) { callback(null, true) }
```
Server-to-server requests (curl, Postman, etc.) are allowed without any origin check.

#### S-3: `console.log(req.body)` in updatePatient
**File:** `Controllers/patient.controller.ts:691`
Can log sensitive patient data to stdout/logs.

#### S-4: Audit logging disabled
**File:** `Controllers/auth.controller.ts:76-85`
All `auditService.log()` calls are commented out. No audit trail exists.

### Design Issues

#### D-1: Auth middleware code duplication
Every middleware variant (`checkAuth`, `checkHospital`, `checkSuperAdmin`, etc.) copy-pastes the same JWT verify + DB lookup logic. Should be extracted into a `getAuthUser()` helper.

#### D-2: Dual upload logic in V1 UploadQueue and V2 controller
Both paths contain almost identical S3 key generation + upload + DB insert logic. Should share a common `uploadToS3AndRecord(file, context)` utility.

#### D-3: `hospital_users.role` anti-pattern
Storing both `'admin'` strings and panel UUIDs in the same `TEXT[]` column creates casting issues (`role::uuid[]` will fail when 'admin' is present) and makes permission queries complex/fragile.

#### D-4: Google Drive tight coupling remains
`drive_folder_id NOT NULL` on the `hospitals` table means hospital creation always creates a Drive folder (even in S3-only mode). Patient creation (`addPatient`) also mandates a Drive folder before DB insert — if Drive fails, no patient is created.

#### D-5: Google Sheet sync is fire-and-forget
Sheet webhook response is never awaited properly nor error-checked. If the webhook fails, the operation silently succeeds.

#### D-6: In-memory UploadQueue not Redis-backed
The custom `GlobalUploadQueue` writes state to `queue_state.json` on disk. In a multi-instance deployment, queues would conflict. In a container restart without volume mounts, the file is lost.

### Missing Features (Gaps in existing implementation)

#### G-1: No `audit_logs` table in schema
`AuditService` class exists with a `.log()` method, but the table was never created and all calls are commented out.

#### G-2: `system_settings` table never queried
Created in migration 001, seeded with config values, but never read. S3 concurrency is hardcoded as `const CONCURRENCY_LIMIT = 5`.

#### G-3: `stay` JSONB column on IPDs unused
Created in schema, never set or read anywhere.

#### G-4: Prometheus metrics endpoint unprotected
`/metrics` is publicly accessible — exposes system internals.

#### G-5: No pagination for hospital-role patient list in V1 `getAllPatients`
When `userRole === 'hospital'`, the query has no LIMIT/OFFSET — will return all patients.

#### G-6: Missing input validation on UUIDs
Route params like `:id`, `:patientId`, `:hospitalId` are passed directly to SQL without validating UUID format. Invalid UUIDs will cause PostgreSQL errors rather than clean 400s.

---

## 14. Gap Analysis

### Feature Gaps
| Gap | Priority | Description |
|---|---|---|
| Audit Trail | High | `audit_logs` table + service integration |
| Rate Limiting | High | Login brute force protection |
| Input Validation | High | UUID validation, Zod schemas on all endpoints |
| Token security | High | `jwt.verify()` instead of `jwt.decode()` |
| Claim Status Workflow | High | `latest_status` is free-text; no defined lifecycle |
| Reporting/Analytics | Medium | No endpoints for claim settlement reports, trend analysis |
| Notification Preferences | Medium | No way to toggle WhatsApp notifications per panel |
| Doctor-Patient Linkage | Medium | No relationship between doctors and IPD records |
| Search on Superadmin | Medium | Superadmin patient list has no search or filter |
| File Preview (Doctor/Hosp docs) | Medium | Proxy route exists but no UI feature documented |
| User Password Reset | Medium | No forgot-password or OTP-based reset flow |
| Multi-device Token | Low | Only one refresh token per user (last device wins) |
| Attachment Tagging | Low | `doc_metadata` and `summary` fields always null |
| Offline Sync (Mobile) | Low | Flutter has connectivity wrapper but no offline queue |

### Infrastructure Gaps
| Gap | Priority | Description |
|---|---|---|
| Drive dependency in patient creation | High | `addPatient` fails if Drive API is down, even in S3 mode |
| Drive `NOT NULL` on hospitals | High | Blocks removing Drive dependency |
| Redis UploadQueue | Medium | V1 queue should use Redis for resilience |
| DB migrations framework | Medium | No migration runner; manual SQL execution |
| Multi-instance deployment | Medium | In-memory state (UploadQueue, NotificationBuffer) not shared |
| Unprotected `/metrics` | Medium | Prometheus endpoint exposes internals |
| No HTTPS enforcement | Low | nginx config likely handles this but not confirmed |
| No staging/preview env | Low | No `docker-compose.staging.yml` |

### Schema Gaps
| Gap | Description |
|---|---|
| `audit_logs` table missing | Needed for compliance |
| `is_active` on `hospital_assignments` | Referenced in code, missing in schema |
| `hospital_users.role` design | Anti-pattern mixing strings and UUIDs |
| `claim_status` enum | Free-text `latest_status` should be typed |
| `admission_type` enum | Free-text, should be constrained |
| Doctor-IPD relationship | No FK linking doctors to patient admissions |
| Discharge documents relation | No separate table for discharge-specific doc metadata |

---

## 15. Recommended Enhancements

### P0 — Critical (Fix Now)

1. **Fix `deletePatient` ownership check** — Replace `hospital_id = userId` with proper join through `hospital_users`
2. **Fix `jwt.decode()` → `jwt.verify(ignoreExpiration: true)`** in refreshAccessToken
3. **Add `is_active` to `hospital_assignments` schema** or remove references in code
4. **Fix `folder_id` → `drive_folder_id`** in `getAdminPatients`
5. **Remove Drive hard dependency from `addPatient`** — create Drive folder asynchronously or make it optional in S3 mode
6. **Make `drive_folder_id` nullable** on hospitals table

### P1 — High Priority (Next Sprint)

7. **Add `audit_logs` table + enable AuditService** — compliance requirement
8. **Add rate limiting** — `express-rate-limit` on `/auth/login` (5 req/min/IP)
9. **Extract auth middleware helper** — single `getAuthUser()` function, compose into variants
10. **Add UUID validation** on all route params — middleware or Zod
11. **Fix Google Sheet sync** — await and log errors; don't silently discard failures
12. **Protect `/metrics` endpoint** — require superadmin auth or IP whitelist
13. **Remove `console.log(req.body)`** from updatePatient

### P2 — Medium Priority (Next Quarter)

14. **Define `claim_status` enum** — PENDING, SUBMITTED, APPROVED, REJECTED, SETTLED, DEDUCTED
15. **Define `admission_type` enum** — CONSERVATIVE, SURGICAL at DB level
16. **Migrate `hospital_users.role` design** — separate table `hospital_user_panels(user_id, hospital_id, panel_id)` + `is_admin` boolean
17. **Move V1 UploadQueue to Redis (Bull)** — aligned with existing notification queue pattern
18. **Create shared `uploadDocumentToS3()` utility** — deduplicate V1/V2 upload logic
19. **Add Doctor-IPD relationship** — `ipd_doctors` junction table
20. **Add DB migration runner** — Flyway or `db-migrate` or `node-pg-migrate`
21. **Claim reporting endpoint** — monthly/panel-level settlement report
22. **Pagination for all list endpoints** — especially hospital-role patient list
23. **`system_settings` integration** — read concurrency config from DB table

### P3 — Long-term Enhancements

24. **Multi-device refresh tokens** — token per device ID
25. **Offline queue in Flutter** — `sqflite` based local queue for uploads when offline
26. **Push notifications** — FCM for claim status updates to hospital users
27. **Document AI integration** — auto-extract claim data from discharge slips via OCR
28. **Webhook reliability** — store Sheet sync jobs in DB + retry queue
29. **Role-based feature flags** — hospital can be granted specific capabilities
30. **API versioning strategy** — formalize V1 deprecation timeline
31. **OpenAPI/Swagger documentation** — auto-generated from routes
32. **E2E test suite** — Supertest + Jest for critical paths (auth, patient CRUD, upload)
33. **CloudFront URL caching in Redis** — avoid re-signing on every request (URLs valid 1hr)
34. **Tenant isolation** — row-level security in PostgreSQL as defense-in-depth
