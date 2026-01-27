import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Users, Building, AlertCircle } from "lucide-react";

interface DashboardStats {
    totalHospitals: number;
    totalAdmins: number;
    activePatients: number;
    recentActivity: Array<{
        assigned_at: string;
        first_name: string;
        last_name: string;
        hospital_name: string;
    }>;
}

interface DashboardOverviewProps {
    stats: DashboardStats | null;
    loading: boolean;
}

const DashboardOverview: React.FC<DashboardOverviewProps> = ({ stats, loading }) => {
    if (loading) {
        return <div className="p-4">Loading stats...</div>;
    }

    return (
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card className="hover:shadow-lg transition-shadow">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Hospitals</CardTitle>
                        <Building className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{stats?.totalHospitals || 0}</div>
                        <p className="text-xs text-muted-foreground">Active hospitals in network</p>
                    </CardContent>
                </Card>
                <Card className="hover:shadow-lg transition-shadow">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Admin Users</CardTitle>
                        <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{stats?.totalAdmins || 0}</div>
                        <p className="text-xs text-muted-foreground">Total registered admins</p>
                    </CardContent>
                </Card>
                <Card className="hover:shadow-lg transition-shadow">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Active Patients</CardTitle>
                        <Activity className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{stats?.activePatients || 0}</div>
                        <p className="text-xs text-muted-foreground">Currently admitted patients</p>
                    </CardContent>
                </Card>
                <Card className="hover:shadow-lg transition-shadow">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Alerts</CardTitle>
                        <AlertCircle className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">0</div>
                        <p className="text-xs text-muted-foreground">System alerts</p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <Card className="col-span-4 hover:shadow-lg transition-shadow">
                    <CardHeader>
                        <CardTitle>Recent Activity</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-4">
                            {stats?.recentActivity.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No recent activity found.</p>
                            ) : (
                                stats?.recentActivity.map((activity, i) => (
                                    <div key={i} className="flex items-center">
                                        <div className="ml-4 space-y-1">
                                            <p className="text-sm font-medium leading-none">
                                                Assignment: {activity.first_name} {activity.last_name}
                                            </p>
                                            <p className="text-sm text-muted-foreground">
                                                Assigned to {activity.hospital_name}
                                            </p>
                                        </div>
                                        <div className="ml-auto font-medium text-xs text-muted-foreground">
                                            {new Date(activity.assigned_at).toLocaleDateString()}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </CardContent>
                </Card>
                <Card className="col-span-3 hover:shadow-lg transition-shadow">
                    <CardHeader>
                        <CardTitle>Quick Actions</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                        <div className="text-sm text-muted-foreground">Select a tab to manage resources</div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
};

export default DashboardOverview;
