# Document/Image Upload Setup for Hospital Attributes

## Overview
Complete setup guide for document and image upload functionality for hospital attributes, including S3 integration and CloudFront delivery.

## Components Required

### 1. Backend Infrastructure
- **S3Service** (`Backend/src/Services/s3.service.ts`)
  - Handles AWS S3 upload/download/delete operations
  - Uses CloudFront for signed URL generation
  - Supports file encryption at rest (AES256)

- **AttachmentService** (`Backend/src/Services/attachment.service.ts`)
  - Manages document metadata in database
  - Handles file organization in S3
  - Links documents to hospital attributes
  - Tracks storage usage and handles cleanup

- **DocumentController** (`Backend/src/Controllers/document.controller.ts`)
  - REST API endpoints for document management
  - Supports upload, download, delete, and metadata operations
  - Links documents to attributes

### 2. Environment Variables (Production)
```env
# AWS S3 Configuration
AWS_ACCESS_KEY_ID=AKIA54QFVUIRQ2XKAXYW
AWS_SECRET_ACCESS_KEY=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
AWS_REGION=us-east-1
AWS_S3_BUCKET=hospital-claims-images

# CloudFront Configuration
CLOUDFRONT_KEY_PAIR_ID=K10NP6H9W5KNGA
CLOUDFRONT_PRIVATE_KEY=<PEM file content>

# Storage Settings
STORAGE_PROVIDER=s3
S3_PARALLEL_UPLOADS=5
```

### 3. Database Schema
Required tables:
- `hospital.hospital_documents` - Document metadata
- `hospital.hospital_attributes` - Hospital attributes with document_id reference
- `hospital.attribute_definitions` - Attribute definitions with file support

### 4. API Routes
**Healthcare Profile Routes** (`Backend/src/Routes/hospitalProfile.routes.ts`)

```typescript
// Document Upload & Management
POST   /hospitals/:hospitalId/documents/upload              // Upload document
GET    /hospitals/:hospitalId/documents                     // List documents
GET    /hospitals/:hospitalId/documents/:documentId         // Get document metadata
GET    /hospitals/:hospitalId/documents/:documentId/download // Download document
PUT    /hospitals/:hospitalId/documents/:documentId         // Update metadata
DELETE /hospitals/:hospitalId/documents/:documentId         // Delete document

// Document-Attribute Linking
PUT    /hospitals/:hospitalId/documents/:documentId/link/:attributeKey // Link to attribute

// AI Extraction (Optional)
POST   /hospitals/:hospitalId/documents/:documentId/extract            // Submit for extraction
GET    /hospitals/:hospitalId/documents/:documentId/extraction         // Get extraction status
POST   /hospitals/:hospitalId/documents/:documentId/extraction/approve // Approve extraction

// Storage Management
GET    /hospitals/:hospitalId/documents/storage-usage // Get storage stats
```

---

## Implementation Checklist

### ✅ Backend Components (Implemented)

- [x] **S3Service** - AWS S3 integration with CloudFront signing
- [x] **AttachmentService** - Document metadata and S3 management
- [x] **DocumentController** - REST API endpoints
- [x] **DocumentExtractionService** - AI extraction pipeline
- [x] **Database migrations** - Document tables created
- [x] **API Routes** - All document endpoints registered

### ✅ S3 Configuration

- [x] S3 bucket created: `hospital-claims-images`
- [x] Server-side encryption enabled (AES256)
- [x] CloudFront distribution configured
- [x] CloudFront key pair generated for URL signing
- [x] CORS configured for multi-region access

### Frontend Integration (To Complete)

- [ ] **Upload Component** - Document upload UI in attributes form
- [ ] **Document Preview** - View uploaded documents
- [ ] **Document Manager** - Manage hospital documents
- [ ] **Link to Attribute** - Associate documents with attributes
- [ ] **Progress Tracking** - Upload progress indicator
- [ ] **Error Handling** - User-friendly error messages

### File Organization in S3
```
hospital-claims-images/
├── hospitals/
│   ├── {hospitalId}/
│   │   ├── documents/
│   │   │   ├── certifications/
│   │   │   │   └── {timestamp}_{filename}
│   │   │   ├── licenses/
│   │   │   │   └── {timestamp}_{filename}
│   │   │   ├── registrations/
│   │   │   │   └── {timestamp}_{filename}
│   │   │   └── {other-categories}/
│   │   │       └── {timestamp}_{filename}
└── uploads/  (for images)
    ├── {hospitalId}/
    │   ├── certificates/
    │   ├── accreditations/
    │   └── other/
```

---

## Document Upload Workflow

### 1. Upload Document
```
POST /hospitals/:hospitalId/documents/upload
Content-Type: multipart/form-data

Form Fields:
- file: (binary) - The document/image file
- documentName: string - Human-readable name
- documentCategory: enum - certifications, licenses, registrations, etc.
- documentType: string - Specific type (NABH, NRHM, etc.)
- attributeKey: string (optional) - Associated attribute
- issueDate: ISO date (optional)
- expiryDate: ISO date (optional)

Response:
{
  "statusCode": 201,
  "success": true,
  "data": {
    "id": "doc-id",
    "hospitalId": "hospital-id",
    "documentName": "NABH Certification",
    "documentCategory": "certifications",
    "documentType": "NABH",
    "fileName": "nabh_cert.pdf",
    "mimeType": "application/pdf",
    "fileSizeBytes": 1024000,
    "s3Key": "hospitals/hospital-id/documents/certifications/1234567890_nabh_cert.pdf",
    "issueDate": "2023-01-01",
    "expiryDate": "2025-01-01",
    "uploadedBy": "user-id",
    "createdAt": "2024-01-15T10:30:00Z"
  }
}
```

