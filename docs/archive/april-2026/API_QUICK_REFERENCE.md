# Multi-Document API Quick Reference

**Base URL**: `http://localhost:8000/api/v1` (development) or `/api/v1` (production)

---

## Document Management on Attributes

### 1. Add Document to Attribute
```bash
POST /hospitals/{hospitalId}/attributes/{attributeKey}/documents

Headers:
  Authorization: Bearer {accessToken}
  Content-Type: application/json

Body:
{
  "documentId": "uuid-of-document"
}

Response (201):
{
  "statusCode": 201,
  "data": {
    "id": "attr-id",
    "attributeKey": "accreditation.nabh",
    "documents": [
      {
        "id": "junction-table-uuid",
        "documentId": "doc-uuid-1",
        "fileName": "NABH_Cert.pdf",
        "fileSize": 250000,
        "mimeType": "application/pdf",
        "uploadedAt": "2026-04-19T10:30:00Z",
        "isPrimary": true
      },
      {
        "id": "junction-table-uuid-2",
        "documentId": "doc-uuid-2",
        "fileName": "Renewal.pdf",
        "fileSize": 180000,
        "mimeType": "application/pdf",
        "uploadedAt": "2026-04-18T14:00:00Z",
        "isPrimary": false
      }
    ]
  },
  "message": "Document added to attribute"
}
```

---

### 2. Set Document as Primary
```bash
PUT /hospitals/{hospitalId}/attributes/{attributeKey}/documents/{documentId}/primary

Headers:
  Authorization: Bearer {accessToken}
  Content-Type: application/json

Body: {} (empty)

Response (200):
{
  "statusCode": 200,
  "data": {
    "id": "attr-id",
    "attributeKey": "accreditation.nabh",
    "documents": [
      {
        "id": "junction-uuid-1",
        "documentId": "doc-uuid-1",
        "fileName": "NABH_Cert.pdf",
        "fileSize": 250000,
        "mimeType": "application/pdf",
        "uploadedAt": "2026-04-19T10:30:00Z",
        "isPrimary": false  // No longer primary
      },
      {
        "id": "junction-uuid-2",
        "documentId": "doc-uuid-2",
        "fileName": "Renewal.pdf",
        "fileSize": 180000,
        "mimeType": "application/pdf",
        "uploadedAt": "2026-04-18T14:00:00Z",
        "isPrimary": true   // Now primary
      }
    ]
  },
  "message": "Document set as primary"
}
```

---

### 3. Remove Document from Attribute
```bash
DELETE /hospitals/{hospitalId}/attributes/{attributeKey}/documents/{documentId}

Headers:
  Authorization: Bearer {accessToken}

Response (200):
{
  "statusCode": 200,
  "data": {
    "success": true,
    "message": "Document removed from attribute"
  }
}

Note: If deleted document was primary, next document (by added_at DESC) 
auto-promoted to primary. If was last document, attribute has empty documents array.
```

---

### 4. Get Attribute with All Documents
```bash
GET /hospitals/{hospitalId}/attributes/{attributeKey}

Headers:
  Authorization: Bearer {accessToken}

Response (200):
{
  "statusCode": 200,
  "data": {
    "id": "attr-uuid",
    "attributeKey": "accreditation.nabh",
    "hospital_id": "hospital-uuid",
    "value": true,
    "verificationStatus": "verified",
    "documents": [
      {
        "id": "junction-uuid-1",
        "documentId": "doc-uuid-1",
        "fileName": "NABH_Cert.pdf",
        "fileSize": 250000,
        "mimeType": "application/pdf",
        "uploadedAt": "2026-04-19T10:30:00Z",
        "isPrimary": true
      },
      {
        "id": "junction-uuid-2",
        "documentId": "doc-uuid-2",
        "fileName": "Renewal.pdf",
        "fileSize": 180000,
        "mimeType": "application/pdf",
        "uploadedAt": "2026-04-18T14:00:00Z",
        "isPrimary": false
      }
    ],
    "verificationNotes": "Verified manually",
    "verifiedAt": "2026-04-19T12:00:00Z",
    "verificationMethod": "manual"
  },
  "message": "Attribute retrieved"
}
```

---

