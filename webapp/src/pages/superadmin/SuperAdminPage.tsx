import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import apiService from "../../services/api";
import { User, Hospital } from "../../types";
import AssignmentModal from "../../components/modals/AssignmentModal";
import AddUserModal from "../../components/modals/AddUserModal";
import AddHospitalModal from "../../components/modals/AddHospitalModal";
import MasterPanelManagement from "../../features/panels/MasterPanelManagement";
import DashboardOverview from "../../features/dashboard/DashboardOverview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LayoutDashboard, Users, Building, FileText, Search, Plus, LogOut } from "lucide-react";

const SuperAdminPage: React.FC = () => {
    const [stats, setStats] = useState(null);
    const [admins, setAdmins] = useState<User[]>([]);
    const [hospitals, setHospitals] = useState<Hospital[]>([]);
    const [loading, setLoading] = useState(true);
    const [showAssignModal, setShowAssignModal] = useState(false);
    const [selectedAdmin, setSelectedAdmin] = useState<User | null>(null);
    const [activeTab, setActiveTab] = useState<'dashboard' | 'admins' | 'hospitals' | 'panels'>(
        (localStorage.getItem('superadmin_active_tab') as 'dashboard' | 'admins' | 'hospitals' | 'panels') || 'dashboard'
    );
    const [searchTerm, setSearchTerm] = useState("");
    const [showAddUserModal, setShowAddUserModal] = useState(false);
    const [showAddHospitalModal, setShowAddHospitalModal] = useState(false);
    const [addUserRole, setAddUserRole] = useState<'admin' | 'hospital'>('admin');
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
            setLoading(true);
            const [statsRes, adminsRes, hospitalsRes] = await Promise.all([
                apiService.getSystemStats(),
                apiService.getAllAdmins(),
                apiService.getAllHospitals(),
            ]);
            setStats(statsRes.data.data);
            setAdmins(adminsRes.data.data || []);
            setHospitals(hospitalsRes.data.data || []);
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

    return (
        <div className="flex h-screen bg-slate-50 dark:bg-slate-900">
            {/* Sidebar */}
            <aside className="hidden w-64 flex-col border-r bg-white px-6 py-8 dark:bg-slate-950 md:flex">
                <div className="flex items-center gap-2 px-2 pb-8">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                        <Building className="h-5 w-5" />
                    </div>
                    <span className="text-lg font-bold tracking-tight">Claim OS</span>
                </div>

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
                        <FileText className="h-4 w-4" />
                        Master Panels
                    </Button>
                </nav>

                <div className="border-t pt-6">
                    <div className="flex items-center gap-3 px-2 pb-4">
                        <Avatar>
                            <AvatarFallback>{user && getInitials(user.first_name, user.last_name)}</AvatarFallback>
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
            <main className="flex-1 overflow-y-auto px-8 py-8">
                <div className="mb-8 flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                            {activeTab === 'dashboard' ? 'Dashboard' :
                                activeTab === 'admins' ? 'Admin Management' :
                                    activeTab === 'hospitals' ? 'Hospital Management' : 'Panel Management'}
                        </h1>
                        <p className="text-muted-foreground">
                            {activeTab === 'dashboard' ? 'Overview of system performance and activities.' :
                                'Manage your system resources efficiently.'}
                        </p>
                    </div>
                    <div className="flex items-center gap-4">
                        {activeTab !== 'dashboard' && activeTab !== 'panels' && (
                            <div className="relative">
                                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                <Input
                                    type="search"
                                    placeholder={`Search ${activeTab}...`}
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
                    </div>
                </div>

                <div className="space-y-6">
                    {activeTab === 'dashboard' && (
                        <DashboardOverview stats={stats} loading={loading} />
                    )}

                    {activeTab === 'admins' && (
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
                                        {filteredAdmins.length === 0 ? (
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
                    )}

                    {activeTab === 'hospitals' && (
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
                                        {filteredHospitals.length === 0 ? (
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
                                                    onClick={() => navigate(`/hospital/${hospital.id}`, { state: { fromTab: 'hospitals' } })}
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
                    )}

                    {activeTab === 'panels' && (
                        <MasterPanelManagement />
                    )}
                </div>
            </main>

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

            {showAddUserModal && (
                <AddUserModal
                    panels={null}
                    hospitalId={null}
                    role={addUserRole}
                    onClose={() => setShowAddUserModal(false)}
                    onSuccess={handleAddUserSuccess}
                />
            )}

            {showAddHospitalModal && (
                <AddHospitalModal
                    onClose={() => setShowAddHospitalModal(false)}
                    onSuccess={() => {
                        setShowAddHospitalModal(false);
                        fetchData();
                    }}
                />
            )}
        </div>
    );
};

export default SuperAdminPage;

