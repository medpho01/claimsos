# Document Upload Feature - Complete Test Plan

## Prerequisites
- Backend running on http://localhost:8000
- Frontend running on http://localhost:3000
- Hospital account created and logged in
- AWS S3 credentials configured in .env

---

## API Level Testing (CURL)

### 1. Test Upload Endpoint
```bash
# Set variables
HOSPITAL_ID="your-hospital-id"
TOKEN="your-auth-token"
FILE="path/to/test-document.pdf"

# Upload document
curl -X POST http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$FILE" \
  -F "documentName=Test Certification" \
  -F "documentCategory=certifications" \
  -F "documentType=NABH" \
  -F "issueDate=2023-01-01" \
  -F "expiryDate=2025-12-31" \
  | jq .

# Expected response:
# {
#   "success": true,
#   "data": {
#     "id": "doc-uuid",
#     "documentName": "Test Certification",
#     "s3Key": "hospitals/{id}/documents/certifications/...",
#     ...
#   }
# }
```

### 2. Test List Documents
```bash
curl -X GET http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents \
  -H "Authorization: Bearer $TOKEN" \
  | jq .

# Should return array of documents with metadata
```

### 3. Test Get Document
```bash
DOC_ID="doc-uuid-from-step-1"

curl -X GET http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents/$DOC_ID \
  -H "Authorization: Bearer $TOKEN" \
  | jq .

# Should return document metadata
```

### 4. Test Download Document
```bash
curl -X GET http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents/$DOC_ID/download \
  -H "Authorization: Bearer $TOKEN" \
  -o downloaded-file.pdf

# Verify file was downloaded and can be opened
file downloaded-file.pdf
```

### 5. Test Delete Document
```bash
curl -X DELETE http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents/$DOC_ID \
  -H "Authorization: Bearer $TOKEN" \
  | jq .

# Should return 200 with success message
```

---

## Frontend UI Testing

### 1. Navigate to Hospital Profile
1. Login to http://localhost:3000
2. Go to your hospital profile
3. Look for "Documents & Certifications" section
4. Verify upload button is present

### 2. Upload Document via UI
1. Click "Upload Document" button
2. Select a test file (PDF, image, or Word doc)
3. Fill in form:
   - Document Name: "Test Certificate"
   - Category: "Certifications"
   - Type: "NABH"
   - Issue Date: (any date)
   - Expiry Date: (future date)
4. Click "Upload"
5. Verify:
   - Progress bar appears and fills
   - Success message displays
   - Document appears in list below

### 3. Verify Document Display
1. Check document appears with correct metadata:
   - Name, category, type, size, dates
   - Issue/expiry dates formatted correctly
   - Expired badge appears if date is past today
2. Hover over document - should show clear on item

### 4. Download Document
1. Click "Download" button on document
2. Verify file downloads with original filename
3. Open downloaded file - content should match original

### 5. Delete Document
1. Click "Delete" button on document
2. Confirm deletion dialog appears
3. Click "Confirm" or "Yes"
4. Verify:
   - Document disappears from list
   - Success message displays
   - S3 file is deleted (check AWS console if needed)

### 6. Test File Validation
1. Try uploading file > 100MB
   - Should show error: "File size exceeds 100MB limit"
2. Try uploading unsupported file type (e.g., .exe)
   - Should be blocked by file input accept filter
3. Try submitting without selecting file
   - Should show error: "Please select a file"
4. Try submitting without document name
   - Should show error: "Please enter a document name"

---

## Integration Testing

### 1. Link Document to Attribute
If attribute feature is implemented:
```bash
ATTR_KEY="nabh_certified"

curl -X PUT http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents/$DOC_ID/link/$ATTR_KEY \
  -H "Authorization: Bearer $TOKEN" \
  | jq .
```

### 2. Get Documents by Attribute
```bash
curl -X GET "http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents?attributeKey=$ATTR_KEY" \
  -H "Authorization: Bearer $TOKEN" \
  | jq .

# Should return only documents linked to this attribute
```

---

## Error Handling Testing

### 1. Test Invalid Hospital ID
```bash
curl -X POST http://localhost:8000/api/v1/hospitals/invalid-id/documents/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test.pdf" \
  -F "documentName=Test"

# Should return 404: Hospital not found
```

### 2. Test Missing Authorization
```bash
curl -X POST http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents/upload \
  -F "file=@test.pdf" \
  -F "documentName=Test"

# Should return 401: Unauthorized
```

### 3. Test Corrupted Form Data
```bash
# Missing required field
curl -X POST http://localhost:8000/api/v1/hospitals/$HOSPITAL_ID/documents/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test.pdf"
  # No documentName

# Should return 400: Missing required field 'documentName'
```

### 4. Test S3 Connectivity Errors
- Temporarily disable AWS credentials in .env
- Try uploading document
- Should see error: "Failed to upload document" or AWS error message
- Re-enable credentials and verify upload works again

---

## Performance Testing

### 1. Upload Speed
- Upload 10MB file - should complete in < 10 seconds
- Upload 50MB file - should complete in < 30 seconds
- Upload 100MB file - should complete in < 60 seconds
- Progress bar should update smoothly (every 200ms)

