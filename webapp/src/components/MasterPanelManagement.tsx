import React, { useState, useEffect } from "react";
import apiService from "../services/api";
import { Panel } from "../types";

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

    return (
        <div className="panel-management">
            {/* Header */}
            <div className="tab-header" style={{ flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
                <div className="search-wrapper">
                    <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <path d="M21 21l-4.35-4.35" />
                    </svg>
                    <input
                        type="text"
                        className="search-input"
                        placeholder="Search panels..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <button
                    className="add-user-btn"
                    onClick={() => setShowCreateModal(true)}
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.625rem 1.25rem',
                        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)',
                        transition: 'all 0.2s ease',
                        marginLeft: 'auto',
                    }}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                    Create Panel
                </button>
            </div>

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

            {/* Panel List */}
            {loading ? (
                <div className="loading-state">
                    <div className="loading-spinner"></div>
                    <span>Loading panels...</span>
                </div>
            ) : (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Panel Name</th>
                                <th>Created</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredPanels.length === 0 ? (
                                <tr>
                                    <td colSpan={2} className="empty-state">
                                        <div className="empty-content">
                                            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4 }}>
                                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                                <path d="M9 9h6M9 13h6M9 17h4" />
                                            </svg>
                                            <span>No panels found. Create your first panel.</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                filteredPanels.map((panel) => (
                                    <tr key={panel.id}>
                                        <td>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                                <div style={{
                                                    width: '36px',
                                                    height: '36px',
                                                    borderRadius: '8px',
                                                    background: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
                                                    color: '#2563eb',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    fontSize: '0.875rem',
                                                    fontWeight: 600,
                                                }}>
                                                    {panel.name.charAt(0).toUpperCase()}
                                                </div>
                                                <span style={{ fontWeight: 500 }}>{panel.name}</span>
                                            </div>
                                        </td>
                                        <td style={{ color: '#64748b' }}>{formatDate(panel.created_at)}</td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Create Panel Modal */}
            {showCreateModal && (
                <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
                        <div className="modal-header">
                            <h2>Create New Panel</h2>
                            <button className="modal-close" onClick={() => setShowCreateModal(false)}>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                        <form onSubmit={handleCreatePanel} className="modal-form">
                            <div className="form-group">
                                <label>Panel Name *</label>
                                <input
                                    type="text"
                                    value={newPanelName}
                                    onChange={(e) => setNewPanelName(e.target.value)}
                                    placeholder="e.g., PMJAY, Star Health, HDFC Ergo"
                                    required
                                    autoFocus
                                />
                            </div>
                            <div className="modal-actions">
                                <button type="button" onClick={() => setShowCreateModal(false)} className="btn-cancel">
                                    Cancel
                                </button>
                                <button type="submit" disabled={isSubmitting || !newPanelName.trim()} className="btn-submit">
                                    {isSubmitting ? "Creating..." : "Create Panel"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MasterPanelManagement;
