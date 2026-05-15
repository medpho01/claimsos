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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
  AlertCircle,
  X,
  GripVertical,
} from "lucide-react";
import apiService from "../../services/api";
import { toast } from "sonner";

// Validation Schema
const panelAttributeSchema = z.object({
  key: z
    .string()
    .min(1, "Key is required")
    .regex(
      /^[a-z0-9_]+$/,
      "Key can only contain lowercase letters, numbers, and underscores"
    ),
  category: z.enum(["portal", "credential", "contact", "document", "operational"]),
  label: z.string().min(1, "Label is required"),
  description: z.string().optional(),
  data_type: z.string().min(1, "Data type is required"),
  options: z.record(z.string()).nullable().optional(),
  validation_regex: z.string().optional(),
  validation_min_length: z.number().nullable().optional(),
  validation_max_length: z.number().nullable().optional(),
  is_required: z.boolean().default(false),
  is_unique: z.boolean().default(false),
  default_value: z.string().optional(),
  sort_order: z.number().default(999),
  is_active: z.boolean().default(true),
});

type FormValues = z.infer<typeof panelAttributeSchema>;

interface PanelAttribute extends FormValues {
  id: string;
  created_at: string;
  updated_at: string;
}

interface PanelAttributeDefinitionsManagerProps {
  searchTerm: string;
  isFormOpen?: boolean;
  onFormOpenChange?: (open: boolean) => void;
}

const PANEL_CATEGORIES = [
  "portal",
  "credential",
  "contact",
  "document",
  "operational",
];

const DATA_TYPES = [
  "text",
  "textarea",
  "email",
  "phone",
  "url",
  "date",
  "boolean",
  "single_select",
  "multi_select",
  "file",
  "json",
  "encrypted_text",
];

const capitalize = (str: string): string => {
  return str
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
};

/**
 * Convert options from any format to object format {key: label}
 * Handles both array format [{key, label}] and object format {key: label}
 */
const normalizeOptions = (options: any): Record<string, string> | null => {
  if (!options) return null;

  // If it's already an object (correct format)
  if (typeof options === 'object' && !Array.isArray(options)) {
    return options;
  }

  // If it's an array (old format), convert to object
  if (Array.isArray(options)) {
    const result: Record<string, string> = {};
    options.forEach((item: any) => {
      if (item.key && item.label) {
        result[item.key] = item.label;
      }
    });
    return Object.keys(result).length > 0 ? result : null;
  }

  return null;
};

const PanelAttributeDefinitionsManager: React.FC<
  PanelAttributeDefinitionsManagerProps
