import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Patient, HospitalPanel, Hospital } from "../../types";
import apiService from "../../services/api";

// Styles
import "../HospitalDetailsPage/HospitalDetailsPage.css";
import "../../styles/SuperAdmin.css";

// Components
import PatientPhotosModal from "../../components/PatientPhotosModal";
import { TableRowSkeleton } from "../../components/Skeleton";
import PatientRow from "../HospitalDetailsPage/components/PatientRow";
import AddPatientModal from "../HospitalDetailsPage/components/AddPatientModal";

// Hooks
import { usePatientActions } from "../HospitalDetailsPage/hooks/usePatientActions";

// Icons
const HomeIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
);

const ChevronRight = () => (
    <svg className="breadcrumb-separator" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

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

const FolderIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
);

const PhoneIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
);

const SheetIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
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
 * Panel Patients Page - displays patients for a specific panel
 * Route: /hospital/:hospitalId/panel/:panelId
 */
const PanelPatientsPage: React.FC = () => {
    const { hospitalId, panelId } = useParams<{ hospitalId: string; panelId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();

    // Data state
    const [hospital, setHospital] = useState<Hospital | null>(null);
    const [panel, setPanel] = useState<HospitalPanel | null>(null);
    const [patients, setPatients] = useState<Patient[]>([]);
    const [loading, setLoading] = useState(true);

    // UI state
    const [searchTerm, setSearchTerm] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "admitted" | "discharged" | "active">("active");
    const [showAddModal, setShowAddModal] = useState(false);
    const [selectedPatientForPhotos, setSelectedPatientForPhotos] = useState<Patient | null>(null);
    const [newPatient, setNewPatient] = useState({
        firstName: "",
        lastName: "",
        phone: "",
        admittedAt: new Date().toISOString().split("T")[0],
        admissionType: "" as "conservative" | "surgical" | "",
    });

    // Patient actions hook
    const { isSubmitting, dischargingId, togglingActiveId, handlePatientUpdate, handleAddPatient, handleDischarge, handleToggleActive } = usePatientActions({
        patients,
        setPatients,
        selectedPatientForPhotos,
        setSelectedPatientForPhotos,
    });

    // Fetch data
    useEffect(() => {
        const fetchData = async () => {
            if (!hospitalId || !panelId) return;
            try {
                setLoading(true);

                // Fetch hospital
                const hospitalsRes = await apiService.getAllHospitals();
                const foundHospital = hospitalsRes.data.data.find((h: Hospital) => h.id === hospitalId);
                setHospital(foundHospital || null);

                // Fetch panel info
                const panelsRes = await apiService.getHospitalPanels(hospitalId);
                const foundPanel = panelsRes.data.data.find((p: HospitalPanel) => p.panel_id === panelId);
                setPanel(foundPanel || null);

                // Fetch patients
                const patientsRes = await apiService.getAllPatients();
                const panelPatients = patientsRes.data.data.filter(
                    (p: Patient) => p.hospital_id === hospitalId && p.panel_id === panelId
                );
                setPatients(panelPatients);
            } catch (err) {
                console.error("Failed to load panel patients", err);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [hospitalId, panelId]);

    // Filter patients
    const filteredPatients = patients.filter((patient) => {
        const matchesSearch =
            patient.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.phone.includes(searchTerm);

        let matchesStatus = true;
        if (statusFilter === "admitted") matchesStatus = !patient.discharged_at;
        if (statusFilter === "discharged") matchesStatus = !!patient.discharged_at;
        if (statusFilter === "active") matchesStatus = patient.is_active;

        return matchesSearch && matchesStatus;
    });

    const admittedCount = patients.filter((p) => !p.discharged_at).length;
    const activeCount = patients.filter((p) => p.is_active).length;

    // Handlers
    const handleNavigateHome = () => {
        navigate(user?.role === "admin" ? "/dashboard" : "/superadmin", {
            state: { activeTab: "hospitals" },
        });
    };

    const handleNavigateToHospital = () => {
        navigate(`/hospital/${hospitalId}`);
    };

    const handlePatientChange = (field: string, value: string) => {
        setNewPatient((prev) => ({ ...prev, [field]: value }));
    };

    const handleAddPatientSubmit = (e: React.FormEvent) => {
        handleAddPatient(e, newPatient, hospitalId!, panel, () => {
            setNewPatient({
                firstName: "",
                lastName: "",
                phone: "",
                admittedAt: new Date().toISOString().split("T")[0],
                admissionType: ""
            });
            setShowAddModal(false);
        });
    };

    const canAddPatient =
        user?.role === "superadmin" || (user?.role === "admin" && (hospital as any)?.can_edit);

    // Helper to check if user can discharge a specific patient
    const canDischargePatient = (patient: Patient) => {
        if (user?.role === "superadmin") return true;
        if (user?.role === "admin" && patient.can_discharge) return true;
        return false;
    };

    // Helper to check if user can toggle active status
    const canToggleActiveStatus = (patient: Patient) => {
        if (user?.role === "superadmin") return true;
        if (user?.role === "admin" && patient.can_edit) return true;
        return false;
    };

    return (
        <div className="hospital-details-page">
            {/* Breadcrumb Navigation */}
            <nav className="breadcrumb-nav">
                <button onClick={handleNavigateHome} className="breadcrumb-link">
                    <HomeIcon />
                    {user?.role === "admin" ? "Dashboard" : "All Hospitals"}
                </button>
                <ChevronRight />
                {hospital && (
                    <>
                        <button onClick={handleNavigateToHospital} className="breadcrumb-link">
                            {hospital.name}
                        </button>
                        <ChevronRight />
                    </>
                )}
                {panel && <span className="breadcrumb-current">{panel.panel_name}</span>}
                {loading && <span className="breadcrumb-current">Loading...</span>}
            </nav>

            {/* Panel Header */}
            <header className="page-header enhanced">
                <div className="header-content">
                    {loading ? (
                        <div className="header-skeleton">
                            <div className="skeleton-avatar"></div>
                            <div className="skeleton-text">
                                <div className="skeleton-line wide"></div>
                                <div className="skeleton-line narrow"></div>
                            </div>
                        </div>
                    ) : (
                        panel && (
                            <>
                                <div className="header-info">
                                    <div className="hospital-avatar large" style={{ background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)" }}>
                                        {panel.panel_name?.charAt(0).toUpperCase() || "P"}
                                    </div>
                                    <div className="hospital-meta">
                                        <h1>{panel.panel_name}</h1>
                                        <div className="hospital-subtitle">
                                            {panel.contact && (
                                                <span className="hospital-city">
                                                    <PhoneIcon />
                                                    {panel.contact}
                                                </span>
                                            )}
                                            {panel.sheet_id && (
                                                <a
                                                    href={`https://docs.google.com/spreadsheets/d/${panel.sheet_id}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="hospital-drive-link"
                                                >
                                                    <SheetIcon />
                                                    Google Sheet
                                                </a>
                                            )}
                                            {panel.drive_folder_id && (
                                                <a
                                                    href={`https://drive.google.com/drive/folders/${panel.drive_folder_id}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="hospital-drive-link"
                                                >
                                                    <FolderIcon />
                                                    Google Drive
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                {/* Stats badges */}
                                <div className="header-stats">
                                    <div className="stat-badge patients">
                                        <UsersIcon />
                                        <span>{patients.length} Patient{patients.length !== 1 ? "s" : ""}</span>
                                    </div>
                                    <div className="stat-badge admitted">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                            <polyline points="22 4 12 14.01 9 11.01" />
                                        </svg>
                                        <span>{admittedCount} Admitted</span>
                                    </div>
                                </div>
                            </>
                        )
                    )}
                </div>
            </header>

            {/* Main Content */}
            <main className="page-content">
                <div className="content-card">
                    {/* Header */}
                    <div className="section-header panel-patients">
                        <div className="section-title">
                            <UsersIcon />
                            <h3>Patients</h3>
                            <span className="section-count">{filteredPatients.length}</span>
                        </div>
                        {canAddPatient && (
                            <button className="btn-add-patient" onClick={() => setShowAddModal(true)}>
                                <PlusIcon />
                                New Patient
                            </button>
                        )}
                    </div>

                    {/* Toolbar */}
                    <div className="toolbar">
                        <div className="filter-tabs">
                            <button
                                className={`filter-tab ${statusFilter === "all" ? "active" : ""}`}
                                onClick={() => setStatusFilter("all")}
                            >
                                All ({patients.length})
                            </button>
                            <button
                                className={`filter-tab ${statusFilter === "active" ? "active" : ""}`}
                                onClick={() => setStatusFilter("active")}
                            >
                                Active ({activeCount})
                            </button>
                            <button
                                className={`filter-tab ${statusFilter === "admitted" ? "active" : ""}`}
                                onClick={() => setStatusFilter("admitted")}
                            >
                                Admitted ({admittedCount})
                            </button>
                            <button
                                className={`filter-tab ${statusFilter === "discharged" ? "active" : ""}`}
                                onClick={() => setStatusFilter("discharged")}
                            >
                                Discharged ({patients.length - admittedCount})
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

                    {/* Table */}
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
                                        <th>Generate PDF</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredPatients.length === 0 ? (
                                        <tr>
                                            <td colSpan={6} className="empty-state">
                                                <div className="empty-content">
                                                    <EmptyPatientIcon />
                                                    <span>No patients found</span>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : (
                                        filteredPatients.map((patient) => (
                                            <PatientRow
                                                key={patient.id}
                                                patient={patient}
                                                onClick={() => setSelectedPatientForPhotos(patient)}
                                                onDischarge={() => handleDischarge(patient.id)}
                                                canDischarge={canDischargePatient(patient)}
                                                isDischarging={dischargingId === patient.id}
                                                onToggleActive={() => handleToggleActive(patient)}
                                                canToggleActive={canToggleActiveStatus(patient)}
                                                isTogglingActive={togglingActiveId === patient.id}
                                            />
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </main>

            {/* Add Patient Modal */}
            {showAddModal && panel && (
                <AddPatientModal
                    selectedPanel={panel}
                    newPatient={newPatient}
                    isSubmitting={isSubmitting}
                    onClose={() => setShowAddModal(false)}
                    onSubmit={handleAddPatientSubmit}
                    onPatientChange={handlePatientChange}
                />
            )}

            {/* Patient Photos Modal */}
            {selectedPatientForPhotos && (
                <PatientPhotosModal
                    patient={selectedPatientForPhotos}
                    onClose={() => setSelectedPatientForPhotos(null)}
                    onUpdate={
                        user?.role === "admin" || user?.role === "superadmin" ? handlePatientUpdate : undefined
                    }
                />
            )}
        </div>
    );
};

export default PanelPatientsPage;
