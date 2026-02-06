import React, { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useHospitalDataContext } from "../../hospital/context/HospitalDataContext";

import PanelsList from "../../superadmin/HospitalDetailsPage/components/PanelsList";
import HospitalUserList from "../../superadmin/HospitalDetailsPage/components/HospitalUserList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { LayoutGrid, Users, CheckCircle2 } from "lucide-react";

/**
 * Hospital Dashboard Component
 * Main landing page for hospital users (role="hospital").
 * Shows stats, allows managing panels (viewing only usually), and valid users.
 */
const HospitalDashboard: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();

    // Use Context Data
    const {
        hospital,
        hospitalUsers,
        hospitalPanels,
        loading,
        setHospitalUsers
    } = useHospitalDataContext();

    // We don't need to handle loading state here as the Layout handles the initial load
    // But we can check for hospital existence just in case
    if (!hospital) return null;

    // Check if the logged-in user is a hospital admin
    // Find the current user in the hospitalUsers array and check their role
    const currentHospitalUser = hospitalUsers.find(hu => hu.user_id === user?.id);
    const isHospitalAdmin = currentHospitalUser?.role?.includes('admin') || false;

    const containerVariants = {
        hidden: { opacity: 0, y: 20 },
        visible: {
            opacity: 1,
            y: 0,
            transition: {
                duration: 0.5,
                // ease: "easeOut", // Removed to use default ease and fix type error
                staggerChildren: 0.1
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            className="max-w-[1400px] mx-auto p-6 space-y-8"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
        >
            {/* Hospital Header Stats */}
            {/* Dashboard Header: Tabs & Stats */}
            <motion.div variants={itemVariants}>
                <Tabs defaultValue="panels" className="space-y-6">
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <TabsList className="bg-white border p-1 rounded-xl shadow-sm inline-flex h-auto w-full sm:w-auto">
                            <TabsTrigger
                                value="panels"
                                className="flex-1 sm:flex-none px-6 py-2.5 rounded-lg data-[state=active]:bg-blue-50 data-[state=active]:text-blue-700 transition-all font-medium"
                            >
                                Panels
                            </TabsTrigger>
                            {isHospitalAdmin && (
                                <TabsTrigger
                                    value="users"
                                    className="flex-1 sm:flex-none px-6 py-2.5 rounded-lg data-[state=active]:bg-blue-50 data-[state=active]:text-blue-700 transition-all font-medium"
                                >
                                    Users
                                </TabsTrigger>
                            )}
                        </TabsList>

                        {/* Inline Stats Badges */}
                        <div className="flex gap-3 flex-wrap justify-center sm:justify-end">
                            <Badge variant="outline" className="px-3 py-1.5 text-sm flex gap-2 border-slate-200 bg-white shadow-sm">
                                <LayoutGrid className="h-4 w-4 text-blue-600" />
                                <span className="font-medium text-slate-700">
                                    {hospitalPanels.length} Panel{hospitalPanels.length !== 1 ? "s" : ""}
                                </span>
                            </Badge>
                            <Badge variant="outline" className="px-3 py-1.5 text-sm flex gap-2 border-slate-200 bg-white shadow-sm">
                                <Users className="h-4 w-4 text-green-600" />
                                <span className="font-medium text-slate-700">
                                </span>
                            </Badge>
                            <Badge className="px-3 py-1.5 text-sm flex gap-2 bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200 shadow-sm">
                                <CheckCircle2 className="h-4 w-4" />
                            </Badge>
                        </div>
                    </div>

                    <TabsContent value="panels" className="mt-0">
                        <PanelsList
                            hospitalPanels={hospitalPanels}
                            loading={loading}
                            user={user}
                            hospital={hospital}
                            onPanelSelect={(panel) => navigate(`/portal/${hospitalId}/panel/${panel.id}`)}
                            onLinkPanel={() => { }}
                            hideDrive={true}
                        />
                    </TabsContent>

                    {isHospitalAdmin && (
                        <TabsContent value="users" className="mt-0">
                            <HospitalUserList
                                panels={hospitalPanels}
                                users={hospitalUsers}
                                loading={loading}
                                user={user}
                                hospital={hospital}
                                onAddUser={() => { }}
                                onUserClick={() => { }}
                                onUserUpdate={(updatedUser) => {
                                    setHospitalUsers(prev => prev.map(u => u.user_id === updatedUser.user_id ? updatedUser : u));
                                }}
                            />
                        </TabsContent>
                    )}
                </Tabs>
            </motion.div>
        </motion.div>
    );
};

export default HospitalDashboard;
