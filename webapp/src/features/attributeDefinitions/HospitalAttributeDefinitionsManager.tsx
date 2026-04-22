import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Edit2,
  Trash2,
  Loader2,
  FileText,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import apiService from "../../services/api";
import { toast } from "sonner";

// Validation Schema
const hospitalAttributeSchema = z.object({
  key: z
    .string()
    .min(1, "Key is required")
    .regex(
      /^[a-z0-9]+\.[a-z0-9]+(\.[a-z0-9]+)?$/,
      "Key format: category.subcategory or category.subcategory.name (lowercase with dots)"
    ),
  label: z.string().min(1, "Label is required"),
  category: z.string().min(1, "Category is required"),
  description: z.string().nullable().optional(),
  data_type: z.string().min(1, "Data type is required"),
  unit: z.string().nullable().optional(),
  requires_document: z.boolean().default(false),
  has_expiry: z.boolean().default(false),
  expected_issuing_authority: z.string().nullable().optional(),
  can_verify_by_image: z.boolean().default(false),
  image_guidance: z.string().nullable().optional(),
  is_mandatory_basic: z.boolean().default(false),
  is_mandatory_empanelment: z.boolean().default(false),
  sort_order: z.number().default(999),
  is_active: z.boolean().default(true),
});

type FormValues = z.infer<typeof hospitalAttributeSchema>;

interface HospitalAttribute extends FormValues {
  key: string;
  created_at: string;
  updated_at: string;
}

interface HospitalAttributeDefinitionsManagerProps {
  searchTerm: string;
  isFormOpen?: boolean;
  onFormOpenChange?: (open: boolean) => void;
}

const capitalize = (str: string): string => {
  return str
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
};

const HospitalAttributeDefinitionsManager: React.FC<
  HospitalAttributeDefinitionsManagerProps
