import React, { useState, useEffect } from "react";
import apiService from "../../services/api";
import { Patient } from "../../types";
import { useAuth } from "../../context/AuthContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface PatientModalProps {
    patient: Patient | null;
    onClose: () => void;
    onSuccess: () => void;
    fixedHospitalId?: string;
    fixedPanelId?: string;
}

const PatientModal: React.FC<PatientModalProps> = ({
    patient,
    onClose,
    onSuccess,
    fixedHospitalId,
    fixedPanelId
}) => {
    const { user } = useAuth();
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [phone, setPhone] = useState("");
    const [admittedAt, setAdmittedAt] = useState(new Date().toISOString().split("T")[0]);
    const [hospitalId, setHospitalId] = useState("");
    const [assignedHospitals, setAssignedHospitals] = useState<any[]>([]);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    // Common input styles to match shadcn Input
    const inputClassName = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

    useEffect(() => {
        if (patient) {
            setFirstName(patient.first_name);
            setLastName(patient.last_name);
            setPhone(patient.phone);
            setAdmittedAt(patient.admitted_at.split("T")[0]);
            setHospitalId(patient.hospital_id);
        } else {
            // If adding new patient and user is admin, fetch hospitals
            const fetchAssignedHospitals = async () => {
                if (!user) return;
                try {
                    const response = await apiService.getAdminHospitals(user.id);
                    // Filter hospitals where admin has edit permission
                    const editableHospitals = response.data.data.filter((h: any) => h.can_edit);
                    setAssignedHospitals(editableHospitals);
                    if (editableHospitals.length > 0) {
                        setHospitalId(editableHospitals[0].id);
                    }
                } catch (err) {
                    console.error("Failed to fetch hospitals", err);
                    setError("Failed to load assigned hospitals");
                }
            };
            if (user?.role === 'admin') {
                fetchAssignedHospitals();
            }
        }
    }, [patient, user]);


    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        try {
            const patientData = {
                firstName,
                lastName,
                phone,
                admittedAt: admittedAt ? new Date(admittedAt).toISOString() : undefined,
                hospitalId: fixedHospitalId || (user?.role === 'admin' ? hospitalId : undefined),
                panelId: fixedPanelId
            };

            if (patient) {
                await apiService.updatePatient(patient.id, {
                    ...patientData,
                    admittedAt: admittedAt ? new Date(admittedAt).toISOString() : patient.admitted_at,
                });
            } else {
                await apiService.addPatient(patientData);
            }

            onSuccess();
        } catch (err: any) {
            setError(err.response?.data?.message || "Operation failed");
        } finally {
            setLoading(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            onClose();
        }
    }

    return (
        <Dialog open={true} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>{patient ? "Edit Patient" : "Add New Patient"}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="grid gap-4 py-4">
                    {error && (
                        <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md">
                            {error}
                        </div>
                    )}

                    {user?.role === 'admin' && !patient && (
                        <div className="grid gap-2">
                            <Label htmlFor="hospital">Hospital *</Label>
                            <select
                                id="hospital"
                                value={hospitalId}
                                onChange={(e) => setHospitalId(e.target.value)}
                                required
                                disabled={loading || assignedHospitals.length === 0}
                                className={inputClassName}
                            >
                                <option value="">Select Hospital</option>
                                {assignedHospitals.map((h) => (
                                    <option key={h.id} value={h.id}>
                                        {h.first_name} {h.last_name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    <div className="grid gap-2">
                        <Label htmlFor="firstName">First Name *</Label>
                        <Input
                            id="firstName"
                            type="text"
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            required
                            disabled={loading}
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="lastName">Last Name</Label>
                        <Input
                            id="lastName"
                            type="text"
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            disabled={loading}
                        />
                    </div>

                    {user?.role !== 'hospital' && (
                        <div className="grid gap-2">
                            <Label htmlFor="phone">Phone *</Label>
                            <Input
                                id="phone"
                                type="tel"
                                value={phone}
                                onChange={(e) => setPhone(e.target.value)}
                                required
                                disabled={loading}
                            />
                        </div>
                    )}

                    <div className="grid gap-2">
                        <Label htmlFor="admittedAt">Admission Date</Label>
                        <Input
                            id="admittedAt"
                            type="date"
                            value={admittedAt}
                            onChange={(e) => setAdmittedAt(e.target.value)}
                            disabled={loading}
                        />
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={loading}>
                            {loading ? "Saving..." : patient ? "Update" : "Add Patient"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default PatientModal;
