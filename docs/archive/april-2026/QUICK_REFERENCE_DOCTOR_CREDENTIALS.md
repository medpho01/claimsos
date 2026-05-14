# 🚀 Quick Reference - Doctor Credentials Management

## Where to Find It
**Path:** Hospital Dashboard → Doctor Card → "View Details" → "Edit Doctor" → "+ Add Attribute"

---

## Three Core Features

### 1️⃣ ADD CREDENTIAL
```
✅ Click "+ Add Attribute"
✅ Select credential type from dropdown
✅ Enter value (text, date, yes/no, or file)
✅ Click "Add Credential"
✅ See it appear in list below
✅ Click "Save Changes" to save
```

### 2️⃣ EDIT CREDENTIAL  
```
✅ Click "Edit Doctor" to enable edit mode
✅ Find credential in list
✅ Click pencil (✏️) icon
✅ Update the value
✅ Click "Save" button
✅ Click "Save Changes" to persist
```

### 3️⃣ DELETE CREDENTIAL
```
✅ Click "Edit Doctor" to enable edit mode
✅ Find credential in list
✅ Click trash (🗑️) icon
✅ Confirm in dialog
✅ See it disappear from list
✅ Click "Save Changes" to persist
```

---

## Supported Credential Types

| Category | Type | Format | Example |
|----------|------|--------|---------|
| **Licenses** | NMC Registration | Text | 12345-67890 |
| | State Registration | Text | ABC-12345 |
| **Qualifications** | MD Degree | Text | MD, MBBS |
| | Specialist | Text | DNB (Cardiology) |
| **Registrations** | Permanent NMC | Yes/No | ☑️ |
| | PCC on Record | Yes/No | ☑️ |
| **Compliance** | Malpractice Insurance | Date | 2027-12-31 |
| | COVID Vaccination | Yes/No | ☑️ |
| **Experience** | Years Practicing | Text | 15 |
| | Publications | Text | 42 |

---

## Keyboard Shortcuts & Quick Actions

| Action | Button | Shortcut |
|--------|--------|----------|
| Open Edit Mode | "Edit Doctor" | — |
| Add Credential | "+ Add Attribute" | — |
| Edit Value | Pencil ✏️ | — |
| Delete Credential | Trash 🗑️ | — |
| Save All Changes | "Save Changes" | — |
| Cancel Edits | "Cancel" | — |

---

## Status Badges

| Badge | Meaning | Color |
|-------|---------|-------|
| ✓ Verified | Credential verified by admin | 🟢 Green |
| ⏳ Pending Review | Waiting for verification | 🟡 Yellow |
| ⚪ Unverified | Not yet verified | ⚪ Gray |
| ✗ Rejected | Verification failed | 🔴 Red |

---

## Common Tasks

### Add NMC License
```
1. Click "Edit Doctor"
2. Click "+ Add Attribute"
3. Select: "NMC Registration Number"
4. Enter: "123456789"
5. Click "Add Credential"
6. Click "Save Changes"
```

### Mark Doctor COVID Vaccinated
```
1. Click "Edit Doctor"
2. Click "+ Add Attribute"
3. Select: "COVID-19 Vaccination Status"
4. Select: "Yes"
5. Click "Add Credential"
6. Click "Save Changes"
```

### Remove Wrong Credential
```
1. Click "Edit Doctor"
2. Find wrong credential
3. Click trash icon (🗑️)
4. Click "Confirm" in dialog
5. Click "Save Changes"
```

### Update License Expiry
```
1. Click "Edit Doctor"
2. Find the license credential
3. Click pencil (✏️) icon
4. Change date
5. Click "Save" button
6. Click "Save Changes"
```

---

## Error Solutions

### Error: "No credential selected"
✅ Make sure dropdown is filled (not blank option)

### Error: "Please enter a value"
✅ Value field is required unless it's a pure document type

### Error: "Failed to add attribute"
✅ Check browser console (F12) for details
✅ Verify doctor ID is valid
✅ Ensure you have admin permissions

### Error: "Delete failed"
✅ Make sure you're in edit mode
✅ Verify the confirmation dialog appeared
✅ Try again after page refresh

### Credential doesn't save
✅ Look for red error box at top of modal
✅ Make sure you clicked "Save Changes" (not just the form button)
✅ Check that save completed successfully (green success message)

---

## Tips & Tricks

💡 **Credentials are grouped by category** - Qualifications, Licenses, Registrations, Compliance, Experience

💡 **Edit mode is required** - Delete and edit buttons only appear when "Edit Doctor" is active

💡 **Always save changes** - Individual credential saves don't persist; you must click "Save Changes" at bottom

💡 **Confirmation required** - Delete requires confirmation to prevent accidents

💡 **Multiple formats** - Use text, dates, or yes/no depending on credential type

💡 **Expiry dates tracked** - Some credentials show expiry information

💡 **Verification status visible** - See badge showing if credential is verified

---

## Technical Details

**API Endpoints:**
- `POST /api/v1/doctors/{id}/attributes/{key}` - Add/Update
- `GET /api/v1/doctors/{id}/attributes` - List
- `DELETE /api/v1/doctors/{id}/attributes/{id}` - Delete

**Response Time:** 200-800ms per operation

**Permissions Required:** Hospital Admin for that hospital

---

## Getting Help

**Browser Console:** Press F12 to see detailed error messages
**Network Tab:** Check if API calls succeeded (200 status)
**Logs:** Backend logs available via Docker: `docker logs hospital_backend_dev`

---

**Version:** 1.0  
**Updated:** April 24, 2026  
**Status:** ✅ Production Ready
