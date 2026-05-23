import React from "react";
import { HospitalPanel, HospitalUser } from "../../../../types";
import { getInitials } from "../utils/formatters";
import { TableCell, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Switch } from "../../../../components/ui/switch";
import { Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UserRowProps {
  panels: HospitalPanel[];
  user: HospitalUser;
  currentUserRole?: string; // Role of the logged-in user
  onClick: () => void;
  onToggleStatus: () => void;
  onEditRole: () => void;
}

/**
 * User table row component
 */
const UserRow: React.FC<UserRowProps> = ({ panels, user, currentUserRole, onClick, onToggleStatus, onEditRole }) => {
  const getPanelname = (id: string) => {
    if (!id) return null;
    const panel = panels.find(p => p.panel_id === id);
    return panel ? panel.panel_name : null;
  }

  // Only superadmin and admin can edit roles and toggle status
  const canManageUsers = currentUserRole === 'superadmin' || currentUserRole === 'admin';

  return (
    <TableRow className="cursor-pointer hover:bg-muted/50" onClick={onClick}>
      {/* UI Revamp: wireframe hw-users style — round brand-700 avatar + name + username sub-line */}
      <TableCell className="font-medium">
        <div className="flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-full bg-brand-700 text-white text-[11px] font-semibold flex items-center justify-center shrink-0">
            {getInitials(user.first_name || "", user.last_name || "")}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="font-medium text-sm text-slate-900 dark:text-slate-100 truncate">
              {user.first_name} {user.last_name}
            </span>
            {user.username && (
              <span className="text-xs text-slate-500 font-mono truncate">{user.username}</span>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="font-mono text-xs text-muted-foreground">{user.phone}</div>
      </TableCell>
      <TableCell>
        <span className="text-sm text-foreground">{user.username}</span>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 flex-wrap max-w-[200px]">
          {user.role && user.role.length > 0 ? (
            <>
              {/* Filter out 'admin' role and only show panel names */}
              {(() => {
                const panelRoles = user.role.filter(r => r !== 'admin');
                const hasAdminOnly = user.role.includes('admin') && panelRoles.length === 0;

                // If user only has 'admin' role, show "All Panels"
                if (hasAdminOnly) {
                  return (
                    <Badge variant="outline" className="w-fit text-xs font-normal px-2 py-0.5 whitespace-nowrap">
                      All Panels
                    </Badge>
                  );
                }

                // Show panel names
                return (
                  <>
                    {panelRoles.slice(0, 2).map((role) => (
                      <Badge key={role} variant="outline" className="w-fit text-xs font-normal px-2 py-0.5 whitespace-nowrap">
                        {getPanelname(role) || role}
                      </Badge>
                    ))}
                    {panelRoles.length > 2 && (
                      <Badge
                        variant="secondary"
                        className="w-fit text-xs font-normal px-2 py-0.5 cursor-help"
                        title={panelRoles.slice(2).map(r => getPanelname(r) || r).join(', ')}
                      >
                        +{panelRoles.length - 2}
                      </Badge>
                    )}
                  </>
                );
              })()}
            </>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
          {canManageUsers && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onEditRole();
              }}
              title="Edit User Roles"
            >
              <Edit2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </TableCell>
      {canManageUsers && (
        <TableCell onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-2">
            <Switch
              checked={user.is_active}
              onCheckedChange={onToggleStatus}
              className="data-[state=checked]:bg-green-600"
            />
            <span className={`text-xs font-medium ${user.is_active ? 'text-green-600' : 'text-muted-foreground'}`}>
              {user.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>
        </TableCell>
      )}
    </TableRow>
  );
};

export default UserRow;

