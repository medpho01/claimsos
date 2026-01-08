import React, { useState } from "react";
import apiService from "../services/api";
import "../styles/Modal.css";

interface AddUserModalProps {
    role: 'admin' | 'hospital';
    onClose: () => void;
    onSuccess: () => void;
}

const AddUserModal: React.FC<AddUserModalProps> = ({ role, onClose, onSuccess }) => {
    const [formData, setFormData] = useState({
        userName: "",
        passWord: "",
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
    });
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        // Validation
        if (!formData.userName || !formData.passWord || !formData.firstName || !formData.phone) {
            setError("Please fill in all required fields");
            return;
        }

        try {
            setSubmitting(true);
            await apiService.signup({
                ...formData,
                role,
            });
            onSuccess();
        } catch (err: any) {
            setError(err.response?.data?.message || "Failed to create user");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Add New {role === 'admin' ? 'Admin' : 'Hospital'}</h2>
                    <button className="modal-close" onClick={onClose} title="Close">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="modal-body">
                    {error && <div className="error-message">{error}</div>}

                    <div className="form-row">
                        <div className="form-group">
                            <label htmlFor="firstName">First Name *</label>
                            <input
                                id="firstName"
                                name="firstName"
                                type="text"
                                value={formData.firstName}
                                onChange={handleChange}
                                placeholder="Enter first name"
                                disabled={submitting}
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="lastName">Last Name</label>
                            <input
                                id="lastName"
                                name="lastName"
                                type="text"
                                value={formData.lastName}
                                onChange={handleChange}
                                placeholder="Enter last name"
                                disabled={submitting}
                            />
                        </div>
                    </div>

                    <div className="form-group">
                        <label htmlFor="userName">Username *</label>
                        <input
                            id="userName"
                            name="userName"
                            type="text"
                            value={formData.userName}
                            onChange={handleChange}
                            placeholder="Enter username"
                            disabled={submitting}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="passWord">Password *</label>
                        <input
                            id="passWord"
                            name="passWord"
                            type="password"
                            value={formData.passWord}
                            onChange={handleChange}
                            placeholder="Enter password"
                            disabled={submitting}
                        />
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label htmlFor="email">Email</label>
                            <input
                                id="email"
                                name="email"
                                type="email"
                                value={formData.email}
                                onChange={handleChange}
                                placeholder="Enter email"
                                disabled={submitting}
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="phone">Phone *</label>
                            <input
                                id="phone"
                                name="phone"
                                type="tel"
                                value={formData.phone}
                                onChange={handleChange}
                                placeholder="Enter phone number"
                                disabled={submitting}
                            />
                        </div>
                    </div>

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-secondary" disabled={submitting}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary" disabled={submitting}>
                            {submitting ? "Creating..." : `Create ${role === 'admin' ? 'Admin' : 'Hospital'}`}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default AddUserModal;
