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
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "lucide-react";
import apiService from "../../services/api";
import { toast } from "sonner";

// Validation Schema for Doctor Attribute Definitions
const doctorAttributeSchema = z.object({
  key: z
    .string()
    .min(1, "Key is required")
    .regex(
      /^[a-z0-9_]+\.[a-z0-9_]+(\.[a-z0-9_]+)?$/,
      "Key format: category.subcategory or category.subcategory.name (lowercase with dots and underscores)"
    ),
  label: z.string().min(1, "Label is required"),
  category: z.string().min(1, "Category is required"),
  description: z.string().nullable().optional(),
  dataType: z.string().min(1, "Data type is required"),
  isRequired: z.boolean().default(false),
  hasExpiry: z.boolean().default(false),
  requiresDocument: z.boolean().default(false),
  canVerifyByDocument: z.boolean().default(true),
  sortOrder: z.number().default(999),
  categorySortOrder: z.number().default(999),
  requiresValidatorVerification: z.boolean().default(false),
  autoVerifiable: z.boolean().default(false),
  verificationUrlPattern: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});

type FormValues = z.infer<typeof doctorAttributeSchema>;

interface DoctorAttribute extends FormValues {
  id: string;
  created_at: string;
  updated_at: string;
}

interface DoctorAttributeDefinitionsManagerProps {
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

const DoctorAttributeDefinitionsManager: React.FC<
  DoctorAttributeDefinitionsManagerProps
> = ({ searchTerm, isFormOpen: externalIsFormOpen, onFormOpenChange }) => {
  const [attributes, setAttributes] = useState<DoctorAttribute[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [dataTypes, setDataTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(externalIsFormOpen ?? false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedAttribute, setSelectedAttribute] =
    useState<DoctorAttribute | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterDataType, setFilterDataType] = useState<string>("");

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(doctorAttributeSchema),
    defaultValues: {
      key: "",
      label: "",
      category: "",
      description: "",
      dataType: "",
      isRequired: false,
      hasExpiry: false,
      requiresDocument: false,
      canVerifyByDocument: true,
      sortOrder: 999,
      categorySortOrder: 999,
      requiresValidatorVerification: false,
      autoVerifiable: false,
      verificationUrlPattern: "",
      isActive: true,
    },
  });

  const dataTypeValue = watch("dataType");

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
      const [attrRes] = await Promise.all([
        apiService.get("/admin/doctor-attributes/definitions/grouped"),
      ]);

      // Flatten the grouped structure
      const grouped = attrRes.data.data || {};
      const flattened: DoctorAttribute[] = [];
      const cats = new Set<string>();
      const types = new Set<string>();

      Object.entries(grouped).forEach(([category, attrs]) => {
        cats.add(category);
        (attrs as DoctorAttribute[]).forEach((attr) => {
          flattened.push(attr);
          types.add(attr.dataType);
        });
      });

