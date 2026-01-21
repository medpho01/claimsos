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
import UserList from "./components/Userlist"

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

            {/* Main Content - Panels List */}
            <main className="page-content" style={{marginTop:"5px"}}>
                <div className="content-card">
                    <PanelsList
                        hospitalPanels={hospitalPanels}
                        patients={patients}
                        loading={loading}
                        user={user}
                        hospital={hospital}
                        onPanelSelect={handlePanelSelect}
                        onLinkPanel={() => setShowLinkPanelModal(true)}
                    />
                </div>
            </main>
            <main className="page-content">
                <div className="content-card">
                    <UserList
                        panels = {hospitalPanels}
                        users={hospitalUsers}
                        loading={loading}
                        user={user}
                        hospital={hospital}
                        onAddUser={()=>{setShowAddUser(true)}}
                        onUserClick={()=>{}}
                    />
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
                    role = 'hospital'
                    panels = {hospitalPanels}
                    onClose={() => setShowAddUser(false)}
                    onSuccess={handleAddUserSuccess}
                />
            )}


        </div>
    );
};

export default HospitalDetailsPage;
