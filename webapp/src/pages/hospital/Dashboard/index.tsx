import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useHospitalData } from "../../superadmin/HospitalDetailsPage/hooks/useHospitalData";
import HospitalHeader from "../../superadmin/HospitalDetailsPage/components/HospitalHeader";
import PanelsList from "../../superadmin/HospitalDetailsPage/components/PanelsList";
import HospitalUserList from "../../superadmin/HospitalDetailsPage/components/HospitalUserList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { LogOut, LayoutDashboard, Users } from "lucide-react";

/**
 * Hospital Dashboard Component
 * Main landing page for hospital users (role="hospital").
 * Shows stats, allows managing panels (viewing only usually), and valid users.
 */
const HospitalDashboard: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const { user, logout } = useAuth();

    // Reuse existing hook for fetching data
    const {
        hospital,
        hospitalUsers,
        hospitalPanels,
        loading,
        setHospitalUsers
    } = useHospitalData({ hospitalId, user });

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    if (loading && !hospital) {
        return <div className="p-8 text-center text-slate-500">Loading hospital profile...</div>;
    }

    if (!hospital) {
        return <div className="p-8 text-center text-red-500">Hospital not found or access denied.</div>;
    }

    return (
        <div className="min-h-screen bg-slate-50/50 dark:bg-slate-950">
            {/* Top Navigation Bar */}
            <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
                <div className="flex items-center gap-2">
                    <div className="bg-blue-600 p-2 rounded-lg">
                        <LayoutDashboard className="h-5 w-5 text-white" />
                    </div>
                    <span className="font-bold text-lg text-slate-800">
                        {hospital.name} <span className="text-slate-400 font-normal text-sm ml-1">Portal</span>
                    </span>
                </div>
                <div className="flex items-center gap-4">
                    <div className="text-right hidden sm:block">
                        <p className="text-sm font-medium text-slate-900">{user?.first_name} {user?.last_name}</p>
                        <p className="text-xs text-slate-500 capitalize">{user?.role}</p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleLogout}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                        <LogOut className="h-4 w-4 mr-2" />
                        Logout
                    </Button>
                </div>
            </div>

            <div className="max-w-[1400px] mx-auto p-6 space-y-8">
                {/* Hospital Header Stats */}
                <HospitalHeader
                    hospital={hospital}
                    hospitalPanels={hospitalPanels}
                    selectedPanel={null}
                    loading={loading}
                />

                {/* Main Content Tabs */}
                <Tabs defaultValue="panels" className="space-y-6">
                    <TabsList className="bg-white border p-1 rounded-xl shadow-sm inline-flex h-auto">
                        <TabsTrigger
                            value="panels"
                            className="px-6 py-2.5 rounded-lg data-[state=active]:bg-blue-50 data-[state=active]:text-blue-700"
                        >
                            Panels & Patients
                        </TabsTrigger>
                        <TabsTrigger
                            value="users"
                            className="px-6 py-2.5 rounded-lg data-[state=active]:bg-blue-50 data-[state=active]:text-blue-700"
                        >
                            Team Members
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="panels">
                        <PanelsList
                            hospitalPanels={hospitalPanels}
                            loading={loading}
                            user={user}
                            hospital={hospital}
                            onPanelSelect={(panel) => navigate(`/portal/${hospitalId}/panel/${panel.id}`)}
                            onLinkPanel={() => { }}
                        />
                    </TabsContent>

                    <TabsContent value="users">
                        <HospitalUserList
                            panels={hospitalPanels}
                            users={hospitalUsers}
                            loading={loading}
                            user={user}
                            hospital={hospital}
                            onAddUser={() => { }} // Hospital users prevent adding new users generally or implement modal if needed
                            onUserClick={() => { }}
                            onUserUpdate={(updatedUser) => {
                                setHospitalUsers(prev => prev.map(u => u.user_id === updatedUser.user_id ? updatedUser : u));
                            }}
                        />
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    );
};

export default HospitalDashboard;
