# Document Upload Integration Guide

## Overview
This guide shows how to integrate the `DocumentUploadManager` component into your hospital profile and attributes features.

---

## Component: DocumentUploadManager

### Location
```
webapp/src/components/DocumentUploadManager.tsx
```

### Features
- Upload documents (PDF, Word, Excel, Images)
- Max file size: 100MB
- Automatic progress tracking
- Download uploaded documents
- Delete documents with confirmation
- Link documents to attributes
- Display document metadata (issue date, expiry date)
- Show expired document badges

---

## Basic Usage

### Import
```tsx
import DocumentUploadManager from '@/components/DocumentUploadManager';
```

### Simple Integration
```tsx
<DocumentUploadManager 
  hospitalId={hospitalId}
/>
```

### With Attribute Linking
```tsx
<DocumentUploadManager 
  hospitalId={hospitalId}
  attributeKey="nabh_certified"
  onDocumentUploaded={(document) => {
    console.log('Document uploaded:', document);
    // Update parent component state if needed
  }}
/>
```

---

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `hospitalId` | string | Yes | Hospital ID for document organization |
| `attributeKey` | string | No | Link documents to specific attribute |
| `onDocumentUploaded` | function | No | Callback when document is uploaded |

---

## Integration Examples

### 1. Hospital Profile Component

```tsx
// webapp/src/pages/hospital/Profile/index.tsx

import React from 'react';
import DocumentUploadManager from '@/components/DocumentUploadManager';

export default function HospitalProfilePage() {
  const { hospitalId } = useParams<{ hospitalId: string }>();

  return (
    <div className="space-y-6">
      {/* Existing profile sections */}
      
      {/* Documents section */}
      <Card>
        <CardHeader>
          <CardTitle>Documents & Certifications</CardTitle>
          <CardDescription>
            Upload documents to support your hospital attributes
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentUploadManager 
            hospitalId={hospitalId}
            onDocumentUploaded={(doc) => {
              // Refresh profile data if needed
              refreshProfileData();
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
```

### 2. Attribute Management Component

```tsx
// webapp/src/pages/hospital/Profile/components/AttributeForm.tsx

import React from 'react';
import DocumentUploadManager from '@/components/DocumentUploadManager';

interface AttributeFormProps {
  hospitalId: string;
  attributeKey: string;
  attributeLabel: string;
}

export default function AttributeForm({
  hospitalId,
  attributeKey,
  attributeLabel
}: AttributeFormProps) {
  return (
    <div className="space-y-6">
      {/* Attribute input fields */}
      <div>
        <Label>{attributeLabel}</Label>
        <Input placeholder="Enter value" />
      </div>

      {/* Supporting documents */}
      <Card>
        <CardHeader>
          <CardTitle>Supporting Documents</CardTitle>
          <CardDescription>
            Upload documents to verify this attribute
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentUploadManager 
            hospitalId={hospitalId}
            attributeKey={attributeKey}
          />
        </CardContent>
      </Card>
    </div>
  );
}
```

### 3. Modal-Based Upload

```tsx
// For inline upload in a modal/dialog

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import DocumentUploadManager from '@/components/DocumentUploadManager';

export default function DocumentUploadModal({
  open,
  onClose,
  hospitalId,
  attributeKey
}) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload Supporting Documents</DialogTitle>
        </DialogHeader>
        <DocumentUploadManager 
          hospitalId={hospitalId}
          attributeKey={attributeKey}
          onDocumentUploaded={() => {
            // Close dialog on successful upload
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
```

---

## API Methods Used

The component uses these ApiService methods (already implemented):

```typescript
// Get documents for hospital (with optional filters)
ApiService.getHospitalDocuments(
  hospitalId: string,
  category?: string,      // certifications, licenses, etc.
  type?: string,         // NABH, ISO, etc.
  attributeKey?: string  // Link to specific attribute
)

// Upload document
ApiService.uploadDocument(
  hospitalId: string,
  formData: FormData   // Contains file + metadata
)

// Download document
ApiService.downloadDocument(
  hospitalId: string,
  documentId: string
)

// Delete document
ApiService.deleteDocument(
  hospitalId: string,
  documentId: string
)

// Link document to attribute
ApiService.linkDocumentToAttribute(
  hospitalId: string,
  documentId: string,
  attributeKey: string
)
```

---

## Document Upload Workflow

### 1. User Selects File
- Click "Upload Document" button
- Select file from filesystem
- File is validated on client-side:
  - Max 100MB
  - Supported formats: PDF, DOC, DOCX, XLS, XLSX, JPG, PNG

### 2. Enter Metadata
Form fields:
- **Document Name** (required) - e.g., "NABH Certification"
- **Category** (required) - Certifications, Licenses, Registrations, etc.
- **Document Type** (optional) - e.g., "NABH", "ISO 9001"
- **Issue Date** (optional) - When document was issued
- **Expiry Date** (optional) - When document expires

### 3. Upload with Progress
- File is uploaded to backend
- Progress bar shows upload percentage
- Form fields are disabled during upload

### 4. Confirmation
- Success message displayed
- Document appears in list
- Form resets for next upload
- Optional callback fires (`onDocumentUploaded`)

---

## Document Storage Structure