### 2. Get Document URL
- Documents are stored in S3
- CloudFront-signed URLs are generated for secure access
- URLs expire in 1 hour by default
- No public access to raw S3 URLs

### 3. Link Document to Attribute
```
PUT /hospitals/:hospitalId/documents/:documentId/link/:attributeKey

Updates hospital_attributes table to reference the document
Allows tracking which documents support each attribute
```

### 4. Download Document
```
GET /hospitals/:hospitalId/documents/:documentId/download

Returns: Binary file with proper headers
- Content-Type: {original mime type}
- Content-Disposition: attachment; filename="{original filename}"
```

---

## Security Features

### 1. **S3 Encryption**
- Server-side encryption with AES256
- All files encrypted at rest

### 2. **CloudFront Signed URLs**
- Time-limited access (1 hour expiry)
- Cryptographically signed with private key
- Cannot be accessed directly from S3

### 3. **Access Control**
- All document operations require authentication
- Hospital staff can only access their hospital's documents
- Admin can access all documents

### 4. **File Size Limits**
- Multer configured with 100MB limit per file
- Hospital storage quota management available

---

## Testing

### Manual Test
```bash
# 1. Get auth token
curl -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"hospital","password":"password123"}'

# 2. Upload document
curl -X POST http://localhost:8000/api/v1/hospitals/{hospitalId}/documents/upload \
  -H "Authorization: Bearer {token}" \
  -F "file=@certificate.pdf" \
  -F "documentName=NABH Certification" \
  -F "documentCategory=certifications" \
  -F "documentType=NABH" \
  -F "attributeKey=nabh_certified"

# 3. List documents
curl -X GET "http://localhost:8000/api/v1/hospitals/{hospitalId}/documents" \
  -H "Authorization: Bearer {token}"

# 4. Get document metadata
curl -X GET "http://localhost:8000/api/v1/hospitals/{hospitalId}/documents/{documentId}" \
  -H "Authorization: Bearer {token}"

# 5. Download document
curl -X GET "http://localhost:8000/api/v1/hospitals/{hospitalId}/documents/{documentId}/download" \
  -H "Authorization: Bearer {token}" \
  -o downloaded_file.pdf
```

---

## Frontend Implementation (Next Steps)

### File Upload Component Structure
```tsx
// Features needed in Attributes section:
1. Document upload button
2. File input with validation (PDF, images, docs)
3. Upload progress bar
4. File preview/thumbnail
5. Delete option
6. Link to attribute selector
7. Metadata form (issue date, expiry date)
```

### Integration Points
- **ProfileForm.tsx** - Add document upload section to attributes
- **AttributeForm.tsx** - Link documents when editing attributes
- **DocumentViewer.tsx** - Display uploaded documents
- **ApiService.ts** - Add upload/download methods

### Error Handling
- File size validation (client + server)
- File type validation
- Upload timeout handling
- Network error recovery
- Duplicate file detection

---

## Performance Optimization

### 1. **Parallel Uploads**
- S3_PARALLEL_UPLOADS=5 (configured)
- Multiple files can be uploaded concurrently

### 2. **CloudFront Caching**
- Document URLs cached at edge locations
- Reduces latency for repeated access
- Automatic cache invalidation on delete

### 3. **Storage Cleanup**
- Automatic deletion of documents 1 year after expiry
- Manual cleanup endpoint available
- Storage usage tracking

---

## Troubleshooting

### S3 Connection Issues
```bash
# Check AWS credentials
echo $AWS_ACCESS_KEY_ID
echo $AWS_SECRET_ACCESS_KEY
echo $AWS_REGION

# Verify bucket exists and is accessible
aws s3 ls s3://hospital-claims-images
```

### CloudFront Signing Issues
```bash
# Verify private key format
cat /path/to/private-key.pem | head -1
# Should output: -----BEGIN PRIVATE KEY-----

# Check key pair ID
echo $CLOUDFRONT_KEY_PAIR_ID
# Should match AWS Console CloudFront distribution
```

### Document Not Found
- Verify document exists in database
- Check S3 key path matches
- Verify bucket name and region match
- Check IAM permissions for S3 bucket

---

## Next Steps

1. **Frontend Document Upload Component**
   - Create reusable upload component
   - Add to Attribute management UI
   - Implement progress tracking

2. **Document Viewer**
   - Preview PDFs and images
   - Download functionality
   - Share links with expiry

3. **AI Extraction** (Optional)
   - Automatic data extraction from documents
   - Manual review and approval
   - Auto-fill attribute values

4. **Analytics**
   - Document upload patterns
   - Storage trends
   - Most used document types
