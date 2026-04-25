# UI Design Guidelines - ClaimOS Application

**Version:** 1.0.0  
**Last Updated:** April 21, 2026  
**Created For:** Consistent UI/UX across all features

---

## Table of Contents

1. [Design System Overview](#design-system-overview)
2. [Color Palette](#color-palette)
3. [Typography](#typography)
4. [Spacing & Layout](#spacing--layout)
5. [Components](#components)
6. [Form Patterns](#form-patterns)
7. [Table Patterns](#table-patterns)
8. [Modal & Dialog Patterns](#modal--dialog-patterns)
9. [Navigation Patterns](#navigation-patterns)
10. [Icons & Images](#icons--images)
11. [States & Interactions](#states--interactions)
12. [Error Handling & Validation](#error-handling--validation)
13. [Code Examples](#code-examples)

---

## Design System Overview

### Technology Stack
- **UI Framework:** React 19.2
- **Styling:** Tailwind CSS with custom theme
- **Component Library:** Shadcn/ui (Radix UI primitives)
- **Form Library:** React Hook Form with Zod validation
- **Icons:** Lucide React
- **Tables:** TanStack React Table
- **Animations:** Framer Motion
- **Dark Mode:** CSS class-based (.dark)

### Design Principles
1. **Clarity:** Information should be easy to scan and understand
2. **Consistency:** Use the same patterns across all screens
3. **Accessibility:** Support keyboard navigation, screen readers, ARIA labels
4. **Responsiveness:** Work on mobile, tablet, and desktop
5. **Efficiency:** Minimize clicks and cognitive load
6. **Feedback:** Provide clear feedback for user actions

---

## Color Palette

### Primary Colors

```css
/* Light Theme (Default) */
--primary: 222.2 47.4% 11.2%;        /* Dark Blue #1e293b */
--primary-foreground: 210 40% 98%;   /* Off-white #f8fafc */

--secondary: 210 40% 96.1%;          /* Light Blue #f0f4f8 */
--secondary-foreground: 222.2 47.4% 11.2%;  /* Dark Blue (primary) */

--accent: 210 40% 96.1%;             /* Light Blue (same as secondary) */
--accent-foreground: 222.2 47.4% 11.2%;    /* Dark Blue (primary) */

/* Dark Theme */
--primary-dark: 210 40% 98%;         /* Off-white #f8fafc */
--secondary-dark: 217.2 32.6% 17.5%; /* Dark gray-blue #1e293b */
--accent-dark: 217.2 32.6% 17.5%;    /* Dark gray-blue */
```

### Semantic Colors

```css
--background: 0 0% 100%;              /* White - page background */
--foreground: 222.2 84% 4.9%;         /* Very dark blue - text */

--card: 0 0% 100%;                    /* White - card backgrounds */
--card-foreground: 222.2 84% 4.9%;    /* Dark - card text */

--muted: 210 40% 96.1%;               /* Light gray - disabled/secondary text */
--muted-foreground: 215.4 16.3% 46.9%; /* Medium gray - secondary text */

--border: 214.3 31.8% 91.4%;          /* Light gray - borders */
--input: 214.3 31.8% 91.4%;           /* Light gray - input backgrounds */

--destructive: 0 84.2% 60.2%;         /* Red - errors/delete actions */
--destructive-foreground: 210 40% 98%; /* White text on destructive */

--ring: 222.2 84% 4.9%;               /* Dark blue - focus rings */
```

### Usage Guidelines

| Color | Usage | Examples |
|-------|-------|----------|
| **Primary** | Main action buttons, active states, key UI elements | "Create", "Save", active tabs, links |
| **Secondary** | Backgrounds, disabled states, less important information | Card backgrounds, filter chips, badges |
| **Destructive** | Delete actions, errors, warnings | Delete button, error messages, validation errors |
| **Muted** | Secondary text, placeholder text, disabled elements | Help text, secondary labels, disabled inputs |
| **Border** | Dividing lines, input borders, card borders | Table borders, input outlines, dividers |
| **Success** | Status badges, success messages, positive indicators | Active status, confirmation dialogs, green checkmarks |

### Color Conversions

```
Primary (HSL): 222.2° 47.4% 11.2% = RGB(30, 41, 59) = #1e293b
Secondary (HSL): 210° 40% 96.1% = RGB(240, 244, 248) = #f0f4f8
Destructive (HSL): 0° 84.2% 60.2% = RGB(239, 68, 68) = #ef4444
Muted Text (HSL): 215.4° 16.3% 46.9% = RGB(120, 113, 108) = #78716c
```

---

## Typography

### Font Stack
```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
```

### Type Scale (Tailwind)

| Usage | Tailwind Class | Size | Weight | Line Height | Example |
|-------|---|------|--------|-------------|---------|
| **Page Heading** | `text-3xl font-bold` | 30px | 700 | 1.2 | Page titles, main headings |
| **Section Heading** | `text-2xl font-semibold` | 24px | 600 | 1.3 | Tab titles, dialog titles |
| **Subsection** | `text-lg font-semibold` | 18px | 600 | 1.4 | Column headers, card titles |
| **Body** | `text-base font-normal` | 16px | 400 | 1.5 | Paragraph text, body content |
| **Small** | `text-sm font-normal` | 14px | 400 | 1.5 | Labels, helper text, badges |
| **Tiny** | `text-xs font-normal` | 12px | 400 | 1.4 | Timestamps, metadata |

### Text Styles

```typescript
// Page Title
<h1 className="text-3xl font-bold text-foreground">Attribute Definitions</h1>

// Section Heading
<h2 className="text-2xl font-semibold text-foreground">Hospital Attributes</h2>

// Card Title
<h3 className="text-lg font-semibold text-card-foreground">Create New Attribute</h3>

// Body Text
<p className="text-base text-foreground">Regular paragraph text here</p>

// Secondary Text
<p className="text-sm text-muted-foreground">Helper text or secondary information</p>

// Emphasis
<strong className="font-semibold">Important content</strong>
```

---

## Spacing & Layout

### Spacing Scale (Tailwind)
```
0: 0px
1: 0.25rem (4px)
2: 0.5rem (8px)
3: 0.75rem (12px)
4: 1rem (16px)
6: 1.5rem (24px)
8: 2rem (32px)
10: 2.5rem (40px)
12: 3rem (48px)
```

### Spacing Patterns

```typescript
// Container padding
<div className="p-4 md:p-6 lg:p-8">
  {/* Content */}
</div>

// Vertical spacing between sections
<div className="space-y-6">
  <Section1 />
  <Section2 />
  <Section3 />
</div>

// Horizontal spacing between items
<div className="flex gap-4">
  <Item1 />
  <Item2 />
</div>

// Card internal spacing
<Card className="p-6">
  <CardContent className="space-y-4">
    {/* Content with vertical spacing */}
  </CardContent>
</Card>
```

### Layout Patterns

```typescript
// Full-width container with max-width
<div className="w-full max-w-7xl mx-auto">
  {/* Content */}
</div>

// Grid layout for responsive design
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
  {/* Items */}
</div>

// Flexbox for alignment
<div className="flex items-center justify-between">
  <div>Left</div>
  <div>Right</div>
</div>
```

---

## Components

### Button Component

```typescript
// Primary action (default blue)
<Button>Create New</Button>
<Button variant="default" size="default">Save</Button>

// Secondary action (light background)
<Button variant="secondary">Cancel</Button>

// Outline (bordered)
<Button variant="outline">Edit</Button>

// Ghost (transparent)
<Button variant="ghost" size="sm">More Options</Button>

// Destructive (red)
<Button variant="destructive">Delete</Button>
<Button variant="destructive" size="sm">Remove</Button>

// Disabled state
<Button disabled>Disabled Button</Button>

// With loading state
<Button disabled>
  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
  Processing...
</Button>

// Size variants
<Button size="sm">Small</Button>
<Button size="default">Default</Button>
<Button size="lg">Large</Button>
```

**Usage:**
- Primary buttons: Main actions (Create, Save, Submit)
- Secondary buttons: Alternative actions (Cancel, Skip)
- Outline buttons: Less important actions (Edit, View)
- Ghost buttons: Minimal actions (More, Help)
- Destructive: Delete/dangerous actions only

### Card Component

```typescript
<Card>
  <CardContent className="p-6">
    <h3 className="text-lg font-semibold mb-4">Title</h3>
    <p>Card content here</p>
  </CardContent>
</Card>

// With header and footer
<Card>
  <CardHeader>
    <h2 className="text-2xl font-semibold">Header</h2>
  </CardHeader>
  <CardContent className="p-6">
    Content
  </CardContent>
  <CardFooter className="p-4 border-t">
    Footer
  </CardFooter>
</Card>
```

**Usage:**
- Group related content
- Separate sections visually
- Default padding: 6 units (24px)
- Border: light gray on light theme

### Badge Component

```typescript
<Badge>Active</Badge>
<Badge variant="secondary">Inactive</Badge>
<Badge variant="destructive">Error</Badge>
<Badge variant="outline">Default</Badge>
```

**Usage:**
- Status indicators (active/inactive)
- Category tags
- Count indicators
- Priority levels

### Input Component

```typescript
<Input 
  type="text" 
  placeholder="Enter attribute key"
  disabled={false}
/>

<Input 
  type="email" 
  placeholder="Enter email"
/>

<Input 
  type="number" 
  placeholder="Enter count"
  min={0}
/>

<textarea 
  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
  placeholder="Enter description"
/>
```

**Usage:**
- Consistent styling across forms
- Use proper input types for browser validation
- Always include labels
- Add helper text for clarity

### Label Component

```typescript
<Label htmlFor="email">Email Address</Label>
<Input id="email" type="email" />

// With required indicator
<Label htmlFor="required">Field Name *</Label>
<Input id="required" required />
```

**Usage:**
- Every input should have a label
- Use `htmlFor` to connect label to input
- Add `*` for required fields

### Dialog Component

```typescript
<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Create New Attribute</DialogTitle>
      <DialogDescription>
        Add a new attribute definition to the system.
      </DialogDescription>
    </DialogHeader>
    
    {/* Form content */}
    
    <DialogFooter>
      <Button variant="outline" onClick={() => setIsOpen(false)}>
        Cancel
      </Button>
      <Button onClick={handleSave}>Create</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Usage:**
- Forms and confirmations
- Modal dialogs for create/edit
- Confirmation dialogs before destructive actions
- Always include Close button
- Focus management is automatic

### Table Component

```typescript
<Card>
  <CardContent className="p-0">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Column 1</TableHead>
          <TableHead>Column 2</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.length === 0 ? (
          <TableRow>
            <TableCell colSpan={3} className="h-64 text-center">
              <div className="flex flex-col items-center justify-center gap-2">
                <FileText className="h-6 w-6 text-muted-foreground" />
                <h3 className="font-semibold">No data found</h3>
                <p className="text-sm text-muted-foreground">
                  Create your first item to get started.
                </p>
              </div>
            </TableCell>
          </TableRow>
        ) : (
          data.map((item) => (
            <TableRow key={item.id}>
              <TableCell>{item.column1}</TableCell>
              <TableCell>{item.column2}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="sm">Edit</Button>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  </CardContent>
</Card>
```

**Usage:**
- Wrap table in Card with `p-0` padding
- Use `TableHeader`, `TableHead`, `TableBody`, `TableCell`, `TableRow`
- Show empty state when no data
- Right-align numeric data and actions
- Use hover states for interactivity

### Tabs Component

```typescript
<Tabs defaultValue="hospital" className="w-full">
  <TabsList>
    <TabsTrigger value="hospital">Hospital Attributes</TabsTrigger>
    <TabsTrigger value="panel">Panel Attributes</TabsTrigger>
  </TabsList>
  
  <TabsContent value="hospital">
    {/* Hospital content */}
  </TabsContent>
  
  <TabsContent value="panel">
    {/* Panel content */}
  </TabsContent>
</Tabs>
```

**Usage:**
- Navigate between related sections
- Keep active tab state in URL or localStorage
- Each tab should be independently loadable
- Limit to 3-4 tabs maximum

---

## Form Patterns

### Form Structure

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

// Define validation schema
const formSchema = z.object({
  key: z.string()
    .min(3, "Key must be at least 3 characters")
    .regex(/^[a-z0-9_]+$/, "Key can only contain lowercase letters, numbers, and underscores"),
  label: z.string().min(1, "Label is required"),
  category: z.string().min(1, "Category is required"),
  description: z.string().optional(),
  isActive: z.boolean().default(true),
});

type FormValues = z.infer<typeof formSchema>;

// Component
const AttributeForm: React.FC<{ onSubmit: (data: FormValues) => void }> = ({ onSubmit }) => {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch,
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      isActive: true,
    },
  });

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {/* Field */}
      <div className="space-y-2">
        <Label htmlFor="key">Attribute Key *</Label>
        <Input
          id="key"
          placeholder="e.g., service.nephrology"
          {...register("key")}
          aria-invalid={!!errors.key}
        />
        {errors.key && (
          <p className="text-sm text-destructive">{errors.key.message}</p>
        )}
      </div>

      {/* Field */}
      <div className="space-y-2">
        <Label htmlFor="label">Label *</Label>
        <Input
          id="label"
          placeholder="e.g., Nephrology Department"
          {...register("label")}
          aria-invalid={!!errors.label}
        />
        {errors.label && (
          <p className="text-sm text-destructive">{errors.label.message}</p>
        )}
      </div>

      {/* Select field */}
      <div className="space-y-2">
        <Label htmlFor="category">Category *</Label>
        <select
          id="category"
          {...register("category")}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <option value="">Select a category</option>
          <option value="service">Service</option>
          <option value="equipment">Equipment</option>
          <option value="staffing">Staffing</option>
        </select>
        {errors.category && (
          <p className="text-sm text-destructive">{errors.category.message}</p>
        )}
      </div>

      {/* Checkbox field */}
      <div className="flex items-center space-x-2">
        <Checkbox
          id="active"
          {...register("isActive")}
          checked={watch("isActive")}
        />
        <Label htmlFor="active">Active</Label>
      </div>

      {/* Textarea field */}
      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <textarea
          id="description"
          placeholder="Describe this attribute..."
          className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          {...register("description")}
        />
      </div>

      {/* Form actions */}
      <div className="flex justify-end gap-3 pt-4">
        <Button variant="outline" type="button" onClick={() => {/* close modal */}}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </form>
  );
};
```

### Form Field Pattern

```typescript
<div className="space-y-2">
  <Label htmlFor="fieldId">Field Label *</Label>
  <Input
    id="fieldId"
    placeholder="Placeholder text"
    {...register("fieldName")}
    aria-invalid={!!errors.fieldName}
    aria-describedby={errors.fieldName ? "fieldName-error" : undefined}
  />
  {errors.fieldName && (
    <p id="fieldName-error" className="text-sm text-destructive">
      {errors.fieldName.message}
    </p>
  )}
  <p className="text-xs text-muted-foreground">Helper text explaining the field</p>
</div>
```

---

## Table Patterns

### Standard Data Table

```typescript
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  ColumnDef,
} from "@tanstack/react-table";

interface DataItem {
  id: string;
  key: string;
  label: string;
  category: string;
  isActive: boolean;
}

const columns: ColumnDef<DataItem>[] = [
  {
    accessorKey: "key",
    header: "Key",
    cell: (info) => <span className="font-medium">{info.getValue() as string}</span>,
  },
  {
    accessorKey: "label",
    header: "Label",
  },
  {
    accessorKey: "category",
    header: "Category",
    cell: (info) => (
      <Badge variant="secondary">{info.getValue() as string}</Badge>
    ),
  },
  {
    accessorKey: "isActive",
    header: "Status",
    cell: (info) => (
      <Badge variant={info.getValue() ? "default" : "outline"}>
        {info.getValue() ? "Active" : "Inactive"}
      </Badge>
    ),
  },
  {
    id: "actions",
    header: "Actions",
    cell: (info) => (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onEdit(info.row.original)}>
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onDelete(info.row.original)}>
          Delete
        </Button>
      </div>
    ),
  },
];

const table = useReactTable({
  data,
  columns,
  getCoreRowModel: getCoreRowModel(),
  getPaginationRowModel: getPaginationRowModel(),
  getSortedRowModel: getSortedRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  state: {
    globalFilter: searchTerm,
  },
  globalFilterFn: (row, columnId, filterValue) => {
    const value = row.getValue(columnId);
    return String(value).toLowerCase().includes(filterValue.toLowerCase());
  },
});

return (
  <Card>
    <CardContent className="p-0">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={header.id === "actions" ? "text-right" : ""}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-64 text-center">
                <div className="flex flex-col items-center justify-center gap-2">
                  <FileText className="h-6 w-6 text-muted-foreground" />
                  <h3 className="font-semibold">No items found</h3>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cell.column.id === "actions" ? "text-right" : ""}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
);
```

---

## Modal & Dialog Patterns

### Create/Edit Modal

```typescript
<Dialog open={isOpen} onOpenChange={setIsOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>
        {editingId ? "Edit Attribute" : "Create New Attribute"}
      </DialogTitle>
      <DialogDescription>
        {editingId
          ? "Update the attribute definition details below."
          : "Add a new attribute definition to the system."}
      </DialogDescription>
    </DialogHeader>

    <AttributeForm
      initialValues={editingItem}
      onSubmit={async (data) => {
        try {
          if (editingId) {
            await apiService.updateAttribute(editingId, data);
          } else {
            await apiService.createAttribute(data);
          }
          setIsOpen(false);
          refreshData();
          toast.success(editingId ? "Updated successfully" : "Created successfully");
        } catch (error) {
          toast.error(error.message);
        }
      }}
    />

    <DialogFooter>
      <Button
        variant="outline"
        onClick={() => setIsOpen(false)}
      >
        Cancel
      </Button>
      <Button type="submit" form="attributeForm">
        {editingId ? "Update" : "Create"}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### Confirmation Dialog

```typescript
<AlertDialog open={isOpen} onOpenChange={setIsOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete Attribute</AlertDialogTitle>
      <AlertDialogDescription>
        Are you sure you want to delete this attribute? This action cannot be undone.
        {associatedCount > 0 && (
          <p className="mt-2 font-semibold text-destructive">
            Warning: {associatedCount} items are using this attribute.
          </p>
        )}
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onClick={handleDelete}
        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
      >
        Delete
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

---

## Navigation Patterns

### Tab Navigation

```typescript
<Tabs defaultValue="hospital" value={activeTab} onValueChange={setActiveTab}>
  <TabsList className="grid w-full grid-cols-2">
    <TabsTrigger value="hospital">Hospital Attributes</TabsTrigger>
    <TabsTrigger value="panel">Panel Attributes</TabsTrigger>
  </TabsList>
</Tabs>
```

### Breadcrumb Pattern

```typescript
<div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
  <span>Admin</span>
  <ChevronRight className="h-4 w-4" />
  <span>Attribute Definitions</span>
  <ChevronRight className="h-4 w-4" />
  <span className="text-foreground">Hospital Attributes</span>
</div>
```

---

## Icons & Images

### Icon Usage

```typescript
import {
  Plus,           // Create/Add actions
  Edit2,          // Edit actions
  Trash2,         // Delete actions
  Eye,            // View actions
  Search,         // Search/filter
  ChevronDown,    // Dropdowns
  Filter,         // Filter actions
  Download,       // Download/export
  Upload,         // Upload
  Check,          // Success/confirmation
  X,              // Close/cancel
  AlertCircle,    // Warnings
  CheckCircle,    // Success status
  XCircle,        // Error status
  Loader2,        // Loading (with animate-spin)
  MoreHorizontal, // Additional actions
} from "lucide-react";

// Icon in button
<Button size="sm">
  <Plus className="h-4 w-4 mr-2" />
  Create New
</Button>

// Icon only button
<Button variant="ghost" size="sm">
  <Edit2 className="h-4 w-4" />
</Button>

// Icon in status
<div className="flex items-center gap-2">
  <CheckCircle className="h-5 w-5 text-green-600" />
  <span>Completed</span>
</div>

// Loading icon
<Button disabled>
  <Loader2 className="h-4 w-4 animate-spin mr-2" />
  Loading...
</Button>
```

**Icon Sizing:**
- Buttons: `h-4 w-4` (16px)
- Status indicators: `h-5 w-5` (20px)
- Large icons: `h-6 w-6` (24px)
- Extra large: `h-8 w-8` (32px)

---

## States & Interactions

### Loading State

```typescript
// Skeleton loading
{loading ? (
  <Card>
    <CardContent className="p-6 space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </CardContent>
  </Card>
) : (
  // Content
)}

// Spinner
{loading && (
  <div className="flex items-center justify-center h-64">
    <Loader2 className="h-8 w-8 animate-spin text-primary" />
  </div>
)}
```

### Empty State

```typescript
<div className="flex flex-col items-center justify-center h-64 text-center">
  <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
    <FileText className="h-6 w-6 text-muted-foreground" />
  </div>
  <h3 className="text-lg font-semibold text-foreground">No data found</h3>
  <p className="text-sm text-muted-foreground mt-2 max-w-sm">
    Get started by creating your first item.
  </p>
  <Button className="mt-4">
    <Plus className="h-4 w-4 mr-2" />
    Create First Item
  </Button>
</div>
```

### Success Message

```typescript
<div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-md text-sm font-medium flex items-center gap-2">
  <CheckCircle className="h-5 w-5" />
  Operation completed successfully!
</div>
```

### Error Message

```typescript
<div className="bg-destructive/15 text-destructive px-4 py-3 rounded-md text-sm font-medium flex items-center gap-2">
  <AlertCircle className="h-5 w-5" />
  An error occurred. Please try again.
</div>
```

### Hover & Active States

```typescript
// Hover effect on table rows
<TableRow className="hover:bg-muted/50 cursor-pointer transition-colors">
  {/* Content */}
</TableRow>

// Active button state (automatic with Button component)
<Button>Active</Button>

// Disabled state (automatic)
<Button disabled>Disabled</Button>
```

---

## Error Handling & Validation

### Field-Level Validation

```typescript
{errors.fieldName && (
  <p className="text-sm text-destructive font-medium">
    {errors.fieldName.message}
  </p>
)}
```

### Form-Level Validation

```typescript
{formError && (
  <div className="bg-destructive/15 text-destructive px-4 py-3 rounded-md text-sm font-medium mb-4">
    {formError}
  </div>
)}
```

### Toast Notifications

```typescript
import { toast } from "sonner"; // or your preferred toast library

// Success
toast.success("Attribute created successfully!");

// Error
toast.error("Failed to create attribute");

// Info
toast.info("Please check your input");

// Loading
const id = toast.loading("Creating attribute...");
// Later...
toast.success("Created!", { id });
```

---

## Code Examples

### Complete Attribute Definition Manager Example

```typescript
import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Edit2, Trash2, Loader2, FileText } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const formSchema = z.object({
  key: z.string().min(1, "Key is required"),
  label: z.string().min(1, "Label is required"),
  category: z.string().min(1, "Category is required"),
  dataType: z.string().min(1, "Data type is required"),
  isActive: z.boolean().default(true),
});

type FormValues = z.infer<typeof formSchema>;

interface AttributeDefinition {
  key: string;
  label: string;
  category: string;
  dataType: string;
  isActive: boolean;
}

const AttributeDefinitionsManager: React.FC = () => {
  const [definitions, setDefinitions] = useState<AttributeDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
  });

  useEffect(() => {
    fetchDefinitions();
  }, []);

  const fetchDefinitions = async () => {
    try {
      setLoading(true);
      // API call
      // const res = await apiService.getAttributeDefinitions();
      // setDefinitions(res.data.data);
    } catch (error) {
      console.error("Failed to fetch definitions", error);
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = async (data: FormValues) => {
    try {
      if (editingKey) {
        // await apiService.updateAttribute(editingKey, data);
      } else {
        // await apiService.createAttribute(data);
      }
      setIsDialogOpen(false);
      reset();
      setEditingKey(null);
      await fetchDefinitions();
    } catch (error) {
      console.error("Failed to save attribute", error);
    }
  };

  const handleEdit = (attribute: AttributeDefinition) => {
    setEditingKey(attribute.key);
    reset(attribute);
    setIsDialogOpen(true);
  };

  const handleDelete = async (key: string) => {
    if (confirm("Are you sure?")) {
      try {
        // await apiService.deleteAttribute(key);
        await fetchDefinitions();
      } catch (error) {
        console.error("Failed to delete attribute", error);
      }
    }
  };

  const filteredDefinitions = definitions.filter(
    (attr) =>
      attr.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
      attr.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Attribute Definitions</h1>
          <p className="text-muted-foreground mt-2">
            Manage hospital and panel attribute definitions
          </p>
        </div>
        <Button onClick={() => setIsDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Create New
        </Button>
      </div>

      {/* Search */}
      <Input
        placeholder="Search by key or label..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className="max-w-md"
      />

      {/* List */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : filteredDefinitions.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64">
              <FileText className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="font-semibold">No definitions found</h3>
            </div>
          ) : (
            <div className="space-y-2 p-4">
              {filteredDefinitions.map((attr) => (
                <div
                  key={attr.key}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <h4 className="font-semibold">{attr.label}</h4>
                    <p className="text-sm text-muted-foreground">{attr.key}</p>
                  </div>
                  <div className="flex items-center gap-4">
                    <Badge variant={attr.isActive ? "default" : "outline"}>
                      {attr.isActive ? "Active" : "Inactive"}
                    </Badge>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEdit(attr)}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(attr.key)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingKey ? "Edit Attribute" : "Create New Attribute"}
            </DialogTitle>
            <DialogDescription>
              {editingKey
                ? "Update the attribute details below."
                : "Add a new attribute definition to the system."}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key">Key *</Label>
              <Input
                id="key"
                placeholder="e.g., service.nephrology"
                {...register("key")}
                aria-invalid={!!errors.key}
              />
              {errors.key && (
                <p className="text-sm text-destructive">{errors.key.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="label">Label *</Label>
              <Input
                id="label"
                placeholder="e.g., Nephrology Department"
                {...register("label")}
                aria-invalid={!!errors.label}
              />
              {errors.label && (
                <p className="text-sm text-destructive">{errors.label.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category *</Label>
              <select
                id="category"
                {...register("category")}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Select category</option>
                <option value="service">Service</option>
                <option value="equipment">Equipment</option>
              </select>
              {errors.category && (
                <p className="text-sm text-destructive">{errors.category.message}</p>
              )}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  setIsDialogOpen(false);
                  reset();
                  setEditingKey(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AttributeDefinitionsManager;
```

---

## Best Practices Summary

1. **Consistency**: Use the same components and styles throughout the app
2. **Accessibility**: Always include labels, ARIA attributes, and keyboard support
3. **Error Handling**: Show clear, actionable error messages to users
4. **Feedback**: Provide visual feedback for all user actions (loading, success, error)
5. **Spacing**: Use the spacing scale consistently (gap, padding, margin)
6. **Colors**: Use semantic colors (primary, destructive, muted) rather than hardcoded colors
7. **Typography**: Use the type scale for consistent text sizing
8. **Forms**: Always validate and show clear error messages
9. **Empty States**: Show helpful empty states when no data is available
10. **Mobile**: Design for mobile first, then enhance for larger screens

---

**Last Updated:** April 21, 2026  
**Author:** Design System Team  
**Status:** ✅ Complete - Ready for Implementation
