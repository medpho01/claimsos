import React, { useMemo, useState } from "react";
import apiService from "../../services/api";
import { HospitalPanel } from "../../types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Search } from "lucide-react";

interface AddUserModalProps {
  role: "admin" | "hospital" | "superadmin";
  hospitalId: string | null;
  panels: HospitalPanel[] | null;
  onClose: () => void;
  onSuccess: () => void;
}

const AddUserModal: React.FC<AddUserModalProps> = ({
  role,
  onClose,
  onSuccess,
  hospitalId = null,
  panels = null,
}) => {
  const [formData, setFormData] = useState({
    userName: "",
    passWord: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    hospitalId: hospitalId,
    userRole: [] as string[],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [roleSearch, setRoleSearch] = useState("");

  const visiblePanels = useMemo(() => {
    if (!panels) return [];
    const q = roleSearch.trim().toLowerCase();
    if (!q) return panels;
    return panels.filter((p) => (p.panel_name || "").toLowerCase().includes(q));
  }, [panels, roleSearch]);

  const allVisibleSelected =
    visiblePanels.length > 0 &&
    visiblePanels.every((p) => formData.userRole.includes(p.panel_id));

  const handleSelectAllVisible = () => {
    const idsToAdd = visiblePanels.map((p) => p.panel_id);
    setFormData((prev) => ({
      ...prev,
      userRole: Array.from(new Set([...prev.userRole, ...idsToAdd])),
    }));
  };

  const handleClearAllVisible = () => {
    const idsToRemove = new Set(visiblePanels.map((p) => p.panel_id));
    setFormData((prev) => ({
      ...prev,
      userRole: prev.userRole.filter((r) => !idsToRemove.has(r)),
    }));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Validation
    if (!formData.userName || !formData.passWord || !formData.firstName || !formData.phone) {
      setError("Please fill in all required fields");
      return;
    }

    try {
      setSubmitting(true);
      await apiService.signup({
        ...formData,
        role,
      });
      onSuccess();
    } catch (err: any) {
      setError(err.response?.data?.message || "Failed to create user");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value, checked } = e.target;
    let updatedRoles = [...formData.userRole];

    if (checked) {
      if (!updatedRoles.includes(value)) updatedRoles.push(value);
    } else {
      updatedRoles = updatedRoles.filter((role) => role !== value);
    }
    setFormData({ ...formData, userRole: updatedRoles });
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  }

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-2 border-b">
          <DialogTitle>Add New {role === "admin" ? "Admin" : "Hospital User"}</DialogTitle>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="grid gap-4 px-6 py-4 overflow-y-auto flex-1 min-h-0">
          {error && (
            <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="firstName">First Name *</Label>
              <Input
                id="firstName"
                name="firstName"
                type="text"
                value={formData.firstName}
                onChange={handleChange}
                placeholder="Enter first name"
                disabled={submitting}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                name="lastName"
                type="text"
                value={formData.lastName}
                onChange={handleChange}
                placeholder="Enter last name"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="userName">Username *</Label>
            <Input
              id="userName"
              name="userName"
              type="text"
              value={formData.userName}
              onChange={handleChange}
              placeholder="Enter username"
              disabled={submitting}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="passWord">Password *</Label>
            <Input
              id="passWord"
              name="passWord"
              type="password"
              value={formData.passWord}
              onChange={handleChange}
              placeholder="Enter password"
              disabled={submitting}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="Enter email"
                disabled={submitting}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="phone">Phone *</Label>
              <Input
                id="phone"
                name="phone"
                type="tel"
                value={formData.phone}
                onChange={handleChange}
                placeholder="Enter phone number"
                disabled={submitting}
              />
            </div>
          </div>

          {role === "hospital" && panels != null && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Roles (Panels)</Label>
                <span className="text-xs text-muted-foreground">
                  {formData.userRole.length} of {panels.length} selected
                </span>
              </div>
              <div className="border rounded-md">
                {/* Sticky search + bulk actions */}
                <div className="flex items-center gap-2 p-2 border-b bg-slate-50/60">
                  <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={roleSearch}
                      onChange={(e) => setRoleSearch(e.target.value)}
                      placeholder="Search panels..."
                      className="pl-7 h-8 text-sm"
                      disabled={submitting}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    onClick={
                      allVisibleSelected ? handleClearAllVisible : handleSelectAllVisible
                    }
                    disabled={submitting || visiblePanels.length === 0}
                  >
                    {allVisibleSelected ? "Clear" : "Select all"}
                  </Button>
                </div>
                {/* Scrollable list */}
                <div className="max-h-56 overflow-y-auto p-2">
                  {visiblePanels.length === 0 ? (
                    <div className="text-center text-xs text-muted-foreground py-4">
                      No panels match "{roleSearch}"
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {visiblePanels.map((panel, index) => (
                        <label
                          key={panel.panel_id || index}
                          className="flex items-center space-x-2 rounded px-1.5 py-1 hover:bg-slate-50 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            name="roles"
                            value={panel.panel_id}
                            checked={formData.userRole.includes(panel.panel_id)}
                            onChange={handleCheckboxChange}
                            disabled={submitting}
                            className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
                          />
                          <span className="text-sm font-normal">{panel.panel_name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          </div>

          <DialogFooter className="px-6 py-4 border-t bg-white">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating..." : `Create ${role === "admin" ? "Admin" : "User"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default AddUserModal;
