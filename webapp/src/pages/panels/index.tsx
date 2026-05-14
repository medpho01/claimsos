import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { GlobalNavbar } from "@/components/Navbar";
import { Patient, HospitalPanel, HospitalAssignment, Hospital } from "../../types";
import apiService from "../../services/api";

// Styles
// Removed legacy CSS import

// Components
import PatientPhotosModal from "../../components/modals/PatientPhotosModal";
import { TableRowSkeleton } from "../../components/common/Skeleton";
import PatientRow from "../superadmin/HospitalDetailsPage/components/PatientRow";
import AddPatientModal from "../superadmin/HospitalDetailsPage/components/AddPatientModal";
import PatientTable from "./components/PatientTable";

// Shadcn UI
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Home,
  ChevronRight,
  Users,
  UserPlus,
  Search,
  Phone,
  FileSpreadsheet,
  Folder,
  Plus,
  ArrowLeft,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from "lucide-react";

// Motion
import { AnimatedPage } from "@/components/ui/motion";

// Hooks
import { usePatientActions } from "../superadmin/HospitalDetailsPage/hooks/usePatientActions";

/**
 * Panel Patients Page - displays patients for a specific panel
 * Route: /hospital/:hospitalId/panel/:panelId
 */
interface MetaData {
  totalCounts: number;
  itemCounts: number;
  itemsPerPage: number;
  totalPages: number;
  currentPage: number;
}

