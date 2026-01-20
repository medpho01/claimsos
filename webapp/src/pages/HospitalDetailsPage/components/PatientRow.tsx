import React from "react";
import { Patient } from "../../../types";
import { getInitials, formatDate } from "../utils/formatters";

interface PatientRowProps {
    patient: Patient;
    onClick: () => void;
    onViewPhotos: (e: React.MouseEvent) => void;
}

/**
 * Patient table row component
 */
const PatientRow: React.FC<PatientRowProps> = ({ patient, onClick, onViewPhotos }) => {
    return (
        <tr className="clickable-row" onClick={onClick}>
            <td>
                <div className="user-cell">
                    <div className="patient-avatar">
                        {getInitials(patient.first_name, patient.last_name)}
                    </div>
                    <div className="user-details">
                        <span className="user-name-cell">
                            {patient.first_name} {patient.last_name}
                        </span>
                    </div>
                </div>
            </td>
            <td>
                <span className="phone-number">{patient.phone}</span>
            </td>
            <td>
                <span className="date-text">{formatDate(patient.admitted_at)}</span>
            </td>
            <td>
                <span className={`type-badge ${patient.admission_type || ""}`}>
                    {patient.admission_type || "—"}
                </span>
            </td>
            <td>
                {patient.discharged_at ? (
                    <span className="status-badge discharged">Discharged</span>
                ) : (
                    <span className="status-badge admitted">Admitted</span>
                )}
            </td>
            <td>
                <button
                    className="edit-btn"
                    onClick={(e) => {
                        e.stopPropagation();
                        onViewPhotos(e);
                    }}
                >
                    View Photos
                </button>
            </td>
        </tr>
    );
};

export default PatientRow;
