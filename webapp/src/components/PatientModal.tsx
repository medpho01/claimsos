import React, { useState, useEffect } from "react";
import apiService from "../services/api";
import { Patient, User } from "../types";
import { useAuth } from "../context/AuthContext";
import "../styles/Modal.css";

interface PatientModalProps {
    patient: Patient | null;
    onClose: () => void;
    onSuccess: () => void;
}

const PatientModal: React.FC<PatientModalProps> = ({ patient, onClose, onSuccess }) => {
    const { user } = useAuth();
    const [firstName, setFirstName] = useState("");
    const [lastName, setLastName] = useState("");
    const [phone, setPhone] = useState("");
    const [admittedAt, setAdmittedAt] = useState("");
    const [hospitalId, setHospitalId] = useState("");
    const [assignedHospitals, setAssignedHospitals] = useState<any[]>([]);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (patient) {
            setFirstName(patient.first_name);
            setLastName(patient.last_name);
            setPhone(patient.phone);
            setAdmittedAt(patient.admitted_at.split("T")[0]);
            setHospitalId(patient.hospital_id);
        } else {
            // If adding new patient and user is admin, fetch hospitals
            if (user?.role === 'admin') {
                fetchAssignedHospitals();
            }
        }
    }, [patient, user]);

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
                hospitalId: user?.role === 'admin' ? hospitalId : undefined
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

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>{patient ? "Edit Patient" : "Add New Patient"}</h2>
                    <button className="modal-close" onClick={onClose}>
                        ×
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="modal-form">
                    {error && <div className="error-message">{error}</div>}

                    {user?.role === 'admin' && !patient && (
                        <div className="form-group">
                            <label htmlFor="hospital">Hospital *</label>
                            <select
                                id="hospital"
                                value={hospitalId}
                                onChange={(e) => setHospitalId(e.target.value)}
                                required
                                disabled={loading || assignedHospitals.length === 0}
                                style={{ padding: '12px 16px', borderRadius: '8px', border: '2px solid #e2e8f0' }}
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

                    <div className="form-group">
                        <label htmlFor="firstName">First Name *</label>
                        <input
                            id="firstName"
                            type="text"
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            required
                            disabled={loading}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="lastName">Last Name</label>
                        <input
                            id="lastName"
                            type="text"
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            disabled={loading}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="phone">Phone *</label>
                        <input
                            id="phone"
                            type="tel"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            required
                            disabled={loading}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="admittedAt">Admission Date</label>
                        <input
                            id="admittedAt"
                            type="date"
                            value={admittedAt}
                            onChange={(e) => setAdmittedAt(e.target.value)}
                            disabled={loading}
                        />
                    </div>

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-secondary" disabled={loading}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary" disabled={loading}>
                            {loading ? "Saving..." : patient ? "Update" : "Add Patient"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default PatientModal;
