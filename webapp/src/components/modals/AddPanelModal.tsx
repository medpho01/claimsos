import React, { useState, useEffect } from "react";
import apiService from "../../services/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

interface AddPanelModalProps {
    onClose: () => void;
    onSuccess: () => void;
}

const AddPanelModal: React.FC<AddPanelModalProps> = ({ onClose, onSuccess }) => {
    const [newPanelName, setNewPanelName] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleCreatePanel = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newPanelName.trim()) return;

        try {
            setIsSubmitting(true);
            setError(null);
            await apiService.createMasterPanel(newPanelName.trim());
            setNewPanelName("");
            onSuccess();
        } catch (err: any) {
            setError(err.response?.data?.message || "Failed to create panel");
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <Dialog open={true} onOpenChange={onClose}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create New Master Panel</DialogTitle>
                    <DialogDescription>
                        Add a new insurance panel or TPA to the master list.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleCreatePanel} className="space-y-4 py-4">
                    {error && (
                        <div className="bg-destructive/15 text-destructive px-4 py-3 rounded-md text-sm font-medium">
                            {error}
                        </div>
                    )}
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
                        <Button type="button" variant="outline" onClick={onClose}>
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
    );
};

export default AddPanelModal;
