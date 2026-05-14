# Frontend Implementation Guide - Attribute Definitions Management

**Version:** 1.0.0  
**Date:** April 21, 2026  
**Status:** Ready for Integration into SuperAdminPage

---

## Overview

This guide covers the frontend implementation of the Attribute Definitions Management feature, including:
- Hospital Attribute Definitions Manager
- Panel Attribute Definitions Manager
- Integration points and setup instructions

---

## Components Created

### 1. Main Component: `AttributeDefinitionsManager`
**Location:** `/src/features/attributeDefinitions/index.tsx`

**Purpose:** Entry point component that combines both hospital and panel attribute managers with a tabbed interface.

**Features:**
- Tab navigation between Hospital and Panel attributes
- Global search functionality that filters both types
- Clean, organized layout with header and description
- Persistent tab selection

**Usage:**
```typescript
import AttributeDefinitionsManager from "@/features/attributeDefinitions";

<AttributeDefinitionsManager />
```

### 2. Hospital Attribute Definitions Manager
**Location:** `/src/features/attributeDefinitions/HospitalAttributeDefinitionsManager.tsx`

**Purpose:** Manage hospital attribute definitions with full CRUD operations.

**Features:**
- List all hospital attributes with infinite scroll capability
- Search by key, label, or description
- Filter by category and data type
- Create new attributes with validation
- Edit existing attributes
- Delete attributes (with warning for associated data)
- Toggle active/inactive status (soft delete pattern)
- Real-time key uniqueness validation
- Conditional fields based on data type (document type)
- Mandatory requirement flags (basic info, empanelment)
- Sort order management
- Form validation with Zod schema
- Error handling with toast notifications
- Loading states and empty states

**Key Functions:**
- `fetchData()` - Load attributes, categories, and data types
- `handleValidateKey()` - Check key uniqueness in real-time
- `onSubmit()` - Save new or updated attribute
- `handleEdit()` - Populate form for editing
- `handleDelete()` - Remove attribute
- `handleToggleActive()` - Activate/deactivate attribute

### 3. Panel Attribute Definitions Manager
**Location:** `/src/features/attributeDefinitions/PanelAttributeDefinitionsManager.tsx`

**Purpose:** Manage panel (vendor) attribute definitions with advanced features.

**Features:**
- Category-based tabbed interface (portal, credential, contact, document, operational)
- Search across all categories
- Create new panel attributes
- Edit existing attributes
- Delete attributes
- Toggle active/inactive status
- Support for 12 different data types
- Options editor for select fields (single/multi-select)
- Validation rules editor (regex, min/max length)
- Field requirement flags (required, unique)
- Default value configuration
- Real-time key uniqueness validation
- Form validation with Zod schema
- Error handling and toast notifications
- Loading and empty states

**Supported Data Types:**
- text
- email
- phone
- url
- date
- boolean
- single_select
- multi_select
- file
- integer
- decimal
- encrypted_text

**Key Functions:**
- `fetchData()` - Load attributes by category
- `handleValidateKey()` - Check key uniqueness
- `onSubmit()` - Save attribute
- `handleEdit()` - Populate form for editing
- `handleDelete()` - Remove attribute
- `addOption()` - Add option to select field
- `removeOption()` - Remove option from select field
- `handleToggleActive()` - Toggle active status

---

## Integration into SuperAdminPage

### Step 1: Import the Component

```typescript
// In /src/pages/superadmin/SuperAdminPage.tsx

import AttributeDefinitionsManager from "@/features/attributeDefinitions";
```

### Step 2: Add to Tab State

```typescript
const [activeTab, setActiveTab] = useState<
  'dashboard' | 'admins' | 'hospitals' | 'panels' | 'attributeDefinitions'
>(
  (localStorage.getItem('superadmin_active_tab') as 
    'dashboard' | 'admins' | 'hospitals' | 'panels' | 'attributeDefinitions') || 'dashboard'
);
```

### Step 3: Add to Tabs UI

