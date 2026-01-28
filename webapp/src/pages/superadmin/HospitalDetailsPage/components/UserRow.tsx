import React from "react";
import { HospitalPanel, HospitalUser } from "../../../../types";
import { getInitials } from "../utils/formatters";
import { TableCell, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Switch } from "../../../../components/ui/switch";

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
    const panel = panels.find(p => p.panel_id === id);
    return panel ? panel.panel_name : null;
  }

  return (
    <TableRow className="cursor-pointer hover:bg-muted/50" onClick={onClick}>
      <TableCell className="font-medium">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-primary/10 text-primary text-xs">
              {getInitials(user.first_name || "", user.last_name || "")}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span className="font-medium text-sm">
              {user.first_name} {user.last_name}
            </span>
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
        <div className="flex flex-col gap-1">
          {user.role && user.role.length > 0 ? (
            user.role.map((role) => (
              <Badge key={role} variant="outline" className="w-fit text-xs font-normal">
                {getPanelname(role) || role}
              </Badge>
            ))
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </div>
      </TableCell>
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
    </TableRow>
  );
};

export default UserRow;

