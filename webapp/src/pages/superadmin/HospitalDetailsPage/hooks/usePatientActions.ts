import { useState } from "react";
import apiService from "../../../../services/api";
import { Patient, HospitalPanel } from "../../../../types";
import { normalizePhone } from "../utils/formatters";

interface UsePatientActionsParams {
    patients: Patient[];
    setPatients: React.Dispatch<React.SetStateAction<Patient[]>>;
    selectedPatientForPhotos: Patient | null;
    setSelectedPatientForPhotos: React.Dispatch<React.SetStateAction<Patient | null>>;
}

interface NewPatientData {
    firstName: string;
    lastName: string;
    phone: string;
    admittedAt: string;
    admissionType: "conservative" | "surgical" | "";
}

interface UsePatientActionsReturn {
    dischargingId: string | null;
    togglingActiveId: string | null;
    generatingIds: string[];
    isSubmitting: boolean;
    handleDischarge: (patientId: string) => Promise<void>;
    handleGeneratePDF: (patientId: string) => Promise<void>;
    handleTypeChange: (patient: Patient, type: "conservative" | "surgical") => Promise<void>;
    handleToggleActive: (patient: Patient) => Promise<void>;
    handlePatientUpdate: (
        patientId: string,
        data: {
            firstName: string;
            lastName?: string;
            phone: string;
            admittedAt: string;
            admissionType?: "conservative" | "surgical";
            beneficiaryId?: string;
            // Claims fields
            treatmentPlan?: string;
            latestStatus?: string;
            claimAmount?: number;
            claimApproved?: number;
            incentive?: number;
            deduction?: number;
            deductionReason?: string;
            claimSettled?: number;
            claimSettledDate?: string;
        }
    ) => Promise<void>;
    handleAddPatient: (
        e: React.FormEvent,
        newPatient: NewPatientData,
        hospitalId: string,
        selectedPanel: HospitalPanel | null,
        onSuccess: () => void
    ) => Promise<void>;
}

/**
 * Custom hook for patient CRUD operations
 */
