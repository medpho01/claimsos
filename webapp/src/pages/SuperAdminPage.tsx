import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import apiService from "../services/api";
import { User } from "../types";
import AssignmentModal from "../components/AssignmentModal";
import AddUserModal from "../components/AddUserModal";
import "../styles/SuperAdmin.css";

const SuperAdminPage: React.FC = () => {
    const [admins, setAdmins] = useState<User[]>([]);
    const [hospitals, setHospitals] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAssignModal, setShowAssignModal] = useState(false);
    const [selectedAdmin, setSelectedAdmin] = useState<User | null>(null);
    const [activeTab, setActiveTab] = useState<'admins' | 'hospitals'>('admins');
    const [searchTerm, setSearchTerm] = useState("");
    const [showAddUserModal, setShowAddUserModal] = useState(false);
    const [addUserRole, setAddUserRole] = useState<'admin' | 'hospital'>('admin');
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            setLoading(true);
            const [adminsRes, hospitalsRes] = await Promise.all([
                apiService.getAllAdmins(),
                apiService.getAllHospitalUsers(),
            ]);
            setAdmins(adminsRes.data.data);
            setHospitals(hospitalsRes.data.data);
        } catch (err) {
            console.error("Failed to load data", err);
        } finally {
            setLoading(false);
        }
    };

    const handleAssign = (admin: User) => {
        setSelectedAdmin(admin);
        setShowAssignModal(true);
    };

    const handleAssignmentSuccess = () => {
        setShowAssignModal(false);
        setSelectedAdmin(null);
        fetchData();
    };

    const handleAddUser = (role: 'admin' | 'hospital') => {
        setAddUserRole(role);
        setShowAddUserModal(true);
    };

    const handleAddUserSuccess = () => {
        setShowAddUserModal(false);
        fetchData();
    };

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const filteredAdmins = admins.filter(admin =>
        admin.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        admin.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        admin.username.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const filteredHospitals = hospitals.filter(hospital =>
        hospital.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        hospital.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        hospital.username.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const getInitials = (firstName: string, lastName: string) => {
        const first = firstName?.charAt(0) || '';
        const last = lastName?.charAt(0) || '';
        return `${first}${last}`.toUpperCase();
    };

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
                            <span className="logo-subtitle">Management System</span>
                        </div>
                    </div>
                </div>

                <nav className="sidebar-nav">
                    <div className="nav-section">
                        <span className="nav-label">Overview</span>
                        <a href="#" className="nav-item active">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="3" width="7" height="7" rx="1" />
                                <rect x="14" y="3" width="7" height="7" rx="1" />
                                <rect x="3" y="14" width="7" height="7" rx="1" />
                                <rect x="14" y="14" width="7" height="7" rx="1" />
                            </svg>
                            Dashboard
                        </a>
                    </div>

                    <div className="nav-section">
                        <span className="nav-label">Management</span>
                        <a href="#" className={`nav-item ${activeTab === 'admins' ? 'active' : ''}`} onClick={() => setActiveTab('admins')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                                <circle cx="9" cy="7" r="4" />
                                <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                            </svg>
                            Admin Users
                            <span className="nav-badge">{admins.length}</span>
                        </a>
                        <a href="#" className={`nav-item ${activeTab === 'hospitals' ? 'active' : ''}`} onClick={() => setActiveTab('hospitals')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                            </svg>
                            Hospitals
                            <span className="nav-badge">{hospitals.length}</span>
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
                            <span className="user-role-badge">Super Admin</span>
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





                {/* Tab Navigation */}
                <div className="tab-container">
                    <div className="tab-header" style={{ flexWrap: 'wrap', gap: '1rem' }}>
                        <div className="tab-nav">
                            <button
                                className={`tab-btn ${activeTab === 'admins' ? 'active' : ''}`}
                                onClick={() => setActiveTab('admins')}
                            >
                                Admin Users
                            </button>
                            <button
                                className={`tab-btn ${activeTab === 'hospitals' ? 'active' : ''}`}
                                onClick={() => setActiveTab('hospitals')}
                            >
                                Hospitals
                            </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginLeft: 'auto' }}>
                            <div className="search-wrapper">
                                <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="11" cy="11" r="8" />
                                    <path d="M21 21l-4.35-4.35" />
                                </svg>
                                <input
                                    type="text"
                                    className="search-input"
                                    placeholder={`Search ${activeTab}...`}
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                            </div>
                            <button
                                className="add-user-btn"
                                onClick={() => handleAddUser(activeTab === 'admins' ? 'admin' : 'hospital')}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    padding: '0.625rem 1.25rem',
                                    background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '8px',
                                    fontSize: '0.875rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
                                    transition: 'all 0.2s ease',
                                }}
                                onMouseOver={(e) => {
                                    e.currentTarget.style.transform = 'translateY(-1px)';
                                    e.currentTarget.style.boxShadow = '0 6px 16px rgba(37, 99, 235, 0.4)';
                                }}
                                onMouseOut={(e) => {
                                    e.currentTarget.style.transform = 'translateY(0)';
                                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(37, 99, 235, 0.3)';
                                }}
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="8" r="4" />
                                    <path d="M20 21a8 8 0 0 0-16 0" />
                                    <line x1="12" y1="16" x2="12" y2="22" />
                                    <line x1="9" y1="19" x2="15" y2="19" />
                                </svg>
                                Add {activeTab === 'admins' ? 'Admin' : 'Hospital'}
                            </button>
                        </div>
                    </div>

                    {loading ? (
                        <div className="loading-state">
                            <div className="loading-spinner"></div>
                            <span>Loading data...</span>
                        </div>
                    ) : (
                        <div className="table-container">
                            {activeTab === 'admins' ? (
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th>User</th>
                                            <th>Username</th>
                                            <th>Contact</th>
                                            <th>Status</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredAdmins.length === 0 ? (
                                            <tr>
                                                <td colSpan={5} className="empty-state">
                                                    <div className="empty-content">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
                                                            <circle cx="9" cy="7" r="4" />
                                                            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
                                                        </svg>
                                                        <span>No admin users found</span>
                                                    </div>
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredAdmins.map((admin) => (
                                                <tr key={admin.id}>
                                                    <td>
                                                        <div className="user-cell">
                                                            <div className="user-avatar-sm">
                                                                {getInitials(admin.first_name, admin.last_name)}
                                                            </div>
                                                            <div className="user-details">
                                                                <span className="user-name-cell">{admin.first_name} {admin.last_name}</span>
                                                                <span className="user-email">{admin.email}</span>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td><span className="username-badge">@{admin.username}</span></td>
                                                    <td>{admin.phone || '—'}</td>
                                                    <td>
                                                        <span className={`status-badge ${admin.is_active ? 'active' : 'inactive'}`}>
                                                            <span className="status-dot"></span>
                                                            {admin.is_active ? 'Active' : 'Inactive'}
                                                        </span>
                                                    </td>
                                                    <td>
                                                        <button onClick={() => handleAssign(admin)} className="btn-action btn-primary-action">
                                                            Assign Hospitals
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            ) : (
                                <table className="data-table">
                                    <thead>
                                        <tr>
                                            <th>Hospital</th>
                                            <th>Username</th>
                                            <th>Contact</th>
                                            <th>Status</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredHospitals.length === 0 ? (
                                            <tr>
                                                <td colSpan={5} className="empty-state">
                                                    <div className="empty-content">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                            <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                                                        </svg>
                                                        <span>No hospitals found</span>
                                                    </div>
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredHospitals.map((hospital) => (
                                                <tr key={hospital.id}>
                                                    <td>
                                                        <div className="user-cell">
                                                            <div className="user-avatar-sm hospital">
                                                                {getInitials(hospital.first_name, hospital.last_name)}
                                                            </div>
                                                            <div className="user-details">
                                                                <span className="user-name-cell">{hospital.first_name} {hospital.last_name}</span>
                                                                <span className="user-email">{hospital.email}</span>
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td><span className="username-badge">@{hospital.username}</span></td>
                                                    <td>{hospital.phone || '—'}</td>
                                                    <td>
                                                        <span className={`status-badge ${hospital.is_active ? 'active' : 'inactive'}`}>
                                                            <span className="status-dot"></span>
                                                            {hospital.is_active ? 'Active' : 'Inactive'}
                                                        </span>
                                                    </td>
                                                    <td>
                                                        <button
                                                            onClick={() => navigate(`/hospital/${hospital.id}`)}
                                                            className="btn-action"
                                                            style={{ color: '#0284c7', background: '#e0f2fe' }}
                                                        >
                                                            View Patients
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    )}
                </div>
            </main>

            {showAssignModal && selectedAdmin && (
                <AssignmentModal
                    admin={selectedAdmin}
                    hospitals={hospitals}
                    onClose={() => {
                        setShowAssignModal(false);
                        setSelectedAdmin(null);
                    }}
                    onSuccess={handleAssignmentSuccess}
                />
            )}

            {showAddUserModal && (
                <AddUserModal
                    role={addUserRole}
                    onClose={() => setShowAddUserModal(false)}
                    onSuccess={handleAddUserSuccess}
                />
            )}
        </div>
    );
};

export default SuperAdminPage;
