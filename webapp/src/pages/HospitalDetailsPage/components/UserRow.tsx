import React from "react";
import { HospitalUser } from "../../../types";
import { getInitials, formatDate } from "../utils/formatters";

interface UserRowProps {
    user: HospitalUser;
    onClick: () => void;
}

/**
 * User table row component
 */
const UserRow: React.FC<UserRowProps> = ({ user, onClick }) => {
    return (
        <tr className="clickable-row" onClick={onClick}>
            <td>
                <div className="user-cell">
                    <div className="patient-avatar">
                        {getInitials(user.first_name||"", user.last_name||"")}
                    </div>
                    <div className="user-details">
                        <span className="user-name-cell">
                            {user.first_name} {user.last_name}
                        </span>
                    </div>
                </div>
            </td>
            <td>
                <span className="phone-number">{user.phone}</span>
            </td>
            <td>
                <span className="date-text">{user.username}</span>
            </td>
            <td>
                <span className={`type-badge ${user.role || ""}`}>
                    {user.role || "—"}
                </span>
            </td>
            <td>
                <span className="status-badge admitted">Active</span>
            </td>
        </tr>
    );
};

export default UserRow;