### 5. Get All Attributes with Documents
```bash
GET /hospitals/{hospitalId}/attributes

Headers:
  Authorization: Bearer {accessToken}

Query Parameters (optional):
  category=accreditation  // Filter by category
  status=verified         // Filter by status

Response (200):
{
  "statusCode": 200,
  "data": [
    {
      "id": "attr-uuid-1",
      "attributeKey": "accreditation.nabh",
      "documents": [
        {
          "id": "junction-uuid",
          "documentId": "doc-uuid",
          "fileName": "NABH_Cert.pdf",
          "fileSize": 250000,
          "mimeType": "application/pdf",
          "uploadedAt": "2026-04-19T10:30:00Z",
          "isPrimary": true
        }
      ],
      "verificationStatus": "verified"
    },
    {
      "id": "attr-uuid-2",
      "attributeKey": "license.medical",
      "documents": [
        {
          "id": "junction-uuid-2",
          "documentId": "doc-uuid-2",
          "fileName": "License.pdf",
          "fileSize": 120000,
          "mimeType": "application/pdf",
          "uploadedAt": "2026-04-15T09:00:00Z",
          "isPrimary": true
        },
        {
          "id": "junction-uuid-3",
          "documentId": "doc-uuid-3",
          "fileName": "License_Renewal.pdf",
          "fileSize": 95000,
          "mimeType": "application/pdf",
          "uploadedAt": "2026-03-20T15:00:00Z",
          "isPrimary": false
        }
      ],
      "verificationStatus": "verified"
    }
  ],
  "message": "Retrieved 2 attributes"
}
```

---

## Error Responses

### Document Not Found (404)
```json
{
  "statusCode": 404,
  "data": null,
  "message": "Document not found for this attribute"
}
```

### Attribute Not Found (404)
```json
{
  "statusCode": 404,
  "data": null,
  "message": "Attribute not set for this hospital"
}
```

### Unauthorized (401)
```json
{
  "statusCode": 401,
  "data": null,
  "message": "Unauthorized"
}
```

### Invalid Request (400)
```json
{
  "statusCode": 400,
  "data": null,
  "message": "Hospital ID and attribute key are required"
}
```

---

## Testing with cURL

### Add Document to Attribute
```bash
curl -X POST http://localhost:8000/api/v1/hospitals/hospital-123/attributes/accreditation.nabh/documents \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"documentId": "doc-456"}'
```

### Set as Primary
```bash
curl -X PUT http://localhost:8000/api/v1/hospitals/hospital-123/attributes/accreditation.nabh/documents/doc-456/primary \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

### Remove Document
```bash
curl -X DELETE http://localhost:8000/api/v1/hospitals/hospital-123/attributes/accreditation.nabh/documents/doc-456 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get Attribute
```bash
curl -X GET http://localhost:8000/api/v1/hospitals/hospital-123/attributes/accreditation.nabh \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Frontend Integration

### Using ApiService in Components

```typescript
import ApiService from '@/services/api';

// Add document to attribute
const response = await ApiService.addDocumentToAttribute(
  hospitalId, 
  attributeKey, 
  documentId
);
const updatedAttribute = response.data.data;
const documents = updatedAttribute.documents;

// Set as primary
await ApiService.setPrimaryDocument(
  hospitalId, 
  attributeKey, 
  documentId
);

// Remove from attribute
await ApiService.removeDocumentFromAttribute(
  hospitalId, 
  attributeKey, 
  documentId
);
```

---

## Response Field Reference

| Field | Type | Description |
|-------|------|-------------|
| id | string (UUID) | Junction table record ID |
| documentId | string (UUID) | Document ID (use for download) |
| fileName | string | Original filename |
| fileSize | number | Size in bytes |
| mimeType | string | MIME type (e.g., "application/pdf") |
| uploadedAt | string (ISO 8601) | Timestamp when document was added to attribute |
| isPrimary | boolean | Is this the primary document for the attribute |

---

## Implementation Notes

1. **Junction Table IDs**: Use `id` for removing/managing documents in junction
2. **Document IDs**: Use `documentId` for download/preview operations
3. **Primary Document**: Only ONE document per attribute can have `isPrimary: true`
4. **Auto-Promotion**: When primary is deleted, next by `added_at DESC` becomes primary
5. **Ordering**: Documents returned ordered by `isPrimary DESC, added_at DESC`
6. **Backward Compatibility**: Old `documentId` field on attribute still supported in write operations

---

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success (GET, PUT, DELETE) |
| 201 | Created (POST) |
| 400 | Bad Request (validation error) |
| 401 | Unauthorized (no/invalid token) |
| 404 | Not Found |
| 500 | Server Error |