### 2. List Performance
- Upload 50 documents
- List all documents - should load in < 2 seconds
- Filter by category - should load instantly

### 3. Download Speed
- Download file - should start within 2 seconds
- File transfer speed should match network speed

---

## Browser Testing

### 1. Chrome/Edge
- [ ] Upload works
- [ ] Download works
- [ ] Delete with confirmation works
- [ ] Progress bar displays
- [ ] Responsive design looks good

### 2. Firefox
- [ ] All above features work
- [ ] No console errors

### 3. Safari
- [ ] All above features work
- [ ] File types are properly restricted

### 4. Mobile (iPhone/Android)
- [ ] Upload dialog opens
- [ ] Can select file from device
- [ ] Form is readable on small screen
- [ ] Upload/download works
- [ ] Delete with confirmation works

---

## Security Testing

### 1. Authentication
- [ ] Unauthenticated users cannot upload
- [ ] Users can only upload to their own hospital
- [ ] Admin users can upload for any hospital

### 2. File Type Validation
- [ ] Only allowed file types accepted
- [ ] Server validates MIME type (not just extension)
- [ ] .exe/.sh files blocked

### 3. S3 Security
- [ ] Documents not publicly accessible
- [ ] Download requires authentication
- [ ] CloudFront-signed URLs work
- [ ] Old signatures expire and fail

### 4. CORS Testing
- [ ] Frontend can make requests to backend
- [ ] File upload POST works
- [ ] Download streaming works

---

## Database Testing

### 1. Check Document Record Created
```sql
SELECT * FROM hospital.hospital_documents 
WHERE hospital_id = 'your-hospital-id'
LIMIT 1;

-- Verify columns:
-- - id: UUID
-- - hospital_id: matches input
-- - document_name: "Test Certificate"
-- - s3_key: has correct format
-- - file_size_bytes: > 0
-- - created_at: timestamp
```

### 2. Check S3 File Exists
```bash
# List files in S3 for your hospital
aws s3 ls s3://hospital-claims-images/hospitals/$HOSPITAL_ID/documents/ --recursive

# Should show: hospitals/{id}/documents/certifications/TIMESTAMP_filename.pdf
```

### 3. Check File Encryption
```bash
# Get file metadata
aws s3api head-object \
  --bucket hospital-claims-images \
  --key "hospitals/$HOSPITAL_ID/documents/certifications/TIMESTAMP_filename.pdf"

# Should show: ServerSideEncryption: AES256
```

---

## Logging & Monitoring

### Backend Logs
1. Check for upload endpoint called:
   ```
   POST /hospitals/:hospitalId/documents/upload
   ```

2. Check for S3 operation logs:
   ```
   S3 Upload: hospitals/{id}/documents/{category}/{timestamp}_{filename}
   ```

3. Check for errors:
   - No "SyntaxError" (Node issue)
   - No "S3 connection failed"
   - No "Database error"

### Frontend Logs (Browser Console)
1. F12 → Console tab
2. Upload a document
3. Check for:
   - No red error messages
   - FormData is properly created
   - API response is received
   - Success callback fires

### CloudFront Logs (Optional)
1. Check CloudFront distribution metrics
2. Verify signed URLs are generated
3. Verify cache hit rate > 50%

---

## Test Case Results

### Passing Tests (Expected)
- [ ] Upload valid PDF document
- [ ] Upload valid image (JPG/PNG)
- [ ] Upload valid Word document
- [ ] List documents works
- [ ] Download document works
- [ ] Delete document with confirmation works
- [ ] File size validation works
- [ ] Required field validation works
- [ ] Error messages display correctly
- [ ] Progress bar shows during upload
- [ ] Success message shows after upload
- [ ] Form resets after successful upload
- [ ] Mobile UI is responsive

### Known Issues (If Any)
- Note any issues found during testing
- Include: browser, OS, file type, error message
- Example: "Firefox: Optional chaining error on upload"

---

## Post-Testing Checklist

- [ ] All API endpoints tested with curl
- [ ] UI tested in at least 2 browsers
- [ ] File upload/download/delete work end-to-end
- [ ] Error handling works correctly
- [ ] No console errors
- [ ] No unhandled promise rejections
- [ ] Database records created correctly
- [ ] S3 files exist and are accessible
- [ ] Backend logs show successful operations
- [ ] Mobile responsiveness verified

---

## If Tests Fail

### Upload Fails - Check These:
1. Backend logs for specific error
2. Network tab in browser DevTools
3. AWS S3 credentials in .env
4. CloudFront distribution is active
5. Hospital ID is correct
6. User has permission to upload

### Download Fails - Check These:
1. File still exists in S3
2. CloudFront distribution is active
3. CloudFront key pair ID matches .env
4. Document record exists in database

### Delete Fails - Check These:
1. Document exists in database
2. S3 file exists
3. User owns the document
4. No permission errors

---

## Success Criteria

✅ **Feature is working when:**
1. Documents can be uploaded via UI
2. Upload progress is visible
3. Documents appear in list with metadata
4. Documents can be downloaded
5. Documents can be deleted with confirmation
6. All validation works (size, type, required fields)
7. No errors in browser console or backend logs
8. Files are stored in S3 and accessible via CloudFront
9. Database records are created correctly
10. Mobile UI is responsive and functional
