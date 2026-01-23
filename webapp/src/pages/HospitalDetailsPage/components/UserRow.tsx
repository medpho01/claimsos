import React from "react";
import { HospitalUser, HospitalPanel } from "../../../types";
import { getInitials, formatDate } from "../utils/formatters";

interface UserRowProps {
  panels: HospitalPanel[];
  user: HospitalUser;
  onClick: () => void;
  onToggleStatus: () => void;
}

/**
 * User table row component
 */
const UserRow: React.FC<UserRowProps> = ({ panels, user, onClick, onToggleStatus }) => {
  const getPanelname = (id: string) => {
    if (!id) return null;
    for (let i = 0; i < panels.length; i++) {
      if (panels[i].panel_id == id) return panels[i].panel_name;
    }
    return null;
  }
  return (
    <tr className="clickable-row">
      <td>
        <div className="user-cell" onClick={onClick} style={{ cursor: 'pointer' }}>
          <div className="patient-avatar">
            {getInitials(user.first_name || "", user.last_name || "")}
          </div>
          <div className="user-details">
            <span className="user-name-cell">
              {user.first_name} {user.last_name}
            </span>
          </div>
        </div>
      </td>
      <td onClick={onClick} style={{ cursor: 'pointer' }}>
        <span className="phone-number">{user.phone}</span>
      </td>
      <td onClick={onClick} style={{ cursor: 'pointer' }}>
        <span className="date-text">{user.username}</span>
      </td>
      <td onClick={onClick} style={{ cursor: 'pointer' }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          {user.role?.map((role) => {
            return <span key={role} className={`type-badge ${role || ""}`}>{getPanelname(role) || "—"}</span>;
          }) || "—"}
        </div>
      </td>
      <td>
        <div
          className={`toggle-switch ${user.is_active ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStatus();
          }}
        >
          <div className="toggle-slider">
            <div className="toggle-knob" />
          </div>
          <span className="toggle-label">
            {user.is_active ? 'Active' : 'Inactive'}
          </span>
        </div>
      </td>
    </tr>
  );
};

export default UserRow;