```typescript
<Tabs value={activeTab} onValueChange={setActiveTab}>
  <TabsList>
    <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
    <TabsTrigger value="admins">Admins</TabsTrigger>
    <TabsTrigger value="hospitals">Hospitals</TabsTrigger>
    <TabsTrigger value="panels">Panels</TabsTrigger>
    <TabsTrigger value="attributeDefinitions">
      Attribute Definitions
    </TabsTrigger>
  </TabsList>

  {/* Existing tabs... */}

  <TabsContent value="attributeDefinitions">
    <AttributeDefinitionsManager />
  </TabsContent>
</Tabs>
```

### Step 4: Update Tab Persistence

Ensure the localStorage key includes the new tab:

```typescript
useEffect(() => {
  localStorage.setItem('superadmin_active_tab', activeTab);
}, [activeTab]);
```

---

## API Integration

### Available Endpoints Used

#### Hospital Attributes
```
GET    /admin/attribute-definitions                    - List all
GET    /admin/attribute-definitions/:key               - Single definition
GET    /admin/attribute-definitions/metadata/categories
GET    /admin/attribute-definitions/metadata/data-types
POST   /admin/attribute-definitions                    - Create
PUT    /admin/attribute-definitions/:key               - Update
DELETE /admin/attribute-definitions/:key               - Delete
PATCH  /admin/attribute-definitions/:key/activate      - Activate
PATCH  /admin/attribute-definitions/:key/deactivate    - Deactivate
POST   /admin/attribute-definitions/validate-key       - Validate key
```

#### Panel Attributes
```
GET    /admin/panel-attributes/definitions                            - List all
GET    /admin/panel-attributes/definitions/by-category                - Grouped by category
GET    /admin/panel-attributes/definitions/:id                        - Single definition
POST   /admin/panel-attributes/definitions                            - Create
PUT    /admin/panel-attributes/definitions/:id                        - Update
DELETE /admin/panel-attributes/definitions/:id                        - Delete
PATCH  /admin/panel-attributes/definitions/:id/activate               - Activate
PATCH  /admin/panel-attributes/definitions/:id/deactivate             - Deactivate
POST   /admin/panel-attributes/definitions/validate-key               - Validate key
```

### API Service Methods Required

Ensure your `apiService` includes:

```typescript
// Hospital Attributes
get('/admin/attribute-definitions')
get('/admin/attribute-definitions/:key')
get('/admin/attribute-definitions/metadata/categories')
get('/admin/attribute-definitions/metadata/data-types')
post('/admin/attribute-definitions', data)
put('/admin/attribute-definitions/:key', data)
delete('/admin/attribute-definitions/:key')
patch('/admin/attribute-definitions/:key/activate')
patch('/admin/attribute-definitions/:key/deactivate')
post('/admin/attribute-definitions/validate-key', { key, excludeKey })

// Panel Attributes
get('/admin/panel-attributes/definitions')
get('/admin/panel-attributes/definitions/by-category')
get('/admin/panel-attributes/definitions/:id')
post('/admin/panel-attributes/definitions', data)
put('/admin/panel-attributes/definitions/:id', data)
delete('/admin/panel-attributes/definitions/:id')
patch('/admin/panel-attributes/definitions/:id/activate')
patch('/admin/panel-attributes/definitions/:id/deactivate')
post('/admin/panel-attributes/definitions/validate-key', { key, excludeId })
```

---

## UI/UX Guidelines Applied

All components follow the UI Design Guidelines document including:

### Colors
- Primary (Dark Blue): Main action buttons, active states
- Secondary (Light Blue): Backgrounds, badges
- Destructive (Red): Delete actions, error states
- Muted (Gray): Secondary text, disabled states

### Typography
- Page titles: `text-3xl font-bold`
- Section titles: `text-2xl font-semibold`
- Subsection: `text-lg font-semibold`
- Body text: `text-base`
- Small text: `text-sm`
- Tiny text: `text-xs`

### Spacing
- Container padding: `p-4 md:p-6 lg:p-8`
- Vertical spacing: `space-y-6` between sections
- Horizontal spacing: `gap-4` between items