Documents are organized in S3:
```
hospital-claims-images/
├── hospitals/{hospitalId}/documents/
│   ├── certifications/
│   ├── licenses/
│   ├── registrations/
│   ├── accreditations/
│   ├── insurance/
│   ├── compliance/
│   └── other/
```

Each file:
- Has unique timestamp prefix
- Original filename is preserved
- Encrypted at rest (AES256)
- Accessible via CloudFront-signed URLs

---

## Document Metadata

Each document stores:
```typescript
{
  id: string;                    // Document ID
  hospitalId: string;            // Hospital ID
  documentName: string;          // Human-readable name
  documentCategory: string;      // Category enum
  documentType: string;          // Specific type (NABH, etc.)
  fileName: string;              // Original filename
  fileSizeBytes: number;         // File size in bytes
  issueDate?: string;           // ISO date
  expiryDate?: string;          // ISO date
  createdAt: string;            // Upload timestamp
  uploadedBy: string;           // User ID who uploaded
}
```

---

## Error Handling

The component handles:

### Client-Side Validation
- File size exceeds 100MB
- No file selected
- Missing required fields
- Invalid date ranges

### Server-Side Validation
- Hospital not found
- File upload failure
- S3 operation failure
- Database errors

### User Feedback
- Error messages displayed in card
- Success messages after upload
- Loading states during operations
- Disabled form during upload

---

## Features

### 1. Document List
- Displays all uploaded documents
- Shows metadata (category, type, size, dates)
- Indicates expired documents with badge
- Hover effect for better UX

### 2. Download
- One-click download from browser
- Original filename preserved
- Proper MIME types
- Works with all file types

### 3. Delete
- Confirmation dialog before deletion
- Removes from S3 and database
- Success/error feedback

### 4. Filtering (Future)
```tsx
// Can filter documents by category when fetching
<DocumentUploadManager 
  hospitalId={hospitalId}
  category="certifications"  // Only show certifications
/>
```

---

## Security Features

### S3 Integration
- Files encrypted at rest (AES256)
- CloudFront-signed URLs (time-limited)
- No public S3 access
- Server-side access validation

### Authentication
- All operations require user authentication
- Only hospital staff can upload documents
- Admin can access all documents
- Document ownership validated

### File Validation
- Size limits enforced (100MB)
- MIME type validation
- Malware scanning (future)
- Version control with timestamps

---

## Performance Considerations

### Upload Optimization
- Multer memory storage (100MB limit)
- S3 parallel uploads (5 concurrent)
- Progress tracking during upload
- Browser caching via CloudFront

### Download Optimization
- CloudFront caching
- Signed URL generation
- Browser cache headers
- Direct streaming from S3

### List Performance
- Pagination possible (future)
- Filtering by category/type
- Index on hospital_id and attribute_key
- Lazy loading for large lists

---

## Testing

### Manual Testing
```bash
# 1. Login to hospital portal
# 2. Navigate to Hospital Profile
# 3. Scroll to "Documents & Certifications" section
# 4. Click "Upload Document"
# 5. Select a file (PDF, image, etc.)
# 6. Fill in metadata
# 7. Click "Upload"
# 8. Verify file appears in list
# 9. Download document
# 10. Delete document with confirmation
```

### Automated Testing (Future)
```typescript
describe('DocumentUploadManager', () => {
  it('should upload a document', async () => {
    // Test file selection
    // Test metadata form
    // Test upload request
    // Test success response
  });

  it('should handle upload errors', async () => {
    // Test file too large
    // Test server error
    // Test network failure
  });

  it('should download documents', async () => {
    // Test download link
    // Test file received
  });

  it('should delete documents', async () => {
    // Test delete confirmation
    // Test deletion request
    // Test list update
  });
});
```

---

## Browser Compatibility

- Chrome/Edge: Supported
- Firefox: Supported
- Safari: Supported (with limitations on some file types)
- Mobile browsers: Supported (responsive design)

---

## Future Enhancements

1. **Document Preview**
   - Inline PDF viewer
   - Image thumbnails
   - Document preview before upload

2. **AI Extraction** (Already implemented in backend)
   - Auto-extract data from documents
   - Suggest attribute values
   - Manual review and approval

3. **Document Versioning**
   - Track multiple versions
   - Compare versions
   - Revert to previous version

4. **Collaboration**
   - Comment on documents
   - Share with external parties
   - Audit trail of access

5. **Advanced Search**
   - Full-text search
   - OCR for scanned documents
   - Metadata search

---

## Troubleshooting

### Upload Fails
- Check internet connection
- Verify file size < 100MB
- Check browser console for errors
- Verify S3 credentials in backend

### Document Not Appearing
- Refresh page
- Check if S3 upload actually succeeded
- Check database for document record
- Check browser console for errors

### Download Fails
- Verify CloudFront is accessible
- Check document still exists in S3
- Check authentication token
- Try different browser

### Expiry Badge Shows Incorrectly
- Check server time is accurate
- Verify expiryDate format (ISO date)
- Check timezone handling

---

## Support

For issues or questions:
1. Check browser console (F12 → Console)
2. Check backend logs
3. Verify AWS S3 credentials
4. Check CloudFront distribution status
