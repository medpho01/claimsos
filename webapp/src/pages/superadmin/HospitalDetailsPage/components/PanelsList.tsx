import React from "react";
import { HospitalPanel, Patient, User, Hospital } from "../../../../types";
import PanelCard from "./PanelCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LayoutGrid, Plus, AppWindow } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface PanelsListProps {
    hospitalPanels: HospitalPanel[];
    loading: boolean;
    user: User | null;
    hospital: Hospital | null;
    onPanelSelect: (panel: HospitalPanel) => void;
    onLinkPanel: () => void;
}

/**
 * Panels list component with grid of panel cards, loading skeleton, and empty state
 */
const PanelsList: React.FC<PanelsListProps> = ({
    hospitalPanels,
    loading,
    user,
    hospital,
    onPanelSelect,
    onLinkPanel,
}) => {
    const canLinkPanel =
        user?.role === "superadmin" ||
        user?.role === "hospital" ||
        (user?.role === "admin" && (hospital as any)?.can_edit);

    return (
        <Card>
            <CardContent className="p-6">
                {/* Panel Section Header */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg">
                            <LayoutGrid className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                                Linked Panels
                                <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-xs font-normal">
                                    {hospitalPanels.length}
                                </Badge>
                            </h3>
                        </div>
                    </div>
                    {canLinkPanel && (
                        <Button onClick={onLinkPanel} className="gap-2 bg-blue-600 hover:bg-blue-700">
                            <Plus className="h-4 w-4" />
                            Link Panel
                        </Button>
                    )}
                </div>

                {loading ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className="h-40 rounded-xl border border-slate-200 bg-slate-50/50 animate-pulse p-5">
                                <div className="flex items-center gap-4 mb-4">
                                    <div className="h-12 w-12 rounded-lg bg-slate-200" />
                                    <div className="flex-1 space-y-2">
                                        <div className="h-4 w-2/3 bg-slate-200 rounded" />
                                        <div className="h-3 w-1/3 bg-slate-200 rounded" />
                                    </div>
                                </div>
                                <div className="h-px bg-slate-200 my-4" />
                                <div className="flex justify-between">
                                    <div className="h-8 w-16 bg-slate-200 rounded" />
                                    <div className="h-8 w-16 bg-slate-200 rounded" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : hospitalPanels.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                        <div className="h-16 w-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                            <AppWindow className="h-8 w-8 text-slate-400" />
                        </div>
                        <h4 className="text-lg font-medium text-slate-900 mb-2">No panels linked yet</h4>
                        <p className="text-slate-500 max-w-sm mb-6">
                            Link a panel to start managing patients under different insurance schemes or categories.
                        </p>
                        {(user?.role === "superadmin" || user?.role === "hospital") && (
                            <Button onClick={onLinkPanel} variant="outline" className="gap-2">
                                <Plus className="h-4 w-4" />
                                Link First Panel
                            </Button>
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {hospitalPanels.map((panel) => (
                            <PanelCard
                                key={panel.id}
                                panel={panel}
                                onClick={() => onPanelSelect(panel)}
                            />
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export default PanelsList;
