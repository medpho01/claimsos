import React from "react";
import { HospitalPanel } from "../../../types";

interface AddPatientModalProps {
    selectedPanel: HospitalPanel;
    newPatient: {
        firstName: string;
        lastName: string;
        phone: string;
        admissionType: "conservative" | "surgical" | "";
    };
    isSubmitting: boolean;
    onClose: () => void;
    onSubmit: (e: React.FormEvent) => void;
    onPatientChange: (field: string, value: string) => void;
}

// Icon component
const CloseIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 6L6 18M6 6l12 12" />
    </svg>
);

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
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Add New Patient</h2>
                    <button className="modal-close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>
                <form onSubmit={onSubmit} className="modal-form">
                    <div className="form-group">
                        <label>First Name *</label>
                        <input
                            type="text"
                            value={newPatient.firstName}
                            onChange={(e) => onPatientChange("firstName", e.target.value)}
                            required
                            placeholder="Enter first name"
                        />
                    </div>
                    <div className="form-group">
                        <label>Last Name</label>
                        <input
                            type="text"
                            value={newPatient.lastName}
                            onChange={(e) => onPatientChange("lastName", e.target.value)}
                            placeholder="Enter last name"
                        />
                    </div>
                    <div className="form-group">
                        <label>Admission Type</label>
                        <select
                            value={newPatient.admissionType}
                            onChange={(e) => onPatientChange("admissionType", e.target.value)}
                        >
                            <option value="">Select Type</option>
                            <option value="conservative">Conservative</option>
                            <option value="surgical">Surgical</option>
                        </select>
                    </div>
                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-cancel">
                            Cancel
                        </button>
                        <button type="submit" disabled={isSubmitting} className="btn-submit">
                            {isSubmitting ? "Adding..." : "Add Patient"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default AddPatientModal;
