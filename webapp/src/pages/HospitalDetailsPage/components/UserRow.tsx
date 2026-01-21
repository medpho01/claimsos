import React from "react";
import { HospitalUser, HospitalPanel } from "../../../types";
import { getInitials, formatDate } from "../utils/formatters";

interface UserRowProps {
  panels:HospitalPanel[];
  user: HospitalUser;
  onClick: () => void;
}

/**
 * User table row component
 */
const UserRow: React.FC<UserRowProps> = ({ panels,user, onClick }) => {
    const getPanelname = (id:string)=>{
        if(!id)return null;
        for(let i = 0;i<panels.length;i++){
            if(panels[i].panel_id == id)return panels[i].panel_name;
        }
        return null;
    }
  return (
    <tr className="clickable-row" onClick={onClick}>
      <td>
        <div className="user-cell">
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
      <td>
        <span className="phone-number">{user.phone}</span>
      </td>
      <td>
        <span className="date-text">{user.username}</span>
      </td>
      <td>
        <div style={{display:"flex",flexDirection:"column",gap:"4px"}}>
          {user.role?.map((role) => {
            return <span key={role} className={`type-badge ${role || ""}`}>{getPanelname(role) || "—"}</span>;
          })|| "—"} 
        </div>
      </td>
      <td>
        <span className="status-badge admitted">Active</span>
      </td>
    </tr>
  );
};

export default UserRow;
