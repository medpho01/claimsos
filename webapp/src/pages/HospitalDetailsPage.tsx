import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import apiService from "../services/api";
import { User, Patient } from "../types";
import "../styles/SuperAdmin.css";
import PatientPhotosModal from "../components/PatientPhotosModal";
import { TableRowSkeleton, StatsCardSkeleton, Skeleton } from "../components/Skeleton";

import { useAuth } from "../context/AuthContext";

const HospitalDetailsPage: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();
    const [hospital, setHospital] = useState<User | null>(null);
    const [patients, setPatients] = useState<Patient[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [dischargingId, setDischargingId] = useState<string | null>(null);
    const [togglingActiveId, setTogglingActiveId] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<'all' | 'admitted' | 'discharged'>('all');
    const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>('all');
    const [showAddModal, setShowAddModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [newPatient, setNewPatient] = useState({
        firstName: '',
        lastName: '',
        phone: '',
        admissionType: '' as 'conservative' | 'surgical' | ''
    });
    const [selectedPatientForPhotos, setSelectedPatientForPhotos] = useState<Patient | null>(null);

    useEffect(() => {
        const fetchData = async () => {
            if (!user?.id) return;
            try {
                setLoading(true);

                if (user.role === 'admin') {
                    // Admin logic: get assigned hospitals to check permission and details
                    const hospitalsRes = await apiService.getAdminHospitals(user.id);
                    const foundHospital = hospitalsRes.data.data.find((h: any) => h.id === hospitalId);

                    if (!foundHospital) {
                        alert("Unauthorized or Hospital Not Found");
                        navigate('/dashboard');
                        return;
                    }

                    if (!foundHospital.can_view) {
                        alert("You do not have permission to view this hospital");
                        navigate('/dashboard');
                        return;
                    }

                    setHospital(foundHospital);

                    // Get patients data. Optimally, backend should support filtering by hospitalId for admin
                    // But current plan relies on getAllPatients and filtering (admin gets all their patients)
                    const patientsRes = await apiService.getAdminPatients(user.id);
                    // Filter specifically for this hospital
                    const hospitalPatients = patientsRes.data.data.filter((p: any) => p.hospital_id === hospitalId);
                    setPatients(hospitalPatients);

                } else {
                    // Superadmin logic
                    const [hospitalsRes, patientsRes] = await Promise.all([
                        apiService.getAllHospitalUsers(),
                        apiService.getAllPatients()
                    ]);

                    const foundHospital = hospitalsRes.data.data.find((h: User) => h.id === hospitalId);
                    setHospital(foundHospital || null);

                    const hospitalPatients = patientsRes.data.data.filter((p: any) => p.hospital_id === hospitalId);
                    setPatients(hospitalPatients);
                }

            } catch (err) {
                console.error("Failed to load hospital details", err);
            } finally {
                setLoading(false);
            }
        };

        if (hospitalId) {
            fetchData();
        }
    }, [hospitalId, user, navigate]);

    const handleDischarge = async (patientId: string) => {
        if (!window.confirm("Are you sure you want to discharge this patient?")) return;

        try {
            setDischargingId(patientId);
            const dischargeDate = new Date().toISOString();
            await apiService.dischargePatient(patientId, dischargeDate);

            setPatients(prev => prev.map(p =>
                p.id === patientId
                    ? { ...p, discharged_at: dischargeDate }
                    : p
            ));
        } catch (err) {
            console.error("Failed to discharge patient", err);
            alert("Failed to discharge patient");
        } finally {
            setDischargingId(null);
        }
    };

    const handleTypeChange = async (patient: Patient, type: 'conservative' | 'surgical') => {
        try {
            // Optimistically update UI
            setPatients(prev => prev.map(p =>
                p.id === patient.id ? { ...p, admission_type: type } : p
            ));

            await apiService.updatePatient(patient.id, {
                firstName: patient.first_name,
                lastName: patient.last_name,
                phone: patient.phone,
                admittedAt: patient.admitted_at,
                admissionType: type
            });
        } catch (err) {
            console.error("Failed to update admission type", err);
            // Revert changes on error
            setPatients(prev => prev.map(p =>
                p.id === patient.id ? { ...p, admission_type: patient.admission_type } : p
            ));
            alert("Failed to update admission type");
        }
    };

    const handleToggleActive = async (patient: Patient) => {
        try {
            const newActiveStatus = !patient.is_active;
            setTogglingActiveId(patient.id);

            // Optimistically update UI
            setPatients(prev => prev.map(p =>
                p.id === patient.id ? { ...p, is_active: newActiveStatus } : p
            ));

            await apiService.togglePatientActiveStatus(patient.id, newActiveStatus);
        } catch (err) {
            console.error("Failed to toggle patient active status", err);
            // Revert on error
            setPatients(prev => prev.map(p =>
                p.id === patient.id ? { ...p, is_active: patient.is_active } : p
            ));
            alert("Failed to update patient status");
        } finally {
            setTogglingActiveId(null);
        }
    };

    const handleAddPatient = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newPatient.firstName || !newPatient.phone || !hospitalId) return;

        try {
            setIsSubmitting(true);
            const response = await apiService.addPatient({
                firstName: newPatient.firstName,
                lastName: newPatient.lastName,
                phone: newPatient.phone,
                hospitalId: hospitalId,
                admissionType: newPatient.admissionType || undefined
            });

            // Add to local state
            const addedPatient = response.data.data;
            setPatients(prev => [addedPatient, ...prev]);

            // Reset form and close modal
            setNewPatient({ firstName: '', lastName: '', phone: '', admissionType: '' });
            setShowAddModal(false);
        } catch (err: any) {
            console.error("Failed to add patient", err);
            alert(err.response?.data?.message || "Failed to add patient");
        } finally {
            setIsSubmitting(false);
        }
    };

    const admittedCount = patients.filter(p => !p.discharged_at).length;
    const dischargedCount = patients.filter(p => p.discharged_at).length;
    const activeCount = patients.filter(p => p.is_active !== false).length;
    const inactiveCount = patients.filter(p => p.is_active === false).length;

    const filteredPatients = patients.filter(patient => {
        const matchesSearch = patient.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.phone.includes(searchTerm);

        let matchesStatus = true;
        if (statusFilter === 'admitted') matchesStatus = !patient.discharged_at;
        if (statusFilter === 'discharged') matchesStatus = !!patient.discharged_at;

        let matchesActive = true;
        if (activeFilter === 'active') matchesActive = patient.is_active !== false;
        if (activeFilter === 'inactive') matchesActive = patient.is_active === false;

        return matchesSearch && matchesStatus && matchesActive;
    });

    const getInitials = (firstName: string, lastName: string) => {
        return `${firstName?.charAt(0) || ''}${lastName?.charAt(0) || ''}`.toUpperCase();
    };

    const formatDate = (dateString?: string) => {
        if (!dateString) return "—";
        return new Date(dateString).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });
    };

    return (
        <div className="hospital-details-page">
            {/* Header */}
            <header className="page-header">
                <div className="header-content">
                    <button onClick={() => navigate(user?.role === 'admin' ? '/dashboard' : '/superadmin')} className="back-button">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M19 12H5M12 19l-7-7 7-7" />
                        </svg>
                        Back
                    </button>
                    {!loading && hospital && (
                        <>
                            <div className="header-info">
                                <div className="hospital-avatar">
                                    {getInitials(hospital.first_name, hospital.last_name)}
                                </div>
                                <div className="hospital-meta">
                                    <h1>{hospital.first_name} {hospital.last_name}</h1>
                                    <span className="hospital-username">{hospital.username}</span>
                                </div>
                            </div>
                            {(user?.role === 'superadmin' || (user?.role === 'admin' && (hospital as any).can_edit)) && (
                                <button className="btn-add-patient" onClick={() => setShowAddModal(true)}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M12 5v14M5 12h14" />
                                    </svg>
                                    New Patient
                                </button>
                            )}
                        </>
                    )}
                </div>
            </header>

            {/* Main Content */}
            <main className="page-content">
                <div className="content-card">
                    {/* Toolbar */}
                    <div className="toolbar">
                        <div className="filter-tabs">
                            <button
                                className={`filter-tab ${statusFilter === 'all' && activeFilter === 'all' ? 'active' : ''}`}
                                onClick={() => { setStatusFilter('all'); setActiveFilter('all'); }}
                            >
                                All ({patients.length})
                            </button>
                            <button
                                className={`filter-tab ${statusFilter === 'admitted' ? 'active' : ''}`}
                                onClick={() => { setStatusFilter('admitted'); setActiveFilter('all'); }}
                            >
                                Admitted ({admittedCount})
                            </button>
                            <button
                                className={`filter-tab ${statusFilter === 'discharged' ? 'active' : ''}`}
                                onClick={() => { setStatusFilter('discharged'); setActiveFilter('all'); }}
                            >
                                Discharged ({dischargedCount})
                            </button>
                            <button
                                className={`filter-tab ${activeFilter === 'active' && statusFilter === 'all' ? 'active' : ''}`}
                                onClick={() => { setActiveFilter('active'); setStatusFilter('all'); }}
                            >
                                <span className="active-indicator"></span>
                                Active ({activeCount})
                            </button>
                        </div>
                        <div className="search-box">
                            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="11" cy="11" r="8" />
                                <path d="M21 21l-4.35-4.35" />
                            </svg>
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
                                        <th>Active</th>
                                        <th style={{ textAlign: 'right' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...Array(5)].map((_, i) => (
                                        <TableRowSkeleton key={i} columns={7} />
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
                                        <th>Active</th>
                                        <th style={{ textAlign: 'right' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredPatients.length === 0 ? (
                                        <tr>
                                            <td colSpan={7} className="empty-state">
                                                <div className="empty-content">
                                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4 }}>
                                                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                                        <circle cx="9" cy="7" r="4" />
                                                        <line x1="23" y1="11" x2="17" y2="11" />
                                                    </svg>
                                                    <span>No patients found</span>
                                                </div>
                                            </td>
                                        </tr>
                                    ) : (
                                        filteredPatients.map((patient) => (
                                            <tr
                                                key={patient.id}
                                                className="clickable-row"
                                                onClick={() => setSelectedPatientForPhotos(patient)}
                                            >
                                                <td>
                                                    <div className="user-cell">
                                                        <div className="patient-avatar">
                                                            {getInitials(patient.first_name, patient.last_name)}
                                                        </div>
                                                        <div className="user-details">
                                                            <span className="user-name-cell">{patient.first_name} {patient.last_name}</span>
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
                                                    {!patient.discharged_at ? (
                                                        <select
                                                            className={`type-select ${patient.admission_type || ''}`}
                                                            value={patient.admission_type || ''}
                                                            onChange={(e) => handleTypeChange(patient, e.target.value as 'conservative' | 'surgical')}
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <option value="">Select Type</option>
                                                            <option value="conservative">Conservative</option>
                                                            <option value="surgical">Surgical</option>
                                                        </select>
                                                    ) : (
                                                        patient.admission_type && (
                                                            <span className={`type-pill ${patient.admission_type}`}>
                                                                {patient.admission_type}
                                                            </span>
                                                        )
                                                    )}
                                                </td>
                                                <td>
                                                    <span className={`status-pill ${!patient.discharged_at ? 'active' : 'discharged'}`}>
                                                        {!patient.discharged_at ? 'Admitted' : 'Discharged'}
                                                    </span>
                                                </td>
                                                <td>
                                                    <button
                                                        className={`toggle-switch ${patient.is_active !== false ? 'on' : 'off'}`}
                                                        onClick={(e) => { e.stopPropagation(); handleToggleActive(patient); }}
                                                        disabled={togglingActiveId === patient.id}
                                                        title={patient.is_active !== false ? 'Click to deactivate' : 'Click to activate'}
                                                    >
                                                        <span className="toggle-slider"></span>
                                                    </button>
                                                </td>
                                                <td style={{ textAlign: 'right' }}>
                                                    {!patient.discharged_at ? (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleDischarge(patient.id); }}
                                                            className="discharge-btn"
                                                            disabled={dischargingId === patient.id}
                                                        >
                                                            {dischargingId === patient.id ? (
                                                                <span className="loading-dots">Processing</span>
                                                            ) : (
                                                                <>
                                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                                                        <polyline points="16 17 21 12 16 7" />
                                                                        <line x1="21" y1="12" x2="9" y2="12" />
                                                                    </svg>
                                                                    Discharge
                                                                </>
                                                            )}
                                                        </button>
                                                    ) : (
                                                        <span className="discharged-date">{formatDate(patient.discharged_at)}</span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </main>

            {/* Add Patient Modal */}
            {showAddModal && (
                <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2>Add New Patient</h2>
                            <button className="modal-close" onClick={() => setShowAddModal(false)}>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <form onSubmit={handleAddPatient} className="modal-form">
                            <div className="form-group">
                                <label>First Name *</label>
                                <input
                                    type="text"
                                    value={newPatient.firstName}
                                    onChange={(e) => setNewPatient({ ...newPatient, firstName: e.target.value })}
                                    required
                                    placeholder="Enter first name"
                                />
                            </div>
                            <div className="form-group">
                                <label>Last Name</label>
                                <input
                                    type="text"
                                    value={newPatient.lastName}
                                    onChange={(e) => setNewPatient({ ...newPatient, lastName: e.target.value })}
                                    placeholder="Enter last name"
                                />
                            </div>
                            <div className="form-group">
                                <label>Phone *</label>
                                <input
                                    type="tel"
                                    value={newPatient.phone}
                                    onChange={(e) => setNewPatient({ ...newPatient, phone: e.target.value })}
                                    required
                                    placeholder="Enter phone number"
                                />
                            </div>
                            <div className="form-group">
                                <label>Admission Type</label>
                                <select
                                    value={newPatient.admissionType}
                                    onChange={(e) => setNewPatient({ ...newPatient, admissionType: e.target.value as 'conservative' | 'surgical' | '' })}
                                >
                                    <option value="">Select Type</option>
                                    <option value="conservative">Conservative</option>
                                    <option value="surgical">Surgical</option>
                                </select>
                            </div>
                            <div className="modal-actions">
                                <button type="button" onClick={() => setShowAddModal(false)} className="btn-cancel">
                                    Cancel
                                </button>
                                <button type="submit" disabled={isSubmitting} className="btn-submit">
                                    {isSubmitting ? 'Adding...' : 'Add Patient'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Patient Photos Modal */}
            {selectedPatientForPhotos && (
                <PatientPhotosModal
                    patient={selectedPatientForPhotos}
                    onClose={() => setSelectedPatientForPhotos(null)}
                />
            )}

            <style>{`
                .hospital-details-page {
                    min-height: 100vh;
                    background: #f8fafc;
                }

                .page-header {
                    background: white;
                    border-bottom: 1px solid #e2e8f0;
                    padding: 1rem 2rem;
                    position: sticky;
                    top: 0;
                    z-index: 10;
                }

                .header-content {
                    max-width: 1400px;
                    margin: 0 auto;
                    display: flex;
                    align-items: center;
                    gap: 2rem;
                }

                .back-button {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.5rem 1rem;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    background: white;
                    color: #64748b;
                    font-size: 0.875rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .back-button:hover {
                    background: #f8fafc;
                    color: #0f172a;
                    border-color: #cbd5e1;
                }

                .header-info {
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                }

                .hospital-avatar {
                    width: 48px;
                    height: 48px;
                    border-radius: 12px;
                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.125rem;
                    font-weight: 600;
                }

                .hospital-meta h1 {
                    font-size: 1.25rem;
                    font-weight: 600;
                    color: #0f172a;
                    margin: 0;
                }

                .hospital-username {
                    font-size: 0.875rem;
                    color: #64748b;
                }

                .stats-row {
                    max-width: 1400px;
                    margin: 1.5rem auto;
                    padding: 0 2rem;
                    display: grid;
                    grid-template-columns: repeat(3, 1fr);
                    gap: 1rem;
                }

                .stat-card-mini {
                    background: white;
                    border-radius: 12px;
                    padding: 1.25rem;
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                    border: 1px solid #e2e8f0;
                }

                .stat-icon-mini {
                    width: 44px;
                    height: 44px;
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .stat-info {
                    display: flex;
                    flex-direction: column;
                }

                .stat-number {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: #0f172a;
                    line-height: 1;
                }

                .stat-label {
                    font-size: 0.8125rem;
                    color: #64748b;
                    margin-top: 2px;
                }

                .page-content {
                    max-width: 1400px;
                    margin: 0 auto;
                    padding: 0 2rem 2rem;
                }

                .content-card {
                    background: white;
                    border-radius: 12px;
                    border: 1px solid #e2e8f0;
                    overflow: hidden;
                }

                .toolbar {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 1rem 1.5rem;
                    border-bottom: 1px solid #e2e8f0;
                    gap: 1rem;
                    flex-wrap: wrap;
                }

                .filter-groups {
                    display: flex;
                    flex-direction: column;
                    gap: 0.75rem;
                }

                .filter-tabs {
                    display: flex;
                    gap: 0.5rem;
                }

                .filter-tabs.secondary {
                    border-left: 3px solid #e2e8f0;
                    padding-left: 1rem;
                }

                .filter-tab {
                    display: flex;
                    align-items: center;
                    gap: 0.375rem;
                    padding: 0.5rem 1rem;
                    border: none;
                    background: transparent;
                    color: #64748b;
                    font-size: 0.875rem;
                    font-weight: 500;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .filter-tab:hover {
                    background: #f1f5f9;
                    color: #0f172a;
                }

                .filter-tab.active {
                    background: #0f172a;
                    color: white;
                }

                .active-indicator {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #22c55e;
                }

                .inactive-indicator {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #94a3b8;
                }

                .filter-tab.active .active-indicator {
                    background: #86efac;
                }

                .filter-tab.active .inactive-indicator {
                    background: #cbd5e1;
                }

                .search-box {
                    position: relative;
                }

                .search-box .search-icon {
                    position: absolute;
                    left: 12px;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 18px;
                    height: 18px;
                    color: #94a3b8;
                }

                .search-box input {
                    padding: 0.625rem 1rem 0.625rem 2.5rem;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    font-size: 0.875rem;
                    min-width: 280px;
                    outline: none;
                    transition: all 0.2s;
                }

                .search-box input:focus {
                    border-color: #2563eb;
                    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
                }

                .patient-avatar {
                    width: 36px;
                    height: 36px;
                    border-radius: 8px;
                    background: #e0f2fe;
                    color: #0284c7;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 0.8125rem;
                    font-weight: 600;
                }

                .phone-number {
                    font-family: 'JetBrains Mono', monospace;
                    font-size: 0.8125rem;
                    color: #64748b;
                }

                .date-text {
                    font-size: 0.875rem;
                    color: #64748b;
                }

                .status-pill {
                    display: inline-flex;
                    padding: 0.25rem 0.75rem;
                    border-radius: 999px;
                    font-size: 0.75rem;
                    font-weight: 600;
                }

                .status-pill.active {
                    background: #dcfce7;
                    color: #16a34a;
                }

                .status-pill.discharged {
                    background: #f1f5f9;
                    color: #64748b;
                }

                .type-pill {
                    display: inline-flex;
                    padding: 0.125rem 0.625rem;
                    border-radius: 6px;
                    font-size: 0.75rem;
                    font-weight: 500;
                    text-transform: capitalize;
                }

                .type-pill.conservative {
                    background: #fef9c3;
                    color: #a16207;
                    border: 1px solid #fde047;
                }

                .type-pill.surgical {
                    background: #fee2e2;
                    color: #b91c1c;
                    border: 1px solid #fca5a5;
                }

                .type-select {
                    padding: 0.25rem 0.5rem;
                    border-radius: 6px;
                    border: 1px solid #e2e8f0;
                    font-size: 0.75rem;
                    font-weight: 500;
                    outline: none;
                    cursor: pointer;
                    background-color: white;
                    color: #475569;
                    transition: all 0.2s;
                }

                .type-select:hover {
                    border-color: #cbd5e1;
                }

                .type-select:focus {
                    border-color: #3b82f6;
                    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
                }

                .type-select.conservative {
                    background: #fef9c3;
                    color: #a16207;
                    border-color: #fde047;
                }

                .type-select.surgical {
                    background: #fee2e2;
                    color: #b91c1c;
                    border-color: #fca5a5;
                }

                .discharge-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.5rem 1rem;
                    border: 1px solid #fecaca;
                    background: #fef2f2;
                    color: #dc2626;
                    font-size: 0.8125rem;
                    font-weight: 500;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .discharge-btn:hover:not(:disabled) {
                    background: #fee2e2;
                    border-color: #fca5a5;
                }

                .discharge-btn:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }

                .clickable-row {
                    cursor: pointer;
                    transition: background-color 0.15s ease;
                }

                .clickable-row:hover {
                    background-color: #f8fafc;
                }

                .clickable-row:active {
                    background-color: #f1f5f9;
                }

                .discharged-date {
                    font-size: 0.8125rem;
                    color: #94a3b8;
                }

                .loading-dots::after {
                    content: '';
                    animation: dots 1.5s steps(4, end) infinite;
                }

                @keyframes dots {
                    0%, 20% { content: ''; }
                    40% { content: '.'; }
                    60% { content: '..'; }
                    80%, 100% { content: '...'; }
                }

                /* Toggle Switch Styles */
                .toggle-switch {
                    position: relative;
                    width: 44px;
                    height: 24px;
                    border: none;
                    border-radius: 12px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    padding: 0;
                }

                .toggle-switch.on {
                    background: #22c55e;
                }

                .toggle-switch.off {
                    background: #cbd5e1;
                }

                .toggle-switch:hover:not(:disabled) {
                    opacity: 0.9;
                }

                .toggle-switch:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .toggle-slider {
                    position: absolute;
                    top: 2px;
                    width: 20px;
                    height: 20px;
                    background: white;
                    border-radius: 50%;
                    transition: all 0.3s ease;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
                }

                .toggle-switch.on .toggle-slider {
                    left: 22px;
                }

                .toggle-switch.off .toggle-slider {
                    left: 2px;
                }



                .btn-add-patient {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    padding: 0.5rem 1rem;
                    background: #eff6ff;
                    border: 1px solid #bfdbfe;
                    color: #2563eb;
                    border-radius: 8px;
                    font-size: 0.875rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    margin-left: auto;
                }

                .btn-add-patient:hover {
                    background: #dbeafe;
                    border-color: #93c5fd;
                    color: #1d4ed8;
                    transform: translateY(-1px);
                    box-shadow: 0 2px 8px rgba(37, 99, 235, 0.15);
                }

                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                    animation: fadeIn 0.2s ease;
                }

                @keyframes fadeIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }

                .modal-content {
                    background: white;
                    border-radius: 12px;
                    padding: 0;
                    width: 90%;
                    max-width: 500px;
                    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
                    animation: slideUp 0.3s ease;
                }

                @keyframes slideUp {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 1.5rem;
                    border-bottom: 1px solid #e2e8f0;
                }

                .modal-header h2 {
                    margin: 0;
                    font-size: 1.25rem;
                    font-weight: 600;
                    color: #0f172a;
                }

                .modal-close {
                    background: none;
                    border: none;
                    color: #64748b;
                    cursor: pointer;
                    padding: 0.25rem;
                    border-radius: 6px;
                    transition: all 0.2s;
                }

                .modal-close:hover {
                    background: #f1f5f9;
                    color: #0f172a;
                }

                .modal-form {
                    padding: 1.5rem;
                }

                .form-group {
                    margin-bottom: 1.25rem;
                }

                .form-group label {
                    display: block;
                    margin-bottom: 0.5rem;
                    font-size: 0.875rem;
                    font-weight: 500;
                    color: #374151;
                }

                .form-group input,
                .form-group select {
                    width: 100%;
                    padding: 0.625rem 0.875rem;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    font-size: 0.875rem;
                    outline: none;
                    transition: all 0.2s;
                }

                .form-group input:focus,
                .form-group select:focus {
                    border-color: #2563eb;
                    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
                }

                .modal-actions {
                    display: flex;
                    gap: 0.75rem;
                    justify-content: flex-end;
                    padding-top: 1rem;
                    border-top: 1px solid #f1f5f9;
                    margin-top: 1.5rem;
                }

                .btn-cancel {
                    padding: 0.625rem 1.25rem;
                    background: white;
                    border: 1px solid #e2e8f0;
                    color: #64748b;
                    border-radius: 8px;
                    font-size: 0.875rem;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .btn-cancel:hover {
                    background: #f8fafc;
                    border-color: #cbd5e1;
                    color: #0f172a;
                }

                .btn-submit {
                    padding: 0.625rem 1.25rem;
                    background: #2563eb;
                    border: none;
                    color: white;
                    border-radius: 8px;
                    font-size: 0.875rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .btn-submit:hover:not(:disabled) {
                    background: #1d4ed8;
                }

                .btn-submit:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }

                @media (max-width: 768px) {
                    .stats-row {
                        grid-template-columns: 1fr;
                    }

                    .toolbar {
                        flex-direction: column;
                        align-items: stretch;
                    }

                    .search-box input {
                        min-width: 100%;
                    }
                }
            `}</style>
        </div>
    );
};

export default HospitalDetailsPage;
