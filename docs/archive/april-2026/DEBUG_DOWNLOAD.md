# 🔍 Debugging Document Download Issue

## The Problem
When clicking to view/download a document, you're seeing:
```
Cannot GET /hospitals/{id}/documents/{id}
```

This error means the browser is trying to navigate directly to a backend route that doesn't exist.

## Root Causes
1. **Clicking the wrong element** - Maybe clicking on document name instead of Download button
2. **Browser cache** - Old code still in browser
3. **Route misconfiguration** - Some page is creating wrong links

## Step-by-Step Testing

### Step 1: Clear Browser Cache
1. Open DevTools (F12)
2. **Settings** → **Network**
3. Check: **Disable cache (while DevTools is open)**
4. **Hard refresh**: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)

### Step 2: Test Upload First
1. Go to http://localhost:3000 (NOT :8000)
2. Login to your hospital account
3. Navigate to Hospital Profile
4. Find **Documents & Certifications** section
5. Click **"Upload Document"** button
6. Select a small file (text file or small PDF)
7. Fill in:
   - **Document Name**: TestDoc123
   - **Category**: Certifications
   - **Type**: Test
8. Click **Upload**
9. **Verify**:
   - ✅ Progress bar appears
   - ✅ Success message shows
   - ✅ Document appears in list below

### Step 3: Open DevTools Network Tab
1. Press F12 to open Developer Tools
2. Click **Network** tab
3. Make sure **Disable cache** is checked
4. Keep this tab open during download test

### Step 4: Test Download - DO NOT CLICK ON DOCUMENT NAME
**IMPORTANT**: Only click the blue **"Download"** button, NOT the document name
1. Find your uploaded document in the list
2. Look for the blue **"Download"** button (bottom right of document)
3. **Single click** on the Download button
4. Watch the **Network tab** - you should see:
   - Request to `/api/v1/hospitals/{id}/documents/{id}/download`
   - Status: 200 OK
   - Response type: blob/binary

### Step 5: Verify File Downloads
1. After clicking Download:
   - ✅ Check if file appears in Downloads folder
   - ✅ Success message should appear on page
   - ✅ No errors in browser console

### Step 6: Check Browser Console
1. Open DevTools (F12)
2. Click **Console** tab
3. Look for any RED error messages
4. Look for any YELLOW warnings
5. Copy any errors and share

## Network Tab Expectations

**When you click Download button, you should see:**

```
GET /api/v1/hospitals/{hospitalId}/documents/{documentId}/download

Status: 200 OK
Response Type: blob
Content-Type: application/octet-stream or text/plain or application/pdf
Size: File size in bytes
```

## If You See the Error Again

Check these things:

### 1. What Element Did You Click?
- ✅ Blue "Download" button = Correct
- ❌ Document name text = Wrong - that shouldn't be clickable
- ❌ Category/Type text = Wrong
- ❌ Any other text = Wrong

### 2. Check Network Tab
- What was the REQUEST URL?
- What was the REQUEST METHOD?
- What was the RESPONSE STATUS?
- What HEADERS were sent?

### 3. Check Console Tab
- Any error messages?
- Any failed requests?

## Correct Behavior vs Wrong Behavior

### ✅ CORRECT - What Should Happen
```
1. Click Download button
2. Network request: GET /api/v1/hospitals/...../download
3. Status: 200
4. File downloads automatically
5. Success message appears
6. No page navigation
7. Still on same page
```

### ❌ WRONG - What's Happening Now
```
1. Click something
2. Page navigates to: http://localhost:8000/hospitals/.../documents/...
3. Shows: "Cannot GET /hospitals/.../documents/..."
4. Backend 404 error
5. Page went to backend instead of staying in React app
```

## The Difference

**Good Download**: API call, file blob returned, browser downloads automatically  
**Bad Download**: Page navigation, trying to visit non-existent backend route

## Testing Checklist

- [ ] Clear browser cache (Cmd+Shift+R)
- [ ] Upload a document successfully
- [ ] Open DevTools (F12)
- [ ] Go to Network tab
- [ ] Find the document in the list
- [ ] **ONLY** click the blue Download button (not document name)
- [ ] Watch Network tab for `/api/v1/.../download` request
- [ ] Check Status: 200
- [ ] Verify file downloads
- [ ] Check for success message
- [ ] Check console for errors

## If Download Still Fails

Run this test in browser console (F12 → Console):
```javascript
// This is what the download function should do
async function testDownload() {
  const hospitalId = 'df2c60d6-d634-4697-a997-e9fd0f3b9960';
  const documentId = '9136b4cd-aa7b-4e93-ab33-28a3b9fc7b1c';
  const token = localStorage.getItem('accessToken');
  
  const response = await fetch(
    `/api/v1/hospitals/${hospitalId}/documents/${documentId}/download`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );
  
  console.log('Status:', response.status);
  console.log('Type:', response.type);
  console.log('Headers:', Object.fromEntries(response.headers));
  
  if (response.ok) {
    const blob = await response.blob();
    console.log('Blob size:', blob.size);
    console.log('Blob type:', blob.type);
    
    // Trigger download
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'test-download.txt';
    a.click();
  }
}

testDownload();
```

Run this and check the console output. Report what you see.

## Possible Solutions

### Solution 1: Hard Refresh Everything
```
1. Close browser tab
2. Close React dev server (Ctrl+C in terminal)
3. Clear node_modules cache: rm -rf node_modules/.cache
4. Restart: npm start
5. Clear browser cache: Cmd+Shift+R
6. Test again
```

### Solution 2: Check if DocumentUploadManager is Being Used
1. F12 → Elements
2. Search for "Download" button
3. Check if it has `onClick={() => handleDownload(doc.id)}`
4. If not, the old component code might still be running

### Solution 3: Verify API Service Path
Run this in browser console:
```javascript
import ApiService from '@/services/api';
// Check the API base URL
console.log('API Base URL configured correctly');
```

## Contact Points

If this doesn't work, check these files:
- Frontend: `/webapp/src/components/DocumentUploadManager.tsx` (lines 174-195)
- API Service: `/webapp/src/services/api.ts` (downloadDocument method)
- Backend: `/Backend/src/Controllers/document.controller.ts` (downloadDocument endpoint)

---

**Before proceeding, complete the testing steps above and report:**
1. What element you clicked (Download button or something else?)
2. What you see in the Network tab
3. Any errors in the Console tab
4. The exact URL that appears in the error