> = ({ searchTerm, isFormOpen: externalIsFormOpen, onFormOpenChange }) => {
  const [attributes, setAttributes] = useState<HospitalAttribute[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [dataTypes, setDataTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(externalIsFormOpen ?? false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [selectedAttribute, setSelectedAttribute] =
    useState<HospitalAttribute | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterDataType, setFilterDataType] = useState<string>("");
  const [keyValidation, setKeyValidation] = useState<{
    isUnique: boolean;
    message: string;
  } | null>(null);
  const [isCheckingKey, setIsCheckingKey] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(hospitalAttributeSchema),
    defaultValues: {
      key: "",
      label: "",
      category: "",
      description: "",
      data_type: "",
      unit: "",
      requires_document: false,
      has_expiry: false,
      expected_issuing_authority: "",
      can_verify_by_image: false,
      image_guidance: "",
      is_mandatory_basic: false,
      is_mandatory_empanelment: false,
      sort_order: 999,
      is_active: true,
    },
  });

  const dataTypeValue = watch("data_type");

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (externalIsFormOpen !== undefined) {
      setIsFormOpen(externalIsFormOpen);
    }
  }, [externalIsFormOpen]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [attrRes, catRes, typeRes] = await Promise.all([
        apiService.get("/admin/attribute-definitions"),
        apiService.get("/admin/attribute-definitions/metadata/categories"),
        apiService.get("/admin/attribute-definitions/metadata/data-types"),
      ]);

      setAttributes(attrRes.data.data || []);
      setCategories(catRes.data.data || []);
      setDataTypes(typeRes.data.data || []);
    } catch (error) {
      console.error("Failed to fetch data", error);
      toast.error("Failed to load attribute definitions");
    } finally {
      setLoading(false);
    }
  };

  const handleValidateKey = async (key: string) => {
    if (!key) return;

    try {
      setIsCheckingKey(true);
      const res = await apiService.post(
        "/admin/attribute-definitions/validate-key",
        {
          key,
          excludeKey: editingKey,
        }
      );

      setKeyValidation(res.data.data);
    } catch (error) {
      console.error("Failed to validate key", error);
    } finally {
      setIsCheckingKey(false);
    }
  };

  const onSubmit = async (data: FormValues) => {
    try {
      console.log("Submitting attribute:", { editingKey, data });

      if (editingKey) {
        console.log(`Updating attribute with key: ${editingKey}`);
        // Don't send the key field when updating - backend won't allow it
        const { key, ...updateData } = data;
        console.log("Update data (key excluded):", updateData);
        const response = await apiService.put(
          `/admin/attribute-definitions/${editingKey}`,
          updateData
        );
        console.log("Update response:", response);
        toast.success("Attribute updated successfully");
      } else {
        console.log("Creating new attribute");
        const response = await apiService.post("/admin/attribute-definitions", data);
        console.log("Create response:", response);
        toast.success("Attribute created successfully");
      }

      setIsFormOpen(false);
      onFormOpenChange?.(false);
      reset();
      setEditingKey(null);
      setKeyValidation(null);
      await fetchData();
    } catch (error: any) {
      console.error("Failed to save attribute:", {
        status: error.response?.status,
        message: error.response?.data?.message,
        error: error.message,
        data: error.response?.data,
      });
      toast.error(error.response?.data?.message || "Failed to save attribute");
    }
  };

  const handleEdit = (attribute: HospitalAttribute) => {
    console.log("=== EDIT CLICKED ===");
    console.log("Attribute to edit:", attribute);

    setEditingKey(attribute.key);
    setSelectedAttribute(attribute);

    const formData = {
      key: attribute.key,
      label: attribute.label,
      category: attribute.category,
      description: attribute.description,
      data_type: attribute.data_type,
      unit: attribute.unit,
      requires_document: attribute.requires_document,
      has_expiry: attribute.has_expiry,
      expected_issuing_authority: attribute.expected_issuing_authority,
      can_verify_by_image: attribute.can_verify_by_image,
      image_guidance: attribute.image_guidance,
      is_mandatory_basic: attribute.is_mandatory_basic,
      is_mandatory_empanelment: attribute.is_mandatory_empanelment,
      sort_order: attribute.sort_order,
      is_active: attribute.is_active,
    };

    console.log("Form data being set:", formData);
    reset(formData);

    console.log("Setting isFormOpen to true");
    setIsFormOpen(true);
    console.log("=== EDIT SETUP COMPLETE ===");
  };

  const handleDeleteClick = (attribute: HospitalAttribute) => {
    setSelectedAttribute(attribute);
    setIsDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!selectedAttribute) return;

    try {
      await apiService.delete(
        `/admin/attribute-definitions/${selectedAttribute.key}`
      );
      toast.success("Attribute deleted successfully");
      setIsDeleteOpen(false);
      setSelectedAttribute(null);
      await fetchData();
    } catch (error: any) {
      console.error("Failed to delete attribute", error);
      const errorMsg = error.response?.data?.message;

      if (error.response?.status === 422) {
        toast.error(
          "Cannot delete: This attribute is used by other items. Use deactivate instead."
        );
      } else {
        toast.error(errorMsg || "Failed to delete attribute");
      }
    }
  };

  const handleToggleActive = async (attribute: HospitalAttribute) => {
    try {
      const endpoint = attribute.is_active ? "deactivate" : "activate";
      await apiService.patch(
        `/admin/attribute-definitions/${attribute.key}/${endpoint}`
      );
      toast.success(
        `Attribute ${attribute.is_active ? "deactivated" : "activated"}`
      );
      await fetchData();
    } catch (error) {
      console.error("Failed to toggle attribute", error);
      toast.error("Failed to update attribute status");
    }
  };

  const filteredAttributes = attributes.filter((attr) => {
    const matchesSearch =
      attr.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
      attr.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (attr.description &&
        attr.description.toLowerCase().includes(searchTerm.toLowerCase()));

    const matchesCategory =
      !filterCategory || attr.category === filterCategory;
    const matchesDataType =
      !filterDataType || attr.data_type === filterDataType;

    return matchesSearch && matchesCategory && matchesDataType;
  });

  const openCreateForm = () => {
    setEditingKey(null);
    setSelectedAttribute(null);
    setKeyValidation(null);
    reset({
      key: "",
      label: "",
      category: "",
      description: "",
      data_type: "",
      unit: "",
      requires_document: false,
      has_expiry: false,
      expected_issuing_authority: "",
      can_verify_by_image: false,
      image_guidance: "",
      is_mandatory_basic: false,
      is_mandatory_empanelment: false,
      sort_order: 999,
      is_active: true,
    });
    setIsFormOpen(true);
    onFormOpenChange?.(true);
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="sticky top-16 z-30 bg-white dark:bg-slate-950 py-3 -mx-8 px-8 border-b border-slate-200 dark:border-slate-800 flex gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px] space-y-2">
          <Label className="text-sm font-medium">All Categories</Label>
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by category..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {capitalize(cat)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-w-[200px] space-y-2">
          <Label className="text-sm font-medium">All Data Types</Label>
          <Select value={filterDataType} onValueChange={setFilterDataType}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by data type..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Data Types</SelectItem>
              {dataTypes.map((type) => (
                <SelectItem key={type} value={type}>
                  {capitalize(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : filteredAttributes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                <FileText className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-semibold">No attributes found</h3>
              <p className="text-muted-foreground text-sm mt-2">
                {searchTerm || filterCategory || filterDataType
                  ? "Try adjusting your filters"
                  : "Create your first attribute definition"}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Key</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Data Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAttributes.map((attr) => (
                    <TableRow
                      key={attr.key}
                      className="hover:bg-muted/50 transition-colors"
                    >
                      <TableCell className="font-mono text-sm">
                        {attr.key}
                      </TableCell>
                      <TableCell className="font-medium">{attr.label}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{attr.category}</Badge>
                      </TableCell>
                      <TableCell>{attr.data_type}</TableCell>
                      <TableCell>
                        <Badge
                          variant={attr.is_active ? "default" : "outline"}
                          className="cursor-pointer"
                          onClick={() => handleToggleActive(attr)}
                        >
                          {attr.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(attr)}
                            title="Edit attribute"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteClick(attr)}
                            title="Delete attribute"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Form Dialog */}
      <Dialog
        open={isFormOpen}
        onOpenChange={(open) => {
          console.log(`Dialog onOpenChange: ${open}, editingKey: ${editingKey}`);
          if (!open) {
            // Dialog is closing - clear all form state
            console.log("Dialog closing, clearing form state");
            setEditingKey(null);
            setSelectedAttribute(null);
            reset();
            setKeyValidation(null);
          }
          setIsFormOpen(open);
          onFormOpenChange?.(open);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingKey ? "Edit Hospital Attribute" : "Create Hospital Attribute"}
            </DialogTitle>
            <DialogDescription>
              {editingKey
                ? "Update the attribute definition details below."
                : "Add a new hospital attribute definition to the system."}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              console.log("=== FORM SUBMIT CLICKED ===");
              console.log("EditingKey:", editingKey);
              console.log("Form errors:", errors);

              // Get current form state
              const formState = watch();
              console.log("Current form values:", formState);

              handleSubmit(onSubmit)(e);
            }}
            className="space-y-4"
            id="hospitalAttrForm"
          >
            {/* Key Field */}
            <div className="space-y-2">
              <Label htmlFor="key">Attribute Key *</Label>
              <Input
                id="key"
                placeholder="e.g., service.nephrology"
                {...register("key")}
                disabled={!!editingKey}
                onBlur={(e) => {
                  if (!editingKey && e.target.value) {
                    handleValidateKey(e.target.value);
                  }
                }}
                aria-invalid={!!(!!errors.key || (keyValidation && !keyValidation.isUnique)) || undefined}
              />
              {errors.key && (
                <p className="text-sm text-destructive">{errors.key.message}</p>
              )}
              {isCheckingKey && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking key uniqueness...
                </p>
              )}
              {keyValidation && !editingKey && (
                <p
                  className={`text-xs ${
                    keyValidation.isUnique
                      ? "text-green-600"
                      : "text-destructive"
                  } flex items-center gap-1`}
                >
                  {keyValidation.isUnique ? "✓" : "✗"} {keyValidation.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Format: category.subcategory or category.subcategory.name (lowercase with dots)
              </p>
            </div>

            {/* ═══ BASIC INFORMATION ═══ */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">BASIC INFORMATION</h3>

              {/* Label Field */}
              <div className="space-y-2">
                <Label htmlFor="label">Label *</Label>
                <Input
                  id="label"
                  placeholder="e.g., Nephrology Department"
                  {...register("label")}
                  aria-invalid={!!errors.label}
                />
                <p className="text-xs text-muted-foreground">Display name shown to users</p>
                {errors.label && (
                  <p className="text-sm text-destructive">{errors.label.message}</p>
                )}
              </div>

              {/* Category Field */}
              <div className="space-y-2">
                <Label htmlFor="category">Category *</Label>
                <Select
                  value={watch("category")}
                  onValueChange={(value: string) => setValue("category", value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {capitalize(cat)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Logical grouping of related attributes</p>
                {errors.category && (
                  <p className="text-sm text-destructive">{errors.category.message}</p>
                )}
              </div>

              {/* Data Type Field */}
              <div className="space-y-2">
                <Label htmlFor="dataType">Data Type *</Label>
                <Select
                  value={watch("data_type")}
                  onValueChange={(value: string) => setValue("data_type", value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a data type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="boolean">Boolean - Yes/No toggle</SelectItem>
                    <SelectItem value="integer">Integer - Whole numbers with optional unit</SelectItem>
                    <SelectItem value="text">Text - Text string</SelectItem>
                    <SelectItem value="date">Date - Calendar date</SelectItem>
                    <SelectItem value="document">Document - File upload with metadata</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Type of value this attribute will store. Affects which fields are shown below.</p>
                {errors.data_type && (
                  <p className="text-sm text-destructive">{errors.data_type.message}</p>
                )}
              </div>

              {/* Description Field */}
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <textarea
                  id="description"
                  placeholder="Describe this attribute..."
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  {...register("description")}
                />
                <p className="text-xs text-muted-foreground">Admin description of this attribute</p>
              </div>

              {/* Unit Field */}
              <div className="space-y-2">
                <Label htmlFor="unit">Unit of Measurement</Label>
                <Input
                  id="unit"
                  placeholder="e.g., count, beds, hours, INR/day, sqft"
                  {...register("unit")}
                />
                <p className="text-xs text-muted-foreground">For integer fields only. Displayed next to the value when users enter data.</p>
              </div>
            </div>

            {/* ═══ DOCUMENT CONFIGURATION ═══ (Always Visible) */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">DOCUMENT CONFIGURATION</h3>

              {/* Document Flags - Grouped Checkboxes */}
              <div className="space-y-3 p-4 bg-muted/30 rounded-lg border border-muted">
                <p className="text-sm font-medium text-foreground mb-3">Document Settings</p>

                {/* Requires Document Checkbox */}
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="requires_document"
                    {...register("requires_document")}
                    className="h-4 w-4 rounded border-gray-300 mt-1"
                    disabled={dataTypeValue === "document"}
                    checked={dataTypeValue === "document" || watch("requires_document")}
                  />
                  <div className="flex-1">
                    <Label htmlFor="requires_document" className="font-normal cursor-pointer">
                      Requires Document
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">
                      {dataTypeValue === "document"
                        ? "Automatically enabled for document-type attributes"
                        : "Users must upload a document for this attribute"}
                    </p>
                  </div>
                </div>

                {/* Has Expiry - ALWAYS VISIBLE */}
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="has_expiry"
                    {...register("has_expiry")}
                    className="h-4 w-4 rounded border-gray-300 mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="has_expiry" className="font-normal cursor-pointer">
                      Has Expiry
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">Document has an expiration/renewal date that needs to be tracked</p>
                  </div>
                </div>

                {/* Can Verify by Image Checkbox */}
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="can_verify_by_image"
                    {...register("can_verify_by_image")}
                    className="h-4 w-4 rounded border-gray-300 mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="can_verify_by_image" className="font-normal cursor-pointer">
                      Can Verify by Image
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">Document can be verified using uploaded image instead of just file upload</p>
                  </div>
                </div>
              </div>

              {/* Text Fields - Grouped Inputs */}
              <div className="space-y-4">
                {/* Expected Issuing Authority - ALWAYS VISIBLE */}
                <div className="space-y-2">
                  <Label htmlFor="expected_issuing_authority">
                    Expected Issuing Authority
                  </Label>
                  <Input
                    id="expected_issuing_authority"
                    placeholder="e.g., NABH, JCI, State Hospital Authority"
                    {...register("expected_issuing_authority")}
                  />
                  <p className="text-xs text-muted-foreground">Organization expected to issue this document. Helps users know which document to upload.</p>
                </div>

                {/* Image Upload Guidance - conditionally visible */}
                {watch("can_verify_by_image") && (
                  <div className="space-y-2">
                    <Label htmlFor="image_guidance">Image Upload Guidance</Label>
                    <textarea
                      id="image_guidance"
                      placeholder="e.g., 'Clear photo of certificate with visible issuing authority name and expiry date'"
                      className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      {...register("image_guidance")}
                    />
                    <p className="text-xs text-muted-foreground">Instructions for users uploading document images. Displayed above the image upload area.</p>
                  </div>
                )}
              </div>
            </div>

            {/* ═══ REQUIREMENTS & MANAGEMENT ═══ */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">REQUIREMENTS & MANAGEMENT</h3>

              {/* Mandatory Flags */}
              <div className="space-y-3">
                <p className="text-sm font-medium text-muted-foreground">Mandatory Requirements</p>

                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_mandatory_basic"
                    {...register("is_mandatory_basic")}
                    className="h-4 w-4 rounded border-gray-300 mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="is_mandatory_basic" className="font-normal cursor-pointer">
                      Required for Basic Hospital Info
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">Hospital must provide this during initial registration setup</p>
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_mandatory_empanelment"
                    {...register("is_mandatory_empanelment")}
                    className="h-4 w-4 rounded border-gray-300 mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="is_mandatory_empanelment" className="font-normal cursor-pointer">
                      Required for Empanelment
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">Hospital must provide this before being added to any panel network</p>
                  </div>
                </div>
              </div>

              {/* Sort Order and Active Status */}
              <div className="space-y-4">
                {/* Sort Order */}
                <div className="space-y-2">
                  <Label htmlFor="sort_order">Display Sort Order</Label>
                  <Input
                    id="sort_order"
                    type="number"
                    placeholder="999"
                    {...register("sort_order", { valueAsNumber: true })}
                  />
                  <p className="text-xs text-muted-foreground">Lower numbers appear first in forms and lists. Use any integer value.</p>
                </div>

                {/* Active Status */}
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_active"
                    {...register("is_active")}
                    className="h-4 w-4 rounded border-gray-300 mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="is_active" className="font-normal cursor-pointer">
                      Active
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">Unchecking disables this attribute in forms but preserves all associated data. Use this instead of deleting when possible.</p>
                  </div>
                </div>
              </div>
            </div>
          </form>

          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setIsFormOpen(false);
                onFormOpenChange?.(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="hospitalAttrForm"
              disabled={
                isSubmitting ||
                (!editingKey && !!(keyValidation && !keyValidation.isUnique))
              }
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                editingKey ? "Update" : "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Hospital Attribute</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <p>
                Are you sure you want to delete the attribute{" "}
                <code className="bg-muted px-2 py-1 rounded text-sm font-mono">
                  {selectedAttribute?.key}
                </code>
                ?
              </p>
              <div className="bg-amber-50 border border-amber-200 rounded p-3 flex gap-2">
                <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-800">
                  This action cannot be undone. Consider deactivating instead if you
                  want to preserve data history.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default HospitalAttributeDefinitionsManager;
