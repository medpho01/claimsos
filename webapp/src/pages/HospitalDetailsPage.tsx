import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import apiService from "../services/api";
import { User, Patient } from "../types";
import "../styles/SuperAdmin.css";

const HospitalDetailsPage: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const [hospital, setHospital] = useState<User | null>(null);
    const [patients, setPatients] = useState<Patient[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [dischargingId, setDischargingId] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<'all' | 'admitted' | 'discharged'>('all');

    useEffect(() => {
        const fetchData = async () => {
            try {
                setLoading(true);
                const [hospitalsRes, patientsRes] = await Promise.all([
                    apiService.getAllHospitalUsers(),
                    apiService.getAllPatients()
                ]);

                const foundHospital = hospitalsRes.data.data.find((h: User) => h.id === hospitalId);
                setHospital(foundHospital || null);

                const hospitalPatients = patientsRes.data.data.filter((p: any) => p.hospital_id === hospitalId);
                setPatients(hospitalPatients);

            } catch (err) {
                console.error("Failed to load hospital details", err);
            } finally {
                setLoading(false);
            }
        };

        if (hospitalId) {
            fetchData();
        }
    }, [hospitalId]);

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

    const admittedCount = patients.filter(p => !p.discharged_at).length;
    const dischargedCount = patients.filter(p => p.discharged_at).length;

    const filteredPatients = patients.filter(patient => {
        const matchesSearch = patient.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.phone.includes(searchTerm);

        if (statusFilter === 'admitted') return matchesSearch && !patient.discharged_at;
        if (statusFilter === 'discharged') return matchesSearch && patient.discharged_at;
        return matchesSearch;
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
                    <button onClick={() => navigate('/superadmin')} className="back-button">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M19 12H5M12 19l-7-7 7-7" />
                        </svg>
                        Back
                    </button>
                    {!loading && hospital && (
                        <div className="header-info">
                            <div className="hospital-avatar">
                                {getInitials(hospital.first_name, hospital.last_name)}
                            </div>
                            <div className="hospital-meta">
                                <h1>{hospital.first_name} {hospital.last_name}</h1>
                                <span className="hospital-username">@{hospital.username}</span>
                            </div>
                        </div>
                    )}
                </div>
            </header>

            {/* Stats Cards */}
            <div className="stats-row">
                <div className="stat-card-mini">
                    <div className="stat-icon-mini" style={{ background: '#e0f2fe', color: '#0284c7' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                            <circle cx="9" cy="7" r="4" />
                        </svg>
                    </div>
                    <div className="stat-info">
                        <span className="stat-number">{patients.length}</span>
                        <span className="stat-label">Total Patients</span>
                    </div>
                </div>
                <div className="stat-card-mini">
                    <div className="stat-icon-mini" style={{ background: '#dcfce7', color: '#16a34a' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                        </svg>
                    </div>
                    <div className="stat-info">
                        <span className="stat-number">{admittedCount}</span>
                        <span className="stat-label">Admitted</span>
                    </div>
                </div>
                <div className="stat-card-mini">
                    <div className="stat-icon-mini" style={{ background: '#fef3c7', color: '#d97706' }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                            <polyline points="16 17 21 12 16 7" />
                            <line x1="21" y1="12" x2="9" y2="12" />
                        </svg>
                    </div>
                    <div className="stat-info">
                        <span className="stat-number">{dischargedCount}</span>
                        <span className="stat-label">Discharged</span>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <main className="page-content">
                <div className="content-card">
                    {/* Toolbar */}
                    <div className="toolbar">
                        <div className="filter-tabs">
                            <button
                                className={`filter-tab ${statusFilter === 'all' ? 'active' : ''}`}
                                onClick={() => setStatusFilter('all')}
                            >
                                All ({patients.length})
                            </button>
                            <button
                                className={`filter-tab ${statusFilter === 'admitted' ? 'active' : ''}`}
                                onClick={() => setStatusFilter('admitted')}
                            >
                                Admitted ({admittedCount})
                            </button>
                            <button
                                className={`filter-tab ${statusFilter === 'discharged' ? 'active' : ''}`}
                                onClick={() => setStatusFilter('discharged')}
                            >
                                Discharged ({dischargedCount})
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
                        <div className="loading-state">
                            <div className="loading-spinner"></div>
                            <span>Loading patients...</span>
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
                                        <th style={{ textAlign: 'right' }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredPatients.length === 0 ? (
                                        <tr>
                                            <td colSpan={5} className="empty-state">
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
                                            <tr key={patient.id}>
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
                                                    {patient.admission_type && (
                                                        <span className={`type-pill ${patient.admission_type}`}>
                                                            {patient.admission_type}
                                                        </span>
                                                    )}
                                                </td>
                                                <td>
                                                    <span className={`status-pill ${!patient.discharged_at ? 'active' : 'discharged'}`}>
                                                        {!patient.discharged_at ? 'Admitted' : 'Discharged'}
                                                    </span>
                                                </td>
                                                <td style={{ textAlign: 'right' }}>
                                                    {!patient.discharged_at ? (
                                                        <button
                                                            onClick={() => handleDischarge(patient.id)}
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

                .filter-tabs {
                    display: flex;
                    gap: 0.5rem;
                }

                .filter-tab {
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
