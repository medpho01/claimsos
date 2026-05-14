import React, { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useHospitalDataContext } from "../../hospital/context/HospitalDataContext";

import PanelsList from "../../superadmin/HospitalDetailsPage/components/PanelsList";
import HospitalUserList from "../../superadmin/HospitalDetailsPage/components/HospitalUserList";
// import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"; // Removed
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { LayoutGrid, Users, Activity } from "lucide-react";
import HospitalOperationsCard from "./components/HospitalOperationsCard";


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

    // Calculate Stats
    const totalPatients = useMemo(() => {
        return hospitalPanels.reduce((sum, panel) => sum + (Number(panel.total_count) || 0), 0);
    }, [hospitalPanels]);

    const activeUsers = useMemo(() => {
        return hospitalUsers.filter(u => u.is_active).length;
    }, [hospitalUsers]);

    // We don't need to handle loading state here as the Layout handles the initial load
    if (!hospital) return null;

    // Check if the logged-in user is a hospital admin
    const currentHospitalUser = hospitalUsers.find(hu => hu.user_id === user?.id);
    const isHospitalAdmin = currentHospitalUser?.role?.includes('admin') || false;

    const containerVariants = {
        hidden: { opacity: 0, y: 10 },
        visible: {
            opacity: 1,
            y: 0,
            transition: {
                duration: 0.4,
                staggerChildren: 0.1
            }
        }
    };

    const itemVariants = {
        hidden: { opacity: 0, y: 10 },
        visible: { opacity: 1, y: 0 }
    };

    return (
        <motion.div
            className="max-w-[1600px] mx-auto p-6 lg:p-10 space-y-8"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
        >
            {/* Hospital Operations Section - Profile & Sharing */}
            <HospitalOperationsCard hospitalId={hospitalId!} />

            {/* Key Metrics Cards */}
            <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    title="Total Panels"
                    value={hospitalPanels.length}
                    icon={<LayoutGrid className="h-5 w-5 text-brand-600" />}
                    trend="Active Chains"
                    onClick={() => navigate(`/portal/${hospitalId}/panels`)}
                    clickable
                />
                <StatCard
                    title="Total Patients"
                    value={totalPatients}
                    icon={<Activity className="h-5 w-5 text-emerald-600" />}
                    trend="Across all panels"
                />
                {isHospitalAdmin && (
                    <StatCard
                        title="Hospital Users"
                        value={activeUsers}
                        icon={<Users className="h-5 w-5 text-violet-600" />}
                        trend="Active Staff"
                        onClick={() => navigate(`/portal/${hospitalId}/users`)}
                        clickable
                    />
                )}
            </motion.div>
        </motion.div>
    );
};

// Simple reusable Stat Card
const StatCard = ({ title, value, icon, trend, onClick, clickable }: any) => (
    <Card
        className={`border-slate-200 shadow-sm bg-white overflow-hidden ${clickable ? 'cursor-pointer hover:border-slate-300 hover:shadow-md transition-all' : ''}`}
        onClick={onClick}
    >
        <CardContent className="p-5">
            <div className="flex justify-between items-start mb-4">
                <div className="p-2 bg-slate-50 rounded-xl border border-slate-100">
                    {icon}
                </div>
                {/* <span className="text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded-full">+2.5%</span> */}
            </div>
            <div>
                <p className="text-sm font-medium text-slate-500">{title}</p>
                <h3 className="text-2xl font-bold text-slate-900 mt-1">{value}</h3>
                <p className="text-xs text-slate-400 mt-2 font-medium">{trend}</p>
            </div>
        </CardContent>
    </Card>
);

export default HospitalDashboard;
