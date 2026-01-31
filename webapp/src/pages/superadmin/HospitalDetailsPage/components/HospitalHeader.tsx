import React from "react";
import { Hospital, HospitalPanel, Patient } from "../../../../types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { MapPin, Folder, FileSpreadsheet, LayoutGrid, Users, CheckCircle2 } from "lucide-react";

interface HospitalHeaderProps {
    hospital: Hospital | null;
    hospitalPanels: HospitalPanel[];
    selectedPanel: HospitalPanel | null;
    loading: boolean;
}

/**
 * Hospital header component showing hospital info and stats badges
 */
const HospitalHeader: React.FC<HospitalHeaderProps> = ({
    hospital,
    hospitalPanels,
    selectedPanel,
    loading,
}) => {
    // const admittedCount = patients.filter((p) => !p.discharged_at).length;

    if (loading) {
        return (
            <div className="max-w-[1400px] mx-auto mb-8 animate-pulse">
                <div className="flex items-center gap-4">
                    <div className="h-16 w-16 bg-slate-200 rounded-xl" />
                    <div className="space-y-2">
                        <div className="h-8 w-64 bg-slate-200 rounded" />
                        <div className="h-4 w-48 bg-slate-200 rounded" />
                    </div>
                </div>
            </div>
        );
    }

    if (!hospital) return null;

    return (
        <header className="max-w-[1400px] mx-auto mb-8">
            <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
                {/* Only show hospital info row when viewing panels list (not when viewing a panel's patients) */}
                {!selectedPanel && (
                    <div className="flex items-start gap-4">
                        <Avatar className="h-16 w-16 rounded-xl">
                            <AvatarFallback className="rounded-xl bg-indigo-600 text-white text-2xl font-bold">
                                {hospital.name.charAt(0).toUpperCase()}
                            </AvatarFallback>
                        </Avatar>
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-50 mb-2">
                                {hospital.name}
                            </h1>
                            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                                <div className="flex items-center gap-1">
                                    <MapPin className="h-4 w-4" />
                                    <span>{hospital.city || "No city"}</span>
                                </div>
                                {hospital.drive_folder_id && (
                                    <a
                                        href={`https://drive.google.com/drive/folders/${hospital.drive_folder_id}`}
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
                )}

                {/* Stats badges in header - only show when viewing panels list */}
                {!selectedPanel && (
                    <div className="flex gap-3 flex-wrap">
                        <Badge variant="outline" className="px-3 py-1.5 text-sm flex gap-2 border-slate-200 bg-white">
                            <LayoutGrid className="h-4 w-4 text-blue-600" />
                            <span className="font-medium text-slate-700">
                                {hospitalPanels.length} Panel{hospitalPanels.length !== 1 ? "s" : ""}
                            </span>
                        </Badge>
                        <Badge variant="outline" className="px-3 py-1.5 text-sm flex gap-2 border-slate-200 bg-white">
                            <Users className="h-4 w-4 text-green-600" />
                            <span className="font-medium text-slate-700">
                                {/* {patients.length} Patient{patients.length !== 1 ? "s" : ""} */}
                            </span>
                        </Badge>
                        <Badge className="px-3 py-1.5 text-sm flex gap-2 bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200">
                            <CheckCircle2 className="h-4 w-4" />
                            {/* <span>{admittedCount} Admitted</span> */}
                        </Badge>
                    </div>
                )}
            </div>
        </header>
    );
};

export default HospitalHeader;
