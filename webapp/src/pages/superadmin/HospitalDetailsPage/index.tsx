import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { HospitalPanel } from "../../../types";
import apiService from "../../../services/api";

// Components
import LinkPanelModal from "../../../components/modals/LinkPanelModal";
import HospitalHeader from "./components/HospitalHeader";
import PanelsList from "./components/PanelsList";
import UserList from "./components/HospitalUserList"
import AddUserModal from "../../../components/modals/AddUserModal";

// Shadcn UI
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Home, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// Hooks
import { useHospitalData } from "./hooks/useHospitalData";

const HospitalDetailsPage: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();

    // Data fetching hook
    const {
        hospital,
        hospitalPanels,
        loading,
        hospitalUsers,
        setHospitalPanels,
        setHospitalUsers,
        refetch,
        refetchUsers
    } = useHospitalData({ hospitalId, user });

    // UI state
    const [showLinkPanelModal, setShowLinkPanelModal] = useState(false);
    const [showAddUser, setShowAddUser] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    const handleRefresh = async () => {
        setRefreshing(true);
        const minDelay = new Promise(resolve => setTimeout(resolve, 500));
        await Promise.all([refetch(), minDelay]);
        setRefreshing(false);
    };

    const handleRefreshUsers = async () => {
        setRefreshing(true);
        const minDelay = new Promise(resolve => setTimeout(resolve, 500));
        await Promise.all([refetchUsers(), minDelay]);
        setRefreshing(false);
    };

    // Navigation handlers
    const handleNavigateHome = () => {
        navigate(user?.role === "admin" ? "/dashboard" : "/superadmin", {
            state: { activeTab: "hospitals" },
        });
    };

    const handlePanelSelect = (panel: HospitalPanel) => {
        navigate(`/hospital/${hospitalId}/panel/${panel.panel_id}`, {
            state: panel
        });
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
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-8">
            {/* Breadcrumb Navigation */}
            <div className="max-w-[1400px] mx-auto mb-8">
                <nav className="inline-flex items-center gap-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-2.5 shadow-sm text-sm">
                    <button onClick={handleNavigateHome} className="flex items-center gap-1.5 text-slate-500 hover:text-primary transition-colors font-medium">
                        <Home className="h-4 w-4" />
                        {user?.role === "admin" ? "Dashboard" : "All Hospitals"}
                    </button>
                    {hospital && (
                        <>
                            <ChevronRight className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 mx-1" />
                            <span className="font-semibold text-slate-900 dark:text-slate-100">{hospital.name}</span>
                        </>
                    )}
                </nav>
            </div>

            {/* Header */}
            <HospitalHeader
                hospital={hospital}
                hospitalPanels={hospitalPanels}
                // patients={patients}
                selectedPanel={null}
                loading={loading}
            />

            {/* Main Content */}
            <main className="max-w-[1400px] mx-auto">
                <Tabs defaultValue="panels" className="w-full">
                    <TabsList className="mb-8">
                        <TabsTrigger value="panels">
                            Linked Panels
                            <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700">
                                {hospitalPanels.length}
                            </span>
                        </TabsTrigger>
                        <TabsTrigger value="users">
                            Users
                            <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700">
                                {hospitalUsers.length}
                            </span>
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="panels" className="mt-0">
                        <PanelsList
                            hospitalPanels={hospitalPanels}
                            loading={loading}
                            user={user}
                            hospital={hospital}
                            onPanelSelect={handlePanelSelect}
                            onLinkPanel={() => setShowLinkPanelModal(true)}
                        />
                    </TabsContent>

                    <TabsContent value="users" className="mt-0">
                        <UserList
                            panels={hospitalPanels}
                            users={hospitalUsers}
                            loading={loading}
                            user={user}
                            hospital={hospital}
                            onAddUser={() => setShowAddUser(true)}
                            onUserClick={() => { }}
                            onUserUpdate={handleUserUpdate}
                            onRefresh={handleRefreshUsers}
                            refreshing={refreshing}
                        />
                    </TabsContent>
                </Tabs>
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
