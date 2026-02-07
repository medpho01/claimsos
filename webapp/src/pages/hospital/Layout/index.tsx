import React, { Suspense } from 'react';
import { Outlet, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';
import { useHospitalData } from '../../superadmin/HospitalDetailsPage/hooks/useHospitalData';
import { HospitalDataProvider } from '../context/HospitalDataContext';
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
            {/* Header */}
            <div className="flex items-center gap-2 px-2 pb-8 pt-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-200">
                    <Building className="h-6 w-6" />
                </div>
                <div className="flex flex-col overflow-hidden">
                    <span className="text-lg font-bold tracking-tight text-slate-900 truncate">
                        {hospital?.name || 'Hospital Portal'}
                    </span>
                    <span className="text-xs text-slate-500 font-medium truncate">
                        {hospital?.city || 'Dashboard'}
                    </span>
                </div>
            </div>

            {/* Navigation */}
            <nav className="flex-1 space-y-2">
                <Button
                    variant={isActive(`/portal/${hospitalId}`) && !location.pathname.includes('/panel/') && !location.pathname.includes('/users') && !location.pathname.includes('/panels') ? 'secondary' : 'ghost'}
                    className={`w-full justify-start gap-3 h-10 ${isActive(`/portal/${hospitalId}`) && !location.pathname.includes('/panel/') && !location.pathname.includes('/users') && !location.pathname.includes('/panels') ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600'}`}
                    onClick={() => navigate(`/portal/${hospitalId}`)}
                >
                    <LayoutDashboard className="h-5 w-5" />
                    Dashboard
                </Button>

                <Button
                    variant={isActive(`/portal/${hospitalId}/panels`) ? 'secondary' : 'ghost'}
                    className={`w-full justify-start gap-3 h-10 ${isActive(`/portal/${hospitalId}/panels`) ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600'}`}
                    onClick={() => navigate(`/portal/${hospitalId}/panels`)}
                >
                    <FileText className="h-5 w-5" />
                    Panels
                </Button>

                {hospitalUsers.find(hu => hu.user_id === user?.id)?.role?.includes('admin') && (
                    <Button
                        variant={isActive(`/portal/${hospitalId}/users`) ? 'secondary' : 'ghost'}
                        className={`w-full justify-start gap-3 h-10 ${isActive(`/portal/${hospitalId}/users`) ? 'bg-blue-50 text-blue-700 font-semibold' : 'text-slate-600'}`}
                        onClick={() => navigate(`/portal/${hospitalId}/users`)}
                    >
                        <Users className="h-5 w-5" />
                        Users
                    </Button>
                )}
            </nav>

            {/* Footer / User Profile */}
            <div className="border-t pt-6 mt-auto">
                <div className="flex items-center gap-3 px-2 pb-4">
                    <Avatar className="h-9 w-9 border border-slate-200">
                        <AvatarImage src="" />
                        <AvatarFallback className="bg-gradient-to-br from-blue-50 to-blue-100 text-blue-700 font-bold text-xs ring-2 ring-white">
                            {user?.first_name?.[0]}{user?.last_name?.[0]}
                        </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col min-w-0">
                        <span className="text-sm font-semibold text-slate-900 truncate">
                            {user?.first_name} {user?.last_name}
                        </span>
                    </div>
                </div>
                <Button
                    variant="outline"
                    className="w-full justify-start gap-2 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-100"
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
            <div className="flex h-screen bg-slate-50/50 dark:bg-slate-950 overflow-hidden">
                {/* Desktop Sidebar */}
                {!isPanelPage && (
                    <aside className="hidden w-72 flex-col border-r bg-white px-6 py-8 dark:bg-slate-950 md:flex shrink-0">
                        <SidebarContent />
                    </aside>
                )}

                {/* Mobile Header & Sidebar Trigger */}
                {!isPanelPage && (
                    <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b p-4 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="bg-blue-600 p-1.5 rounded-lg">
                                <Building className="h-5 w-5 text-white" />
                            </div>
                            <span className="font-bold text-lg">{hospital?.name}</span>
                        </div>
                        <Sheet>
                            <SheetTrigger asChild>
                                <Button variant="ghost" size="icon">
                                    <Menu className="h-6 w-6" />
                                </Button>
                            </SheetTrigger>
                            <SheetContent side="left" className="p-6 w-72">
                                <SidebarContent />
                            </SheetContent>
                        </Sheet>
                    </div>
                )}

                {/* Main Content Area */}
                <main className={`flex-1 overflow-y-auto md:p-2 relative ${!isPanelPage ? 'pt-20' : ''} md:pt-0`}>
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