      setAttributes(flattened);
      setCategories(Array.from(cats).sort());
      setDataTypes(Array.from(types).sort());
    } catch (error) {
      console.error("Failed to fetch doctor attribute definitions", error);
      toast.error("Failed to load doctor attribute definitions");
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = async (data: FormValues) => {
    try {
      if (editingId) {
        // Update existing
        const response = await apiService.put(
          `/admin/doctor-attributes/definitions/${editingId}`,
          data
        );
        toast.success("Doctor attribute updated successfully");
      } else {
        // Create new
        const response = await apiService.post(
          "/admin/doctor-attributes/definitions",
          data
        );
        toast.success("Doctor attribute created successfully");
      }

      setIsFormOpen(false);
      onFormOpenChange?.(false);
      reset();
      setEditingId(null);
      await fetchData();
    } catch (error: any) {
      console.error("Failed to save doctor attribute:", error);
      toast.error(
        error.response?.data?.message || "Failed to save doctor attribute"
      );
    }
  };

  const handleEdit = (attribute: DoctorAttribute) => {
    setEditingId(attribute.id);
    setSelectedAttribute(attribute);

    const formData = {
      key: attribute.key,
      label: attribute.label,
      category: attribute.category,
      description: attribute.description,
      dataType: attribute.dataType,
      isRequired: attribute.isRequired,
      hasExpiry: attribute.hasExpiry,
      requiresDocument: attribute.requiresDocument,
      canVerifyByDocument: attribute.canVerifyByDocument,
      sortOrder: attribute.sortOrder,
      categorySortOrder: attribute.categorySortOrder,
      requiresValidatorVerification: attribute.requiresValidatorVerification,
      autoVerifiable: attribute.autoVerifiable,
      verificationUrlPattern: attribute.verificationUrlPattern,
      isActive: attribute.isActive,
    };

    reset(formData);
    setIsFormOpen(true);
  };

  const handleDeleteClick = (attribute: DoctorAttribute) => {
    setSelectedAttribute(attribute);
    setIsDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!selectedAttribute) return;

    try {
      await apiService.delete(
        `/admin/doctor-attributes/definitions/${selectedAttribute.id}`
      );
      toast.success("Doctor attribute deactivated successfully");
      setIsDeleteOpen(false);
      setSelectedAttribute(null);
      await fetchData();
    } catch (error: any) {
      console.error("Failed to delete doctor attribute", error);
      toast.error(
        error.response?.data?.message || "Failed to delete doctor attribute"
      );
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
      !filterDataType || attr.dataType === filterDataType;

    return matchesSearch && matchesCategory && matchesDataType;
  });

  const openCreateForm = () => {
    setEditingId(null);
    setSelectedAttribute(null);
    reset({
      key: "",
      label: "",
      category: "",
      description: "",
      dataType: "",
      isRequired: false,
      hasExpiry: false,
      requiresDocument: false,
      canVerifyByDocument: true,
      sortOrder: 999,
      categorySortOrder: 999,
      requiresValidatorVerification: false,
      autoVerifiable: false,
      verificationUrlPattern: "",
      isActive: true,
    });
    setIsFormOpen(true);
    onFormOpenChange?.(true);
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex gap-4 flex-wrap">
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
              <h3 className="font-semibold">No doctor attributes found</h3>
              <p className="text-muted-foreground text-sm mt-2">
                {searchTerm || filterCategory || filterDataType
                  ? "Try adjusting your filters"
                  : "Create your first doctor attribute definition"}
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
                    <TableHead>Config</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAttributes.map((attr) => (
                    <TableRow
                      key={attr.id}
                      className="hover:bg-muted/50 transition-colors"
                    >
                      <TableCell className="font-mono text-sm">
                        {attr.key}
                      </TableCell>
                      <TableCell className="font-medium">{attr.label}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{attr.category}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">{attr.dataType}</TableCell>
                      <TableCell className="text-xs">
                        <div className="flex gap-1 flex-wrap">
                          {attr.hasExpiry && (
                            <Badge variant="outline" className="text-xs">
                              Expiry
                            </Badge>
                          )}
                          {attr.requiresDocument && (
                            <Badge variant="outline" className="text-xs">
                              Doc
                            </Badge>
                          )}
                          {attr.requiresValidatorVerification && (
                            <Badge variant="outline" className="text-xs">
                              Verify
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={attr.isActive ? "default" : "outline"}
                          className="cursor-pointer"
                        >
                          {attr.isActive ? "Active" : "Inactive"}
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
                            title="Deactivate attribute"
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
            setEditingId(null);
            setSelectedAttribute(null);
            reset();
          }
          setIsFormOpen(open);
          onFormOpenChange?.(open);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? "Edit Doctor Attribute"
                : "Create Doctor Attribute"}
            </DialogTitle>
            <DialogDescription>
              {editingId
                ? "Update the doctor attribute definition details below."
                : "Add a new doctor attribute definition to the system. Used for credentials like qualifications, licenses, and certifications."}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={handleSubmit(onSubmit)}
            className="space-y-4"
            id="doctorAttrForm"
          >
            {/* Key Field */}
            <div className="space-y-2">
              <Label htmlFor="key">Attribute Key *</Label>
              <Input
                id="key"
                placeholder="e.g., qualification.md or license.nmc_registration"
                {...register("key")}
                disabled={!!editingId}
              />
              {errors.key && (
                <p className="text-sm text-destructive">{errors.key.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Format: category.subcategory (lowercase with dots and underscores)
              </p>
            </div>

            {/* ═══ BASIC INFORMATION ═══ */}
            <div className="space-y-6 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">
                BASIC INFORMATION
              </h3>

              {/* Label Field */}
              <div className="space-y-2">
                <Label htmlFor="label">Label *</Label>
                <Input
                  id="label"
                  placeholder="e.g., Medical Degree (MD)"
                  {...register("label")}
                  aria-invalid={!!errors.label}
                />
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
                    setValue("category", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="qualifications">
                      Qualifications
                    </SelectItem>
                    <SelectItem value="licenses">Licenses</SelectItem>
                    <SelectItem value="registrations">
                      Registrations
                    </SelectItem>
                    <SelectItem value="compliance">Compliance</SelectItem>
                    <SelectItem value="experience">Experience</SelectItem>
                  </SelectContent>
                </Select>
                {errors.category && (
                  <p className="text-sm text-destructive">
                    {errors.category.message}
                  </p>
                )}
              </div>

              {/* Description Field */}
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  placeholder="e.g., Doctor's primary medical qualification"
                  {...register("description")}
                />
              </div>

              {/* Data Type Field */}
              <div className="space-y-2">
                <Label htmlFor="dataType">Data Type *</Label>
                <Select
                  value={watch("dataType")}
                  onValueChange={(value: string) =>
                    setValue("dataType", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select data type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="date">Date</SelectItem>
                    <SelectItem value="boolean">Boolean (Yes/No)</SelectItem>
                    <SelectItem value="document">Document</SelectItem>
                  </SelectContent>
                </Select>
                {errors.dataType && (
                  <p className="text-sm text-destructive">
                    {errors.dataType.message}
                  </p>
                )}
              </div>
            </div>

            {/* ═══ REQUIREMENTS ═══ */}
            <div className="space-y-4 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">
                REQUIREMENTS
              </h3>

              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="isRequired"
                    {...register("isRequired")}
                    checked={watch("isRequired")}
                    onCheckedChange={(checked) =>
                      setValue("isRequired", checked as boolean)
                    }
                  />
                  <Label htmlFor="isRequired" className="font-normal">
                    This field is required
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="hasExpiry"
                    {...register("hasExpiry")}
                    checked={watch("hasExpiry")}
                    onCheckedChange={(checked) =>
                      setValue("hasExpiry", checked as boolean)
                    }
                  />
                  <Label htmlFor="hasExpiry" className="font-normal">
                    Credentials can expire
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="requiresDocument"
                    {...register("requiresDocument")}
                    checked={watch("requiresDocument")}
                    onCheckedChange={(checked) =>
                      setValue("requiresDocument", checked as boolean)
                    }
                  />
                  <Label htmlFor="requiresDocument" className="font-normal">
                    Must have supporting document(s)
                  </Label>
                </div>
              </div>
            </div>

            {/* ═══ VERIFICATION ═══ */}
            <div className="space-y-4 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">
                VERIFICATION
              </h3>

              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="canVerifyByDocument"
                    {...register("canVerifyByDocument")}
                    checked={watch("canVerifyByDocument")}
                    onCheckedChange={(checked) =>
                      setValue("canVerifyByDocument", checked as boolean)
                    }
                  />
                  <Label htmlFor="canVerifyByDocument" className="font-normal">
                    Can be verified by document
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="requiresValidatorVerification"
                    {...register("requiresValidatorVerification")}
                    checked={watch("requiresValidatorVerification")}
                    onCheckedChange={(checked) =>
                      setValue("requiresValidatorVerification", checked as boolean)
                    }
                  />
                  <Label
                    htmlFor="requiresValidatorVerification"
                    className="font-normal"
                  >
                    Requires on-site validator verification
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="autoVerifiable"
                    {...register("autoVerifiable")}
                    checked={watch("autoVerifiable")}
                    onCheckedChange={(checked) =>
                      setValue("autoVerifiable", checked as boolean)
                    }
                  />
                  <Label htmlFor="autoVerifiable" className="font-normal">
                    Can be auto-verified (e.g., online lookup)
                  </Label>
                </div>

                {watch("autoVerifiable") && (
                  <div className="space-y-2 pl-6">
                    <Label htmlFor="verificationUrlPattern" className="text-sm">
                      Verification URL Pattern
                    </Label>
                    <Input
                      id="verificationUrlPattern"
                      placeholder="e.g., https://nmc.org.in/search?id={value}"
                      {...register("verificationUrlPattern")}
                    />
                    <p className="text-xs text-muted-foreground">
                      URL pattern for automatic verification lookup
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* ═══ ORDERING ═══ */}
            <div className="space-y-4 border-t pt-6">
              <h3 className="text-sm font-semibold text-foreground">
                DISPLAY ORDER
              </h3>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="sortOrder">Sort Order Within Category</Label>
                  <Input
                    id="sortOrder"
                    type="number"
                    min="0"
                    {...register("sortOrder", { valueAsNumber: true })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="categorySortOrder">
                    Category Display Order
                  </Label>
                  <Input
                    id="categorySortOrder"
                    type="number"
                    min="0"
                    {...register("categorySortOrder", {
                      valueAsNumber: true,
                    })}
                  />
                </div>
              </div>
            </div>

            {/* Form Actions */}
            <DialogFooter className="pt-6 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsFormOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  (editingId ? "Update" : "Create") + " Doctor Attribute"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate Doctor Attribute?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the "{selectedAttribute?.label}" attribute.
              Existing attributes will not be affected, but new doctors won't be
              able to use this definition.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive">
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default DoctorAttributeDefinitionsManager;
