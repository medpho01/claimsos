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
import { Search, Plus, Users, UserX } from "lucide-react";
import { Badge } from "@/components/ui/badge";

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

    const canAddPatient =
        user?.role === "superadmin" || (user?.role === "admin" && (hospital as any)?.can_edit);

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
                                <TableHead>Status</TableHead>
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
                                filteredUsers.map((user) => (
                                    <UserRow
                                        panels={panels}
                                        key={user.user_id}
                                        user={user}
                                        onClick={() => onUserClick(user as any)}
                                        onToggleStatus={() => handleToggleStatus(user)}
                                    />
                                ))
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
};

export default HospitalUserList;

