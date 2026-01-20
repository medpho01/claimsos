import React, { useState, useEffect } from "react";
import apiService from "../services/api";
import { User, Hospital } from "../types";
import "../styles/Modal.css";

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
                setAssignedHospitals(response.data.data);
                setSelectedHospitals(response.data.data.map((h: any) => h.id));
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
            const currentAssigned = assignedHospitals.map((h) => h.id);
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

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content large-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>
                        Assign Hospitals to {admin.first_name} {admin.last_name}
                    </h2>
                    <button className="modal-close" onClick={onClose} title="Close">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>

                <div className="modal-body">
                    {loading ? (
                        <div className="loading">Loading...</div>
                    ) : (
                        <>
                            {error && <div className="error-message">{error}</div>}
                            <div className="hospital-list">
                                {hospitals.map((hospital) => {
                                    const isSelected = selectedHospitals.includes(hospital.id);
                                    return (
                                        <div
                                            key={hospital.id}
                                            className={`hospital-item ${isSelected ? 'selected' : ''}`}
                                            onClick={() => handleToggleHospital(hospital.id)}
                                        >
                                            <label onClick={(e) => e.stopPropagation()}>
                                                <div className="checkbox-wrapper">
                                                    <svg className="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                                        <polyline points="20 6 9 17 4 12"></polyline>
                                                    </svg>
                                                </div>
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => handleToggleHospital(hospital.id)}
                                                    disabled={submitting}
                                                />
                                                <div className="hospital-info">
                                                    <span className="hospital-name">{hospital.name}</span>
                                                    <span className="hospital-username">{hospital.city || 'No city'}</span>
                                                </div>
                                            </label>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>

                <div className="modal-actions">
                    <button onClick={onClose} className="btn-primary" disabled={submitting} style={{ background: "transparent", color: "black", border: "solid 1px grey" }}>
                        Cancel
                    </button>
                    <button onClick={handleSave} className="btn-primary" disabled={submitting || loading}>
                        {submitting ? "Saving..." : "Save Assignments"}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AssignmentModal;
