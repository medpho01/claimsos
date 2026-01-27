import React from "react";
import { HospitalPanel, Patient } from "../../../../types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Phone, ChevronRight, Folder, FileSpreadsheet } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface PanelCardProps {
    panel: HospitalPanel;
    patients: Patient[];
    onClick: () => void;
}

/**
 * Panel card component showing panel info and patient stats
 */
const PanelCard: React.FC<PanelCardProps> = ({ panel, patients, onClick }) => {
    const panelPatientCount = patients.filter((p) => p.panel_id === panel.panel_id).length;
    const admittedInPanel = patients.filter(
        (p) => p.panel_id === panel.panel_id && !p.discharged_at
    ).length;

    return (
        <Card
            className="hover:border-primary/50 hover:shadow-md transition-all cursor-pointer group"
            onClick={onClick}
        >
            <CardContent className="p-5">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <Avatar className="h-11 w-11 rounded-lg">
                            <AvatarFallback className="rounded-lg bg-blue-50 text-blue-600 font-bold text-lg">
                                {panel.panel_name?.charAt(0).toUpperCase() || "P"}
                            </AvatarFallback>
                        </Avatar>
                        <div>
                            <h4 className="font-semibold text-slate-900 group-hover:text-primary transition-colors line-clamp-1">
                                {panel.panel_name}
                            </h4>
                            {panel.contact && (
                                <div className="flex items-center gap-1.5 text-sm text-slate-500 mt-1">
                                    <Phone className="h-3 w-3" />
                                    <span>{panel.contact}</span>
                                </div>
                            )}
                        </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-slate-400 group-hover:text-primary group-hover:translate-x-1 transition-all" />
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                    <div className="flex gap-6">
                        <div className="flex flex-col">
                            <span className="text-xl font-bold text-slate-900 leading-none">{panelPatientCount}</span>
                            <span className="text-xs text-slate-500 mt-1 font-medium">Total</span>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-xl font-bold text-amber-600 leading-none">{admittedInPanel}</span>
                            <span className="text-xs text-slate-500 mt-1 font-medium">Admitted</span>
                        </div>
                    </div>

                    <div className="flex gap-2">
                        {panel.sheet_id && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 px-2 bg-green-50 text-green-700 border-green-200 hover:bg-green-100 focus:ring-0"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    window.open(`https://docs.google.com/spreadsheets/d/${panel.sheet_id}`, '_blank');
                                }}
                                title="Open Google Sheet"
                            >
                                <FileSpreadsheet className="h-3.5 w-3.5 mr-1" />
                                Sheet
                            </Button>
                        )}
                        {panel.drive_folder_id && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 px-2"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    window.open(`https://drive.google.com/drive/folders/${panel.drive_folder_id}`, '_blank');
                                }}
                            >
                                <Folder className="h-3.5 w-3.5 mr-1" />
                                Drive
                            </Button>
                        )}
                    </div>
                </div>
            </CardContent>
        </Card>
    );
};

export default PanelCard;
