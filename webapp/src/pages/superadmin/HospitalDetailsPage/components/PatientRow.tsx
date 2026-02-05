import React, { useState } from "react";
import { motion } from "framer-motion";
import apiService from "../../../../services/api";
import { Patient } from "../../../../types";
import { getInitials, formatDate } from "../utils/formatters";
import { TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Loader2, ChevronRight } from "lucide-react";

interface PatientRowProps {
    patient: Patient;
    onClick: () => void;
    onDischarge?: (e: React.MouseEvent) => void;
    canDischarge?: boolean;
    isDischarging?: boolean;
    onToggleActive?: (e: React.MouseEvent) => void;
    canToggleActive?: boolean;
    isTogglingActive?: boolean;
    hideActions?: boolean;
    hideGeneratePdf?: boolean;
}

/**
 * Patient table row component
 */
const PatientRow: React.FC<PatientRowProps> = ({
    patient,
    onClick,
    onDischarge,
    canDischarge = false,
    isDischarging = false,
    onToggleActive,
    canToggleActive = false,
    isTogglingActive = false,
    hideActions = false,
    hideGeneratePdf = false
}) => {
    const isAdmitted = !patient.discharged_at;
    const [isGenerating, setIsGenerating] = useState(false);

    return (
        <motion.tr
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            whileHover={{
                backgroundColor: "rgba(0, 0, 0, 0.02)",
                scale: 1.002,
                transition: { duration: 0.15 }
            }}
            className="cursor-pointer transition-all duration-200 hover:bg-muted/50 hover:shadow-sm border-b"
            onClick={onClick}
        >
            <TableCell>
                <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                        <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                            {getInitials(patient.first_name, patient.last_name)}
                        </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                        <span className="font-medium">
                            {patient.first_name} {patient.last_name}
                        </span>
                    </div>
                </div>
            </TableCell>
            <TableCell>
                <span className="font-mono text-sm text-muted-foreground">{formatDate(patient.updated_at)}</span>
            </TableCell>
            <TableCell>
                <span className="text-sm text-muted-foreground">{formatDate(patient.admitted_at)}</span>
            </TableCell>
            <TableCell>
                <Badge
                    variant="outline"
                    className={`capitalize ${patient.admission_type === 'surgical'
                        ? 'border-red-200 bg-red-50 text-red-700 hover:bg-red-50'
                        : 'border-yellow-200 bg-yellow-50 text-yellow-700 hover:bg-yellow-50'
                        }`}
                >
                    {patient.admission_type || "—"}
                </Badge>
            </TableCell>
            <TableCell>
                {patient.discharged_at ? (
                    <Badge variant="secondary">Discharged</Badge>
                ) : (
                    <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-green-200">Admitted</Badge>
                )}
            </TableCell>
            {!hideActions && (
                <TableCell>
                    <div className="flex items-center gap-2">
                        {canDischarge && isAdmitted && onDischarge && (
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDischarge(e);
                                }}
                                disabled={isDischarging}
                            >
                                {isDischarging ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                                {isDischarging ? 'Discharging...' : 'Discharge'}
                            </Button>
                        )}
                        {canToggleActive && onToggleActive && (
                            <Button
                                variant={patient.is_active !== false ? "secondary" : "default"}
                                size="sm"
                                className={patient.is_active === false ? "bg-green-600 hover:bg-green-700" : "bg-amber-600 hover:bg-amber-700 text-white"}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleActive(e);
                                }}
                                disabled={isTogglingActive}
                            >
                                {isTogglingActive ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                                {isTogglingActive ? 'Updating...' : (patient.is_active !== false ? 'Deactivate' : 'Activate')}
                            </Button>
                        )}
                    </div>
                </TableCell>
            )}
            {!hideGeneratePdf && (
                <TableCell>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={isGenerating}
                        onClick={async (e) => {
                            e.stopPropagation();
                            setIsGenerating(true);
                            await apiService.generatePDF(patient.id);
                            setIsGenerating(false);
                        }}
                    >
                        {isGenerating ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : null}
                        {isGenerating ? "Generating..." : "Generate PDF"}
                    </Button>
                </TableCell>
            )}
            {(hideActions && hideGeneratePdf) && (
                <TableCell>
                    <div className="flex justify-end pr-4">
                        <ChevronRight className="h-5 w-5 text-slate-400" />
                    </div>
                </TableCell>
            )}
        </motion.tr>
    );
};

export default PatientRow;
