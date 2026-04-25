# Analysis: Doctor Attributes Not Saving Issue

**Date:** April 24, 2026  
**Issue:** Doctor attributes not being saved to database (table is empty)

---

## 1. HOW HOSPITAL ATTRIBUTES WORK (WORKING CORRECTLY)

### Hospital Attributes Flow:
```
Frontend (React)
  ↓
  POST /hospitals/{id}/attributes/{key}
  Body: { valueText/valueDate/valueBoolean, documentId }
  ↓
attribute.controller.ts (setAttribute)
  ↓
attribute.service.ts
  1. INSERT INTO hospital_attributes with values
  2. Link documents to junction table
  3. Return attribute with documents
  ↓
Database Tables:
  - hospital_attributes (stores values)
  - hospital_attribute_documents (stores document links)
  - hospital_documents (stores file metadata)
```

**Key Points:**
- Insert with `ON CONFLICT` to handle updates
- Documents are linked AFTER attribute is created
- Attributes ALWAYS inserted even without documents (empty documentIds array)
- Response includes formatted attribute object

---

## 2. HOW DOCTOR ATTRIBUTES SHOULD WORK (CURRENTLY BROKEN)

### Current Doctor Attributes Flow:
```
Frontend (React)
  ↓
  POST /doctors/{id}/attributes/{key}
  Body: { valueText/valueDate/valueBoolean, documentIds: [] }
  ↓
doctorAttribute.controller.ts (setAttribute)
  ↓
doctorAttribute.service.ts
  1. Verify doctor exists
  2. Verify attribute definition exists
  3. INSERT INTO doctor_attributes with values
  4. Link documents (if any)
  5. Return attribute
  ↓
Database Tables:
  - doctor_attributes (should store values)
  - doctor_attribute_documents (should link documents)
```

**The Problem:** Table is empty, so INSERT is either:
- Not happening
- Failing silently
- Not returning data properly

---

## 3. DEBUGGING PLAN

### Step 1: Check if Controller is Being Called
Add logging to doctorAttribute.controller.ts

### Step 2: Check if Service Method is Executing
Add logging to doctorAttribute.service.ts setAttribute()

### Step 3: Check Database Insert
Verify INSERT query is working

### Step 4: Check Response Format
Verify frontend can read the response

### Step 5: Check Frontend Handling
Verify frontend processes the response correctly

---

## 4. POTENTIAL ISSUES IDENTIFIED

### Issue A: Missing formatAttributeResponse
The service calls `this.formatAttributeResponse(attribute)` but I need to verify this method exists.

### Issue B: Response Structure Mismatch
Frontend expects: `response.data?.attributes`
Service returns: `{ attributes: [...], grouped: {...} }`
Controller might not be wrapping correctly

### Issue C: No Error Logging
If INSERT fails, there's no error being thrown or logged

### Issue D: Empty documentIds Handling
Frontend sends empty `documentIds: []` - service might be rejecting this

---

## 5. COMPARISON: What Hospital Attributes Do Right

**attribute.service.ts (working):**
```typescript
// Lines 114-135: Handles document linking
if (input.documentId || input.documentIds) {
  const documentIds = input.documentIds || (input.documentId ? [input.documentId] : []);
  
  for (let i = 0; i < documentIds.length; i++) {
    const docId = documentIds[i];
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(docId)) continue;
    
    // Add document to attribute
    await this.addDocumentToAttribute(...);
  }
}
```

**Key: Only processes documentIds that are valid UUIDs!**

---

## 6. WHAT NEEDS TO BE FIXED

1. **Doctor Attribute Controller**
   - Ensure it returns response in correct format
   - Add error handling/logging

2. **Doctor Attribute Service**
   - Verify formatAttributeResponse method exists and works
   - Ensure INSERT query executes properly
   - Handle empty documentIds correctly (don't try to process empty array)
   - Add logging for debugging

3. **Frontend Payload**
   - Must match backend expectations
   - DocumentIds should be empty array (not sent at all) until upload works
   - Values must not be null/undefined

4. **Frontend Response Handling**
   - Check correct property path for response data
   - Add error logging

---

## 7. FIX STRATEGY

1. **First:** Check formatAttributeResponse method
2. **Second:** Add comprehensive logging to service
3. **Third:** Test with curl to see if API works
4. **Fourth:** Fix frontend to handle response correctly
5. **Fifth:** Verify data appears in database

---

## 8. ROOT CAUSE HYPOTHESIS

Most likely: The controller is calling the service, service is trying to insert, but either:
- The INSERT is succeeding but response isn't being formatted correctly
- The INSERT is failing but error isn't being shown
- The frontend isn't reading the response correctly

Solution: Add logging and test with curl.

---

