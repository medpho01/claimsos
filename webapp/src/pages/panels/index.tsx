import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Patient, HospitalPanel, Hospital } from "../../types";
import apiService from "../../services/api";

// Styles
// Removed legacy CSS import

// Components
import PatientPhotosModal from "../../components/modals/PatientPhotosModal";
import { TableRowSkeleton } from "../../components/common/Skeleton";
import PatientRow from "../superadmin/HospitalDetailsPage/components/PatientRow";
import AddPatientModal from "../superadmin/HospitalDetailsPage/components/AddPatientModal";

// Shadcn UI
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
    Home, ChevronRight, Users, UserPlus, Search,
    Phone, FileSpreadsheet, Folder, Plus, ArrowLeft, ArrowUpDown, ArrowUp, ArrowDown
} from "lucide-react";

// Motion
import { AnimatedPage } from "@/components/ui/motion";

// Hooks
import { usePatientActions } from "../superadmin/HospitalDetailsPage/hooks/usePatientActions";



/**
 * Panel Patients Page - displays patients for a specific panel
 * Route: /hospital/:hospitalId/panel/:panelId
 */
const PanelPatientsPage: React.FC = () => {
    const { hospitalId, panelId } = useParams<{ hospitalId: string; panelId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();

    // Data state
    const [hospital, setHospital] = useState<Hospital | null>(null);
    const [panel, setPanel] = useState<HospitalPanel | null>(null);
    const [patients, setPatients] = useState<Patient[]>([]);
    const [loading, setLoading] = useState(true);

    // UI state
    const [searchTerm, setSearchTerm] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "admitted" | "discharged" | "active" | "deactivated">("active");
    const [showAddModal, setShowAddModal] = useState(false);
    const [selectedPatientForPhotos, setSelectedPatientForPhotos] = useState<Patient | null>(null);
    const [newPatient, setNewPatient] = useState({
        firstName: "",
        lastName: "",
        phone: "",
        admittedAt: new Date().toISOString().split("T")[0],
        admissionType: "" as "conservative" | "surgical" | "",
    });

    const [sortConfig, setSortConfig] = useState<{ key: string; direction: "asc" | "desc" } | null>({
        key: 'updated_at',
        direction: 'desc'
    });

    // Patient actions hook
    const { isSubmitting, dischargingId, togglingActiveId, handlePatientUpdate, handleAddPatient, handleDischarge, handleToggleActive } = usePatientActions({
        patients,
        setPatients,
        selectedPatientForPhotos,
        setSelectedPatientForPhotos,
    });

    // Fetch data
    useEffect(() => {
        const fetchData = async () => {
            if (!hospitalId || !panelId) return;
            try {
                setLoading(true);

                // Fetch hospital
                const hospitalsRes = await apiService.getAllHospitals();
                const foundHospital = hospitalsRes.data.data.find((h: Hospital) => h.id === hospitalId);
                setHospital(foundHospital || null);

                // Fetch panel info
                const panelsRes = await apiService.getHospitalPanels(hospitalId);
                const foundPanel = panelsRes.data.data.find((p: HospitalPanel) => p.panel_id === panelId);
                setPanel(foundPanel || null);

                // Fetch patients
                const patientsRes = await apiService.getAllPatients();
                const panelPatients = patientsRes.data.data.filter(
                    (p: Patient) => p.hospital_id === hospitalId && p.panel_id === panelId
                );
                setPatients(panelPatients);
            } catch (err) {
                console.error("Failed to load panel patients", err);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [hospitalId, panelId]);

    // Filter patients
    const filteredPatients = patients.filter((patient) => {
        const matchesSearch =
            patient.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.last_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            patient.phone.includes(searchTerm);

        let matchesStatus = true;
        if (statusFilter === "admitted") matchesStatus = !patient.discharged_at && patient.is_active;
        if (statusFilter === "discharged") matchesStatus = !!patient.discharged_at && patient.is_active;
        if (statusFilter === "active") matchesStatus = patient.is_active;
        if (statusFilter === "deactivated") matchesStatus = !patient.is_active;

        return matchesSearch && matchesStatus;
    }).sort((a, b) => {
        if (!sortConfig) return 0;

        let aValue: any = a[sortConfig.key as keyof Patient];
        let bValue: any = b[sortConfig.key as keyof Patient];

        // Debug logging
        // console.log(`Sorting ${sortConfig.key}:`, { a: aValue, b: bValue });

        // Handle date strings
        if (sortConfig.key === 'updated_at' || sortConfig.key === 'admitted_at') {
            const dateA = new Date(aValue || 0);
            const dateB = new Date(bValue || 0);
            aValue = dateA.getTime();
            bValue = dateB.getTime();

            // Check for invalid dates
            if (isNaN(aValue)) aValue = 0;
            if (isNaN(bValue)) bValue = 0;
        }

        if (aValue < bValue) {
            return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
            return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
    });

    const handleSort = (key: string) => {
        setSortConfig((current) => {
            if (current?.key === key) {
                return {
                    key,
                    direction: current.direction === 'asc' ? 'desc' : 'asc'
                };
            }
            return { key, direction: 'asc' }; // Default to asc when changing column, though for dates desc is usually better initial, but standard is asc. 
            // Actually for "Last Updated" starting with DESC makes more sense usually, but toggle logic is standard.
        });
    };

    const admittedCount = patients.filter((p) => !p.discharged_at).length;
    const activeCount = patients.filter((p) => p.is_active).length;

    // Handlers
    const handleNavigateHome = () => {
        navigate(user?.role === "admin" ? "/dashboard" : "/superadmin", {
            state: { activeTab: "hospitals" },
        });
    };

    const handleNavigateToHospital = () => {
        navigate(`/hospital/${hospitalId}`);
    };

    const handlePatientChange = (field: string, value: string) => {
        setNewPatient((prev) => ({ ...prev, [field]: value }));
    };

    const handleAddPatientSubmit = (e: React.FormEvent) => {
        handleAddPatient(e, newPatient, hospitalId!, panel, () => {
            setNewPatient({
                firstName: "",
                lastName: "",
                phone: "",
                admittedAt: new Date().toISOString().split("T")[0],
                admissionType: ""
            });
            setShowAddModal(false);
        });
    };

    const canAddPatient =
        user?.role === "superadmin" || (user?.role === "admin" && (hospital as any)?.can_edit);

    // Helper to check if user can discharge a specific patient
    const canDischargePatient = (patient: Patient) => {
        if (user?.role === "superadmin") return true;
        if (user?.role === "admin" && patient.can_discharge) return true;
        return false;
    };

    // Helper to check if user can toggle active status
    const canToggleActiveStatus = (patient: Patient) => {
        if (user?.role === "superadmin") return true;
        if (user?.role === "admin" && patient.can_edit) return true;
        return false;
    };

    return (
        <AnimatedPage className="min-h-screen bg-slate-50 dark:bg-slate-900 p-8">
            {/* Breadcrumb Navigation */}
            <div className="max-w-[1400px] mx-auto mb-8">
                <nav className="flex items-center text-sm text-muted-foreground">
                    <button onClick={handleNavigateHome} className="flex items-center hover:text-primary transition-colors">
                        <Home className="h-4 w-4 mr-2" />
                        {user?.role === "admin" ? "Dashboard" : "All Hospitals"}
                    </button>
                    <ChevronRight className="h-4 w-4 mx-2" />
                    {hospital && (
                        <>
                            <button onClick={handleNavigateToHospital} className="hover:text-primary transition-colors">
                                {hospital.name}
                            </button>
                            <ChevronRight className="h-4 w-4 mx-2" />
                        </>
                    )}
                    {panel && <span className="font-medium text-foreground">{panel.panel_name}</span>}
                </nav>
            </div>

            {/* Panel Header */}
            <div className="max-w-[1400px] mx-auto mb-8">
                {panel && (
                    <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
                        <div className="flex items-start gap-4">
                            <Avatar className="h-16 w-16 rounded-xl">
                                <AvatarFallback className="rounded-xl bg-primary text-primary-foreground text-2xl font-bold">
                                    {panel.panel_name?.charAt(0).toUpperCase()}
                                </AvatarFallback>
                            </Avatar>
                            <div>
                                <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 mb-2">
                                    {panel.panel_name}
                                </h1>
                                <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                                    {panel.contact && (
                                        <div className="flex items-center gap-1">
                                            <Phone className="h-4 w-4" />
                                            <span className="font-mono">{panel.contact}</span>
                                        </div>
                                    )}
                                    {panel.sheet_id && (
                                        <a
                                            href={`https://docs.google.com/spreadsheets/d/${panel.sheet_id}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-1 text-blue-600 hover:underline"
                                        >
                                            <FileSpreadsheet className="h-4 w-4" />
                                            Google Sheet
                                        </a>
                                    )}
                                    {panel.drive_folder_id && (
                                        <a
                                            href={`https://drive.google.com/drive/folders/${panel.drive_folder_id}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-1 text-blue-600 hover:underline"
                                        >
                                            <Folder className="h-4 w-4" />
                                            Google Drive
                                        </a>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <Badge variant="secondary" className="px-4 py-2 text-sm flex gap-2">
                                <Users className="h-4 w-4" />
                                {patients.length} Patients
                            </Badge>
                            <Badge className="px-4 py-2 text-sm flex gap-2 bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-yellow-200">
                                <Users className="h-4 w-4" />
                                {admittedCount} Admitted
                            </Badge>
                        </div>
                    </div>
                )}
            </div>

            {/* Main Content */}
            <main className="max-w-[1400px] mx-auto">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-7">
                        <div className="space-y-1">
                            <CardTitle className="text-xl flex items-center gap-2">
                                <Users className="h-5 w-5 text-muted-foreground" />
                                Patients
                                <Badge variant="secondary" className="ml-2 rounded-full">{filteredPatients.length}</Badge>
                            </CardTitle>
                        </div>
                        {canAddPatient && (
                            <Button onClick={() => setShowAddModal(true)} className="gap-2">
                                <Plus className="h-4 w-4" />
                                New Patient
                            </Button>
                        )}
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-col gap-6">
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                                <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)} className="w-[400px]">
                                    <TabsList>
                                        <TabsTrigger value="all">All</TabsTrigger>
                                        <TabsTrigger value="active">Active</TabsTrigger>
                                        <TabsTrigger value="admitted">Admitted</TabsTrigger>
                                        <TabsTrigger value="discharged">Discharged</TabsTrigger>
                                        <TabsTrigger value="deactivated">Deactivated</TabsTrigger>
                                    </TabsList>
                                </Tabs>
                                <div className="relative w-full md:w-[300px]">
                                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                                    <Input
                                        type="search"
                                        placeholder="Search patients..."
                                        className="pl-9"
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                    />
                                </div>
                            </div>

                            <div className="rounded-md border">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-[300px]">Patient</TableHead>
                                            <TableHead>
                                                <Button
                                                    variant="ghost"
                                                    className="p-0 hover:bg-transparent"
                                                    onClick={() => handleSort('updated_at')}
                                                >
                                                    <div className="flex items-center gap-1">
                                                        Last Updated
                                                        {sortConfig?.key === 'updated_at' ? (
                                                            sortConfig.direction === 'asc' ? (
                                                                <ArrowUp className="h-4 w-4" />
                                                            ) : (
                                                                <ArrowDown className="h-4 w-4" />
                                                            )
                                                        ) : (
                                                            <ArrowUpDown className="h-4 w-4 opacity-50" />
                                                        )}
                                                    </div>
                                                </Button>
                                            </TableHead>
                                            <TableHead>
                                                <Button
                                                    variant="ghost"
                                                    className="p-0 hover:bg-transparent"
                                                    onClick={() => handleSort('admitted_at')}
                                                >
                                                    <div className="flex items-center gap-1">
                                                        Admitted On
                                                        {sortConfig?.key === 'admitted_at' ? (
                                                            sortConfig.direction === 'asc' ? (
                                                                <ArrowUp className="h-4 w-4" />
                                                            ) : (
                                                                <ArrowDown className="h-4 w-4" />
                                                            )
                                                        ) : (
                                                            <ArrowUpDown className="h-4 w-4 opacity-50" />
                                                        )}
                                                    </div>
                                                </Button>
                                            </TableHead>
                                            <TableHead>Type</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead>Actions</TableHead>
                                            <TableHead>Generate PDF</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {loading ? (
                                            [...Array(5)].map((_, i) => (
                                                <TableRow key={i}>
                                                    <TableCell colSpan={7} className="h-16">
                                                        <div className="w-full h-8 bg-muted animate-pulse rounded" />
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        ) : filteredPatients.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                                                    No patients found.
                                                </TableCell>
                                            </TableRow>
                                        ) : (
                                            filteredPatients.map((patient) => (
                                                <PatientRow
                                                    key={patient.id}
                                                    patient={patient}
                                                    onClick={() => setSelectedPatientForPhotos(patient)}
                                                    onDischarge={() => handleDischarge(patient.id)}
                                                    canDischarge={canDischargePatient(patient)}
                                                    isDischarging={dischargingId === patient.id}
                                                    onToggleActive={() => handleToggleActive(patient)}
                                                    canToggleActive={canToggleActiveStatus(patient)}
                                                    isTogglingActive={togglingActiveId === patient.id}
                                                />
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </main>

            {/* Add Patient Modal */}
            {showAddModal && panel && (
                <AddPatientModal
                    selectedPanel={panel}
                    newPatient={newPatient}
                    isSubmitting={isSubmitting}
                    onClose={() => setShowAddModal(false)}
                    onSubmit={handleAddPatientSubmit}
                    onPatientChange={handlePatientChange}
                />
            )}

            {/* Patient Photos Modal */}
            {selectedPatientForPhotos && (
                <PatientPhotosModal
                    patient={selectedPatientForPhotos}
                    onClose={() => setSelectedPatientForPhotos(null)}
                    onUpdate={
                        user?.role === "admin" || user?.role === "superadmin" ? handlePatientUpdate : undefined
                    }
                />
            )}
        </AnimatedPage>
    );
};

export default PanelPatientsPage;
