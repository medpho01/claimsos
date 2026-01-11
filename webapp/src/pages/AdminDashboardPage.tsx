import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import apiService from "../services/api";
import { User } from "../types";
import "../styles/SuperAdmin.css"; // Reusing existing styles for consistency

const AdminDashboardPage: React.FC = () => {
    const [hospitals, setHospitals] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        fetchHospitals();
    }, [user]);

    const fetchHospitals = async () => {
        if (!user?.id) return;
        try {
            setLoading(true);
            const response = await apiService.getAdminHospitals(user.id);
            setHospitals(response.data.data);
        } catch (err) {
            console.error("Failed to load hospitals", err);
        } finally {
            setLoading(false);
        }
    };

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const getInitials = (firstName: string, lastName: string) => {
        const first = firstName?.charAt(0) || '';
        const last = lastName?.charAt(0) || '';
        return `${first}${last}`.toUpperCase();
    };



    return (
        <div className="admin-layout">
            {/* Sidebar */}
            <aside className="sidebar">
               

                <nav className="sidebar-nav">
                    <div className="nav-section">
                        <span className="nav-label">Overview</span>
                        <a href="#" className="nav-item active">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 21h18M5 21V7l8-4 8 4v14M8 21v-2a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 9h4M10 13h4M10 17h4" />
                            </svg>
                            My Hospitals
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
                            <span className="user-role-badge">Admin</span>
                        </div>
                        <button className="btn-logout" onClick={handleLogout} title="Logout">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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



                {/* Hospital Grid */}
                {loading ? (
                    <div className="loading-state">
                        <div className="loading-spinner"></div>
                        <span>Loading hospitals...</span>
                    </div>
                ) : hospitals.length === 0 ? (
                    <div className="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                        </svg>
                        <span>No hospitals assigned</span>
                        <p>Contact the superadmin to get hospitals assigned to you.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-6">
                        {hospitals.map((hospital) => (
                            <div
                                key={hospital.id}
                                className="hospital-card"
                                onClick={() => navigate(`/hospital/${hospital.id}`)}
                            >
                                <div className="card-header">
                                    <div className="hospital-icon">
                                        {getInitials(hospital.first_name, hospital.last_name)}
                                    </div>
                                    <div className="hospital-status">
                                        <span className={`status-dot ${hospital.is_active ? 'active' : 'inactive'}`}></span>
                                        {hospital.is_active ? 'Active' : 'Inactive'}
                                    </div>
                                </div>

                                <div className="card-body">
                                    <h3 className="hospital-name">
                                        {hospital.first_name} {hospital.last_name}
                                    </h3>
                                    <p className="hospital-username">@{hospital.username}</p>
                                </div>

                                <div className="card-footer">
                                    <div className="contact-info">
                                        <svg className="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                                        </svg>
                                        <span>{hospital.phone || 'No phone'}</span>
                                    </div>
                                    <div className="action-arrow">
                                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                                        </svg>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </main>
            <style>{`
                .grid { display: grid; }
                .gap-4 { gap: 1rem; }
                .p-6 { padding: 1.5rem; }
                
                .hospital-card {
                    background: white;
                    border: 1px solid #e2e8f0;
                    border-radius: 12px;
                    padding: 1.25rem;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    display: flex;
                    flex-direction: column;
                    gap: 1rem;
                    position: relative;
                }

                .hospital-card:hover {
                    border-color: #3b82f6;
                    box-shadow: 0 4px 12px rgba(37, 99, 235, 0.1);
                    transform: translateY(-2px);
                }

                .card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                }

                .hospital-icon {
                    width: 40px;
                    height: 40px;
                    background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
                    color: #2563eb;
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 1rem;
                    border: 1px solid #bfdbfe;
                }

                .hospital-status {
                    display: flex;
                    align-items: center;
                    gap: 0.375rem;
                    font-size: 0.75rem;
                    font-weight: 500;
                    color: #64748b;
                    background: #f8fafc;
                    padding: 0.25rem 0.625rem;
                    border-radius: 99px;
                    border: 1px solid #f1f5f9;
                }

                .status-dot {
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                }

                .status-dot.active { background: #10b981; box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2); }
                .status-dot.inactive { background: #94a3b8; }

                .card-body {
                    flex: 1;
                }

                .hospital-name {
                    font-size: 1rem;
                    font-weight: 600;
                    color: #0f172a;
                    margin: 0 0 0.25rem 0;
                    line-height: 1.4;
                    display: -webkit-box;
                    -webkit-line-clamp: 2;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                }

                .hospital-username {
                    font-size: 0.8125rem;
                    color: #64748b;
                    margin: 0;
                }

                .card-footer {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding-top: 1rem;
                    border-top: 1px solid #f1f5f9;
                    margin-top: auto;
                }

                .contact-info {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    color: #64748b;
                    font-size: 0.8125rem;
                }

                .contact-info .icon {
                    width: 14px;
                    height: 14px;
                }

                .action-arrow {
                    color: #cbd5e1;
                    width: 16px;
                    height: 16px;
                    transition: transform 0.2s;
                }

                .hospital-card:hover .action-arrow {
                    color: #3b82f6;
                    transform: translateX(4px);
                }
                
                @media (min-width: 768px) {
                    .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
                    .md\\:grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
                }
                
                @media (min-width: 1024px) {
                    .lg\\:grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
                }

                @media (min-width: 1280px) {
                    .xl\\:grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
                }
            `}</style>
        </div>
    );
};

export default AdminDashboardPage;
