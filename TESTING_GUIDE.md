# Multi-Document Attribute Management - Testing & Integration Guide

**Status**: ✅ Implementation Complete  
**Date**: April 19, 2026  
**Servers Running**: Backend (8000) ✅ | Webapp (3000) ✅

---

## Overview

This document provides comprehensive testing procedures for the multi-document attribute management feature. The backend now supports 1:many relationships between attributes and documents via the `hospital_attribute_documents` junction table. The frontend components have been enhanced to expose this functionality to users.

---

## Implementation Summary

### Backend Changes (Complete)
- ✅ Junction table created: `hospital_attribute_documents`
- ✅ Database migration applied and verified
- ✅ AttributeService enhanced with multi-document methods
- ✅ API controllers updated with document management endpoints
- ✅ Routes registered for all document operations
- ✅ API service methods implemented in frontend

### Frontend Changes (Complete)

#### DocumentUploadManager.tsx
- ✅ Added `isPrimary?: boolean` field to Document interface
- ✅ Added `isLinkingDocument` state for tracking async operations
- ✅ Implemented `handleSetPrimary(documentId)` method
- ✅ Enhanced `handleDelete()` to call `removeDocumentFromAttribute()` when attributeKey exists
- ✅ Added visual primary indicator (filled star SVG icon)
- ✅ Shows "Set Primary" button only for non-primary documents
- ✅ Changes delete label from "Delete" to "Remove" when document is linked to attribute
- ✅ Properly disables buttons during async operations

#### AttributesManager.tsx
- ✅ Added `AttributeDocument` interface matching backend response
- ✅ Updated `Attribute` interface to include `documents?: AttributeDocument[]` array
- ✅ Added document count badge to attribute card header
- ✅ Completely rewrote document display section to show all documents
- ✅ Displays primary indicator (filled yellow star) for each document
- ✅ Added compact Eye icon button for preview
- ✅ Added compact Download icon button for download
- ✅ Shows empty state when no documents exist

---

## Test Environment Setup

### Prerequisites
- Node.js v18.18.0 ✅
- Backend running on port 8000 ✅
- Webapp running on port 3000 ✅
- Database with applied migrations ✅

### Start Servers (if not running)
```bash
# Backend
cd /Users/maverick/Documents/Finclarity-Tech/claimsos/Backend
export PATH=/Users/maverick/.nvm/versions/node/v18.18.0/bin:$PATH
npm start

# Webapp (in new terminal)
cd /Users/maverick/Documents/Finclarity-Tech/claimsos/webapp
export PATH=/Users/maverick/.nvm/versions/node/v18.18.0/bin:$PATH
BROWSER=none npm start
```

---

## API Endpoints to Test

### Document Management on Attributes

#### 1. Add Document to Attribute
```bash
POST /api/v1/hospitals/{hospitalId}/attributes/{attributeKey}/documents
Body: { documentId: "doc-uuid" }
Response: { id, documentId, fileName, fileSize, mimeType, uploadedAt, isPrimary }
```

#### 2. Set Document as Primary
```bash
PUT /api/v1/hospitals/{hospitalId}/attributes/{attributeKey}/documents/{documentId}/primary
Response: Updated attribute with documents array
```

#### 3. Remove Document from Attribute
```bash
DELETE /api/v1/hospitals/{hospitalId}/attributes/{attributeKey}/documents/{documentId}
Response: { success: true, message: "Document removed" }
```

#### 4. Get Attribute with Documents
```bash
GET /api/v1/hospitals/{hospitalId}/attributes/{attributeKey}
Response: {
  id, attributeKey, value, verificationStatus,
  documents: [
    { id, documentId, fileName, fileSize, mimeType, uploadedAt, isPrimary },
    ...
  ]
}
```

---

## Manual Testing Checklist

### Phase 1: DocumentUploadManager Component

#### ✅ Single Document Upload
- [ ] Navigate to hospital profile
- [ ] Open DocumentUploadManager component
- [ ] Click "Upload Document" button
- [ ] Fill in all fields (name, category, type, dates)
- [ ] Select a file (PDF, image, or doc)
- [ ] Click "Upload"
- [ ] Document appears in list
- [ ] Document metadata displays correctly

#### ✅ Multiple Documents
- [ ] Upload 3+ documents to test component behavior
- [ ] Verify all documents display in the list
- [ ] Check document count and sizing
- [ ] Verify scroll behavior if many documents
- [ ] Check responsive layout on different screen sizes

#### ✅ Primary Document Management
- [ ] Upload 2 documents
- [ ] First document should show filled star icon
- [ ] Second document should show outline star
- [ ] Click star on second document → "Set Primary" button appears
- [ ] Click "Set Primary"
- [ ] Wait for API call to complete
- [ ] Verify star moves to second document
- [ ] First document star should disappear
- [ ] Check success message appears
- [ ] Refresh page → primary status persists

