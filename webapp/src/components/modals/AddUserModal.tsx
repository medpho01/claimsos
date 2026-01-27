import React, { useState } from "react";
import apiService from "../../services/api";
import { HospitalPanel } from "../../types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

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
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add New {role === "admin" ? "Admin" : "Hospital User"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4 py-4">
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
              <Label>Roles</Label>
              <div className="flex flex-col gap-2 p-2 border rounded-md">
                {panels.map((panel, index) => (
                  <div key={index} className="flex items-center space-x-2">
                    <input
                      id={`role-${index}`}
                      type="checkbox"
                      name="roles"
                      value={panel.panel_id}
                      checked={formData.userRole.includes(panel.panel_id)}
                      onChange={handleCheckboxChange}
                      disabled={submitting}
                      className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
                    />
                    <Label htmlFor={`role-${index}`} className="font-normal cursor-pointer">
                      {panel.panel_name}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter className="mt-4">
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