export const usePatientActions = ({
    patients,
    setPatients,
    selectedPatientForPhotos,
    setSelectedPatientForPhotos,
}: UsePatientActionsParams): UsePatientActionsReturn => {
    const [dischargingId, setDischargingId] = useState<string | null>(null);
    const [togglingActiveId, setTogglingActiveId] = useState<string | null>(null);
    const [generatingIds, setGeneratingIds] = useState<string[]>([]);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleDischarge = async (patientId: string) => {
        if (!window.confirm("Are you sure you want to discharge this patient?")) return;

        try {
            setDischargingId(patientId);
            const dischargeDate = new Date().toISOString();
            await apiService.dischargePatient(patientId, dischargeDate);

            setPatients((prev) =>
                prev.map((p) => (p.id === patientId ? { ...p, discharged_at: dischargeDate } : p))
            );
        } catch (err) {
            console.error("Failed to discharge patient", err);
            alert("Failed to discharge patient");
        } finally {
            setDischargingId(null);
        }
    };

    const handleGeneratePDF = async (patientId: string) => {
        try {
            setGeneratingIds((prev) => [...prev, patientId]);
            const res = await apiService.generatePDF(patientId);
            if (res.status >= 400) throw new Error("PDF generation failed");
        } catch (err) {
            console.error("PDF generation failed", err);
            alert("PDF generation failed");
        } finally {
            setGeneratingIds((prev) => prev.filter((id) => id !== patientId));
        }
    };

    const handleTypeChange = async (patient: Patient, type: "conservative" | "surgical") => {
        try {
            // Optimistically update UI
            setPatients((prev) =>
                prev.map((p) => (p.id === patient.id ? { ...p, admission_type: type } : p))
            );

            await apiService.updatePatient(patient.id, {
                firstName: patient.first_name,
                lastName: patient.last_name,
                phone: patient.phone,
                admittedAt: patient.admitted_at,
                admissionType: type,
            });
        } catch (err) {
            console.error("Failed to update admission type", err);
            // Revert changes on error
            setPatients((prev) =>
                prev.map((p) =>
                    p.id === patient.id ? { ...p, admission_type: patient.admission_type } : p
                )
            );
            alert("Failed to update admission type");
        }
    };

    const handleToggleActive = async (patient: Patient) => {
        try {
            const newActiveStatus = !patient.is_active;
            setTogglingActiveId(patient.id);

            // Optimistically update UI
            setPatients((prev) =>
                prev.map((p) => (p.id === patient.id ? { ...p, is_active: newActiveStatus } : p))
            );

            await apiService.togglePatientActiveStatus(patient.id, newActiveStatus);
        } catch (err) {
            console.error("Failed to toggle patient active status", err);
            // Revert on error
            setPatients((prev) =>
                prev.map((p) => (p.id === patient.id ? { ...p, is_active: patient.is_active } : p))
            );
            alert("Failed to update patient status");
        } finally {
            setTogglingActiveId(null);
        }
    };

    const handlePatientUpdate = async (
        patientId: string,
        data: {
            firstName: string;
            lastName?: string;
            phone: string;
            admittedAt: string;
            admissionType?: "conservative" | "surgical";
            beneficiaryId?: string;
            // Claims fields
            treatmentPlan?: string;
            latestStatus?: string;
            claimAmount?: number;
            claimApproved?: number;
            incentive?: number;
            deduction?: number;
            deductionReason?: string;
            claimSettled?: number;
            claimSettledDate?: string;
        }
    ) => {
        // Optimistically update UI
        setPatients((prev) =>
            prev.map((p) =>
                p.id === patientId
                    ? {
                        ...p,
                        beneficiary_id: data.beneficiaryId,
                        admission_type: data.admissionType,
                        phone: data.phone,
                        treatment_plan: data.treatmentPlan,
                        latest_status: data.latestStatus,
                        claim_amount: data.claimAmount,
                        claim_approved: data.claimApproved,
                        incentive: data.incentive,
                        deduction: data.deduction,
                        deduction_reason: data.deductionReason,
                        claim_settled: data.claimSettled,
                        claim_settled_date: data.claimSettledDate,
                    }
                    : p
            )
        );

        // Also update the selected patient for photos modal
        if (selectedPatientForPhotos?.id === patientId) {
            setSelectedPatientForPhotos((prev) =>
                prev
                    ? {
                        ...prev,
                        beneficiary_id: data.beneficiaryId,
                        admission_type: data.admissionType,
                        phone: data.phone,
                        treatment_plan: data.treatmentPlan,
                        latest_status: data.latestStatus,
                        claim_amount: data.claimAmount,
                        claim_approved: data.claimApproved,
                        incentive: data.incentive,
                        deduction: data.deduction,
                        deduction_reason: data.deductionReason,
                        claim_settled: data.claimSettled,
                        claim_settled_date: data.claimSettledDate,
                    }
                    : null
            );
        }

        await apiService.updatePatient(patientId, data);
    };

    const handleAddPatient = async (
        e: React.FormEvent,
        newPatient: NewPatientData,
        hospitalId: string,
        selectedPanel: HospitalPanel | null,
        onSuccess: () => void
    ) => {
        e.preventDefault();
        if (!newPatient.firstName || !hospitalId || !selectedPanel) return;

        try {
            setIsSubmitting(true);
            const response = await apiService.addPatient({
                firstName: newPatient.firstName,
                lastName: newPatient.lastName,
                phone: normalizePhone(newPatient.phone),
                hospitalId: hospitalId,
                panelId: selectedPanel.panel_id,
                admittedAt: newPatient.admittedAt ? new Date(newPatient.admittedAt).toISOString() : new Date().toISOString(),
                admissionType: newPatient.admissionType || undefined,
            });

            // Add to local state
            const addedPatient = { ...response.data.data, is_active: true };
            setPatients((prev) => [addedPatient, ...prev]);

            onSuccess();
        } catch (err: any) {
            console.error("Failed to add patient", err);
            alert(err.response?.data?.message || "Failed to add patient");
        } finally {
            setIsSubmitting(false);
        }
    };

    return {
        dischargingId,
        togglingActiveId,
        generatingIds,
        isSubmitting,
        handleDischarge,
        handleGeneratePDF,
        handleTypeChange,
        handleToggleActive,
        handlePatientUpdate,
        handleAddPatient,
    };
};