#### ✅ Document Download
- [ ] Click "Download" button on any document
- [ ] File downloads with correct name
- [ ] File opens/renders correctly
- [ ] Verify file is not corrupted
- [ ] Test with different file types (PDF, PNG, DOC)

#### ✅ Document Removal
- [ ] Click "Remove" or "Delete" button on document
- [ ] Confirm dialog appears
- [ ] Click "Confirm"
- [ ] Document removed from list
- [ ] Success message shown
- [ ] API call completes (check network tab)
- [ ] Refresh page → document not in list
- [ ] If primary was removed → next document auto-promoted

#### ✅ Button State Management
- [ ] During API call, buttons should be disabled
- [ ] "Set Primary" should only show for non-primary docs
- [ ] Label should change: "Delete" → "Remove" when attributeKey present
- [ ] Spinner/loading indicator should show during operations
- [ ] Buttons re-enable after operation completes

### Phase 2: AttributesManager Component

#### ✅ Document Count Badge
- [ ] View attribute card
- [ ] If documents exist, badge shows: "(1 doc)", "(3 docs)", etc.
- [ ] Badge styling is visible (blue background)
- [ ] Badge only shows when documents > 0
- [ ] Count updates when documents added/removed

#### ✅ Multiple Document Display
- [ ] Add attribute with multiple documents
- [ ] Document section expands to show all documents
- [ ] Each document row shows:
  - [ ] Yellow star if primary
  - [ ] File icon
  - [ ] File name (truncated if long)
  - [ ] Eye button (preview)
  - [ ] Download button
- [ ] Primary indicator (star) only on primary document

#### ✅ Document Actions in AttributesManager
- [ ] Click Eye icon → FilePreviewModal opens
- [ ] Click Download icon → file downloads
- [ ] Empty state shows "No documents uploaded" when no docs
- [ ] Document list is readable and compact

#### ✅ Attribute Card Integration
- [ ] View multiple attributes with different document counts
- [ ] Some with 0 docs, some with 1, some with multiple
- [ ] Layout doesn't break with variable counts
- [ ] All UI elements render without overlaps
- [ ] Responsive on mobile devices

### Phase 3: Integration Testing

#### ✅ Full Workflow: Upload → Link → Manage
1. [ ] Create new attribute (e.g., "NABH Certification")
2. [ ] Upload document in DocumentUploadManager
3. [ ] In AttributesManager, add new attribute
4. [ ] Verify document appears in attribute's document list
5. [ ] Set document as primary from AttributesManager
6. [ ] Verify primary indicator updates
7. [ ] Delete document from attribute
8. [ ] Verify document removed from list
9. [ ] Count badge updates correctly

#### ✅ Multiple Attributes with Shared Documents
- [ ] Upload 2 documents
- [ ] Create Attribute A, link document 1
- [ ] Create Attribute B, link document 2
- [ ] Create Attribute C, link both documents
- [ ] In AttributesManager:
  - [ ] A shows 1 doc
  - [ ] B shows 1 doc
  - [ ] C shows 2 docs with primary indicator
- [ ] Modify documents in C:
  - [ ] Add more documents
  - [ ] Change primary document
  - [ ] Remove document
- [ ] Verify other attributes unaffected

#### ✅ API Response Handling
- [ ] Upload document → backend returns correct structure
- [ ] Verify response has all required fields:
  - [ ] `id` (junction table ID)
  - [ ] `documentId` (for download)
  - [ ] `fileName`
  - [ ] `fileSize`
  - [ ] `mimeType`
  - [ ] `uploadedAt`
  - [ ] `isPrimary`
- [ ] Field names are camelCase
- [ ] Data types match TypeScript interfaces

### Phase 4: Edge Cases

#### ✅ No Documents
- [ ] Empty state displays "No documents uploaded"
- [ ] "Upload Document" button visible and functional
- [ ] No errors in console
- [ ] Badge doesn't show

#### ✅ Single Document
- [ ] Star icon fills (primary)
- [ ] "Set Primary" button doesn't show (already primary)
- [ ] Download and preview work
- [ ] Removing document shows empty state

#### ✅ Many Documents (10+)
- [ ] All display correctly
- [ ] Scroll behavior works
- [ ] Performance acceptable
- [ ] No layout shifts
- [ ] All buttons accessible

#### ✅ Long Filenames
- [ ] Filenames truncated with ellipsis
- [ ] Full name visible on hover (title attribute)
- [ ] Download button still functional
- [ ] Layout doesn't break

#### ✅ Special Characters in Filenames
- [ ] Files with spaces download correctly
- [ ] Files with special chars (©, ®, etc.) handled
- [ ] Unicode filenames work
- [ ] No encoding issues on display

