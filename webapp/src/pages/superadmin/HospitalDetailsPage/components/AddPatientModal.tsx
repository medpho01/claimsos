import React from "react";
import { HospitalPanel } from "../../../../types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../../../../components/ui/dialog";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";

interface AddPatientModalProps {
    selectedPanel: HospitalPanel;
    newPatient: {
        firstName: string;
        lastName: string;
        phone: string;
        admittedAt: string;
        admissionType: "conservative" | "surgical" | "";
    };
    isSubmitting: boolean;
    onClose: () => void;
    onSubmit: (e: React.FormEvent) => void;
    onPatientChange: (field: string, value: string) => void;
}

/**
 * Modal for adding a new patient
 */
const AddPatientModal: React.FC<AddPatientModalProps> = ({
    selectedPanel,
    newPatient,
    isSubmitting,
    onClose,
    onSubmit,
    onPatientChange,
}) => {
    const handleOpenChange = (open: boolean) => {
        if (!open) onClose();
    }

    return (
        <Dialog open={true} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Add New Patient</DialogTitle>
                </DialogHeader>
                <form onSubmit={onSubmit} className="grid gap-4 py-2">
                    <div className="grid gap-2">
                        <Label htmlFor="firstName">First Name *</Label>
                        <Input
                            id="firstName"
                            type="text"
                            value={newPatient.firstName}
                            onChange={(e) => onPatientChange("firstName", e.target.value)}
                            required
                            placeholder="Enter first name"
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="lastName">Last Name</Label>
                        <Input
                            id="lastName"
                            type="text"
                            value={newPatient.lastName}
                            onChange={(e) => onPatientChange("lastName", e.target.value)}
                            placeholder="Enter last name"
                        />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="admissionType">Admission Type</Label>
                        <select
                            id="admissionType"
                            value={newPatient.admissionType}
                            onChange={(e) => onPatientChange("admissionType", e.target.value)}
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <option value="">Select Type</option>
                            <option value="conservative">Conservative</option>
                            <option value="surgical">Surgical</option>
                        </select>
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="admittedAt">Admission Date</Label>
                        <Input
                            id="admittedAt"
                            type="date"
                            value={newPatient.admittedAt}
                            onChange={(e) => onPatientChange("admittedAt", e.target.value)}
                        />
                    </div>
                    <DialogFooter className="mt-2">
                        <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isSubmitting}>
                            {isSubmitting ? "Adding..." : "Add Patient"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default AddPatientModal;
