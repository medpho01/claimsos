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
import MasterOptionsManager from "@/pages/superadmin/MasterOptionsManager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "../../components/common/Skeleton";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LayoutDashboard, Users, Building, FileText, Search, Plus, LogOut, RefreshCw, Grid3X3, Settings, List } from "lucide-react";

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
    const [hospitals, setHospitals] = useState<Hospital[]>(getCached('sa_hospitals', []));
    // Only show skeleton if we have no cached data at all
    const [loading, setLoading] = useState(getCached<Hospital[]>('sa_hospitals', []).length === 0);
    const [showAssignModal, setShowAssignModal] = useState(false);
    const [selectedAdmin, setSelectedAdmin] = useState<User | null>(null);
    const [activeTab, setActiveTab] = useState<'dashboard' | 'admins' | 'hospitals' | 'panels' | 'hospitalAttributes' | 'panelAttributes' | 'masterOptions'>(
        (localStorage.getItem('superadmin_active_tab') as 'dashboard' | 'admins' | 'hospitals' | 'panels' | 'hospitalAttributes' | 'panelAttributes' | 'masterOptions') || 'dashboard'
    );
    const [searchTerm, setSearchTerm] = useState("");
    const [showAddUserModal, setShowAddUserModal] = useState(false);
    const [showAddHospitalModal, setShowAddHospitalModal] = useState(false);
    const [showAddPanelModal, setShowAddPanelModal] = useState(false);
    const [openAttributeForm, setOpenAttributeForm] = useState(false);
    const [panelsCount, setPanelsCount] = useState(0);
    const [hospitalAttributesCount, setHospitalAttributesCount] = useState(0);
    const [panelAttributesCount, setPanelAttributesCount] = useState(0);

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
            const [statsRes, adminsRes, hospitalsRes, healthRes, panelsRes, attributeDefsRes, panelAttributeDefsRes, masterOptionsRes] = await Promise.all([
                apiService.getSystemStats(),
                apiService.getAllAdmins(),
                apiService.getAllHospitals(),
                apiService.getSystemHealth(),
                apiService.getAllMasterPanels(),
                apiService.get("/admin/attribute-definitions"),
                apiService.getPanelAttributeDefinitions(),
                apiService.get("/master-options/categories/list")
            ]);
            const newAdmins = adminsRes.data.data || [];
            const newHospitals = hospitalsRes.data.data || [];
            const panelsList = panelsRes.data.data || [];
            const attributeDefsList = attributeDefsRes.data.data || [];
            const panelAttributeDefsList = panelAttributeDefsRes.data.data || [];
            const masterOptionsList = masterOptionsRes.data.data || [];
            const totalMasterOptions = masterOptionsList.reduce((sum: number, cat: any) => sum + cat.count, 0);

            setStats(statsRes.data.data);
            setAdmins(newAdmins);
            setHospitals(newHospitals);
            setSystemHealth(healthRes.data);
            setPanelsCount(panelsList.length);
            setHospitalAttributesCount(attributeDefsList.length);
            setPanelAttributesCount(panelAttributeDefsList.length);
            setMasterOptionsCount(totalMasterOptions);

            // Cache for instant rendering on re-mount
            sessionStorage.setItem('sa_admins', JSON.stringify(newAdmins));
            sessionStorage.setItem('sa_hospitals', JSON.stringify(newHospitals));
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
                {/* Sidebar */}
                <aside className="hidden w-64 flex-col border-r bg-white px-6 py-8 dark:bg-slate-950 md:flex">
                <div className="pb-4"></div>

                <nav className="flex-1 space-y-2">
                    <Button
                        variant={activeTab === 'dashboard' ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2"
                        onClick={() => setActiveTab('dashboard')}
                    >
                        <LayoutDashboard className="h-4 w-4" />
                        Dashboard
                    </Button>
                    <Button
                        variant={activeTab === 'admins' ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2"
                        onClick={() => setActiveTab('admins')}
                    >
                        <Users className="h-4 w-4" />
                        Admin Users
                        <Badge variant="secondary" className="ml-auto">{admins.length}</Badge>
                    </Button>
                    <Button
                        variant={activeTab === 'hospitals' ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2"
                        onClick={() => setActiveTab('hospitals')}
                    >
                        <Building className="h-4 w-4" />
                        Hospitals
                        <Badge variant="secondary" className="ml-auto">{hospitals.length}</Badge>
                    </Button>
                    <Button
                        variant={activeTab === 'panels' ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2"
                        onClick={() => setActiveTab('panels')}
                    >
                        <Grid3X3 className="h-4 w-4" />
                        Master Panels
                        <Badge variant="secondary" className="ml-auto">{panelsCount}</Badge>
                    </Button>
                    <Button
                        variant={activeTab === 'hospitalAttributes' ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2"
                        onClick={() => setActiveTab('hospitalAttributes')}
                    >
                        <Settings className="h-4 w-4" />
                        Hospital Attributes
                        <Badge variant="secondary" className="ml-auto">{hospitalAttributesCount}</Badge>
                    </Button>
                    <Button
                        variant={activeTab === 'panelAttributes' ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2"
                        onClick={() => setActiveTab('panelAttributes')}
                    >
                        <List className="h-4 w-4" />
                        Panel Attributes
                        <Badge variant="secondary" className="ml-auto">{panelAttributesCount}</Badge>
                    </Button>
                    <Button
                        variant={activeTab === 'masterOptions' ? 'secondary' : 'ghost'}
                        className="w-full justify-start gap-2"
                        onClick={() => setActiveTab('masterOptions')}
                    >
                        <Settings className="h-4 w-4" />
                        Master Options
                        <Badge variant="secondary" className="ml-auto">{masterOptionsCount}</Badge>
                    </Button>
                </nav>

                <div className="border-t pt-6">
                    <div className="flex items-center gap-3 px-2 pb-4">
                        <Avatar>
                            <AvatarFallback>{user && ((user.first_name?.[0] || '') + (user.last_name?.[0] || ''))}</AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col">
                            <span className="text-sm font-medium">{user?.first_name} {user?.last_name}</span>
                            <span className="text-xs text-muted-foreground">Super Admin</span>
                        </div>
                    </div>
                    <Button variant="outline" className="w-full justify-start gap-2 text-destructive hover:bg-destructive/10" onClick={handleLogout}>
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
                                                activeTab === 'panelAttributes' ? 'Panel Attributes' : 'Master Options'}
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
                                    placeholder={`Search ${activeTab === 'hospitalAttributes' ? 'attributes' : activeTab === 'panelAttributes' ? 'attributes' : activeTab}...`}
                                    className="w-[250px] pl-9"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                />
                            </div>
                        )}
                        {activeTab === 'admins' && (
                            <Button onClick={() => handleAddUser('admin')} className="gap-2">
                                <Plus className="h-4 w-4" /> Add Admin
                            </Button>
                        )}
                        {activeTab === 'hospitals' && (
                            <Button onClick={() => setShowAddHospitalModal(true)} className="gap-2">
                                <Plus className="h-4 w-4" /> Add Hospital
                            </Button>
                        )}
                        {activeTab === 'panels' && (
                            <Button onClick={() => setShowAddPanelModal(true)} className="gap-2">
                                <Plus className="h-4 w-4" /> Create Panel
                            </Button>
                        )}
                        {(activeTab === 'hospitalAttributes' || activeTab === 'panelAttributes') && (
                            <Button onClick={() => setOpenAttributeForm(true)} className="gap-2">
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
                                                <TableHead>Hospital</TableHead>
                                                <TableHead>City</TableHead>
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
                                                            <div className="flex justify-end">
                                                                <Skeleton width={100} height={32} borderRadius={6} />
                                                            </div>
                                                        </TableCell>
                                                    </TableRow>
                                                ))
                                            ) : filteredHospitals.length === 0 ? (
                                                <TableRow>
                                                    <TableCell colSpan={3} className="h-24 text-center">
                                                        No hospitals found.
                                                    </TableCell>
                                                </TableRow>
                                            ) : (
                                                filteredHospitals.map((hospital) => (
                                                    <TableRow
                                                        key={hospital.id}
                                                        className="cursor-pointer hover:bg-muted/50"
                                                        onClick={() => navigate(`/hospital/${hospital.id}`, { state: { fromTab: 'hospitals', hospital } })}
                                                    >
                                                        <TableCell className="font-medium">
                                                            <div className="flex items-center gap-3">
                                                                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-blue-700 font-bold text-xs uppercase">
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
