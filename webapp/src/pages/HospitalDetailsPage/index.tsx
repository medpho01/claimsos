import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { HospitalPanel } from "../../types";
import apiService from "../../services/api";

// Styles
import "./HospitalDetailsPage.css";
import "../../styles/SuperAdmin.css";

// Components
import LinkPanelModal from "../../components/LinkPanelModal";
import BreadcrumbNav from "./components/BreadcrumbNav";
import HospitalHeader from "./components/HospitalHeader";
import PanelsList from "./components/PanelsList";
import UserList from "./components/UserList"

// Hooks
import { useHospitalData } from "./hooks/useHospitalData";
import AddUserModal from "../../components/AddUserModal";

/**
 * Hospital Details Page - displays hospital info and linked panels
 * Route: /hospital/:hospitalId
 */
const HospitalDetailsPage: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();

    // Data fetching hook
    const {
        hospital,
        patients,
        hospitalPanels,
        loading,
        hospitalUsers,
        setHospitalPanels,
        setHospitalUsers,
    } = useHospitalData({ hospitalId, user });

    // UI state
    const [showLinkPanelModal, setShowLinkPanelModal] = useState(false);
    const [showAddUser, setShowAddUser] = useState(false);
    const [activeTab, setActiveTab] = useState<'panels' | 'users'>('panels');

    // Navigation handlers
    const handleNavigateHome = () => {
        navigate(user?.role === "admin" ? "/dashboard" : "/superadmin", {
            state: { activeTab: "hospitals" },
        });
    };

    const handlePanelSelect = (panel: HospitalPanel) => {
        navigate(`/hospital/${hospitalId}/panel/${panel.panel_id}`);
    };

    const handleUserAdd = () => {

    };

    // Panel link success handler
    const handleLinkPanelSuccess = () => {
        setShowLinkPanelModal(false);
        // Refresh panels
        if (hospitalId) {
            apiService.getHospitalPanels(hospitalId).then((res) => {
                setHospitalPanels(res.data.data || []);
            });
        }
    };

    const handleAddUserSuccess = () => {
        setShowAddUser(false);
        // Refresh panels
        if (hospitalId) {
            apiService.getHospitalUsers(hospitalId).then((res) => {
                setHospitalUsers(res.data.data || []);
            });
        }
    };

    const handleUserUpdate = (updatedUser: any) => {
        setHospitalUsers(prevUsers =>
            prevUsers.map(u => u.user_id === updatedUser.user_id ? updatedUser : u)
        );
    };

    return (
        <div className="hospital-details-page">
            {/* Breadcrumb Navigation */}
            <BreadcrumbNav
                user={user}
                hospital={hospital}
                selectedPanel={null}
                loading={loading}
                onNavigateHome={handleNavigateHome}
                onNavigateToHospital={() => { }}
            />

            {/* Header */}
            <HospitalHeader
                hospital={hospital}
                hospitalPanels={hospitalPanels}
                patients={patients}
                selectedPanel={null}
                loading={loading}
            />

            {/* Tab Navigation */}
            <div className="tab-navigation">
                <button
                    className={`tab-btn ${activeTab === 'panels' ? 'active' : ''}`}
                    onClick={() => setActiveTab('panels')}
                >
                    Linked Panels
                    <span className="tab-count">{hospitalPanels.length}</span>
                </button>
                <button
                    className={`tab-btn ${activeTab === 'users' ? 'active' : ''}`}
                    onClick={() => setActiveTab('users')}
                >
                    Users
                    <span className="tab-count">{hospitalUsers.length}</span>
                </button>
            </div>

            {/* Main Content */}
            <main className="page-content">
                <div className="content-card">
                    {activeTab === 'panels' ? (
                        <PanelsList
                            hospitalPanels={hospitalPanels}
                            patients={patients}
                            loading={loading}
                            user={user}
                            hospital={hospital}
                            onPanelSelect={handlePanelSelect}
                            onLinkPanel={() => setShowLinkPanelModal(true)}
                        />
                    ) : (
                        <UserList
                            panels={hospitalPanels}
                            users={hospitalUsers}
                            loading={loading}
                            user={user}
                            hospital={hospital}
                            onAddUser={() => setShowAddUser(true)}
                            onUserClick={() => { }}
                            onUserUpdate={handleUserUpdate}
                        />
                    )}
                </div>
            </main>

            {/* Link Panel Modal */}
            {showLinkPanelModal && hospitalId && (
                <LinkPanelModal
                    hospitalId={hospitalId}
                    onClose={() => setShowLinkPanelModal(false)}
                    onSuccess={handleLinkPanelSuccess}
                />
            )}


            {showAddUser && hospitalId && (
                <AddUserModal
                    hospitalId={hospitalId}
                    role='hospital'
                    panels={hospitalPanels}
                    onClose={() => setShowAddUser(false)}
                    onSuccess={handleAddUserSuccess}
                />
            )}


        </div>
    );
};

export default HospitalDetailsPage;
