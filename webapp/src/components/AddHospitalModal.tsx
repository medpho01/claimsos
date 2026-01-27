import React, { useState } from "react";
import apiService from "../services/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface AddHospitalModalProps {
    onClose: () => void;
    onSuccess: () => void;
}

const AddHospitalModal: React.FC<AddHospitalModalProps> = ({ onClose, onSuccess }) => {
    const [name, setName] = useState("");
    const [city, setCity] = useState("");
    const [driveFolderId, setDriveFolderId] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) {
            setError("Hospital name is required");
            return;
        }

        try {
            setIsSubmitting(true);
            setError(null);
            await apiService.addHospital({
                name: name.trim(),
                city: city.trim(),
                driveFolderId: driveFolderId.trim() || undefined
            });
            onSuccess();
        } catch (err: any) {
            setError(err.response?.data?.message || "Failed to add hospital");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            onClose();
        }
    }

    return (
        <Dialog open={true} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-[450px]">
                <DialogHeader>
                    <DialogTitle>Add New Hospital</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="gap-4 py-4 grid">
                    {error && (
                        <div className="bg-destructive/15 text-destructive text-sm p-3 rounded-md">
                            {error}
                        </div>
                    )}

                    <div className="grid gap-2">
                        <Label htmlFor="name">Hospital Name *</Label>
                        <Input
                            id="name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., City General Hospital"
                            required
                            autoFocus
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="city">City</Label>
                        <Input
                            id="city"
                            value={city}
                            onChange={(e) => setCity(e.target.value)}
                            placeholder="e.g., Mumbai"
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="driveFolderId">
                            Google Drive Folder ID <span className="text-muted-foreground font-normal text-xs">(Optional)</span>
                        </Label>
                        <Input
                            id="driveFolderId"
                            value={driveFolderId}
                            onChange={(e) => setDriveFolderId(e.target.value)}
                            placeholder="Existing Folder ID (Leave empty to auto-create)"
                        />
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isSubmitting || !name.trim()}>
                            {isSubmitting ? "Adding..." : "Add Hospital"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default AddHospitalModal;
