import React, { useState, useEffect } from "react";
import apiService from "../../services/api";
import { Panel } from "../../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Search, Plus, Loader2, FileText, Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface MasterPanelManagementProps {
    onPanelCreated?: () => void;
}

const MasterPanelManagement: React.FC<MasterPanelManagementProps> = ({ onPanelCreated }) => {
    const [panels, setPanels] = useState<Panel[]>([]);
    const [loading, setLoading] = useState(true);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newPanelName, setNewPanelName] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [searchTerm, setSearchTerm] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchPanels();
    }, []);

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

    const handleCreatePanel = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newPanelName.trim()) return;

        try {
            setIsSubmitting(true);
            setError(null);
            await apiService.createMasterPanel(newPanelName.trim());
            setNewPanelName("");
            setShowCreateModal(false);
            fetchPanels();
            onPanelCreated?.();
        } catch (err: any) {
            setError(err.response?.data?.message || "Failed to create panel");
        } finally {
            setIsSubmitting(false);
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

    // Reset modal state when closed
    useEffect(() => {
        if (!showCreateModal) {
            setNewPanelName("");
            setError(null);
        }
    }, [showCreateModal]);

    return (
        <div className="space-y-6">
            {/* Header Actions */}
            <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                <div className="relative w-full sm:w-[300px]">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search panels..."
                        className="pl-9"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <Button onClick={() => setShowCreateModal(true)} className="gap-2">
                    <Plus className="h-4 w-4" />
                    Create Panel
                </Button>
            </div>

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
                                            {!searchTerm && (
                                                <Button variant="outline" onClick={() => setShowCreateModal(true)} className="mt-4">
                                                    Create Panel
                                                </Button>
                                            )}
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

            {/* Create Panel Modal */}
            <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create New Master Panel</DialogTitle>
                        <DialogDescription>
                            Add a new insurance panel or TPA to the master list.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleCreatePanel} className="space-y-4 py-4">
                        <div className="space-y-2">
                            <label htmlFor="panelName" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                                Panel Name <span className="text-destructive">*</span>
                            </label>
                            <Input
                                id="panelName"
                                value={newPanelName}
                                onChange={(e) => setNewPanelName(e.target.value)}
                                placeholder="e.g., PMJAY, Star Health, HDFC Ergo"
                                autoFocus
                            />
                        </div>
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setShowCreateModal(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={isSubmitting || !newPanelName.trim()}>
                                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                {isSubmitting ? "Creating..." : "Create Panel"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default MasterPanelManagement;