### Components Used
- Shadcn UI Button, Input, Label
- Shadcn UI Card, Badge
- Shadcn UI Dialog, AlertDialog, Tabs
- Shadcn UI Table, Select
- Lucide React icons
- React Hook Form with Zod validation
- Sonner for toast notifications

### Patterns
- Empty states with icon and description
- Loading states with spinner
- Error states with alert styling
- Form validation with field-level errors
- Confirmation dialogs before destructive actions
- Real-time validation feedback
- Success notifications after operations

---

## Form Validation

### Hospital Attributes Validation Schema

```typescript
const hospitalAttributeSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9]+\.[a-z0-9]+(\.[a-z0-9]+)?$/)
    .min(1),
  label: z.string().min(1),
  category: z.string().min(1),
  description: z.string().optional(),
  data_type: z.string().min(1),
  // ... additional fields with optional types
});
```

### Panel Attributes Validation Schema

```typescript
const panelAttributeSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .min(1),
  category: z.enum(["portal", "credential", "contact", "document", "operational"]),
  label: z.string().min(1),
  data_type: z.string().min(1),
  // ... additional fields with optional types
});
```

---

## State Management

Both managers use React Hook Form for form state management:

```typescript
const {
  register,        // Register input fields
  handleSubmit,    // Handle form submission
  reset,           // Reset form to defaults
  watch,           // Watch field values
  setValue,        // Set field values programmatically
  formState: { errors, isSubmitting },  // Form state
} = useForm<FormValues>({
  resolver: zodResolver(schema),  // Zod validation
  defaultValues: { ... }
});
```

---

## Error Handling

### Error Display Patterns

**Field-level Errors:**
```typescript
{errors.fieldName && (
  <p className="text-sm text-destructive">{errors.fieldName.message}</p>
)}
```

**Toast Notifications:**
```typescript
import { toast } from "sonner";

toast.success("Action completed successfully");
toast.error("An error occurred");
toast.info("Informational message");
```

**Alert Dialogs:**
```typescript
<AlertDialog open={isOpen} onOpenChange={setIsOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Confirm Action</AlertDialogTitle>
      <AlertDialogDescription>
        Are you sure? This action cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
  </AlertDialogContent>
</AlertDialog>
```

---

## Loading and Empty States

### Loading State
```typescript
{loading ? (
  <div className="flex items-center justify-center h-64">
    <Loader2 className="h-8 w-8 animate-spin" />
  </div>
) : (
  // Content
)}
```

### Empty State
```typescript
{items.length === 0 ? (
  <div className="flex flex-col items-center justify-center h-64">
    <FileText className="h-12 w-12 text-muted-foreground mb-4" />
    <h3 className="font-semibold">No items found</h3>
    <p className="text-muted-foreground text-sm mt-2">
      Create your first item to get started.
    </p>
  </div>
) : (
  // List
)}
```

---

## Features by Component

### Hospital Attribute Definitions Manager

**CRUD Operations:**
- ✅ Create new attributes with validation
- ✅ Read/list with search and filter
- ✅ Update existing attributes
- ✅ Delete with confirmation (soft delete via deactivate)
- ✅ Activate/Deactivate toggle

**Filtering & Search:**
- ✅ Search by key, label, description
- ✅ Filter by category
- ✅ Filter by data type
- ✅ Combined filter results

**Validation:**
- ✅ Key format validation (category.subcategory.name)
- ✅ Real-time key uniqueness check
- ✅ Required field validation
- ✅ Conditional field validation

**Special Features:**
- ✅ Document type specific fields
- ✅ Mandatory requirement flags
- ✅ Sort order management
- ✅ Unit of measurement field
- ✅ Image guidance for document uploads

### Panel Attribute Definitions Manager

**CRUD Operations:**
- ✅ Create new attributes
- ✅ Read/list by category with search
- ✅ Update existing attributes
- ✅ Delete with confirmation
- ✅ Activate/Deactivate toggle

**Category Management:**
- ✅ 5 category tabs (portal, credential, contact, document, operational)
- ✅ Attributes grouped by category
- ✅ Search across all categories

**Data Type Support:**
- ✅ 12 different data types
- ✅ Type-specific UI (options for selects, validation rules)
- ✅ Options editor for select types
- ✅ Drag-handle ready for option reordering

