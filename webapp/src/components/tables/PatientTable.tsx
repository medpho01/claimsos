import React from "react";
import { Patient } from "../../types";
import { Button } from "@/components/ui/button";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { ArrowUp, ArrowDown, ArrowUpDown, ChevronRight } from "lucide-react";
import PatientRow from "../../pages/superadmin/HospitalDetailsPage/components/PatientRow";

interface PatientTableProps {
    patients: Patient[];
    loading: boolean;
    sortConfig?: { key: string; direction: "asc" | "desc" } | null;
    onSort?: (key: string) => void;
    onEdit?: (patient: Patient) => void;
    onDelete?: (patientId: string) => void;
    onDischarge: (patientId: string) => void;
    onToggleActive: (patient: Patient) => void;
    onViewPhotos: (patient: Patient) => void; // Used for "Generate PDF" column action roughly or row click
    userRole?: string;
    canEdit?: boolean;
    canDischarge?: boolean | ((patient: Patient) => boolean);
    canToggleActive?: boolean | ((patient: Patient) => boolean);
    dischargingId?: string | null;
    togglingActiveId?: string | null;
    hideActions?: boolean;
    hideGeneratePdf?: boolean;
}

const PatientTable: React.FC<PatientTableProps> = ({
    patients,
    loading,
    sortConfig,
    onSort,
    onDischarge,
    onToggleActive,
    onViewPhotos,
    canDischarge,
    canToggleActive,
    dischargingId,
    togglingActiveId,
    hideActions = false,
    hideGeneratePdf = false
}) => {
    // Helper to evaluate permission
    const checkPermission = (check: boolean | ((p: Patient) => boolean) | undefined, patient: Patient) => {
        if (typeof check === 'function') return check(patient);
        return !!check;
    };

    return (
        <div className="rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-[300px]">Patient</TableHead>
                        <TableHead>
                            <Button
                                variant="ghost"
                                className="p-0 hover:bg-transparent"
                                onClick={() => onSort && onSort("updated_at")}
                            >
                                <div className="flex items-center gap-1">
                                    Last Updated
                                    {sortConfig?.key === "updated_at" ? (
                                        sortConfig.direction === "asc" ? (
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
                                onClick={() => onSort && onSort("admitted_at")}
                            >
                                <div className="flex items-center gap-1">
                                    Admitted On
                                    {sortConfig?.key === "admitted_at" ? (
                                        sortConfig.direction === "asc" ? (
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
                        {!hideActions && <TableHead>Actions</TableHead>}
                        {!hideGeneratePdf && <TableHead>Generate PDF</TableHead>}
                        {(hideActions && hideGeneratePdf) && <TableHead className="w-[50px]"></TableHead>}
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
                    ) : patients.length === 0 ? (
                        <TableRow>
                            <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                                No patients found.
                            </TableCell>
                        </TableRow>
                    ) : (
                        patients.map((patient) => (
                            <PatientRow
                                key={patient.id}
                                patient={patient}
                                onClick={() => onViewPhotos(patient)}
                                onDischarge={() => onDischarge(patient.id)}
                                canDischarge={checkPermission(canDischarge, patient)}
                                isDischarging={dischargingId === patient.id}
                                onToggleActive={() => onToggleActive(patient)}
                                canToggleActive={checkPermission(canToggleActive, patient)}
                                isTogglingActive={togglingActiveId === patient.id}
                                hideActions={hideActions}
                                hideGeneratePdf={hideGeneratePdf}
                            />
                        ))
                    )}
                </TableBody>
            </Table>
        </div>
    );
};

export default PatientTable;
