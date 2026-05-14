import React, { useState, useMemo } from "react";
import { HospitalPanel, User, Hospital } from "../../../../types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
    LayoutGrid,
    Plus,
    AppWindow,
    ChevronRight,
    ArrowUpDown,
    ArrowUp,
    ArrowDown,
} from "lucide-react";

interface PanelsListProps {
    hospitalPanels: HospitalPanel[];
    loading: boolean;
    user: User | null;
    hospital: Hospital | null;
    onPanelSelect: (panel: HospitalPanel) => void;
    onLinkPanel: () => void;
}

type SortKey = "panel_name" | "total" | "admitted" | "discharged";
type SortDir = "asc" | "desc";

/**
 * Panels list — sortable table view.
 * Replaces the previous card-grid (PanelCard) layout.
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
        (user?.role === "admin" && (hospital as any)?.can_edit);

    const [sortKey, setSortKey] = useState<SortKey>("panel_name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(key);
            // Numeric columns default to descending (most loaded first).
            setSortDir(key === "panel_name" ? "asc" : "desc");
        }
    };

    const toNum = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;

    const sortedPanels = useMemo(() => {
        const arr = [...hospitalPanels];
        const dir = sortDir === "asc" ? 1 : -1;
        arr.sort((a, b) => {
            switch (sortKey) {
                case "panel_name":
                    return (a.panel_name || "").localeCompare(b.panel_name || "") * dir;
                case "total":
                    return (toNum(a.total_count) - toNum(b.total_count)) * dir;
                case "admitted":
                    return (toNum(a.admitted_count) - toNum(b.admitted_count)) * dir;
                case "discharged":
                    return (toNum(a.discharged_count) - toNum(b.discharged_count)) * dir;
                default:
                    return 0;
            }
        });
        return arr;
    }, [hospitalPanels, sortKey, sortDir]);

    const SortIndicator: React.FC<{ active: boolean }> = ({ active }) => {
        if (!active) return <ArrowUpDown className="ml-1 h-3.5 w-3.5 opacity-40" />;
        return sortDir === "asc" ? (
            <ArrowUp className="ml-1 h-3.5 w-3.5" />
        ) : (
            <ArrowDown className="ml-1 h-3.5 w-3.5" />
        );
    };

    const Header: React.FC<{
        label: string;
        sortKeyValue: SortKey;
        align?: "left" | "right";
    }> = ({ label, sortKeyValue, align = "left" }) => (
        <button
            type="button"
            onClick={() => toggleSort(sortKeyValue)}
            className={`inline-flex items-center hover:text-foreground transition-colors ${
                align === "right" ? "ml-auto" : ""
            }`}
        >
            {label}
            <SortIndicator active={sortKey === sortKeyValue} />
        </button>
    );

    return (
        <Card>
            <CardContent className="p-6">
                {/* Section Header */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg">
                            <LayoutGrid className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                        </div>
                        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
                            Linked Panels
                            <Badge
                                variant="secondary"
                                className="rounded-full px-2 py-0.5 text-xs font-normal"
                            >
                                {hospitalPanels.length}
                            </Badge>
                        </h3>
                    </div>
                    {canLinkPanel && (
                        <Button
                            onClick={onLinkPanel}
                            className="gap-2 bg-brand-600 hover:bg-brand-700"
                        >
                            <Plus className="h-4 w-4" />
                            Link Panel
                        </Button>
                    )}
                </div>

                {/* Empty state */}
                {!loading && hospitalPanels.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                        <div className="h-16 w-16 bg-slate-100 rounded-2xl flex items-center justify-center mb-4">
                            <AppWindow className="h-8 w-8 text-slate-400" />
                        </div>
                        <h4 className="text-lg font-medium text-slate-900 mb-2">
                            No panels linked yet
                        </h4>
                        <p className="text-slate-500 max-w-sm mb-6">
                            Link a panel to start managing patients under different insurance
                            schemes or categories.
                        </p>
                        {user?.role === "superadmin" && (
                            <Button onClick={onLinkPanel} variant="outline" className="gap-2">
                                <Plus className="h-4 w-4" />
                                Link First Panel
                            </Button>
                        )}
                    </div>
                ) : (
                    <div className="rounded-lg border border-slate-200 overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow className="bg-slate-50/80">
                                    <TableHead className="w-[40%]">
                                        <Header label="Panel" sortKeyValue="panel_name" />
                                    </TableHead>
                                    <TableHead className="text-right">
                                        <Header label="Total" sortKeyValue="total" align="right" />
                                    </TableHead>
                                    <TableHead className="text-right">
                                        <Header label="Admitted" sortKeyValue="admitted" align="right" />
                                    </TableHead>
                                    <TableHead className="text-right">
                                        <Header label="Discharged" sortKeyValue="discharged" align="right" />
                                    </TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {loading ? (
                                    [...Array(4)].map((_, i) => (
                                        <TableRow key={i}>
                                            <TableCell>
                                                <div className="flex items-center gap-3">
                                                    <div className="h-9 w-9 rounded-lg bg-slate-200 animate-pulse" />
                                                    <div className="h-4 w-40 rounded bg-slate-200 animate-pulse" />
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="h-4 w-8 ml-auto rounded bg-slate-200 animate-pulse" />
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="h-4 w-8 ml-auto rounded bg-slate-200 animate-pulse" />
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="h-4 w-8 ml-auto rounded bg-slate-200 animate-pulse" />
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="h-8 w-24 ml-auto rounded bg-slate-200 animate-pulse" />
                                            </TableCell>
                                        </TableRow>
                                    ))
                                ) : (
                                    sortedPanels.map((panel) => {
                                        const total = toNum(panel.total_count);
                                        const admitted = toNum(panel.admitted_count);
                                        const discharged = toNum(panel.discharged_count);
                                        return (
                                            <TableRow
                                                key={panel.id}
                                                className="cursor-pointer hover:bg-muted/50 transition-colors group"
                                                onClick={() => onPanelSelect(panel)}
                                            >
                                                <TableCell className="font-medium">
                                                    <div className="flex items-center gap-3">
                                                        <Avatar className="h-9 w-9 rounded-lg">
                                                            <AvatarFallback className="rounded-lg bg-brand-50 text-brand-600 font-bold text-sm">
                                                                {panel.panel_name?.charAt(0).toUpperCase() || "P"}
                                                            </AvatarFallback>
                                                        </Avatar>
                                                        <span className="text-slate-900 group-hover:text-primary transition-colors">
                                                            {panel.panel_name || "Unnamed panel"}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums font-medium">
                                                    {total}
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums">
                                                    {admitted > 0 ? (
                                                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                                                            {admitted}
                                                        </span>
                                                    ) : (
                                                        <span className="text-slate-400">0</span>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums text-slate-600">
                                                    {discharged}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="gap-1 group-hover:text-primary"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            onPanelSelect(panel);
                                                        }}
                                                    >
                                                        View Patients
                                                        <ChevronRight className="h-3.5 w-3.5 group-hover:translate-x-0.5 transition-transform" />
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })
                                )}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export default PanelsList;