> = ({ searchTerm, isFormOpen: externalIsFormOpen, onFormOpenChange }) => {
  const [attributes, setAttributes] = useState<PanelAttribute[]>([]);
  const [attributesByCategory, setAttributesByCategory] = useState<
    Record<string, PanelAttribute[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(externalIsFormOpen ?? false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedAttribute, setSelectedAttribute] =
    useState<PanelAttribute | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("portal");
  const [filterDataType, setFilterDataType] = useState<string>("");
  const [newOption, setNewOption] = useState({ key: "", label: "" });
  const [isCheckingKey, setIsCheckingKey] = useState(false);
  const [keyValidation, setKeyValidation] = useState<{
    isUnique: boolean;
    message: string;
  } | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(panelAttributeSchema),
    defaultValues: {
      is_active: true,
      sort_order: 999,
      is_required: false,
      is_unique: false,
      options: {},
    },
  });

  const dataTypeValue = watch("data_type");
  const optionsValue = watch("options");

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
      const res = await apiService.get(
        "/admin/panel-attributes/definitions"
      );

      const allAttrs = (res.data.data || []).map((attr: any) => ({
        ...attr,
        options: normalizeOptions(attr.options),
      }));
      setAttributes(allAttrs);

      // Group by category
      const grouped: Record<string, PanelAttribute[]> = {};
      PANEL_CATEGORIES.forEach((cat) => {
        grouped[cat] = allAttrs.filter((attr: PanelAttribute) => attr.category === cat);
      });
      setAttributesByCategory(grouped);
    } catch (error) {
      console.error("Failed to fetch data", error);
      toast.error("Failed to load panel attribute definitions");
    } finally {
      setLoading(false);
    }
  };

  const handleValidateKey = async (key: string) => {
    if (!key) return;

    try {
      setIsCheckingKey(true);
      const res = await apiService.post(
        "/admin/panel-attributes/definitions/validate-key",
        {
          key,
          excludeId: editingId,
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
      if (editingId) {
        await apiService.put(
          `/admin/panel-attributes/definitions/${editingId}`,
          data
        );
        toast.success("Attribute updated successfully");
      } else {
        await apiService.post("/admin/panel-attributes/definitions", data);
        toast.success("Attribute created successfully");
      }

      setIsFormOpen(false);
      onFormOpenChange?.(false);
      reset();
      setEditingId(null);
      setKeyValidation(null);
      setNewOption({ key: "", label: "" });
      await fetchData();
    } catch (error: any) {
      console.error("Failed to save attribute", error);
      toast.error(error.response?.data?.message || "Failed to save attribute");
    }
  };

  const handleEdit = (attribute: PanelAttribute) => {
    setEditingId(attribute.id);
    setSelectedAttribute(attribute);
    reset({
      key: attribute.key,
      category: attribute.category,
      label: attribute.label,
      description: attribute.description,
      data_type: attribute.data_type,
      options: normalizeOptions(attribute.options),
      validation_regex: attribute.validation_regex,
      validation_min_length: attribute.validation_min_length,
      validation_max_length: attribute.validation_max_length,
      is_required: attribute.is_required,
      is_unique: attribute.is_unique,
      default_value: attribute.default_value,
      sort_order: attribute.sort_order,
      is_active: attribute.is_active,
    });
    setIsFormOpen(true);
  };

  const handleDeleteClick = (attribute: PanelAttribute) => {
    setSelectedAttribute(attribute);
    setIsDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!selectedAttribute) return;

    try {
      await apiService.delete(
        `/admin/panel-attributes/definitions/${selectedAttribute.id}`
      );
      toast.success("Attribute deleted successfully");
      setIsDeleteOpen(false);
      setSelectedAttribute(null);
      await fetchData();
    } catch (error: any) {
      console.error("Failed to delete attribute", error);
      toast.error(error.response?.data?.message || "Failed to delete attribute");
    }
  };

  const handleToggleActive = async (attribute: PanelAttribute) => {
    try {
      const endpoint = attribute.is_active ? "deactivate" : "activate";
      await apiService.patch(
        `/admin/panel-attributes/definitions/${attribute.id}/${endpoint}`
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

  const addOption = () => {
    if (!newOption.key || !newOption.label) {
      toast.error("Please fill in both key and label");
      return;
    }

    const currentOptions = optionsValue || {};
    setValue("options", {
      ...currentOptions,
      [newOption.key]: newOption.label,
    });
    setNewOption({ key: "", label: "" });
    toast.success("Option added");
  };

  const removeOption = (optionKey: string) => {
    const currentOptions = optionsValue || {};
    const updatedOptions = { ...currentOptions };
    delete updatedOptions[optionKey];
    setValue("options", Object.keys(updatedOptions).length > 0 ? updatedOptions : null);
  };

  const openCreateForm = () => {
    setEditingId(null);
    setSelectedAttribute(null);
    setKeyValidation(null);
    setNewOption({ key: "", label: "" });
    reset({
      is_active: true,
      sort_order: 999,
      is_required: false,
      is_unique: false,
      options: {},
    });
    setIsFormOpen(true);
  };

  const filteredAttributesByCategory = PANEL_CATEGORIES.map((cat) => ({
    category: cat,
    attributes: (attributesByCategory[cat] || []).filter((attr) => {
      const matchesSearch =
        attr.key.toLowerCase().includes(searchTerm.toLowerCase()) ||
        attr.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (attr.description &&
          attr.description.toLowerCase().includes(searchTerm.toLowerCase()));

      const matchesDataType = !filterDataType || attr.data_type === filterDataType;

      return matchesSearch && matchesDataType;
    }),
  }));

  // Get attributes to display based on selected category
  const displayAttributes = activeCategory === ""
    ? filteredAttributesByCategory.flatMap(c => c.attributes)
    : (filteredAttributesByCategory.find(c => c.category === activeCategory)?.attributes || []);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px] space-y-2">
          <Label htmlFor="category-filter" className="text-sm font-medium">All Categories</Label>
          <Select value={activeCategory} onValueChange={setActiveCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Categories</SelectItem>
              {PANEL_CATEGORIES.map((cat) => (
                <SelectItem key={cat} value={cat}>
                  {capitalize(cat)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-w-[200px] space-y-2">
          <Label htmlFor="datatype-filter" className="text-sm font-medium">All Data Types</Label>
          <Select value={filterDataType} onValueChange={setFilterDataType}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by data type..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Data Types</SelectItem>
              {DATA_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {capitalize(type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

        {/* Attributes Table */}
        <Card>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin" />
              </div>
            ) : displayAttributes.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64">
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                  <FileText className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="font-semibold">No attributes found</h3>
                <p className="text-muted-foreground text-sm mt-2">
                  {searchTerm
                    ? "Try adjusting your search"
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
                      <TableHead>Data Type</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {displayAttributes.map((attr) => (
                      <TableRow
                        key={attr.id}
                        className="hover:bg-muted/50 transition-colors"
                      >
                        <TableCell className="font-mono text-sm">
                          {attr.key}
                        </TableCell>
                        <TableCell className="font-medium">
                          {attr.label}
                        </TableCell>
                        <TableCell>{attr.data_type}</TableCell>
                        <TableCell>
                          {attr.is_required ? (
                            <Badge variant="secondary">Required</Badge>
                          ) : (
                            <Badge variant="outline">Optional</Badge>
                          )}
                        </TableCell>
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
          if (!open) {
            // Dialog is closing - clear all form state
            setEditingId(null);
            setSelectedAttribute(null);
            reset();
            setKeyValidation(null);
            setNewOption({ key: "", label: "" });
          }
          setIsFormOpen(open);
          onFormOpenChange?.(open);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "Edit Panel Attribute" : "Create Panel Attribute"}
            </DialogTitle>
            <DialogDescription>
              {editingId
                ? "Update the attribute definition details below."
                : "Add a new panel attribute definition to the system."}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={handleSubmit(onSubmit)}
            className="space-y-4"
            id="panelAttrForm"
          >
            {/* Key Field */}
            <div className="space-y-2">
              <Label htmlFor="key">Attribute Key *</Label>
              <Input
                id="key"
                placeholder="e.g., vendor_gst_number"
                {...register("key")}
                disabled={!!editingId}
                onBlur={(e) => {
                  if (!editingId && e.target.value) {
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
              {keyValidation && !editingId && (
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
                Use lowercase letters, numbers, and underscores only
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
                  placeholder="e.g., GST Number"
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
                  onValueChange={(value: string) =>
                    setValue("category", value as any)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {PANEL_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        <span className="capitalize">{cat}</span>
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
                  onValueChange={(value: string) => {
                    setValue("data_type", value);
                    if (!["single_select", "multi_select"].includes(value)) {
                      setValue("options", null);
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a data type" />
                  </SelectTrigger>
                  <SelectContent>
                    {DATA_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {capitalize(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Type of value this attribute will store</p>
                {errors.data_type && (
                  <p className="text-sm text-destructive">{errors.data_type.message}</p>
                )}
              </div>

              {/* Description */}
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
            </div>

            {/* ═══ OPTIONS CONFIGURATION ═══ */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">OPTIONS CONFIGURATION</h3>
              <p className="text-xs text-muted-foreground">
                {["single_select", "multi_select"].includes(dataTypeValue)
                  ? `Define the available options for this ${dataTypeValue === "multi_select" ? "multi-select" : "single-select"} field.`
                  : "Store predefined option values as JSON. Useful for select fields and custom metadata."}
              </p>

                {/* Add Option Form */}
                <div className="space-y-3 p-4 bg-muted/30 rounded-lg border border-muted">
                  <p className="text-sm font-medium text-foreground mb-3">Add New Option</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder="Option key"
                      value={newOption.key}
                      onChange={(e) =>
                        setNewOption({ ...newOption, key: e.target.value })
                      }
                      className="text-sm"
                    />
                    <Input
                      placeholder="Option label"
                      value={newOption.label}
                      onChange={(e) =>
                        setNewOption({ ...newOption, label: e.target.value })
                      }
                      className="text-sm"
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addOption}
                    className="w-full"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Option
                  </Button>
                </div>

                {/* Options List */}
                {optionsValue && Object.keys(optionsValue).length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground">
                      Options ({Object.keys(optionsValue).length})
                    </p>
                    <div className="space-y-2">
                      {Object.entries(optionsValue).map(([optionKey, optionLabel]) => (
                        <div
                          key={optionKey}
                          className="flex items-center gap-2 bg-background p-3 rounded border border-border"
                        >
                          <GripVertical className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <div className="flex-1">
                            <p className="font-mono text-xs text-muted-foreground">{optionKey}</p>
                            <p className="text-sm font-medium">{optionLabel}</p>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeOption(optionKey)}
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>

            {/* ═══ VALIDATION RULES ═══ */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">VALIDATION RULES</h3>

              <div className="space-y-2">
                <Label htmlFor="validation_regex">Regex Pattern</Label>
                <Input
                  id="validation_regex"
                  placeholder="e.g., ^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[0-9]{1}$"
                  {...register("validation_regex")}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">Optional: Regular expression pattern for validation</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="validation_min_length">Min Length</Label>
                  <Input
                    id="validation_min_length"
                    type="number"
                    placeholder="0"
                    {...register("validation_min_length", { valueAsNumber: true })}
                  />
                  <p className="text-xs text-muted-foreground">Minimum character length</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="validation_max_length">Max Length</Label>
                  <Input
                    id="validation_max_length"
                    type="number"
                    placeholder="255"
                    {...register("validation_max_length", { valueAsNumber: true })}
                  />
                  <p className="text-xs text-muted-foreground">Maximum character length</p>
                </div>
              </div>
            </div>

            {/* ═══ FIELD REQUIREMENTS ═══ */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">FIELD REQUIREMENTS</h3>

              <div className="space-y-3">
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_required"
                    {...register("is_required")}
                    className="h-4 w-4 rounded border-slate-300 mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="is_required" className="font-normal cursor-pointer">
                      Field is Required
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">User must provide a value for this field</p>
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_unique"
                    {...register("is_unique")}
                    className="h-4 w-4 rounded border-slate-300 mt-1"
                  />
                  <div className="flex-1">
                    <Label htmlFor="is_unique" className="font-normal cursor-pointer">
                      Value Must Be Unique
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1">No two vendors can have the same value for this field</p>
                  </div>
                </div>
              </div>
            </div>

            {/* ═══ DATA & MANAGEMENT ═══ */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">DATA & MANAGEMENT</h3>

              {/* Default Value */}
              <div className="space-y-2">
                <Label htmlFor="default_value">Default Value</Label>
                <Input
                  id="default_value"
                  placeholder="Value to use if not provided by vendor"
                  {...register("default_value")}
                />
                <p className="text-xs text-muted-foreground">Pre-filled value if vendor doesn't enter one</p>
              </div>

              {/* Sort Order */}
              <div className="space-y-2">
                <Label htmlFor="sort_order">Display Sort Order</Label>
                <Input
                  id="sort_order"
                  type="number"
                  placeholder="999"
                  {...register("sort_order", { valueAsNumber: true })}
                />
                <p className="text-xs text-muted-foreground">Lower numbers appear first in forms and lists</p>
              </div>

              {/* Active Status */}
              <div className="flex items-start space-x-3">
                <input
                  type="checkbox"
                  id="is_active"
                  {...register("is_active")}
                  className="h-4 w-4 rounded border-slate-300 mt-1"
                />
                <div className="flex-1">
                  <Label htmlFor="is_active" className="font-normal cursor-pointer">
                    Active
                  </Label>
                  <p className="text-xs text-muted-foreground mt-1">Unchecking disables this field in forms but preserves all associated data</p>
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
              form="panelAttrForm"
              disabled={
                isSubmitting ||
                (!editingId && !!(keyValidation && !keyValidation.isUnique))
              }
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                editingId ? "Update" : "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Panel Attribute</AlertDialogTitle>
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

export default PanelAttributeDefinitionsManager;
