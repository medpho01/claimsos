# Global Navbar Testing Guide

## What Was Integrated

The `GlobalNavbar` component has been integrated into the following pages:

1. ✅ **Hospital Portal Layout** (`src/pages/hospital/Layout/index.tsx`)
   - Shows hospital name in navbar context
   - Integrated with existing sidebar
   - Full responsive support

2. ✅ **Superadmin Dashboard** (`src/pages/superadmin/SuperAdminPage.tsx`)
   - Shows "Admin Portal" context
   - Full admin menu integration
   - Role-based navigation

3. ✅ **Public Hospital Profile** (`src/pages/PublicHospitalProfile.tsx`)
   - Shows Finclarity branding without hospital context
   - Clean public-facing interface
   - Seamless integration with profile content

## Testing Checklist

### 1. Hospital Portal Pages
**URL:** http://localhost:5001/portal/[hospitalId]

#### Visual Check:
- [ ] Navbar appears at the top (fixed position)
- [ ] Finclarity logo visible on left
- [ ] Hospital name shown next to "/" divider
- [ ] User profile avatar on right
- [ ] "Hospital Profiles" subtext in navbar

#### Functionality Check:
- [ ] Click Finclarity logo → navigates to home/dashboard
- [ ] Click user profile avatar → dropdown menu appears
- [ ] Hover on dropdown menu items → items highlight
- [ ] Click "Admin Dashboard" → navigates to admin (if admin user)
- [ ] Click "Hospital Directory" → navigates to directory
- [ ] Click "Sign out" → logs out and redirects to login
- [ ] Mobile view (< 768px) → hamburger menu appears
- [ ] Click hamburger → side sheet opens with full menu
- [ ] Close side sheet → menu slides closed

#### Content Layout Check:
- [ ] Content doesn't overlap with navbar
- [ ] Sidebar still visible on desktop (below navbar)
- [ ] Proper padding (pt-16) on main content
- [ ] Scroll content → navbar stays fixed at top
- [ ] Navbar z-index correct (content scrolls under properly)

---

### 2. Hospital Dashboard
**URL:** http://localhost:5001/portal/[hospitalId]

#### Check:
- [ ] Dashboard content loads below navbar
- [ ] Page title "Dashboard" visible
- [ ] All dashboard cards display properly
- [ ] No layout conflicts with navbar
- [ ] Sidebar below navbar works correctly

---

### 3. Panels Page
**URL:** http://localhost:5001/portal/[hospitalId]/panels

#### Check:
- [ ] Navbar displays at top
- [ ] Page header "Select Panel to view Patients" visible
- [ ] Panel list loads correctly
- [ ] Scrolling works smoothly
- [ ] Navbar stays fixed while content scrolls

---

### 4. Superadmin Pages
**URL:** http://localhost:5001/superadmin

#### Visual Check:
- [ ] Navbar appears with "Admin Portal" context
- [ ] Finclarity logo and branding visible
- [ ] User profile with "Super Admin" role
- [ ] All tabs visible (Dashboard, Admin Users, Hospitals, etc.)

#### Functionality Check:
- [ ] Switch between tabs → navbar stays fixed
- [ ] Sidebar navigation works
- [ ] Click user profile → dropdown appears
- [ ] "Admin Settings" visible in dropdown (super_admin only)
- [ ] Logout works from navbar dropdown

#### Content Check:
- [ ] Dashboard stats visible
- [ ] All management sections load properly
- [ ] Tables and content align with navbar padding
- [ ] Search/filter sections don't overlap navbar

---

### 5. Public Hospital Profile (Share Link)
**URL:** http://localhost:5001/hospitals/share/[token]

#### Check:
- [ ] Navbar appears without hospital context
- [ ] "Hospital Profiles" subtext visible
- [ ] Hospital info displays below navbar
- [ ] Profile tabs (Profile Details, Certifications) work
- [ ] Content scrolls under fixed navbar
- [ ] Logout available in user menu (if authenticated)

---

### 6. Responsive Testing

#### Mobile (< 768px):
- [ ] Hamburger menu icon visible
- [ ] Navbar height: 64px (4rem)
- [ ] Logo text hidden (only icon visible)
- [ ] User profile pill visible
- [ ] Click hamburger → side sheet opens
- [ ] Side sheet width: 288px (w-72)
- [ ] All menu items accessible in side sheet

