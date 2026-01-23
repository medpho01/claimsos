import React, { useState } from "react";
import { Patient, HospitalPanel, User, Hospital } from "../../../types";
import { TableRowSkeleton } from "../../../components/Skeleton";
import PatientRow from "./PatientRow";

interface PatientsTableProps {
    patients: Patient[];
    selectedPanel: HospitalPanel;
    loading: boolean;
    user: User | null;
    hospital: Hospital | null;
    onAddPatient: () => void;
    onPatientClick: (patient: Patient) => void;
}

// Icon components
const UsersIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);

const PlusIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14M5 12h14" />
    </svg>
);

const SearchIcon = () => (
    <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
    </svg>
);

const EmptyPatientIcon = () => (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4 }}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
);

/**
 * Patients table component with filters, search, and patient rows
 */
const PatientsTable: React.FC<PatientsTableProps> = ({
    patients,
    selectedPanel,
    loading,
    user,
    hospital,
    onAddPatient,
    onPatientClick,
}) => {
    const [searchTerm, setSearchTerm] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "admitted" | "discharged">("all");
    const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");

    // Filter patients by panel and other criteria
    const filteredPatients = patients.filter((patient) => {
        const matchesSearch =
            patient.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.phone.includes(searchTerm);

        let matchesStatus = true;
        if (statusFilter === "admitted") matchesStatus = !patient.discharged_at;
        if (statusFilter === "discharged") matchesStatus = !!patient.discharged_at;

        let matchesActive = true;
        if (activeFilter === "active") matchesActive = patient.is_active !== false;
        if (activeFilter === "inactive") matchesActive = patient.is_active === false;

        // Panel filter
        const matchesPanel = patient.panel_id === selectedPanel.panel_id;

        return matchesSearch && matchesStatus && matchesActive && matchesPanel;
    });

    const canAddPatient =
        user?.role === "superadmin" || (user?.role === "admin" && (hospital as any)?.can_edit);

    return (
        <>
            {/* Panel Patients Header */}
            <div className="section-header panel-patients">
                <div className="section-title">
                    <UsersIcon />
                    <h3>{selectedPanel.panel_name} Patients</h3>
                    <span className="section-count">{filteredPatients.length}</span>
                </div>
                {canAddPatient && (
                    <button className="btn-add-patient" onClick={onAddPatient}>
                        <PlusIcon />
                        New Patient
                    </button>
                )}
            </div>

            {/* Toolbar for filtering patients */}
            <div className="toolbar">
                <div className="filter-tabs">
                    <button
                        className={`filter-tab ${statusFilter === "all" && activeFilter === "all" ? "active" : ""}`}
                        onClick={() => {
                            setStatusFilter("all");
                            setActiveFilter("all");
                        }}
                    >
                        All ({filteredPatients.length})
                    </button>
                    <button
                        className={`filter-tab ${statusFilter === "admitted" ? "active" : ""}`}
                        onClick={() => {
                            setStatusFilter("admitted");
                            setActiveFilter("all");
                        }}
                    >
                        Admitted ({filteredPatients.filter((p) => !p.discharged_at).length})
                    </button>
                    <button
                        className={`filter-tab ${statusFilter === "discharged" ? "active" : ""}`}
                        onClick={() => {
                            setStatusFilter("discharged");
                            setActiveFilter("all");
                        }}
                    >
                        Discharged ({filteredPatients.filter((p) => !!p.discharged_at).length})
                    </button>
                </div>
                <div className="search-box">
                    <SearchIcon />
                    <input
                        type="text"
                        placeholder="Search patients..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
            </div>

            {/* Patients Table */}
            {loading ? (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Patient</th>
                                <th>Contact</th>
                                <th>Admitted On</th>
                                <th>Type</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...Array(5)].map((_, i) => (
                                <TableRowSkeleton key={i} columns={5} />
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Patient</th>
                                <th>Contact</th>
                                <th>Admitted On</th>
                                <th>Type</th>
                                <th>Status</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredPatients.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="empty-state">
                                        <div className="empty-content">
                                            <EmptyPatientIcon />
                                            <span>No patients found for this panel</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                filteredPatients.map((patient) => (
                                    <PatientRow
                                        key={patient.id}
                                        patient={patient}
                                        onClick={() => onPatientClick(patient)}
                                    />
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
};

export default PatientsTable;
