import React, { useState, useEffect } from "react";
import apiService from "../../services/api";
import { User, Hospital } from "../../types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";

interface AssignmentModalProps {
    admin: User;
    hospitals: Hospital[];
    onClose: () => void;
    onSuccess: () => void;
}

const AssignmentModal: React.FC<AssignmentModalProps> = ({
    admin,
    hospitals,
    onClose,
    onSuccess,
}) => {
    const [selectedHospitals, setSelectedHospitals] = useState<string[]>([]);
    const [assignedHospitals, setAssignedHospitals] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        const fetchAssignedHospitals = async () => {
            try {
                setLoading(true);
                const response = await apiService.getAdminHospitals(admin.id);
                console.log(response.data.data);
                setAssignedHospitals(response.data.data);
                setSelectedHospitals(response.data.data);
            } catch (err) {
                console.error("Failed to load assigned hospitals", err);
            } finally {
                setLoading(false);
            }
        };
        fetchAssignedHospitals();
    }, [admin.id]);


    const handleToggleHospital = (hospitalId: string) => {
        setSelectedHospitals((prev) =>
            prev.includes(hospitalId) ? prev.filter((id) => id !== hospitalId) : [...prev, hospitalId]
        );
    };

    const handleSave = async () => {
        setSubmitting(true);
        setError("");

        try {
            const currentAssigned = assignedHospitals
            const toAssign = selectedHospitals.filter((id) => !currentAssigned.includes(id));
            const toRemove = currentAssigned.filter((id: string) => !selectedHospitals.includes(id));

            // Assign new hospitals
            for (const hospitalId of toAssign) {
                await apiService.assignHospitalToAdmin({
                    adminId: admin.id,
                    hospitalId,
                    canView: true,
                    canEdit: true,
                    canDischarge: true,
                });
            }

            // Remove unselected hospitals
            for (const hospitalId of toRemove) {
                await apiService.removeHospitalAssignment(admin.id, hospitalId);
            }

            onSuccess();
        } catch (err: any) {
            setError(err.response?.data?.message || "Failed to update assignments");
        } finally {
            setSubmitting(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (!open) onClose();
    }

    return (
        <Dialog open={true} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-[600px] max-h-[85vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle>
                        Assign Hospitals to {admin.first_name} {admin.last_name}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex-1 overflow-y-auto px-1 py-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-8 text-muted-foreground">Loading...</div>
                    ) : (
                        <>
                            {error && (
                                <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md mb-4">
                                    {error}
                                </div>
                            )}
                            <div className="flex flex-col gap-2">
                                {hospitals.map((hospital) => {
                                    const isSelected = selectedHospitals.includes(hospital.id);
                                    return (
                                        <div
                                            key={hospital.id}
                                            className={`border rounded-lg p-3 cursor-pointer transition-all ${isSelected
                                                ? 'border-indigo-600 bg-indigo-50/50'
                                                : 'border-border hover:bg-slate-50 hover:border-slate-300'
                                                }`}
                                            onClick={() => handleToggleHospital(hospital.id)}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div
                                                    className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${isSelected
                                                        ? 'bg-indigo-600 border-indigo-600 text-white'
                                                        : 'border-slate-300 bg-white'
                                                        }`}
                                                >
                                                    {isSelected && (
                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                                            <polyline points="20 6 9 17 4 12"></polyline>
                                                        </svg>
                                                    )}
                                                </div>
                                                <div className="flex flex-col">
                                                    <span className={`text-sm font-medium ${isSelected ? 'text-indigo-900' : 'text-slate-900'}`}>{hospital.name}</span>
                                                    <span className="text-xs text-muted-foreground">{hospital.city || 'No city'}</span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>

                <DialogFooter className="mt-4 pt-2 border-t">
                    <Button variant="outline" onClick={onClose} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button onClick={handleSave} disabled={submitting || loading}>
                        {submitting ? "Saving..." : "Save Assignments"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default AssignmentModal;
