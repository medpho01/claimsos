import React, { useState, useEffect } from "react";
import apiService from "../services/api";
import { Panel } from "../types";

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

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
                <div className="modal-header">
                    <h2>Link Panel to Hospital</h2>
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

                    {/* Panel Selection */}
                    <div className="form-group">
                        <label>Select Panel *</label>
                        {loading ? (
                            <div style={{ padding: '0.75rem', color: '#64748b' }}>Loading panels...</div>
                        ) : (
                            <>
                                <select
                                    value={selectedPanelId}
                                    onChange={(e) => setSelectedPanelId(e.target.value)}
                                    required
                                    style={{
                                        width: '100%',
                                        padding: '0.625rem 0.875rem',
                                        borderRadius: '8px',
                                        border: '1px solid #e2e8f0',
                                        fontSize: '0.9375rem',
                                        background: 'white',
                                    }}
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
                                    style={{
                                        marginTop: '0.5rem',
                                        background: 'none',
                                        border: 'none',
                                        color: '#2563eb',
                                        fontSize: '0.875rem',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.25rem',
                                    }}
                                >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M12 5v14M5 12h14" />
                                    </svg>
                                    {showCreateNew ? 'Cancel' : 'Create new panel'}
                                </button>

                                {/* Create New Panel Inline */}
                                {showCreateNew && (
                                    <div style={{
                                        marginTop: '0.75rem',
                                        padding: '0.75rem',
                                        background: '#f8fafc',
                                        borderRadius: '8px',
                                        display: 'flex',
                                        gap: '0.5rem',
                                    }}>
                                        <input
                                            type="text"
                                            value={newPanelName}
                                            onChange={(e) => setNewPanelName(e.target.value)}
                                            placeholder="Panel name (e.g., Star Health)"
                                            style={{
                                                flex: 1,
                                                padding: '0.5rem 0.75rem',
                                                borderRadius: '6px',
                                                border: '1px solid #e2e8f0',
                                                fontSize: '0.875rem',
                                            }}
                                        />
                                        <button
                                            type="button"
                                            onClick={handleCreateNewPanel}
                                            disabled={isCreatingPanel || !newPanelName.trim()}
                                            style={{
                                                padding: '0.5rem 1rem',
                                                background: '#10b981',
                                                color: 'white',
                                                border: 'none',
                                                borderRadius: '6px',
                                                fontSize: '0.875rem',
                                                cursor: 'pointer',
                                                opacity: isCreatingPanel || !newPanelName.trim() ? 0.6 : 1,
                                            }}
                                        >
                                            {isCreatingPanel ? '...' : 'Add'}
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Optional Configuration */}
                    {selectedPanel && (
                        <div style={{
                            borderTop: '1px solid #e2e8f0',
                            paddingTop: '1rem',
                            marginTop: '0.5rem'
                        }}>
                            <h4 style={{
                                fontSize: '0.875rem',
                                fontWeight: 600,
                                color: '#475569',
                                marginBottom: '0.75rem'
                            }}>
                                Optional Configuration for "{selectedPanel.name}"
                            </h4>

                            <div className="form-group">
                                <label>Contact Number</label>
                                <input
                                    type="tel"
                                    value={contact}
                                    onChange={(e) => setContact(e.target.value)}
                                    placeholder="10-digit phone number"
                                    maxLength={10}
                                />
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                                <div className="form-group">
                                    <label>Google Sheet ID</label>
                                    <input
                                        type="text"
                                        value={sheetId}
                                        onChange={(e) => setSheetId(e.target.value)}
                                        placeholder="Sheet ID"
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Sheet Name</label>
                                    <input
                                        type="text"
                                        value={sheetName}
                                        onChange={(e) => setSheetName(e.target.value)}
                                        placeholder="e.g., Patients"
                                    />
                                </div>
                            </div>

                            <div className="form-group">
                                <label>WhatsApp Group ID</label>
                                <input
                                    type="text"
                                    value={whatsAppGroupId}
                                    onChange={(e) => setWhatsAppGroupId(e.target.value)}
                                    placeholder="Group ID for notifications"
                                />
                            </div>
                        </div>
                    )}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-cancel">
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={isSubmitting || !selectedPanelId}
                            className="btn-submit"
                        >
                            {isSubmitting ? "Linking..." : "Link Panel"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default LinkPanelModal;
