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

// Hooks
import { useHospitalData } from "./hooks/useHospitalData";

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
        setHospitalPanels,
    } = useHospitalData({ hospitalId, user });

    // UI state
    const [showLinkPanelModal, setShowLinkPanelModal] = useState(false);

    // Navigation handlers
    const handleNavigateHome = () => {
        navigate(user?.role === "admin" ? "/dashboard" : "/superadmin", {
            state: { activeTab: "hospitals" },
        });
    };

    const handlePanelSelect = (panel: HospitalPanel) => {
        navigate(`/hospital/${hospitalId}/panel/${panel.panel_id}`);
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
            <main className="page-content">
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

            {/* Link Panel Modal */}
            {showLinkPanelModal && hospitalId && (
                <LinkPanelModal
                    hospitalId={hospitalId}
                    onClose={() => setShowLinkPanelModal(false)}
                    onSuccess={handleLinkPanelSuccess}
                />
            )}
        </div>
    );
};

export default HospitalDetailsPage;
