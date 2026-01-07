import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import apiService from "../services/api";
import { Patient } from "../types";
import PatientModal from "../components/PatientModal";
import "../styles/Dashboard.css";

const DashboardPage: React.FC = () => {
    const [patients, setPatients] = useState<Patient[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [searchTerm, setSearchTerm] = useState("");
    const [showAddModal, setShowAddModal] = useState(false);
    const [editingPatient, setEditingPatient] = useState<Patient | null>(null);
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'discharged'>('all');

    const { user, logout } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        fetchPatients();
    }, []);

    const fetchPatients = async () => {
        try {
            setLoading(true);
            const response = await apiService.getAllPatients();
            setPatients(response.data.data);
            setError("");
        } catch (err: any) {
            setError("Failed to load patients");
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const handleDischarge = async (patient: Patient) => {
        if (!window.confirm(`Discharge ${patient.first_name} ${patient.last_name}?`)) {
            return;
        }

        try {
            await apiService.dischargePatient(patient.id, new Date().toISOString());
            await fetchPatients();
        } catch (err) {
            alert("Failed to discharge patient");
        }
    };

    const handleDelete = async (patient: Patient) => {
        if (!window.confirm(`Delete ${patient.first_name} ${patient.last_name}? This cannot be undone.`)) {
            return;
        }

        try {
            await apiService.deletePatient(patient.id);
            await fetchPatients();
        } catch (err) {
            alert("Failed to delete patient");
        }
    };

    const getInitials = (firstName: string, lastName: string) => {
        const first = firstName?.charAt(0) || '';
        const last = lastName?.charAt(0) || '';
        return `${first}${last}`.toUpperCase();
    };

    const filteredPatients = patients.filter((p) => {
        const matchesSearch =
            p.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.phone.includes(searchTerm);

        const matchesStatus =
            statusFilter === 'all' ||
            (statusFilter === 'active' && !p.discharged_at) ||
            (statusFilter === 'discharged' && p.discharged_at);

        return matchesSearch && matchesStatus;
    });

    const activeCount = patients.filter(p => !p.discharged_at).length;
    const dischargedCount = patients.filter(p => p.discharged_at).length;

    return (
        <div className="admin-layout">
            {/* Sidebar */}
            <aside className="sidebar">
                <div className="sidebar-header">
                    <div className="sidebar-logo">
                        <div className="logo-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                            </svg>
                        </div>
                        <div className="logo-text">
                            <span className="logo-title">Hospital Admin</span>
                            <span className="logo-subtitle">Patient Management</span>
                        </div>
                    </div>
                </div>

                <nav className="sidebar-nav">
                    <div className="nav-section">
                        <span className="nav-label">Overview</span>
                        <a href="#" className="nav-item active">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                            </svg>
                            Patients
                            <span className="nav-badge">{patients.length}</span>
                        </a>
                    </div>

                    <div className="nav-section">
                        <span className="nav-label">Quick Filters</span>
                        <a href="#" className={`nav-item ${statusFilter === 'active' ? 'filter-active' : ''}`} onClick={() => setStatusFilter(statusFilter === 'active' ? 'all' : 'active')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                                <polyline points="22,4 12,14.01 9,11.01" />
                            </svg>
                            Active Patients
                            <span className="nav-badge">{activeCount}</span>
                        </a>
                        <a href="#" className={`nav-item ${statusFilter === 'discharged' ? 'filter-active' : ''}`} onClick={() => setStatusFilter(statusFilter === 'discharged' ? 'all' : 'discharged')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            Discharged
                            <span className="nav-badge">{dischargedCount}</span>
                        </a>
                    </div>
                </nav>

                <div className="sidebar-footer">
                    <div className="user-card">
                        <div className="user-avatar">
                            {user && getInitials(user.first_name, user.last_name)}
                        </div>
                        <div className="user-info">
                            <span className="user-name">{user?.first_name} {user?.last_name}</span>
                            <span className="user-role-badge">{user?.role}</span>
                        </div>
                        <button className="btn-logout" onClick={handleLogout} title="Logout">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                                <polyline points="16,17 21,12 16,7" />
                                <line x1="21" y1="12" x2="9" y2="12" />
                            </svg>
                        </button>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="main-content">
                <header className="content-header">
                    <div className="header-title">
                        <h1>Patient Dashboard</h1>
                        <p className="header-subtitle">Welcome back, {user?.first_name}! Manage your patients here.</p>
                    </div>
                    <button onClick={() => setShowAddModal(true)} className="btn-add-patient">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add Patient
                    </button>
                </header>

                {/* Stats Grid */}
                <div className="stats-grid">
                    <div className="stat-card stat-blue">
                        <div className="stat-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                            </svg>
                        </div>
                        <div className="stat-content">
                            <span className="stat-label">Total Patients</span>
                            <span className="stat-value">{patients.length}</span>
                        </div>
                    </div>
                    <div className="stat-card stat-green">
                        <div className="stat-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                                <polyline points="22,4 12,14.01 9,11.01" />
                            </svg>
                        </div>
                        <div className="stat-content">
                            <span className="stat-label">Active</span>
                            <span className="stat-value">{activeCount}</span>
                        </div>
                    </div>
                    <div className="stat-card stat-orange">
                        <div className="stat-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                        </div>
                        <div className="stat-content">
                            <span className="stat-label">Discharged</span>
                            <span className="stat-value">{dischargedCount}</span>
                        </div>
                    </div>
                </div>

                {/* Search Bar */}
                <div className="search-container">
                    <div className="search-wrapper">
                        <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <path d="M21 21l-4.35-4.35" />
                        </svg>
                        <input
                            type="text"
                            placeholder="Search patients by name or phone..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="search-input"
                        />
                        {searchTerm && (
                            <button className="search-clear" onClick={() => setSearchTerm("")}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        )}
                    </div>
                    <div className="filter-pills">
                        <button
                            className={`filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
                            onClick={() => setStatusFilter('all')}
                        >
                            All
                        </button>
                        <button
                            className={`filter-pill ${statusFilter === 'active' ? 'active' : ''}`}
                            onClick={() => setStatusFilter('active')}
                        >
                            Active
                        </button>
                        <button
                            className={`filter-pill ${statusFilter === 'discharged' ? 'active' : ''}`}
                            onClick={() => setStatusFilter('discharged')}
                        >
                            Discharged
                        </button>
                    </div>
                </div>

                {/* Patient Grid */}
                {loading ? (
                    <div className="loading-state">
                        <div className="loading-spinner"></div>
                        <span>Loading patients...</span>
                    </div>
                ) : error ? (
                    <div className="error-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                        <span>{error}</span>
                        <button onClick={fetchPatients} className="btn-retry">Try Again</button>
                    </div>
                ) : filteredPatients.length === 0 ? (
                    <div className="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                            <circle cx="9" cy="7" r="4" />
                            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                        </svg>
                        <span>No patients found</span>
                        {searchTerm && <p>Try adjusting your search or filters</p>}
                    </div>
                ) : (
                    <div className="patients-grid">
                        {filteredPatients.map((patient) => (
                            <div key={patient.id} className={`patient-card ${patient.discharged_at ? 'discharged' : ''}`}>
                                <div className="patient-header">
                                    <div className="patient-avatar">
                                        {getInitials(patient.first_name, patient.last_name)}
                                    </div>
                                    <div className="patient-status">
                                        {patient.discharged_at ? (
                                            <span className="status-tag discharged">
                                                <span className="status-dot"></span>
                                                Discharged
                                            </span>
                                        ) : (
                                            <span className="status-tag active">
                                                <span className="status-dot"></span>
                                                Active
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="patient-info">
                                    <h3 className="patient-name">
                                        {patient.first_name} {patient.last_name}
                                    </h3>
                                    <div className="patient-meta">
                                        <div className="meta-item">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z" />
                                            </svg>
                                            <span>{patient.phone}</span>
                                        </div>
                                        <div className="meta-item">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                                                <line x1="16" y1="2" x2="16" y2="6" />
                                                <line x1="8" y1="2" x2="8" y2="6" />
                                                <line x1="3" y1="10" x2="21" y2="10" />
                                            </svg>
                                            <span>{new Date(patient.admitted_at).toLocaleDateString()}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="patient-actions">
                                    <button
                                        onClick={() => setEditingPatient(patient)}
                                        className="btn-card-action btn-edit"
                                        title="Edit"
                                    >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                                        </svg>
                                    </button>
                                    {!patient.discharged_at && (
                                        <button
                                            onClick={() => handleDischarge(patient)}
                                            className="btn-card-action btn-discharge"
                                            title="Discharge"
                                        >
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                                                <polyline points="22,4 12,14.01 9,11.01" />
                                            </svg>
                                        </button>
                                    )}
                                    <button
                                        onClick={() => handleDelete(patient)}
                                        className="btn-card-action btn-delete"
                                        title="Delete"
                                    >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <polyline points="3,6 5,6 21,6" />
                                            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                            <line x1="10" y1="11" x2="10" y2="17" />
                                            <line x1="14" y1="11" x2="14" y2="17" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </main>

            {(showAddModal || editingPatient) && (
                <PatientModal
                    patient={editingPatient}
                    onClose={() => {
                        setShowAddModal(false);
                        setEditingPatient(null);
                    }}
                    onSuccess={() => {
                        fetchPatients();
                        setShowAddModal(false);
                        setEditingPatient(null);
                    }}
                />
            )}
        </div>
    );
};

export default DashboardPage;
