import React, { useState } from "react";
import { Patient, HospitalPanel, User, Hospital, HospitalUser, Panel } from "../../../types";
import { TableRowSkeleton } from "../../../components/Skeleton";
import UserRow from "./UserRow";

interface UsersTableProps {
    panels:HospitalPanel[];
    users: HospitalUser[];
    loading: boolean;
    user: User | null;
    hospital: Hospital | null;
    onAddUser: () => void;
    onUserClick: (patient: Patient) => void;
}

// Icon components
const UsersIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);

const PlusIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14M5 12h14" />
    </svg>
);

const SearchIcon = () => (
    <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="M21 21l-4.35-4.35" />
    </svg>
);

const EmptyPatientIcon = () => (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4 }}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
);

/**
 * Patients table component with filters, search, and patient rows
 */
const UsersTable: React.FC<UsersTableProps> = ({
    panels,
    users,
    loading,
    user,
    hospital,
    onAddUser,
    onUserClick,
}) => {
    const [searchTerm, setSearchTerm] = useState("");

    const canAddPatient =
        user?.role === "superadmin" || (user?.role === "admin" && (hospital as any)?.can_edit);

    return (
        <>
            {/* Panel Patients Header */}
            <div className="section-header panel-patients">
                <div className="section-title">
                    <UsersIcon />
                    <h3>Users</h3>
                    <span className="section-count">{users.length}</span>
                </div>
                {canAddPatient && (
                    <button className="btn-add-patient" onClick={onAddUser}>
                        <PlusIcon />
                        New User
                    </button>
                )}
            </div>

            {/* Users Table */}
            {loading ? (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Contact</th>
                                <th>Username</th>
                                <th>Role</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {[...Array(5)].map((_, i) => (
                                <TableRowSkeleton key={i} columns={5} />
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Contact</th>
                                <th>Username</th>
                                <th>Role</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="empty-state">
                                        <div className="empty-content">
                                            <EmptyPatientIcon />
                                            <span>No users found for this hospital</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                users.map((user:any) => (
                                    <UserRow
                                        panels={panels}
                                        key={user.user_id}
                                        user={user}
                                        onClick={() => onUserClick(user)}
                                    />
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
};

export default UsersTable;