**Validation Rules:**
- ✅ Regex pattern input
- ✅ Min/max length constraints
- ✅ Required/unique flags
- ✅ Default value configuration

---

## Testing Checklist

### Hospital Attributes Manager

- [ ] Create new attribute with valid data
- [ ] Create attribute with invalid key format
- [ ] Try duplicate key (should warn)
- [ ] Edit existing attribute
- [ ] Update attribute label and description
- [ ] Search by key
- [ ] Search by label
- [ ] Filter by category
- [ ] Filter by data type
- [ ] Combined search and filters
- [ ] Delete attribute (non-associated)
- [ ] Try delete with associated data (should error)
- [ ] Activate attribute
- [ ] Deactivate attribute
- [ ] Toggle status badge to deactivate
- [ ] Empty state display
- [ ] Loading state display
- [ ] Error messages display correctly
- [ ] Success notifications display
- [ ] Form validation errors show
- [ ] Conditional fields appear for document type

### Panel Attributes Manager

- [ ] Create new attribute in each category
- [ ] Create attribute with valid key
- [ ] Try duplicate key
- [ ] Edit existing attribute
- [ ] Search by key across categories
- [ ] Search by label across categories
- [ ] Switch between category tabs
- [ ] Add options to select field
- [ ] Remove options from select field
- [ ] Add validation rules
- [ ] Set min/max length
- [ ] Add regex pattern
- [ ] Delete attribute
- [ ] Activate/deactivate attribute
- [ ] Set required flag
- [ ] Set unique flag
- [ ] Set default value
- [ ] Empty state for each category
- [ ] Loading state display
- [ ] Error messages and toast notifications
- [ ] Form validation for all fields

---

## Performance Considerations

1. **Search Debouncing:** Consider adding debounce to search input for large datasets
2. **Pagination:** Add pagination for 100+ attributes
3. **Memoization:** Components are optimized for re-renders
4. **API Caching:** Cache categories and data types (rarely change)
5. **Lazy Loading:** Consider lazy loading tabs content

---

## Future Enhancements

1. **Bulk Operations:** Enable/disable multiple attributes at once
2. **Import/Export:** CSV or JSON import/export of definitions
3. **Audit Trail:** Show who created/modified each attribute
4. **Version History:** Revert to previous definitions
5. **Dependency Rules:** Define field dependencies
6. **Templates:** Pre-built attribute templates for common use cases
7. **Advanced Search:** Full-text search with filters
8. **Keyboard Shortcuts:** Ctrl+K for quick search, etc.
9. **Dark Mode:** Full dark mode support
10. **Accessibility:** Enhanced keyboard navigation and screen reader support

---

## File Structure

```
src/features/attributeDefinitions/
├── index.tsx                                  (Main component)
├── HospitalAttributeDefinitionsManager.tsx    (Hospital manager)
├── PanelAttributeDefinitionsManager.tsx       (Panel manager)
└── utils/
    └── (Future: helper functions)
└── hooks/
    └── (Future: custom hooks)
```

---

## Troubleshooting

### Component Not Showing
1. Check import path
2. Verify apiService methods exist
3. Check browser console for errors
4. Verify authentication token is valid

### API Calls Failing
1. Check backend is running (localhost:8000)
2. Verify auth header is being sent
3. Check token hasn't expired
4. Check CORS settings

### Form Validation Not Working
1. Ensure Zod schema is correct
2. Check React Hook Form configuration
3. Verify error messages are displayed
4. Check browser console for validation errors

### Styling Issues
1. Verify Tailwind CSS is configured
2. Check color CSS variables in index.css
3. Verify shadcn/ui components are installed
4. Clear browser cache

---

## Support & Contact

For issues or questions:
1. Check the API Integration Guide
2. Review UI Design Guidelines
3. Check API Test Results for endpoint behavior
4. Consult React Hook Form documentation
5. Refer to Shadcn/ui component documentation

---

**Document Created:** April 21, 2026  
**Last Updated:** April 21, 2026  
**Status:** ✅ Complete - Ready for Integration
