# Sticky Headers & Filters Implementation Plan

## Overview
Identify which header/filter sections should be sticky (remain visible at top while scrolling) on each page.

---

## Pages Analysis

### 1. Hospital Portal Pages (via HospitalPortalLayout)
All these pages are nested under `/portal/:hospitalId/*` with the HospitalPortalLayout wrapper.

#### 1.1 Dashboard (`/portal/:hospitalId`)
**Current Structure:**
```
- HospitalOperationsCard (Profile & Sharing section)
- Key Metrics Cards (Total Panels, Total Patients, Hospital Users)
```
**Header Elements:**
- Page title: "Dashboard" (implicit)
- Stats cards showing metrics

**Sticky Candidate:** 
- None (page is mostly cards, limited scrolling)

---

#### 1.2 Panels Page (`/portal/:hospitalId/panels`)
**Current Structure:**
```
- Page title section (implicit in component)
- PanelsList component (shows linked panels)
```
**Header Elements:**
- Title: "Select Panel to view Patients"

**Sticky Candidate:**
- None (limited content, less scrolling)

---

#### 1.3 Panel Details (`/portal/:hospitalId/panel/:panelId`)
**Current Structure:**
```
- Header Navigation (Back button + Panel name)
- Actions Bar (Search input + Refresh + Add Patient buttons)
- Patient Table
```
**Header Elements:**
- Back button + panel name + subtitle
- Search input
- Action buttons (Refresh, Add Patient)

**Sticky Candidate:**
- ✅ **Actions Bar** (search + buttons) - Users need to search/add while scrolling through patient table

---

#### 1.4 Hospital Profile (`/portal/:hospitalId/profile`)
**Current Structure:**
```
- Breadcrumb Navigation
- Hospital Icon + Name Header
- Tabs (Profile, Attributes, Panels, Sharing)
- Tab Content
```
**Header Elements:**
- Breadcrumb
- Hospital name + icon header
- Tab navigation

**Sticky Candidate:**
- ✅ **Tabs** - Users switch between tabs while viewing content, should remain accessible

---

#### 1.5 Hospital Users (`/portal/:hospitalId/users`)
**Current Structure:**
```
- HospitalUserList component
```
**Header Elements:**
- Title: "Users" (in component header)
- User management controls

**Sticky Candidate:**
- Depends on HospitalUserList internal structure (need to examine)

---

### 2. Superadmin Pages

#### 2.1 Hospital Details Page (`/hospital/:hospitalId`)
**Current Structure:**
```
- Breadcrumb Navigation (All Hospitals > Hospital Name)
- Hospital Header (Icon + Name + Stats)
- Tabs (Linked Panels, Users)
- Tab Content (Panel list / User list)
```
**Header Elements:**
- Breadcrumb
- Hospital name + stats
- Tab navigation

**Sticky Candidate:**
- ✅ **Tabs** - Users switch between panels/users, tabs should stay visible

---

#### 2.2 Panel Patients Page (`/hospital/:hospitalId/panel/:panelId`)
**Current Structure:**
```
- Breadcrumb Navigation (Home > Hospital > Panel)
- Panel Header (Icon + Name + Patient counts)
- Tabs (All, Active, Admitted, Discharged, Deactivated)
- Search input
- Patient Table
- Pagination
```
**Header Elements:**
- Breadcrumb
- Panel name + patient counts
- Status filter tabs (All, Active, Admitted, etc.)
- Search input

**Sticky Candidate:**
- ✅ **Tabs + Search** - Critical for filtering; users need these visible while scrolling through 71 patients

---

#### 2.3 SuperAdmin Dashboard (`/superadmin`)
**Current Structure:**
```
- Multiple tabs/sections for management
- Various content sections
```
**Header Elements:**
- Tab navigation
- Section headers

**Sticky Candidate:**
- ✅ **Top tabs** - Main navigation between Hospital, Admin Users, etc.

---

### 3. Other Pages

#### 3.1 Hospital Directory (`/hospitals`)
**Current Structure:**
```
- Page Title: "Hospital Directory"
- Search & Filter Card
  - Search input
  - Filter buttons (All Hospitals, Verified Only, Pending Verification)
- Hospital Grid
- Pagination
```
**Header Elements:**
- Title
- Search input
- Filter buttons (status filters)

**Sticky Candidate:**
- ✅ **Search & Filter Card** - Users need to refine search while scrolling through hospital list

---

#### 3.2 Admin Dashboard (`/dashboard`)
**Current Structure:**
```
- Page Title: "Dashboard"
- Hospital Grid Cards
```
**Header Elements:**
- Title

**Sticky Candidate:**
- None (mostly grid cards, limited scrolling)

---

## Summary Table

| Page | Current URL | Sticky Element | Priority | Notes |
|------|------------|-----------------|----------|-------|
| Hospital Dashboard | `/portal/:id` | None | Low | Mostly cards |
| Panels Page | `/portal/:id/panels` | None | Low | Limited content |
| **Panel Details** | `/portal/:id/panel/:pid` | **Search + Action buttons** | **High** | Users filter/add while viewing table |
| **Hospital Profile** | `/portal/:id/profile` | **Tab navigation** | **Medium** | Switch tabs while viewing forms |
| Hospital Users | `/portal/:id/users` | Depends | Medium | Need to check HospitalUserList |
| **Hospital Details (Superadmin)** | `/hospital/:id` | **Tabs** | **Medium** | Switch between panels/users |
| **Panel Patients** | `/hospital/:id/panel/:pid` | **Tabs + Search** | **High** | Critical filters + search |
| **SuperAdmin Dashboard** | `/superadmin` | **Main tabs** | **High** | Main section navigation |
| **Hospital Directory** | `/hospitals` | **Search + Filters** | **High** | Essential for discovery |
| Admin Dashboard | `/dashboard` | None | Low | Mostly grid cards |

---

## Sticky Header Implementation Strategy

### Priority 1 (High): Implement First
1. **Panel Patients Page** - Search + Tabs (filter + search while browsing 70+ patients)
2. **Hospital Directory** - Search + Filters (essential for hospital discovery)
3. **SuperAdmin Dashboard** - Main tabs (core navigation)

### Priority 2 (Medium): Implement Second
1. **Hospital Profile** - Tab navigation (better UX for data entry forms)
2. **Hospital Details (Superadmin)** - Tabs (manage panels/users)
3. **Hospital Users** - Depends on component structure

### Priority 3 (Low): Optional
1. Dashboard pages - Minimal benefit, limited scrolling

---

## Technical Implementation Notes

### Sticky Container Requirements
- Fixed position when user scrolls past element
- Should account for navbar height (pt-16 = 64px)
- Background color to match page (avoid transparency issues)
- Shadow/border to distinguish from content
- Return to normal position when scrolling back up

### CSS Classes Needed
```css
/* Sticky wrapper - apply to header containers */
.sticky-header {
  position: sticky;
  top: 64px; /* Below navbar */
  background-color: inherit;
  z-index: 40; /* Below navbar z-50, above content */
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
```

### Implementation Order
1. Panel Patients (complex: tabs + search)
2. Hospital Directory (search + filters)
3. Superadmin tabs
4. Hospital Profile tabs
5. Hospital Details tabs

---

## Questions to Clarify

1. **Search behavior**: Should sticky search retain previous searches when scrolling back?
2. **Tab switching**: Should tab content be lazy-loaded or pre-loaded?
3. **Mobile behavior**: Should sticky headers be simplified or hidden on mobile?
4. **Performance**: Any concerns about sticky positioning with large tables?

