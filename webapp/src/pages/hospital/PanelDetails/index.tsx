import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { useHospitalDataContext } from "../../hospital/context/HospitalDataContext";
import apiService from "../../../services/api";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, Plus } from "lucide-react";
import { Patient, HospitalPanel } from "../../../types";
import PatientTable from "../../../pages/panels/components/PatientTable";
import PatientModal from "@/components/modals/PatientModal";
import PatientPhotosModal from "@/components/modals/PatientPhotosModal";
import { usePatientActions } from "../../superadmin/HospitalDetailsPage/hooks/usePatientActions";
import { toast } from "sonner";
import { motion } from "framer-motion";

/**
 * Hospital Panel Details Page
 * View patients within a specific panel.
 */
const HospitalPanelDetails: React.FC = () => {
    const { hospitalId, panelId } = useParams<{ hospitalId: string; panelId: string }>();
    const navigate = useNavigate();
    const { user } = useAuth();

    // Get context data
    const { hospitalPanels } = useHospitalDataContext();

    // State
    const [panel, setPanel] = useState<HospitalPanel | null>(null);
    const [patients, setPatients] = useState<Patient[]>([]);
    const [loadingPatients, setLoadingPatients] = useState(true);
    const [searchTerm, setSearchTerm] = useState("");
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);

    // Photos modal state
    const [isPhotosModalOpen, setIsPhotosModalOpen] = useState(false);
    const [selectedPhotosPatient, setSelectedPhotosPatient] = useState<Patient | null>(null);

    // Find panel from context instead of fetching
    useEffect(() => {
        if (hospitalPanels.length > 0 && panelId) {
            const found = hospitalPanels.find(p => p.id === panelId);
            if (found) {
                setPanel(found);
            }
        }
    }, [hospitalPanels, panelId]);

    // Fetch Patients - uses panel.panel_id (actual panel ID from panels table)
    const fetchPatients = async () => {
        if (!hospitalId || !panel?.panel_id) return;
        setLoadingPatients(true);
        try {
            const res = await apiService.getHospitalPanelPatients(hospitalId, panel.panel_id);
            // Paginated response: res.data.data = { data: [...patients], meta: {...} }
            setPatients(res.data.data.data || []);
        } catch (err) {
            console.error("Failed to load patients", err);
            toast.error("Failed to load patients");
        } finally {
            setLoadingPatients(false);
        }
    };

    useEffect(() => {
        if (panel?.panel_id) {
            fetchPatients();
        }
    }, [hospitalId, panel?.panel_id]);

    // Hook for actions
    const {
        handleDischarge,
        handlePatientUpdate,
        handleAddPatient,
        handleToggleActive
    } = usePatientActions({
        patients,
        setPatients,
        selectedPatientForPhotos: selectedPhotosPatient,
        setSelectedPatientForPhotos: setSelectedPhotosPatient,
    });

    // Handlers
    const handleDeletePatient = async (patientId: string) => {
        if (!window.confirm("Are you sure you want to delete this patient?")) return;
        try {
            await apiService.deletePatient(patientId);
            setPatients(prev => prev.filter(p => p.id !== patientId));
            toast.success("Patient deleted successfully");
        } catch (err) {
            console.error("Failed to delete patient", err);
            toast.error("Failed to delete patient");
        }
    };

    const handleViewPhotos = (patient: Patient) => {
        setSelectedPhotosPatient(patient);
        setIsPhotosModalOpen(true);
    };

    const filteredPatients = patients.filter(p =>
        p.first_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.last_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.phone.includes(searchTerm)
    );

    return (
        <motion.div
            className="p-6"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
        >
            <div className="max-w-[1400px] mx-auto">

                {/* Header Navigation */}
                <div className="flex items-center gap-4 mb-6">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`/portal/${hospitalId}`)}
                        className="rounded-full hover:bg-slate-100"
                    >
                        <ArrowLeft className="h-5 w-5" />
                    </Button>
                    <div>
                        <h1 className="text-2xl font-bold text-slate-900">
                            {panel?.panel_name || "Panel Details"}
                        </h1>
                        <p className="text-slate-500 text-sm">Patient Management</p>
                    </div>
                </div>

                {/* Actions Bar */}
                <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mb-6">
                    <div className="w-full sm:w-72">
                        <input
                            type="text"
                            placeholder="Search patients..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full px-4 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-sans"
                        />
                    </div>
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <Button
                            variant="outline"
                            onClick={fetchPatients}
                            disabled={loadingPatients}
                            className="gap-2"
                        >
                            <RefreshCw className={`h-4 w-4 ${loadingPatients ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                        <Button
                            onClick={() => setIsAddModalOpen(true)}
                            className="gap-2 bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/20"
                        >
                            <Plus className="h-4 w-4" />
                            Add Patient
                        </Button>
                    </div>
                </div>

                {/* Patient Table */}
                <PatientTable
                    patients={filteredPatients}
                    loading={loadingPatients}
                    onEdit={(p) => setSelectedPatient(p)}
                    onDelete={handleDeletePatient}
                    onDischarge={handleDischarge}
                    onViewPhotos={handleViewPhotos}
                    userRole={user?.role}
                    canEdit={true}
                    canDischarge={true}
                    onToggleActive={handleToggleActive}
                    hideActions={true}
                    hideGeneratePdf={true}
                />
            </div>

            {/* Modals */}
            {(isAddModalOpen || selectedPatient) && (
                <PatientModal
                    patient={selectedPatient}
                    fixedHospitalId={hospitalId}
                    fixedPanelId={panel?.panel_id}
                    onClose={() => {
                        setIsAddModalOpen(false);
                        setSelectedPatient(null);
                    }}
                    onSuccess={() => {
                        fetchPatients();
                        setIsAddModalOpen(false);
                        setSelectedPatient(null);
                        toast.success(selectedPatient ? "Patient updated successfully" : "Patient added successfully");
                    }}
                />
            )}

            {isPhotosModalOpen && selectedPhotosPatient && (
                <PatientPhotosModal
                    patient={selectedPhotosPatient}
                    onClose={(shouldRefresh) => {
                        setIsPhotosModalOpen(false);
                        if (shouldRefresh) {
                            fetchPatients(); // Only refresh if changes occurred
                        }
                    }}
                />
            )}
        </motion.div>
    );
};

export default HospitalPanelDetails;
