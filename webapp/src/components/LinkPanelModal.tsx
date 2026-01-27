import React, { useState, useEffect } from "react";
import apiService from "../services/api";
import { Panel } from "../types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface LinkPanelModalProps {
    hospitalId: string;
    onClose: () => void;
    onSuccess: () => void;
}

const LinkPanelModal: React.FC<LinkPanelModalProps> = ({ hospitalId, onClose, onSuccess }) => {
    const [panels, setPanels] = useState<Panel[]>([]);
    const [selectedPanelId, setSelectedPanelId] = useState<string>("");
    const [loading, setLoading] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Optional panel config
    const [contact, setContact] = useState("");
    const [sheetId, setSheetId] = useState("");
    const [sheetName, setSheetName] = useState("");
    const [whatsAppGroupId, setWhatsAppGroupId] = useState("");

    // Create new panel mode
    const [showCreateNew, setShowCreateNew] = useState(false);
    const [newPanelName, setNewPanelName] = useState("");
    const [isCreatingPanel, setIsCreatingPanel] = useState(false);

    // Styling for select to match Input
    const selectClassName = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";


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

    const handleCreateNewPanel = async () => {
        if (!newPanelName.trim()) return;

        try {
            setIsCreatingPanel(true);
            setError(null);
            const res = await apiService.createMasterPanel(newPanelName.trim());
            const newPanel = res.data.data;

            // Add to list and select it
            setPanels(prev => [...prev, newPanel]);
            setSelectedPanelId(newPanel.id);
            setNewPanelName("");
            setShowCreateNew(false);
        } catch (err: any) {
            setError(err.response?.data?.message || "Failed to create panel");
        } finally {
            setIsCreatingPanel(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedPanelId) {
            setError("Please select a panel");
            return;
        }

        try {
            setIsSubmitting(true);
            setError(null);

            await apiService.linkPanelToHospital({
                hospitalId,
                panelId: selectedPanelId,
                contact: contact || undefined,
                sheetId: sheetId || undefined,
                sheetName: sheetName || undefined,
                whatsAppGroupId: whatsAppGroupId || undefined,
            });

            onSuccess();
        } catch (err: any) {
            setError(err.response?.data?.message || "Failed to link panel");
        } finally {
            setIsSubmitting(false);
        }
    };

    const selectedPanel = panels.find(p => p.id === selectedPanelId);

    const handleOpenChange = (open: boolean) => {
        if (!open) onClose();
    }

    return (
        <Dialog open={true} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Link Panel to Hospital</DialogTitle>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="grid gap-4 py-2">
                    {error && (
                        <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md">
                            {error}
                        </div>
                    )}

                    {/* Panel Selection */}
                    <div className="grid gap-2">
                        <Label>Select Panel *</Label>
                        {loading ? (
                            <div className="text-sm text-muted-foreground p-2">Loading panels...</div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <select
                                    value={selectedPanelId}
                                    onChange={(e) => setSelectedPanelId(e.target.value)}
                                    required
                                    className={selectClassName}
                                >
                                    <option value="">-- Select a panel --</option>
                                    {panels.map(panel => (
                                        <option key={panel.id} value={panel.id}>{panel.name}</option>
                                    ))}
                                </select>

                                {/* Create New Toggle */}
                                <button
                                    type="button"
                                    onClick={() => setShowCreateNew(!showCreateNew)}
                                    className="text-sm text-indigo-600 font-medium flex items-center gap-1 hover:text-indigo-700 w-fit"
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M12 5v14M5 12h14" />
                                    </svg>
                                    {showCreateNew ? 'Cancel' : 'Create new panel'}
                                </button>

                                {/* Create New Panel Inline */}
                                {showCreateNew && (
                                    <div className="flex gap-2 p-3 bg-slate-50 rounded-lg border border-slate-100 items-end">
                                        <div className="flex-1 grid gap-1.5">
                                            <Label className="text-xs">New Panel Name</Label>
                                            <Input
                                                type="text"
                                                value={newPanelName}
                                                onChange={(e) => setNewPanelName(e.target.value)}
                                                placeholder="e.g., Star Health"
                                                className="h-9"
                                            />
                                        </div>
                                        <Button
                                            type="button"
                                            onClick={handleCreateNewPanel}
                                            disabled={isCreatingPanel || !newPanelName.trim()}
                                            size="sm"
                                            className="bg-emerald-600 hover:bg-emerald-700"
                                        >
                                            {isCreatingPanel ? '...' : 'Add'}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Optional Configuration */}
                    {selectedPanel && (
                        <div className="border-t pt-4 mt-2 grid gap-4">
                            <h4 className="text-sm font-semibold text-slate-700">
                                Optional Configuration for "{selectedPanel.name}"
                            </h4>

                            <div className="grid gap-2">
                                <Label>Contact Number</Label>
                                <Input
                                    type="tel"
                                    value={contact}
                                    onChange={(e) => setContact(e.target.value)}
                                    placeholder="10-digit phone number"
                                    maxLength={10}
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-2">
                                    <Label>Google Sheet ID</Label>
                                    <Input
                                        type="text"
                                        value={sheetId}
                                        onChange={(e) => setSheetId(e.target.value)}
                                        placeholder="Sheet ID"
                                    />
                                </div>
                                <div className="grid gap-2">
                                    <Label>Sheet Name</Label>
                                    <Input
                                        type="text"
                                        value={sheetName}
                                        onChange={(e) => setSheetName(e.target.value)}
                                        placeholder="e.g., Patients"
                                    />
                                </div>
                            </div>

                            <div className="grid gap-2">
                                <Label>WhatsApp Group ID</Label>
                                <Input
                                    type="text"
                                    value={whatsAppGroupId}
                                    onChange={(e) => setWhatsAppGroupId(e.target.value)}
                                    placeholder="Group ID for notifications"
                                />
                            </div>
                        </div>
                    )}

                    <DialogFooter className="mt-2">
                        <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={isSubmitting || !selectedPanelId}
                        >
                            {isSubmitting ? "Linking..." : "Link Panel"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default LinkPanelModal;
