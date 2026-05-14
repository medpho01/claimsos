import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { GlobalNavbar } from "@/components/Navbar";
import apiService from "../../services/api";
import { User, Hospital } from "../../types";
import AssignmentModal from "../../components/modals/AssignmentModal";
import AddUserModal from "../../components/modals/AddUserModal";
import AddHospitalModal from "../../components/modals/AddHospitalModal";
import AddPanelModal from "../../components/modals/AddPanelModal";
import MasterPanelManagement from "../../features/panels/MasterPanelManagement";
import DashboardOverview from "../../features/dashboard/DashboardOverview";
import HospitalAttributeDefinitionsManager from "@/features/attributeDefinitions/HospitalAttributeDefinitionsManager";
import PanelAttributeDefinitionsManager from "@/features/attributeDefinitions/PanelAttributeDefinitionsManager";
import DoctorAttributeDefinitionsManager from "@/features/attributeDefinitions/DoctorAttributeDefinitionsManager";
import MasterOptionsManager from "@/pages/superadmin/MasterOptionsManager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "../../components/common/Skeleton";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LayoutDashboard, Users, Building, FileText, Search, Plus, LogOut, RefreshCw, Grid3X3, Settings, List, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

const SuperAdminPage: React.FC = () => {
    // Helper to load cached data from sessionStorage
    const getCached = <T,>(key: string, fallback: T): T => {
        try {
            const cached = sessionStorage.getItem(key);
            return cached ? JSON.parse(cached) : fallback;
        } catch { return fallback; }
    };

    const [systemHealth, setSystemHealth] = useState(null);
    const [stats, setStats] = useState(null);
    const [admins, setAdmins] = useState<User[]>(getCached('sa_admins', []));
    const [hospitals, setHospitals] = useState<Hospital[]>(getCached('sa_hospitals_v2', []));
    // Only show skeleton if we have no cached data at all
    const [loading, setLoading] = useState(getCached<Hospital[]>('sa_hospitals_v2', []).length === 0);
    const [showAssignModal, setShowAssignModal] = useState(false);
    const [selectedAdmin, setSelectedAdmin] = useState<User | null>(null);
    const [activeTab, setActiveTab] = useState<'dashboard' | 'admins' | 'hospitals' | 'panels' | 'hospitalAttributes' | 'panelAttributes' | 'doctorAttributes' | 'masterOptions'>(
        (localStorage.getItem('superadmin_active_tab') as 'dashboard' | 'admins' | 'hospitals' | 'panels' | 'hospitalAttributes' | 'panelAttributes' | 'doctorAttributes' | 'masterOptions') || 'dashboard'
    );
    const [searchTerm, setSearchTerm] = useState("");
    const [showAddUserModal, setShowAddUserModal] = useState(false);
    const [showAddHospitalModal, setShowAddHospitalModal] = useState(false);
    const [showAddPanelModal, setShowAddPanelModal] = useState(false);
    const [openAttributeForm, setOpenAttributeForm] = useState(false);
    const [panelsCount, setPanelsCount] = useState(0);
    const [hospitalAttributesCount, setHospitalAttributesCount] = useState(0);
    const [panelAttributesCount, setPanelAttributesCount] = useState(0);
    const [doctorAttributesCount, setDoctorAttributesCount] = useState(0);

    const [addUserRole, setAddUserRole] = useState<'admin' | 'hospital'>('admin');
    const [refreshing, setRefreshing] = useState(false);
    const [panelRefreshTrigger, setPanelRefreshTrigger] = useState(0);
    const [masterOptionsCount, setMasterOptionsCount] = useState(0);
    const { user, logout } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        fetchData();
    }, []);

    useEffect(() => {
        localStorage.setItem('superadmin_active_tab', activeTab);
    }, [activeTab]);

    const fetchData = async () => {
        try {
            const [statsRes, adminsRes, hospitalsRes, healthRes, panelsRes, attributeDefsRes, panelAttributeDefsRes, doctorAttributeDefsRes, masterOptionsRes] = await Promise.all([
                apiService.getSystemStats(),
                apiService.getAllAdmins(),
                apiService.getAllHospitals(),
                apiService.getSystemHealth(),
                apiService.getAllMasterPanels(),
                apiService.get("/admin/attribute-definitions"),
                apiService.getPanelAttributeDefinitions(),
                apiService.get("/admin/doctor-attributes/definitions/grouped"),
                apiService.get("/master-options/categories/list")
            ]);
            const newAdmins = adminsRes.data.data || [];
            const newHospitals = hospitalsRes.data.data || [];
            const panelsList = panelsRes.data.data || [];
            const attributeDefsList = attributeDefsRes.data.data || [];
            const panelAttributeDefsList = panelAttributeDefsRes.data.data || [];
            const doctorAttributeDefsGrouped = doctorAttributeDefsRes.data.data || {};
            const masterOptionsList = masterOptionsRes.data.data || [];
            const totalMasterOptions = masterOptionsList.reduce((sum: number, cat: any) => sum + cat.count, 0);

            // Count doctor attributes from grouped structure
            let doctorAttrCount = 0;
            Object.values(doctorAttributeDefsGrouped).forEach((attrs: any) => {
                doctorAttrCount += Array.isArray(attrs) ? attrs.length : 0;
            });

            setStats(statsRes.data.data);
            setAdmins(newAdmins);
            setHospitals(newHospitals);
            setSystemHealth(healthRes.data);
            setPanelsCount(panelsList.length);
            setHospitalAttributesCount(attributeDefsList.length);
            setPanelAttributesCount(panelAttributeDefsList.length);
            setDoctorAttributesCount(doctorAttrCount);
            setMasterOptionsCount(totalMasterOptions);

            // Cache for instant rendering on re-mount
            sessionStorage.setItem('sa_admins', JSON.stringify(newAdmins));
            sessionStorage.setItem('sa_hospitals_v2', JSON.stringify(newHospitals));
        } catch (err) {
            console.error("Failed to load data", err);
        } finally {
            setLoading(false);
        }
    };

    const handleAssign = (admin: User) => {
        setSelectedAdmin(admin);
        setShowAssignModal(true);
    };

    const handleAssignmentSuccess = () => {
        setShowAssignModal(false);
        setSelectedAdmin(null);
        fetchData();
    };

    const handleAddUser = (role: 'admin' | 'hospital') => {
        setAddUserRole(role);
        setShowAddUserModal(true);
    };

    const handleAddUserSuccess = () => {
        setShowAddUserModal(false);
        fetchData();
    };

    const handleLogout = () => {
        logout();
        navigate("/login");
    };

    const filteredAdmins = admins.filter(admin =>
        admin.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        admin.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        admin.username.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const filteredHospitals = hospitals.filter(hospital =>
        hospital.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (hospital.city || '').toLowerCase().includes(searchTerm.toLowerCase())
    );

    // Sort state for the Hospitals table.
    // Numeric columns (panels, patients) start descending — most-loaded first.
    type HospitalSortKey = 'name' | 'city' | 'panels' | 'patients';
    const [hospitalSortKey, setHospitalSortKey] = useState<HospitalSortKey>('name');
    const [hospitalSortDir, setHospitalSortDir] = useState<'asc' | 'desc'>('asc');

    const toggleHospitalSort = (key: HospitalSortKey) => {
        if (hospitalSortKey === key) {
            setHospitalSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setHospitalSortKey(key);
            // Numeric columns default to descending; text columns default to ascending.
            setHospitalSortDir(key === 'panels' || key === 'patients' ? 'desc' : 'asc');
        }
    };

    const sortedHospitals = [...filteredHospitals].sort((a, b) => {
        const dir = hospitalSortDir === 'asc' ? 1 : -1;
        switch (hospitalSortKey) {
            case 'name':
                return a.name.localeCompare(b.name) * dir;
            case 'city':
                return (a.city || '').localeCompare(b.city || '') * dir;
            case 'panels':
                return ((a.panels_count ?? 0) - (b.panels_count ?? 0)) * dir;
            case 'patients':
                return ((a.patients_count ?? 0) - (b.patients_count ?? 0)) * dir;
            default:
                return 0;
        }
    });

    const SortIndicator: React.FC<{ active: boolean; dir: 'asc' | 'desc' }> = ({ active, dir }) => {
        if (!active) return <ArrowUpDown className="ml-1 h-3.5 w-3.5 opacity-40" />;
        return dir === 'asc'
            ? <ArrowUp className="ml-1 h-3.5 w-3.5" />
            : <ArrowDown className="ml-1 h-3.5 w-3.5" />;
    };

    const getInitials = (firstName: string, lastName: string) => {
        const first = firstName?.charAt(0) || '';
        const last = lastName?.charAt(0) || '';
        return `${first}${last}`.toUpperCase();
    };

    const handleRefresh = async () => {
        setRefreshing(true);

        const minDelay = new Promise(resolve => setTimeout(resolve, 500));

        try {
            await Promise.all([fetchData(), minDelay]);
            setPanelRefreshTrigger(prev => prev + 1);
        } catch (error) {
            console.error("Refresh failed:", error);
        } finally {
            setRefreshing(false);
        }
    };

    return (
        <>
            {/* Global Navbar */}
            <GlobalNavbar
                hospitalName="Admin Portal"
                showHospitalContext={true}
            />

            <div className="flex h-screen pt-16 bg-slate-50 dark:bg-slate-900">
                {/* Sidebar — UI Revamp PR 0.2: grouped IA (Platform / Configurators), brand palette, Logout pinned to bottom */}
                <aside className="hidden w-64 flex-col border-r border-slate-200 bg-white py-6 dark:border-slate-800 dark:bg-slate-950 md:flex">
                <nav className="flex-1 overflow-y-auto px-3 space-y-1">
                    {/* PLATFORM group */}
                    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500">
                        Platform
                    </div>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'dashboard' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('dashboard')}
                    >
                        <LayoutDashboard className="h-4 w-4" />
                        Dashboard
                    </Button>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'admins' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('admins')}
                    >
                        <Users className="h-4 w-4" />
                        Admin Users
                        <Badge variant={activeTab === 'admins' ? 'outline' : 'secondary'} className={`ml-auto ${activeTab === 'admins' ? 'border-white/30 text-white' : ''}`}>{admins.length}</Badge>
                    </Button>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'hospitals' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('hospitals')}
                    >
                        <Building className="h-4 w-4" />
                        Hospitals
                        <Badge variant={activeTab === 'hospitals' ? 'outline' : 'secondary'} className={`ml-auto ${activeTab === 'hospitals' ? 'border-white/30 text-white' : ''}`}>{hospitals.length}</Badge>
                    </Button>

                    {/* CONFIGURATORS group */}
                    <div className="px-3 pt-5 pb-1 text-[10px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500">
                        Configurators
                    </div>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'panels' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('panels')}
                    >
                        <Grid3X3 className="h-4 w-4" />
                        Master Panels
                        <Badge variant={activeTab === 'panels' ? 'outline' : 'secondary'} className={`ml-auto ${activeTab === 'panels' ? 'border-white/30 text-white' : ''}`}>{panelsCount}</Badge>
                    </Button>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'hospitalAttributes' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('hospitalAttributes')}
                    >
                        <Settings className="h-4 w-4" />
                        Hospital Attributes
                        <Badge variant={activeTab === 'hospitalAttributes' ? 'outline' : 'secondary'} className={`ml-auto ${activeTab === 'hospitalAttributes' ? 'border-white/30 text-white' : ''}`}>{hospitalAttributesCount}</Badge>
                    </Button>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'panelAttributes' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('panelAttributes')}
                    >
                        <List className="h-4 w-4" />
                        Panel Attributes
                        <Badge variant={activeTab === 'panelAttributes' ? 'outline' : 'secondary'} className={`ml-auto ${activeTab === 'panelAttributes' ? 'border-white/30 text-white' : ''}`}>{panelAttributesCount}</Badge>
                    </Button>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'doctorAttributes' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('doctorAttributes')}
                    >
                        <FileText className="h-4 w-4" />
                        Doctor Attributes
                        <Badge variant={activeTab === 'doctorAttributes' ? 'outline' : 'secondary'} className={`ml-auto ${activeTab === 'doctorAttributes' ? 'border-white/30 text-white' : ''}`}>{doctorAttributesCount}</Badge>
                    </Button>
                    <Button
                        variant="ghost"
                        className={`w-full justify-start gap-2.5 font-medium ${activeTab === 'masterOptions' ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white' : 'text-slate-700 dark:text-slate-300'}`}
                        onClick={() => setActiveTab('masterOptions')}
                    >
                        <Settings className="h-4 w-4" />
                        Master Options
                        <Badge variant={activeTab === 'masterOptions' ? 'outline' : 'secondary'} className={`ml-auto ${activeTab === 'masterOptions' ? 'border-white/30 text-white' : ''}`}>{masterOptionsCount}</Badge>
                    </Button>
                </nav>

                {/* Footer: user + logout pinned to bottom */}
                <div className="border-t border-slate-200 dark:border-slate-800 px-3 pt-3 mt-3">
                    <div className="flex items-center gap-3 px-2 pb-3">
                        <Avatar className="h-8 w-8">
                            <AvatarFallback className="text-xs bg-brand-600 text-white">{user && ((user.first_name?.[0] || '') + (user.last_name?.[0] || ''))}</AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col min-w-0">
                            <span className="text-sm font-medium truncate">{user?.first_name} {user?.last_name}</span>
                            <span className="text-xs text-muted-foreground">Super Admin</span>
                        </div>
                    </div>
                    <Button variant="ghost" className="w-full justify-start gap-2.5 font-medium text-slate-600 hover:bg-danger-50 hover:text-danger-700 dark:text-slate-300 dark:hover:bg-danger-700/20 dark:hover:text-danger-50" onClick={handleLogout}>
                        <LogOut className="h-4 w-4" />
                        Log out
                    </Button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 overflow-y-auto px-8 pt-6 pb-8">
                <div className="mb-6 flex items-center justify-between py-2.5 -mx-8 px-8">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                            {activeTab === 'dashboard' ? 'Dashboard' :
                                activeTab === 'admins' ? 'Admin Management' :
                                    activeTab === 'hospitals' ? 'Hospital Management' :
                                        activeTab === 'panels' ? 'Panel Management' :
                                            activeTab === 'hospitalAttributes' ? 'Hospital Attributes' :
                                                activeTab === 'panelAttributes' ? 'Panel Attributes' :
                                                    activeTab === 'doctorAttributes' ? 'Doctor Attributes' : 'Master Options'}
                        </h1>
                        {activeTab === 'dashboard' && (
                            <p className="text-muted-foreground">
                                Overview of system performance and activities.
                            </p>
                        )}
                    </div>
                    <div className="flex items-center gap-4">
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={handleRefresh}
                            disabled={refreshing}
                            className="bg-white hover:bg-slate-50 border-slate-200"
                            title="Refresh data"
                        >
                            <RefreshCw className={`h-4 w-4 text-slate-600 ${refreshing ? 'animate-spin' : ''}`} />
                        </Button>

                        {activeTab !== 'dashboard' && activeTab !== 'masterOptions' && (
                            <div className="relative">
                                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                    type="search"
                                    placeholder={`Search ${activeTab === 'hospitalAttributes' ? 'attributes' : activeTab === 'panelAttributes' ? 'attributes' : activeTab === 'doctorAttributes' ? 'attributes' : activeTab}...`}
                                    className="w-[250px] pl-9"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                            </div>
                        )}
                        {activeTab === 'admins' && (
                            <Button onClick={() => handleAddUser('admin')} className="gap-2 bg-brand-600 hover:bg-brand-700 text-white">
                                <Plus className="h-4 w-4" /> Add Admin
                            </Button>
                        )}
                        {activeTab === 'hospitals' && (
                            <Button onClick={() => setShowAddHospitalModal(true)} className="gap-2 bg-brand-600 hover:bg-brand-700 text-white">
                                <Plus className="h-4 w-4" /> Add Hospital
                            </Button>
                        )}
                        {activeTab === 'panels' && (
                            <Button onClick={() => setShowAddPanelModal(true)} className="gap-2 bg-brand-600 hover:bg-brand-700 text-white">
                                <Plus className="h-4 w-4" /> Create Panel
                            </Button>
                        )}
                        {(activeTab === 'hospitalAttributes' || activeTab === 'panelAttributes' || activeTab === 'doctorAttributes') && (
                            <Button onClick={() => setOpenAttributeForm(true)} className="gap-2 bg-brand-600 hover:bg-brand-700 text-white">
                                <Plus className="h-4 w-4" /> Create New
                            </Button>
                        )}
                    </div>
                </div>

                <div className="space-y-6">
                    {activeTab === 'dashboard' && (
                        <DashboardOverview
                            stats={stats}
                            loading={loading}
                            systemHealth={systemHealth}
                            onAddHospital={() => setShowAddHospitalModal(true)}
                            onAddAdmin={() => handleAddUser('admin')}
                        />
                    )}


                    {
                        activeTab === 'admins' && (
                            <Card>
                                <CardContent className="p-0">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>User</TableHead>
                                                <TableHead>Username</TableHead>
                                                <TableHead>Contact</TableHead>
                                                <TableHead className="text-right">Actions</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {loading ? (
                                                [...Array(5)].map((_, i) => (
                                                    <TableRow key={i}>
                                                        <TableCell>
                                                            <div className="flex items-center gap-3">
                                                                <Skeleton width={32} height={32} borderRadius="50%" />
                                                                <div className="flex flex-col gap-1">
                                                                    <Skeleton width={120} height={16} />
                                                                    <Skeleton width={150} height={12} />
                                                                </div>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell><Skeleton width={100} height={20} borderRadius={12} /></TableCell>
                                                        <TableCell><Skeleton width={100} height={16} /></TableCell>
                                                        <TableCell className="text-right">
                                                            <div className="flex justify-end">
                                                                <Skeleton width={80} height={32} borderRadius={6} />
                                                            </div>
                                                        </TableCell>
                                                    </TableRow>
                                                ))
                                            ) : filteredAdmins.length === 0 ? (
                                                <TableRow>
                                                    <TableCell colSpan={4} className="h-24 text-center">
                                                        No results found.
                                                    </TableCell>
                                                </TableRow>
                                            ) : (
                                                filteredAdmins.map((admin) => (
                                                    <TableRow key={admin.id} className="cursor-pointer hover:bg-muted/50" onClick={() => handleAssign(admin)}>
                                                        <TableCell className="font-medium">
                                                            <div className="flex items-center gap-3">
                                                                <Avatar className="h-8 w-8">
                                                                    <AvatarFallback>{getInitials(admin.first_name, admin.last_name)}</AvatarFallback>
                                                                </Avatar>
                                                                <div className="flex flex-col">
                                                                    <span>{admin.first_name} {admin.last_name}</span>
                                                                    <span className="text-xs text-muted-foreground">{admin.email}</span>
                                                                </div>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Badge variant="outline">{admin.username}</Badge>
                                                        </TableCell>
                                                        <TableCell>{admin.phone || '—'}</TableCell>
                                                        <TableCell className="text-right">
                                                            <Button variant="ghost" size="sm">Manage</Button>
                                                        </TableCell>
                                                    </TableRow>
                                                ))
                                            )}
                                        </TableBody>
                                    </Table>
                                </CardContent>
                            </Card>
                        )
                    }

                    {
                        activeTab === 'hospitals' && (
                            <Card>
                                <CardContent className="p-0">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleHospitalSort('name')}
                                                        className="inline-flex items-center hover:text-foreground transition-colors"
                                                    >
                                                        Hospital
                                                        <SortIndicator active={hospitalSortKey === 'name'} dir={hospitalSortDir} />
                                                    </button>
                                                </TableHead>
                                                <TableHead>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleHospitalSort('city')}
                                                        className="inline-flex items-center hover:text-foreground transition-colors"
                                                    >
                                                        City
                                                        <SortIndicator active={hospitalSortKey === 'city'} dir={hospitalSortDir} />
                                                    </button>
                                                </TableHead>
                                                <TableHead className="text-right">
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleHospitalSort('panels')}
                                                        className="inline-flex items-center hover:text-foreground transition-colors ml-auto"
                                                    >
                                                        Panels
                                                        <SortIndicator active={hospitalSortKey === 'panels'} dir={hospitalSortDir} />
                                                    </button>
                                                </TableHead>
                                                <TableHead className="text-right">
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleHospitalSort('patients')}
                                                        className="inline-flex items-center hover:text-foreground transition-colors ml-auto"
                                                    >
                                                        Patients
                                                        <SortIndicator active={hospitalSortKey === 'patients'} dir={hospitalSortDir} />
                                                    </button>
                                                </TableHead>
                                                <TableHead className="text-right">Actions</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {loading ? (
                                                [...Array(5)].map((_, i) => (
                                                    <TableRow key={i}>
                                                        <TableCell>
                                                            <div className="flex items-center gap-3">
                                                                <Skeleton width={32} height={32} borderRadius="50%" />
                                                                <Skeleton width={200} height={16} />
                                                            </div>
                                                        </TableCell>
                                                        <TableCell>
                                                            <div className="flex items-center gap-2">
                                                                <Skeleton width={16} height={16} />
                                                                <Skeleton width={100} height={16} />
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <Skeleton width={40} height={16} />
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <Skeleton width={40} height={16} />
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <div className="flex justify-end">
                                                                <Skeleton width={100} height={32} borderRadius={6} />
                                                            </div>
                                                        </TableCell>
                                                    </TableRow>
                                                ))
                                            ) : sortedHospitals.length === 0 ? (
                                                <TableRow>
                                                    <TableCell colSpan={5} className="h-24 text-center">
                                                        No hospitals found.
                                                    </TableCell>
                                                </TableRow>
                                            ) : (
                                                sortedHospitals.map((hospital) => (
                                                    <TableRow
                                                        key={hospital.id}
                                                        className="cursor-pointer hover:bg-muted/50"
                                                        onClick={() => navigate(`/hospital/${hospital.id}`, { state: { fromTab: 'hospitals', hospital } })}
                                                    >
                                                        <TableCell className="font-medium">
                                                            <div className="flex items-center gap-3">
                                                                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-50 text-brand-700 font-bold text-xs uppercase">
                                                                    {hospital.name.charAt(0)}
                                                                </div>
                                                                <span>{hospital.name}</span>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell>
                                                            <div className="flex items-center gap-2 text-muted-foreground">
                                                                <Building className="h-3 w-3" />
                                                                {hospital.city || 'No city'}
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {hospital.panels_count ?? 0}
                                                        </TableCell>
                                                        <TableCell className="text-right tabular-nums">
                                                            {hospital.patients_count ?? 0}
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <Button variant="ghost" size="sm">View Details</Button>
                                                        </TableCell>
                                                    </TableRow>
                                                ))
                                            )}
                                        </TableBody>
                                    </Table>
                                </CardContent>
                            </Card>
                        )
                    }

                    {
                        activeTab === 'panels' && (
                            <MasterPanelManagement
                                refreshTrigger={panelRefreshTrigger}
                                searchTerm={searchTerm}
                            />
                        )
                    }

                    {activeTab === 'hospitalAttributes' && (
                        <HospitalAttributeDefinitionsManager
                          searchTerm={searchTerm}
                          isFormOpen={openAttributeForm}
                          onFormOpenChange={setOpenAttributeForm}
                        />
                    )}

                    {activeTab === 'panelAttributes' && (
                        <PanelAttributeDefinitionsManager
                          searchTerm={searchTerm}
                          isFormOpen={openAttributeForm}
                          onFormOpenChange={setOpenAttributeForm}
                        />
                    )}

                    {activeTab === 'doctorAttributes' && (
                        <DoctorAttributeDefinitionsManager
                          searchTerm={searchTerm}
                          isFormOpen={openAttributeForm}
                          onFormOpenChange={setOpenAttributeForm}
                        />
                    )}

                    {activeTab === 'masterOptions' && (
                        <MasterOptionsManager />
                    )}
                </div >
            </main >

            {showAssignModal && selectedAdmin && (
                <AssignmentModal
                    admin={selectedAdmin}
                    hospitals={hospitals}
                    onClose={() => {
                        setShowAssignModal(false);
                        setSelectedAdmin(null);
                    }}
                    onSuccess={handleAssignmentSuccess}
                />
            )}

            {
                showAddUserModal && (
                    <AddUserModal
                        panels={null}
                        hospitalId={null}
                        role={addUserRole}
                        onClose={() => setShowAddUserModal(false)}
                        onSuccess={handleAddUserSuccess}
                    />
                )
            }

            {
                showAddHospitalModal && (
                    <AddHospitalModal
                        onClose={() => setShowAddHospitalModal(false)}
                        onSuccess={() => {
                            setShowAddHospitalModal(false);
                            fetchData();
                        }}
                    />
                )
            }

            {
                showAddPanelModal && (
                    <AddPanelModal
                        onClose={() => setShowAddPanelModal(false)}
                        onSuccess={() => {
                            setShowAddPanelModal(false);
                            setPanelRefreshTrigger(prev => prev + 1);
                        }}
                    />
                )
            }
            </div>
        </>
    );
};

export default SuperAdminPage;
