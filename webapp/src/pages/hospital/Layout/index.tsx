import React, { Suspense } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';
import { useHospitalData } from '../../superadmin/HospitalDetailsPage/hooks/useHospitalData';
import { HospitalDataProvider } from '../context/HospitalDataContext';
import { GlobalNavbar } from '@/components/Navbar';
import { Button } from "@/components/ui/button";
import { LogOut, LayoutDashboard, Building, Users, FileText, Menu } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"; // For mobile sidebar

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export const HospitalPortalLayout: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
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

    // Helper to check active route
    const isActive = (path: string) => location.pathname === path || location.pathname.startsWith(path);

    // Sidebar Component (Reusable for Desktop & Mobile)
    const SidebarContent = () => (
        <div className="flex flex-col h-full">
            {/* Header - Just spacing */}
            <div className="pb-8"></div>

            {/* Navigation — UI Revamp PR B.1: brand palette active states (was blue-50/blue-700) */}
            <nav className="flex-1 space-y-1">
                <Button
                    variant="ghost"
                    className={`w-full justify-start gap-3 h-10 font-medium ${isActive(`/portal/${hospitalId}`) && !location.pathname.includes('/panel/') && !location.pathname.includes('/users') && !location.pathname.includes('/panels') ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-600 dark:text-slate-300'}`}
                    onClick={() => navigate(`/portal/${hospitalId}`)}
                >
                    <LayoutDashboard className="h-5 w-5" />
                    Dashboard
                </Button>

                <Button
                    variant="ghost"
                    className={`w-full justify-start gap-3 h-10 font-medium ${isActive(`/portal/${hospitalId}/panels`) ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-600 dark:text-slate-300'}`}
                    onClick={() => navigate(`/portal/${hospitalId}/panels`)}
                >
                    <FileText className="h-5 w-5" />
                    Select Panel to view Patients
                </Button>

                {hospitalUsers.find(hu => hu.user_id === user?.id)?.role?.includes('admin') && (
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-3 h-10 font-medium ${isActive(`/portal/${hospitalId}/users`) ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-600 dark:text-slate-300'}`}
                        onClick={() => navigate(`/portal/${hospitalId}/users`)}
                    >
                        <Users className="h-5 w-5" />
                        Users
                    </Button>
                )}

                {/* UI Revamp PR G.1: Hospital Profile (was previously only reachable via deep link) */}
                <Button
                    variant="ghost"
                    className={`w-full justify-start gap-3 h-10 font-medium ${location.pathname.endsWith('/profile') ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-600 dark:text-slate-300'}`}
                    onClick={() => navigate(`/portal/${hospitalId}/profile`)}
                >
                    <Building className="h-5 w-5" />
                    Hospital Profile
                </Button>
            </nav>

            {/* Footer / User Profile — Logout pinned to bottom, brand avatar, danger hover */}
            <div className="border-t border-slate-200 dark:border-slate-800 pt-3 mt-auto">
                <div className="flex items-center gap-3 px-2 pb-3">
                    <Avatar className="h-8 w-8">
                        <AvatarImage src="" />
                        <AvatarFallback className="bg-brand-600 text-white font-semibold text-xs">
                            {user?.first_name?.[0]}{user?.last_name?.[0]}
                        </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                            {user?.first_name} {user?.last_name}
                        </span>
                    </div>
                </div>
                <Button
                    variant="ghost"
                    className="w-full justify-start gap-2.5 font-medium text-slate-600 hover:bg-danger-50 hover:text-danger-700 dark:text-slate-300 dark:hover:bg-danger-700/20 dark:hover:text-danger-50"
                    onClick={handleLogout}
                >
                    <LogOut className="h-4 w-4" />
                    Sign out
                </Button>
            </div>
        </div>
    );

    // Full page loading state
    if (loading && !hospital) {
        return (
            <div className="min-h-screen bg-slate-50/50 dark:bg-slate-950 p-6 flex">
                <aside className="hidden w-72 flex-col border-r bg-white px-6 py-8 dark:bg-slate-950 md:flex">
                    <div className="flex items-center gap-4 mb-8">
                        <Skeleton className="h-10 w-10 rounded-xl" />
                        <div className="space-y-2">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-3 w-20" />
                        </div>
                    </div>
                    <div className="space-y-3">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </div>
                </aside>
                <main className="flex-1 p-8">
                    <Skeleton className="h-32 w-full rounded-2xl mb-8" />
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <Skeleton className="h-32 rounded-xl" />
                        <Skeleton className="h-32 rounded-xl" />
                        <Skeleton className="h-32 rounded-xl" />
                    </div>
                </main>
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

    const isPanelPage = location.pathname.includes('/panel/');
    // UI Revamp PR G.1: keep sidebar visible on profile page so users
    // can navigate between Profile and other sections without going
    // through a deep link.
    const isProfilePage = false;

    return (
        <HospitalDataProvider value={{
            hospital,
            hospitalUsers,
            hospitalPanels,
            loading,
            setHospitalUsers,
            setHospitalPanels,
            refreshData: () => { /* Handle refresh */ }
        }}>
            {/* Global Navbar */}
            <GlobalNavbar
                hospitalName={hospital?.name}
                showHospitalContext={true}
            />

            <div className="flex h-screen pt-12 bg-slate-50/50 dark:bg-slate-950 overflow-hidden">
                {/* Desktop Sidebar */}
                {!isPanelPage && !isProfilePage && (
                    <aside className="hidden w-72 flex-col border-r bg-white px-6 py-8 dark:bg-slate-950 md:flex shrink-0">
                        <SidebarContent />
                    </aside>
                )}

                {/* Main Content Area */}
                <main className={`flex-1 overflow-y-auto md:p-2 relative`}>
                    {/* Suspense fallback for lazy loaded routes */}
                    <Suspense fallback={
                        <div className="p-8 space-y-8">
                            <Skeleton className="h-12 w-48 rounded-lg" />
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                                {[...Array(4)].map((_, i) => (
                                    <Skeleton key={i} className="h-32 rounded-xl" />
                                ))}
                            </div>
                        </div>
                    }>
                        <Outlet />
                    </Suspense>
                </main>
            </div>
        </HospitalDataProvider>
    );
};
