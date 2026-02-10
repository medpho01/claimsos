import React, { useState, useEffect } from "react";
import apiService from "../../services/api";
import { Panel } from "../../types";
import { Button } from "@/components/ui/button";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, FileText, Calendar } from "lucide-react";

interface MasterPanelManagementProps {
    onPanelCreated?: () => void;
    refreshTrigger?: number;
    searchTerm: string;
}

const MasterPanelManagement: React.FC<MasterPanelManagementProps> = ({ onPanelCreated, refreshTrigger = 0, searchTerm }) => {
    const [panels, setPanels] = useState<Panel[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchPanels();
    }, [refreshTrigger]);

    const fetchPanels = async () => {
        try {
            setLoading(true);
            const res = await apiService.getAllMasterPanels();
            setPanels(res.data.data || []);
        } catch (err) {
            console.error("Failed to fetch panels", err);
            setError("Failed to load panels");
        } finally {
            setLoading(false);
        }
    };

    const filteredPanels = panels.filter(panel =>
        panel.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const formatDate = (dateString?: string) => {
        if (!dateString) return "—";
        return new Date(dateString).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
            year: "numeric",
        });
    };

    return (
        <div className="space-y-6">
            {error && (
                <div className="bg-destructive/15 text-destructive px-4 py-3 rounded-md text-sm font-medium">
                    {error}
                </div>
            )}

            {/* Panel List */}
            <Card>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Panel Name</TableHead>
                                <TableHead>Created Date</TableHead>
                                <TableHead className="text-right">Action</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {loading ? (
                                <TableRow>
                                    <TableCell colSpan={3} className="h-32 text-center">
                                        <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
                                            <Loader2 className="h-8 w-8 animate-spin" />
                                            <p>Loading panels...</p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : filteredPanels.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={3} className="h-64 text-center">
                                        <div className="flex flex-col items-center justify-center gap-2">
                                            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-2">
                                                <FileText className="h-6 w-6 text-muted-foreground" />
                                            </div>
                                            <h3 className="text-lg font-semibold">No panels found</h3>
                                            <p className="text-muted-foreground text-sm max-w-sm mx-auto">
                                                {searchTerm ? "No panels match your search." : "Get started by creating your first master panel."}
                                            </p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredPanels.map((panel) => (
                                    <TableRow key={panel.id} className="group">
                                        <TableCell className="font-medium">
                                            <div className="flex items-center gap-3">
                                                <div className="h-9 w-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center text-sm font-bold dark:bg-blue-900/20 dark:text-blue-400">
                                                    {panel.name.charAt(0).toUpperCase()}
                                                </div>
                                                <span>{panel.name}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-2 text-muted-foreground text-sm">
                                                <Calendar className="h-3.5 w-3.5" />
                                                {formatDate(panel.created_at)}
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button variant="ghost" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity">
                                                Details
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

export default MasterPanelManagement;

