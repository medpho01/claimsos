# Global Navbar Integration Guide

## Overview

A new `GlobalNavbar` component has been created to provide consistent branding and navigation across the entire application.

**Location:** `src/components/Navbar/GlobalNavbar.tsx`

## Features

✅ **Finclarity Branding** - Logo and brand name visible on all pages
✅ **Hospital/Portal Context** - Shows current hospital or portal context
✅ **User Profile Menu** - Dropdown with user info, navigation, and logout
✅ **Responsive Design** - Desktop navigation + mobile hamburger menu
✅ **Role-Based Navigation** - Different options based on user role
✅ **Smooth Integration** - Works with existing authentication and routing

## Component Props

```typescript
interface GlobalNavbarProps {
  hospitalName?: string;      // Name of the current hospital/panel (optional)
  showHospitalContext?: boolean; // Show hospital context info (default: true)
}
```

## Usage Examples

### Example 1: In Hospital Portal Layout

```tsx
import { GlobalNavbar } from '@/components/Navbar';

export const HospitalPortalLayout: React.FC = () => {
  const { hospital } = useHospitalData();

  return (
    <>
      {/* Add navbar at the top */}
      <GlobalNavbar 
        hospitalName={hospital?.name}
        showHospitalContext={true}
      />

      {/* Add margin to account for navbar height (64px) */}
      <div className="flex pt-16">
        {/* Sidebar or main content */}
      </div>
    </>
  );
};
```

### Example 2: In Superadmin Layout

```tsx
import { GlobalNavbar } from '@/components/Navbar';

export const SuperAdminPage: React.FC = () => {
  return (
    <>
      <GlobalNavbar 
        hospitalName="Admin Portal"
        showHospitalContext={true}
      />
      
      <div className="pt-16">
        {/* Admin content */}
      </div>
    </>
  );
};
```

### Example 3: Without Hospital Context

```tsx
<GlobalNavbar 
  hospitalName={undefined}
  showHospitalContext={false}
/>
```

## Integration Steps

### Step 1: Update Hospital Portal Layout
File: `src/pages/hospital/Layout/index.tsx`

```tsx
import { GlobalNavbar } from '@/components/Navbar';

// In the component return:
return (
  <>
    <GlobalNavbar 
      hospitalName={hospital?.name}
      showHospitalContext={true}
    />
    
    <div className="flex h-screen pt-16 bg-slate-50/50">
      {/* Rest of layout */}
    </div>
  </>
);
```

### Step 2: Update Superadmin Layout
File: `src/pages/superadmin/SuperAdminPage.tsx` (or similar)

```tsx
import { GlobalNavbar } from '@/components/Navbar';

return (
  <>
    <GlobalNavbar 
      hospitalName="Admin Portal"
      showHospitalContext={true}
    />
    
    <div className="pt-16 px-6 py-8">
      {/* Admin content */}
    </div>
  </>
);
```

### Step 3: Update Other Pages
File: Any other page layout that needs the navbar

```tsx
<GlobalNavbar hospitalName={contextName} />
<div className="pt-16">
  {/* Page content */}
</div>
```

## CSS Notes

⚠️ **Important:** Add `pt-16` (padding-top) to content areas to account for the fixed navbar height.

The navbar has a height of **64px (4rem)**, so use:
- `pt-16` for Tailwind (equivalent to 64px padding)
- Or `padding-top: 64px` in custom CSS

## Navigation Features

### User Dropdown Menu Includes:

- **User Profile Info**
  - Full name
  - Email address
  - Current role

- **Navigation Items**
  - Dashboard (for admins)
  - Hospital Directory
  - Admin Settings (for super_admin)

- **Sign Out**
  - Logout functionality

### Mobile Menu (Hamburger)

On mobile devices (< 768px width):
- Opens a side sheet with all navigation items
- Shows hospital/portal context
- Includes user info and logout button
- Closes automatically when navigating

## Responsive Breakpoints

| Breakpoint | Behavior |
|-----------|----------|
| Mobile (< 768px) | Hamburger menu, collapsed hospital context |
| Tablet (768px - 1024px) | Full navbar, hamburger menu available |
| Desktop (> 1024px) | Full navbar with all items visible |

## Styling Customization

The navbar uses:
- **Colors**: Blue gradient (blue-600 to blue-700) for branding
- **Fonts**: Tailwind's default sans-serif stack
- **Spacing**: Based on Tailwind's spacing scale
- **Shadows**: Subtle shadow for depth (`shadow-sm`)
- **Borders**: Light gray border (`border-gray-200`)

To customize, edit the color classes in `GlobalNavbar.tsx`:
- `bg-gradient-to-br from-blue-600 to-blue-700` - Logo background
- `text-blue-700` - Blue accent text
- `border-gray-200` - Border color

## Accessibility Features

✅ Semantic HTML (`<nav>` element)
✅ Keyboard navigation support (via shadcn components)
✅ ARIA labels for icon buttons
✅ Sufficient color contrast
✅ Mobile-friendly touch targets (48px minimum)

## Known Limitations

- Navbar is always visible (no auto-hide on scroll)
- No breadcrumb navigation (can be added in future)
- Search functionality is not included (can be added in Phase 2)
- No notification/bell icon (can be added in Phase 3)

## Future Enhancements (Phase 2+)

- Global search bar
- Notification/alert bell
- Breadcrumb navigation
- Dark mode support
- Sticky subheader for page-specific filters
- Quick action buttons

## Testing Checklist

When integrating, verify:

- [ ] Navbar appears on all authenticated pages
- [ ] Navbar is fixed at the top
- [ ] Content doesn't overlap with navbar
- [ ] User profile dropdown works
- [ ] Logout functionality works
- [ ] Mobile hamburger menu opens/closes
- [ ] Mobile menu items navigate correctly
- [ ] Hospital context displays correctly
- [ ] All navigation links work as expected
- [ ] Responsive design works on all screen sizes

## Troubleshooting

### Navbar overlaps content
**Solution:** Ensure main content has `pt-16` (or `padding-top: 64px`)

### Dropdown menu appears behind content
**Solution:** Navbar has `z-50`, make sure other overlays use lower z-index values

### Mobile menu not closing
**Solution:** Verify `Sheet` component from shadcn is properly imported and working

### User info not displaying
**Solution:** Check that `useAuth()` hook is properly retrieving user data from context
