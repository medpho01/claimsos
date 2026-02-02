import React from "react";
import { UseFormReturn } from "react-hook-form";
import { Label } from "../../../ui/label";
import { Input } from "../../../ui/input";
import { IpdFormData } from "../types";
import { Patient } from "../../../../types";

interface IPDFieldsProps {
    form: UseFormReturn<IpdFormData>;
    patient: Patient;
}

export const IPDFields: React.FC<IPDFieldsProps> = ({ form, patient }) => {
    return (
        <>
            <div className="grid gap-2">
                <Label>Mobile Number</Label>
                <Input
                    type="text"
                    {...form.register("phone")}
                    placeholder="e.g., 9876543210"
                    className={form.formState.errors.phone ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {form.formState.errors.phone && (
                    <p className="text-sm text-red-500">{form.formState.errors.phone.message}</p>
                )}
            </div>
            <div className="grid gap-2">
                <Label>Beneficiary ID</Label>
                <Input
                    type="text"
                    {...form.register("beneficiaryId")}
                    placeholder="e.g., BEN123456789"
                />
            </div>
            <div className="grid gap-2">
                <Label>Admission Type</Label>
                <select
                    {...form.register("admissionType")}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <option value="">Select type</option>
                    <option value="conservative">Conservative</option>
                    <option value="surgical">Surgical</option>
                </select>
            </div>
            <div className="grid gap-2">
                <Label>Admitted At</Label>
                <Input
                    type="text"
                    value={
                        patient.admitted_at
                            ? new Date(patient.admitted_at).toLocaleString("en-IN")
                            : "—"
                    }
                    disabled
                />
            </div>
            <div className="grid gap-2">
                <Label>Discharged At</Label>
                <Input
                    type="text"
                    value={
                        patient.discharged_at
                            ? new Date(patient.discharged_at).toLocaleString("en-IN")
                            : "Not discharged"
                    }
                    disabled
                />
            </div>
            <div className="grid gap-2">
                <Label>Active Status</Label>
                <Input
                    type="text"
                    value={patient.is_active ? "Active" : "Inactive"}
                    disabled
                />
            </div>
            <div className="grid gap-2">
                <Label>Panel</Label>
                <Input type="text" value={patient.panel_name || "Not assigned"} disabled />
            </div>
        </>
    );
};
