import React, { useState } from "react";
import { Patient, HospitalPanel, User, Hospital, HospitalUser } from "../../../../types";

import { TableRowSkeleton } from "../../../../components/common/Skeleton";
import UserRow from "./UserRow";
import apiService from "../../../../services/api";
import { Button } from "@/components/ui/button";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search, Plus, Users, UserX, Edit2, Shield, Search as SearchIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";

interface HospitalUserListProps {
    panels: HospitalPanel[];
    users: HospitalUser[];
    loading: boolean;
    user: User | null;
    hospital: Hospital | null;
    onAddUser: () => void;
    onUserClick: (patient: Patient) => void;
    onUserUpdate: (updatedUser: HospitalUser) => void;
}

const HospitalUserList: React.FC<HospitalUserListProps> = ({
    panels,
    users: initialUsers,
    loading,
    user,
    hospital,
    onAddUser,
    onUserClick,
    onUserUpdate,
}) => {
    const [searchTerm, setSearchTerm] = useState("");
    const [localUsers, setLocalUsers] = useState<HospitalUser[]>(initialUsers);
    const [editingUser, setEditingUser] = useState<HospitalUser | null>(null);
    const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
    const [updatingRole, setUpdatingRole] = useState(false);
    const [roleSearchTerm, setRoleSearchTerm] = useState("");

    // Update local users when initial users change (e.g. initial load)
    React.useEffect(() => {
        setLocalUsers(initialUsers);
    }, [initialUsers]);

    const handleToggleStatus = async (user: HospitalUser) => {
        // Optimistic update
        const updatedUser = { ...user, is_active: !user.is_active };
        const updatedUsers = localUsers.map(u =>
            u.user_id === user.user_id ? updatedUser : u
        );
        setLocalUsers(updatedUsers);

        try {
            await apiService.toggleUserStatus(user.user_id, !user.is_active);
            onUserUpdate(updatedUser);
        } catch (error) {
            console.error("Failed to toggle status", error);
            // Revert on failure
            setLocalUsers(localUsers);
            alert("Failed to update status");
        }
    };

    const handleEditRoleClick = (user: HospitalUser) => {
        setEditingUser(user);
        setSelectedRoles(user.role || []);
    };

    const handleRoleUpdate = async () => {
        if (!editingUser || !hospital) return;
        setUpdatingRole(true);
        try {
            await apiService.updateHospitalUserRole(hospital.id, editingUser.user_id, selectedRoles);

            const updatedUser = { ...editingUser, role: selectedRoles };
            const updatedUsers = localUsers.map(u =>
                u.user_id === editingUser.user_id ? updatedUser : u
            );
            setLocalUsers(updatedUsers);
            onUserUpdate(updatedUser);
            setEditingUser(null);
            toast.success("User roles updated successfully");
        } catch (error) {
            console.error("Failed to update role", error);
            toast.error("Failed to update user roles");
        } finally {
            setUpdatingRole(false);
        }
    };

    const toggleRole = (panelId: string) => {
        setSelectedRoles(prev =>
            prev.includes(panelId)
                ? prev.filter(id => id !== panelId)
                : [...prev, panelId]
        );
    };

    const canAddPatient =
        user?.role === "superadmin" || (user?.role === "admin" && (hospital as any)?.can_edit);

    // Only superadmin and admin can manage users
    const canManageUsers = user?.role === "superadmin" || user?.role === "admin";

    const filteredUsers = localUsers.filter(u =>
        u.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        u.last_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        u.username?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        u.phone?.includes(searchTerm)
    );

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6">
                    <div className="space-y-1">
                        <CardTitle className="text-xl flex items-center gap-2">
                            <Users className="h-5 w-5 text-muted-foreground" />
                            Users
                            <Badge variant="secondary" className="ml-2 rounded-full">{localUsers.length}</Badge>
                        </CardTitle>
                    </div>
                    <div className="flex items-center gap-2 w-full sm:w-auto">
                        <div className="relative w-full sm:w-[250px]">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search users..."
                                className="pl-9"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        {canAddPatient && (
                            <Button onClick={onAddUser} className="gap-2 shrink-0">
                                <Plus className="h-4 w-4" />
                                <span className="hidden sm:inline">New User</span>
                            </Button>
                        )}
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="w-[300px]">User</TableHead>
                                <TableHead>Contact</TableHead>
                                <TableHead>Username</TableHead>
                                <TableHead>Role</TableHead>
                                {canManageUsers && <TableHead>Status</TableHead>}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {loading ? (
                                [...Array(5)].map((_, i) => (
                                    <TableRow key={i}>
                                        <TableCell colSpan={5} className="p-4">
                                            <div className="flex items-center gap-4">
                                                <div className="h-10 w-10 rounded-full bg-muted animate-pulse" />
                                                <div className="space-y-2 flex-1">
                                                    <div className="h-4 w-[200px] bg-muted animate-pulse rounded" />
                                                    <div className="h-3 w-[150px] bg-muted animate-pulse rounded" />
                                                </div>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))
                            ) : filteredUsers.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={5} className="h-64 text-center">
                                        <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground py-8">
                                            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-2">
                                                <UserX className="h-6 w-6" />
                                            </div>
                                            <h3 className="text-lg font-semibold text-foreground">No users found</h3>
                                            <p className="text-sm max-w-sm mx-auto">
                                                {searchTerm ? "No users match your search terms." : "There are no users assigned to this hospital yet."}
                                            </p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : (
                                filteredUsers.map((u) => (
                                    <UserRow
                                        panels={panels}
                                        key={u.user_id}
                                        user={u}
                                        currentUserRole={user?.role}
                                        onClick={() => onUserClick(u as any)}
                                        onToggleStatus={() => handleToggleStatus(u)}
                                        onEditRole={() => handleEditRoleClick(u)}
                                    />
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
                <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                        <DialogTitle>Edit User Roles</DialogTitle>
                        <DialogDescription>
                            Select the panels that {editingUser?.first_name} {editingUser?.last_name} should have access to.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="py-4 space-y-4">
                        <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/20">
                            <div className="space-y-0.5">
                                <Label className="text-base font-medium">Full Access & Admin</Label>
                                <p className="text-sm text-muted-foreground">
                                    Grant access to all panels and admin features
                                </p>
                            </div>
                            <Switch
                                checked={selectedRoles.includes('admin')}
                                onCheckedChange={(checked) => {
                                    if (checked) {
                                        // Exclusive Admin role
                                        setSelectedRoles(['admin']);
                                    } else {
                                        setSelectedRoles([]);
                                    }
                                }}
                            />
                        </div>

                        <div className="relative">
                            <SearchIcon className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search panels..."
                                className="pl-9"
                                value={roleSearchTerm}
                                onChange={(e) => setRoleSearchTerm(e.target.value)}
                                disabled={selectedRoles.includes('admin')}
                            />
                        </div>

                        <div className={`space-y-2 max-h-[300px] overflow-y-auto pr-2 ${selectedRoles.includes('admin') ? 'opacity-50 pointer-events-none' : ''}`}>
                            {panels
                                .filter(panel =>
                                    !roleSearchTerm ||
                                    panel.panel_name?.toLowerCase().includes(roleSearchTerm.toLowerCase())
                                )
                                .map((panel) => {
                                    const isSelected = selectedRoles.includes(panel.panel_id);
                                    return (
                                        <div
                                            key={panel.id}
                                            className={`
                                                flex items-center space-x-3 p-3 rounded-lg border cursor-pointer transition-colors
                                                ${isSelected ? 'bg-primary/5 border-primary/20' : 'hover:bg-muted/50 border-input'}
                                            `}
                                            onClick={() => toggleRole(panel.panel_id)}
                                        >
                                            <Checkbox
                                                id={panel.panel_id}
                                                checked={isSelected}
                                                onCheckedChange={() => toggleRole(panel.panel_id)}
                                            />
                                            <div className="flex flex-col flex-1 cursor-pointer">
                                                <Label
                                                    htmlFor={panel.panel_id}
                                                    className="cursor-pointer font-medium mb-1"
                                                >
                                                    {panel.panel_name}
                                                </Label>
                                                {panel.contact && (
                                                    <span className="text-xs text-muted-foreground">
                                                        {panel.contact}
                                                    </span>
                                                )}
                                            </div>
                                            {isSelected && <Shield className="h-4 w-4 text-primary opacity-50" />}
                                        </div>
                                    );
                                })}
                            {panels.length === 0 && (
                                <p className="text-sm text-muted-foreground text-center py-8">
                                    No panels available to assign.
                                </p>
                            )}
                            {panels.length > 0 && panels.filter(p => !roleSearchTerm || p.panel_name?.toLowerCase().includes(roleSearchTerm.toLowerCase())).length === 0 && (
                                <p className="text-sm text-muted-foreground text-center py-8">
                                    No panels match your search.
                                </p>
                            )}
                        </div>

                        <div className="flex items-center justify-between text-sm text-muted-foreground pt-2 border-t">
                            <span>{selectedRoles.filter(r => r !== 'admin').length} panels selected</span>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-auto p-0 hover:bg-transparent text-primary"
                                onClick={() => setSelectedRoles(prev => {
                                    const hasAdmin = prev.includes('admin');
                                    const allPanels = panels.map(p => p.panel_id);
                                    return hasAdmin ? ['admin', ...allPanels] : allPanels;
                                })}
                                disabled={selectedRoles.includes('admin')}
                            >
                                Select All
                            </Button>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditingUser(null)}>Cancel</Button>
                        <Button onClick={handleRoleUpdate} disabled={updatingRole}>
                            {updatingRole ? "Saving..." : "Save Changes"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

export default HospitalUserList;