#### Tablet (768px - 1024px):
- [ ] Full navbar visible
- [ ] Logo + "Finclarity" text visible
- [ ] Hospital context visible (if applicable)
- [ ] User profile visible
- [ ] Hamburger also available as backup

#### Desktop (> 1024px):
- [ ] Full navbar with all elements
- [ ] No hamburger menu
- [ ] All navigation visible
- [ ] User dropdown functional

---

## Browser Console Check

Open browser DevTools (F12) and check:

- [ ] No console errors (red messages)
- [ ] No console warnings related to navbar
- [ ] No React warnings about missing props
- [ ] Network tab shows navbar assets loading
- [ ] No z-index conflicts visible

---

## Common Issues to Look For

### Issue: Navbar overlaps content
**Check:** 
- Is main content using `pt-16` padding?
- Is navbar set to `position: fixed`?
- **Fix:** Ensure parent div has `pt-16` class

### Issue: Navbar not appearing
**Check:**
- Is GlobalNavbar imported in the page?
- Is it rendered before the content?
- Are there import errors in console?
- **Fix:** Check console for error messages

### Issue: Dropdown menu hidden behind content
**Check:**
- Is navbar z-index set to `z-50`?
- Are other elements using higher z-index?
- **Fix:** Check z-index of overlapping elements

### Issue: Mobile menu doesn't open
**Check:**
- Sheet component imported properly?
- Is hamburger button visible?
- Are there JS errors in console?
- **Fix:** Check console and verify Sheet component

### Issue: User info not showing
**Check:**
- Is useAuth() hook working?
- Is user object populated?
- **Fix:** Check AuthContext and login status

---

## Performance Check

- [ ] Navbar loads immediately (no delay)
- [ ] Page transitions smooth (navbar doesn't flicker)
- [ ] No lag when scrolling content
- [ ] Mobile menu opens/closes smoothly
- [ ] Dropdown menu appears instantly

---

## Accessibility Check

- [ ] Can navigate navbar with keyboard (Tab key)
- [ ] Can open/close dropdown with Enter key
- [ ] All buttons have visible focus states
- [ ] Colors have sufficient contrast
- [ ] Icon buttons have tooltips/labels

---

## Cross-Page Navigation

Test navbar navigation between different pages:

- [ ] Hospital Portal → Admin Dashboard (if admin)
- [ ] Admin Dashboard → Hospital Directory
- [ ] Any page → Sign out (logs out and redirects)
- [ ] Sign in → Navbar appears on authenticated pages
- [ ] Sign out → Navbar disappears on public pages

---

## Testing Results

After testing, record your findings:

```
Date Tested: ___________
Tester: __________________
Environment: [Dev/Production] - [Browser] - [OS]

Pages Tested:
- [ ] Hospital Portal
- [ ] Hospital Dashboard
- [ ] Panels Page
- [ ] Superadmin Dashboard
- [ ] Public Hospital Profile

Issues Found:
1. ___________________________
2. ___________________________
3. ___________________________

Recommendation: [Approved / Needs Fixes / Needs Redesign]
```

---

## Next Steps

If testing passes:
✅ Proceed to **Phase 2: Sticky Headers & Filters**

If issues found:
🔧 Document issues and fixes needed
📝 Update navbar component as needed
🔄 Re-test after fixes

---

## Debugging Tips

### Check if Navbar Renders:
```javascript
// In browser console:
document.querySelector('nav')  // Should return the nav element
```

### Check Navbar Height:
```javascript
// In browser console:
const nav = document.querySelector('nav');
console.log(nav.offsetHeight);  // Should be 64px (4rem)
```

### Check Content Padding:
```javascript
// In browser console:
const main = document.querySelector('main');
console.log(window.getComputedStyle(main).paddingTop);  // Should include pt-16
```

### Check z-index:
```javascript
// In browser console:
const nav = document.querySelector('nav');
console.log(window.getComputedStyle(nav).zIndex);  // Should be 50
```

---

## Support

If you encounter issues:
1. Check the browser console for errors
2. Verify GlobalNavbar is imported correctly
3. Check that useAuth() hook returns user data
4. Ensure pt-16 padding is applied to content areas
5. Verify z-index values don't conflict
