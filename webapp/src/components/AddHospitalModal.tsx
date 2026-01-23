import React, { useState } from "react";
import apiService from "../services/api";

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

    return (
        <div className="modal-overlay">
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '450px' }}>
                <div className="modal-header">
                    <h2>Add New Hospital</h2>
                    <button className="modal-close" onClick={onClose}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="modal-form">
                    {error && (
                        <div style={{
                            background: '#fef2f2',
                            color: '#dc2626',
                            padding: '0.75rem 1rem',
                            borderRadius: '8px',
                            marginBottom: '1rem',
                            fontSize: '0.875rem'
                        }}>
                            {error}
                        </div>
                    )}

                    <div className="form-group">
                        <label>Hospital Name *</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., City General Hospital"
                            required
                            autoFocus
                        />
                    </div>

                    <div className="form-group">
                        <label>City</label>
                        <input
                            type="text"
                            value={city}
                            onChange={(e) => setCity(e.target.value)}
                            placeholder="e.g., Mumbai"
                        />
                    </div>

                    <div className="form-group">
                        <label>Google Drive Folder ID <span style={{ color: '#6b7280', fontWeight: 'normal', fontSize: '0.875rem' }}>(Optional)</span></label>
                        <input
                            type="text"
                            value={driveFolderId}
                            onChange={(e) => setDriveFolderId(e.target.value)}
                            placeholder="Existing Folder ID (Leave empty to auto-create)"
                        />
                    </div>

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-cancel">
                            Cancel
                        </button>
                        <button type="submit" disabled={isSubmitting || !name.trim()} className="btn-submit">
                            {isSubmitting ? "Adding..." : "Add Hospital"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default AddHospitalModal;