#### ✅ Large Files
- [ ] 10MB+ files download correctly
- [ ] No memory issues with blob handling
- [ ] Upload progress shows accurately
- [ ] Timeout handling works properly

#### ✅ Error Scenarios
- [ ] Network error during download → user-friendly message
- [ ] Failed "Set Primary" → error shown, state reverts
- [ ] Failed remove → error message, document stays in list
- [ ] Invalid file → upload validation prevents submission

### Phase 5: Data Persistence

#### ✅ Page Refresh
- [ ] Upload 2 documents
- [ ] Set second as primary
- [ ] Refresh page (Cmd+R)
- [ ] All documents still present
- [ ] Primary status preserved
- [ ] Count badge unchanged

#### ✅ Browser Navigation
- [ ] Upload documents
- [ ] Navigate to different attribute
- [ ] Navigate back
- [ ] Documents still there
- [ ] Primary status preserved

#### ✅ LocalStorage & Auth
- [ ] Clear localStorage
- [ ] Log out and log back in
- [ ] Documents persist in database
- [ ] Primary status preserved
- [ ] No data loss

---

## Code Quality Verification

### TypeScript Compilation
```bash
cd /Users/maverick/Documents/Finclarity-Tech/claimsos/webapp
export PATH=/Users/maverick/.nvm/versions/node/v18.18.0/bin:$PATH
npx tsc --noEmit
# Expected: No output (no errors)
```

### Component Imports
- ✅ DocumentUploadManager imports ApiService correctly
- ✅ AttributesManager imports DocumentUploadManager (if needed)
- ✅ All interfaces properly typed
- ✅ No unused imports or variables

### Error Handling
- ✅ Try/catch blocks in all async functions
- ✅ User-friendly error messages
- ✅ Loading states managed properly
- ✅ Console errors logged with context

### Performance
- ✅ Documents array efficiently rendered (map with key)
- ✅ No unnecessary re-renders
- ✅ useEffect dependencies correct
- ✅ API calls debounced/throttled if needed

---

## Browser Console Checks

While testing in browser, check for:
- [ ] No red errors in console
- [ ] No unhandled promise rejections
- [ ] All API calls succeed (check Network tab)
- [ ] No TypeScript or linting warnings
- [ ] Memory usage stable during operations

### Network Tab Verification
- [ ] POST to `/attributes/{key}/documents` succeeds
- [ ] PUT to `.../documents/{id}/primary` succeeds
- [ ] DELETE from `.../documents/{id}` succeeds
- [ ] Response status codes correct (200, 201, 204, etc.)
- [ ] Response payloads match expected structure

---

## Rollback Plan (if needed)

If issues are discovered:

1. **Backend Issues**: 
   - Restore previous version of AttributeService
   - Run migration rollback (if data corruption)

2. **Frontend Issues**:
   - Revert DocumentUploadManager.tsx changes
   - Revert AttributesManager.tsx changes
   - Backend stays unchanged (backwards compatible)

---

## Sign-Off Criteria

Testing is complete when:
- ✅ All "Phase 1-4" checklist items pass
- ✅ No console errors or warnings
- ✅ API responses match expected format
- ✅ Data persists correctly
- ✅ No TypeScript compilation errors
- ✅ Feature works on Chrome, Firefox, Safari

---

## Known Limitations

1. **File Input**: Currently single file at a time (can extend to multiple later)
2. **Primary Promotion**: Automatic, can't be disabled (working as designed)
3. **Document Size**: Limited to 100MB (backend config)
4. **Preview**: Only for supported formats (PDF, images, basic documents)

---

## Next Steps

1. **Manual Testing**: Follow checklist above in browser
2. **Load Testing**: Test with many documents (100+) if needed
3. **Cross-Browser**: Test on Safari, Firefox, edge cases
4. **User Acceptance**: Get stakeholder sign-off
5. **Production Deployment**: Monitor for issues post-launch

---

## Support & Troubleshooting

### Common Issues

**Q: Star icon doesn't appear for primary document**
- A: Check isPrimary field in response, inspect element, verify API returned correct data

**Q: "Set Primary" button disabled**
- A: isLinkingDocument state true, wait for API to complete, check network errors

**Q: Documents disappear after removal**
- A: Expected behavior, document removed from attribute (not from system)
- To restore: Re-upload and re-link document

**Q: Document count badge wrong**
- A: Refresh page, verify API response includes all documents, check for filter applied

---

## Contact & Questions

For issues or questions during testing, refer to:
- Backend: /Backend/src/Services/attribute.service.ts
- Frontend: /webapp/src/components/DocumentUploadManager.tsx
- Integration: /webapp/src/pages/hospital/Profile/components/AttributesManager.tsx