const PanelPatientsPage: React.FC = () => {
  const { hospitalId, panelId } = useParams<{ hospitalId: string; panelId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const location = useLocation();

  // Data state
  const [hospital, setHospital] = useState<HospitalAssignment | null>(null);
  const [hospitalName, setHospitalName] = useState<string>((location.state as any)?.hospitalName || "");
  const [panel, setPanel] = useState<HospitalPanel | null>(location.state);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState<number>(0);
  const [admitted, setAdmitted] = useState<number>(0);

  // Tab counts from server (all 5 statuses in one query)
  const [tabCounts, setTabCounts] = useState<Record<string, number>>({
    all: 0, active: 0, admitted: 0, discharged: 0, deactivated: 0
  });

  // Stale-while-revalidate cache: stores last fetched data per tab+page
  const patientsCache = useRef<Record<string, { patients: Patient[]; meta: MetaData }>>({});

  // UI state
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "admitted" | "discharged" | "active" | "deactivated"
  >("active");
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
    key: "updated_at",
    direction: "desc",
  });

  const [meta, setMeta] = useState<MetaData>({
    totalCounts: 0,
    itemCounts: 0,
    itemsPerPage: 0,
    totalPages: 1,
    currentPage: 1,
  });
  const [page, setPage] = useState<number>(1);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Debounce search input (300ms delay)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Reset page to 1 when filters or search change
  useEffect(() => {
    setPage(1);
  }, [statusFilter, debouncedSearch]);

  // Patient actions hook
  const {
    isSubmitting,
    dischargingId,
    togglingActiveId,
    handlePatientUpdate,
    handleAddPatient,
    handleDischarge,
    handleToggleActive,
  } = usePatientActions({
    patients,
    setPatients,
    selectedPatientForPhotos,
    setSelectedPatientForPhotos,
  });

  // Fetch hospital name (once on mount)
  useEffect(() => {
    const fetchData = async () => {
      if (!hospitalId || !panelId) return;
      try {
        const promises: Promise<any>[] = [
          apiService.getPatientsSummary(hospitalId)
        ];
        if (!hospitalName) {
          if (user?.role === "admin") {
            promises.push(apiService.getAdminHospitals(user?.id as string));
          } else if (user?.role === "superadmin") {
            promises.push(apiService.getHospitalById(hospitalId));
          }
        }
        const results = await Promise.all(promises);
        const summaryRes = results[0];
        if (summaryRes.data.data && summaryRes.data.data[panelId]) {
          setTotal(summaryRes.data.data[panelId].total);
          setAdmitted(summaryRes.data.data[panelId].admitted);
        }
        if (!hospitalName && results[1]) {
          if (user?.role === "admin") {
            const currentHospital = results[1].data.data.filter(
              (elem: any) => elem.hospital_id == hospitalId
            )[0];
            if (currentHospital) {
              setHospital(currentHospital);
              setHospitalName(currentHospital.name || "");
            }
          } else if (user?.role === "superadmin") {
            const currentHospital = results[1].data?.data;
            if (currentHospital) {
              setHospitalName(currentHospital.name);
            }
          }
        }
      } catch (error) {
        console.error("Failed to load data", error);
      }
    };
    fetchData();
  }, [hospitalId, panelId, user?.id, user?.role]);

  // Fetch tab counts (single query for all 5 tabs) — refreshes on search change / data refresh
  useEffect(() => {
    if (!hospitalId || !panelId) return;
    apiService.getTabCounts(hospitalId, panelId, debouncedSearch)
      .then(res => {
        const data = res.data.data;
        setTabCounts({
          all: parseInt(data.all) || 0,
          active: parseInt(data.active) || 0,
          admitted: parseInt(data.admitted) || 0,
          discharged: parseInt(data.discharged) || 0,
          deactivated: parseInt(data.deactivated) || 0,
        });
      })
      .catch(err => console.error("Failed to fetch tab counts", err));
  }, [hospitalId, panelId, debouncedSearch, refreshTrigger]);

  // Fetch patients — stale-while-revalidate pattern
  useEffect(() => {
    if (!hospitalId || !panelId) return;

    const cacheKey = `${statusFilter}_${page}_${debouncedSearch}`;

    // Show cached data instantly if available (no loading skeleton)
    const cached = patientsCache.current[cacheKey];
    if (cached) {
      setPatients(cached.patients);
      setMeta(cached.meta);
      setLoading(false);
    } else {
      setLoading(true);
    }

    // Fetch fresh data in background
    apiService.getHospitalPanelPatients(
      hospitalId, panelId, page, statusFilter, debouncedSearch
    )
      .then(patientsRes => {
        const newData = {
          patients: patientsRes.data.data.data,
          meta: patientsRes.data.data.meta,
        };
        // Update cache
        patientsCache.current[cacheKey] = newData;
        // Update UI
        setMeta(newData.meta);
        setPatients(newData.patients);
      })
      .catch(err => console.error("Failed to load panel patients", err))
      .finally(() => setLoading(false));
  }, [hospitalId, panelId, page, statusFilter, debouncedSearch, refreshTrigger]);


  // Sort patients (server already handles filtering; sorting is done client-side on the current page)
  const sortedPatients = React.useMemo(() => {
    if (!sortConfig) return patients;
    return [...patients].sort((a, b) => {
      let aValue: any = a[sortConfig.key as keyof Patient];
      let bValue: any = b[sortConfig.key as keyof Patient];

      // Handle date strings
      if (sortConfig.key === "updated_at" || sortConfig.key === "admitted_at") {
        const dateA = new Date(aValue || 0);
        const dateB = new Date(bValue || 0);
        aValue = dateA.getTime();
        bValue = dateB.getTime();

        if (isNaN(aValue)) aValue = 0;
        if (isNaN(bValue)) bValue = 0;
      }

      if (aValue < bValue) {
        return sortConfig.direction === "asc" ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === "asc" ? 1 : -1;
      }
      return 0;
    });
  }, [patients, sortConfig]);

  const handleSort = (key: string) => {
    setSortConfig((current) => {
      if (current?.key === key) {
        return {
          key,
          direction: current.direction === "asc" ? "desc" : "asc",
        };
      }
      return { key, direction: "asc" }; // Default to asc when changing column, though for dates desc is usually better initial, but standard is asc.
      // Actually for "Last Updated" starting with DESC makes more sense usually, but toggle logic is standard.
    });
  };

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
        admissionType: "",
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
    <>
      <GlobalNavbar showHospitalContext={false} />
      <AnimatedPage className="min-h-screen bg-slate-50 dark:bg-slate-900 p-8 pt-12">
        {/* Breadcrumb Navigation */}
      <div className="max-w-[1400px] mx-auto mb-8 mt-6">
        <nav className="inline-flex items-center gap-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-2.5 shadow-sm text-sm">
          <button
            onClick={handleNavigateHome}
            className="flex items-center gap-1.5 text-slate-500 hover:text-primary transition-colors font-medium"
          >
            <Home className="h-4 w-4" />
            {user?.role === "admin" ? "Dashboard" : "All Hospitals"}
          </button>
          {hospitalName && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 mx-1" />
              <button
                onClick={handleNavigateToHospital}
                className="text-slate-500 hover:text-primary transition-colors font-medium"
              >
                {hospitalName}
              </button>
            </>
          )}
          {panel && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-slate-300 dark:text-slate-600 mx-1" />
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {panel.panel_name}
              </span>
            </>
          )}
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
                      className="flex items-center gap-1 text-brand-600 hover:underline"
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
                      className="flex items-center gap-1 text-brand-600 hover:underline"
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
                {total} Patients
              </Badge>
              <Badge className="px-4 py-2 text-sm flex gap-2 bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-yellow-200">
                <Users className="h-4 w-4" />
                {admitted} Admitted
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
                <Badge variant="secondary" className="ml-2 rounded-full">
                  {meta.totalCounts}
                </Badge>
              </CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={async () => {
                  setRefreshing(true);
                  setRefreshTrigger(prev => prev + 1);
                  await new Promise(resolve => setTimeout(resolve, 500));
                  setRefreshing(false);
                }}
                disabled={refreshing}
                className="bg-white hover:bg-slate-50 border-slate-200"
                title="Refresh data"
              >
                <RefreshCw className={`h-4 w-4 text-slate-600 ${refreshing ? 'animate-spin' : ''}`} />
              </Button>
              {canAddPatient && (
                <Button onClick={() => setShowAddModal(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  New Patient
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                {/* UI Revamp J.7: status filter as colored pills matching wireframe hw-patients */}
                <div className="flex items-center gap-2 flex-wrap">
                  {[
                    { v: 'all',         label: 'All',         tone: 'info',   count: tabCounts.all },
                    { v: 'active',      label: 'Active',      tone: 'info',   count: tabCounts.active },
                    { v: 'admitted',    label: 'Admitted',    tone: 'info',   count: tabCounts.admitted },
                    { v: 'discharged',  label: 'Discharged',  tone: 'ok',     count: tabCounts.discharged },
                    { v: 'deactivated', label: 'Deactivated', tone: 'danger', count: tabCounts.deactivated },
                  ].map(({ v, label, tone, count }) => {
                    const active = statusFilter === v;
                    const base =
                      tone === 'ok'
                        ? 'bg-ok-50 text-ok-700'
                        : tone === 'danger'
                        ? 'bg-danger-50 text-danger-700'
                        : tone === 'warn'
                        ? 'bg-warn-50 text-warn-700'
                        : 'bg-info-50 text-info-700';
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setStatusFilter(v as any)}
                        className={`pill ${base} ${active ? 'ring-2 ring-brand-600/30' : 'opacity-70 hover:opacity-100'} transition-opacity`}
                      >
                        {label} · {count}
                      </button>
                    );
                  })}
                </div>
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

              <PatientTable
                patients={sortedPatients}
                loading={loading}
                sortConfig={sortConfig}
                onSort={handleSort}
                onDischarge={handleDischarge}
                onToggleActive={handleToggleActive}
                onViewPhotos={setSelectedPatientForPhotos}
                canDischarge={canDischargePatient}
                canToggleActive={canToggleActiveStatus}
                dischargingId={dischargingId}
                togglingActiveId={togglingActiveId}
              />

              <div className="flex items-center justify-between px-2 py-4 border-t">
                <div className="text-sm text-muted-foreground">
                  Showing page <span className="font-medium">{meta?.currentPage || 1}</span> of{" "}
                  <span className="font-medium">{meta?.totalPages || 1}</span>
                </div>
                <div className="flex items-center space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((prev) => Math.max(prev - 1, 1))}
                    disabled={page === 1 || loading}
                  >
                    Previous
                  </Button>

                  {/* Simple Page Numbers */}
                  <div className="flex items-center gap-1">
                    {Array.from({ length: meta?.totalPages || 1 }, (_, i) => i + 1)
                      .filter(
                        (p) => p === 1 || p === meta?.totalPages || Math.abs(p - page) <= 1
                      )
                      .map((p, idx, arr) => (
                        <React.Fragment key={p}>
                          {idx > 0 && arr[idx - 1] !== p - 1 && (
                            <span className="text-muted-foreground">...</span>
                          )}
                          <Button
                            variant={page === p ? "default" : "ghost"}
                            size="sm"
                            className="w-8 h-8 p-0"
                            onClick={() => setPage(p)}
                          >
                            {p}
                          </Button>
                        </React.Fragment>
                      ))}
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPage((prev) => Math.min(prev + 1, meta?.totalPages || 1))
                    }
                    disabled={page === meta?.totalPages || loading}
                  >
                    Next
                  </Button>
                </div>
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
          onClose={(shouldRefresh) => {
            setSelectedPatientForPhotos(null);
            if (shouldRefresh) {
              setRefreshTrigger(prev => prev + 1);
            }
          }}
          onUpdate={
            user?.role === "admin" || user?.role === "superadmin" ? handlePatientUpdate : undefined
          }
        />
      )}
      </AnimatedPage>
    </>
  );
};

export default PanelPatientsPage;
