import React, { Suspense } from 'react';
import { Outlet, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';
import { useHospitalData } from '../../superadmin/HospitalDetailsPage/hooks/useHospitalData';
import { HospitalDataProvider } from '../context/HospitalDataContext';
import { Button } from "@/components/ui/button";
import { LogOut, LayoutDashboard } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "framer-motion";

export const HospitalPortalLayout: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const { user, logout } = useAuth();

    // Fetch data once at the layout level
    const {
        hospital,
        hospitalUsers,
        hospitalPanels,
        loading,
        setHospitalUsers,
        setHospitalPanels
    } = useHospitalData({ hospitalId, user });

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    // Full page loading state
    if (loading && !hospital) {
        return (
            <div className="min-h-screen bg-slate-50/50 dark:bg-slate-950 p-6">
                <div className="max-w-[1400px] mx-auto space-y-8 pt-6">
                    {/* Header Section */}
                    <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
                        <div className="flex items-start gap-4">
                            <Skeleton className="h-16 w-16 rounded-xl" />
                            <div className="space-y-2">
                                <Skeleton className="h-8 w-64" />
                                <Skeleton className="h-4 w-48" />
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <Skeleton className="h-8 w-24 rounded-full" />
                            <Skeleton className="h-8 w-24 rounded-full" />
                        </div>
                    </div>

                    {/* Tabs List */}
                    <div className="border bg-white p-1 rounded-xl w-fit shadow-sm">
                        <div className="flex gap-1">
                            <Skeleton className="h-9 w-32 rounded-lg" />
                            <Skeleton className="h-9 w-32 rounded-lg" />
                        </div>
                    </div>

                    {/* Panels Grid */}
                    <div className="border rounded-xl bg-white p-6 shadow-sm">
                        <div className="flex justify-between items-center mb-6">
                            <Skeleton className="h-6 w-32" />
                            <Skeleton className="h-9 w-28 rounded-lg" />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {[...Array(6)].map((_, i) => (
                                <Skeleton key={i} className="h-40 rounded-xl" />
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (!hospital) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-slate-50 text-red-500">
                Hospital not found or access denied.
            </div>
        );
    }

    return (
        <HospitalDataProvider value={{
            hospital,
            hospitalUsers,
            hospitalPanels,
            loading,
            setHospitalUsers,
            setHospitalPanels,
            refreshData: () => { /* Handle refresh if needed by re-triggering hook or invalidating query */ }
        }}>
            <div className="min-h-screen bg-slate-50/50 dark:bg-slate-950">
                {/* Top Navigation Bar - Persistent across routes */}
                <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-50 shadow-sm glass-effect">
                    <div className="flex items-center gap-2 cursor-pointer" onClick={() => navigate(`/portal/${hospital.id}`)}>
                        <div className="bg-blue-600 p-2 rounded-lg shadow-blue-200 shadow-md">
                            <LayoutDashboard className="h-5 w-5 text-white" />
                        </div>
                        <span className="font-bold text-lg text-slate-800 tracking-tight">
                            {hospital.name} <span className="text-slate-400 font-normal text-sm ml-1">Portal</span>
                        </span>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="text-right hidden sm:block">
                            <motion.p
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="text-sm font-medium text-slate-900"
                            >
                                {user?.first_name} {user?.last_name}
                            </motion.p>
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

                {/* Main Content Area */}
                {/* Suspense fallback for lazy loaded routes */}
                <Suspense fallback={
                    <div className="max-w-[1400px] mx-auto p-6 space-y-8">
                        {/* Header Section */}
                        <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
                            <div className="flex items-start gap-4">
                                <Skeleton className="h-16 w-16 rounded-xl" />
                                <div className="space-y-2">
                                    <Skeleton className="h-8 w-64" />
                                    <Skeleton className="h-4 w-48" />
                                </div>
                            </div>
                        </div>

                        {/* Tabs List */}
                        <Skeleton className="h-11 w-64 rounded-xl" />

                        {/* Panels Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {[...Array(3)].map((_, i) => (
                                <Skeleton key={i} className="h-40 rounded-xl" />
                            ))}
                        </div>
                    </div>
                }>
                    <Outlet />
                </Suspense>
            </div>
        </HospitalDataProvider>
    );
};
