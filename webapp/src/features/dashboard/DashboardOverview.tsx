import React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Activity, Users, Building, UserPlus, ArrowUpRight, Clock, Building2, CalendarDays, TrendingUp } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface DashboardStats {
    totalHospitals: number;
    totalPatients: number;
    activePatients: number;
    totalAdmins: number;
    recentActivity: Array<{
        created_at: string;
        updated_at: string;
        first_name: string;
        last_name: string;
        hospital_name: string;
        type: string;
        event_time: string;
    }>;
}

interface SystemHealth {
    message: string;
    database: string;
    uptime: string;
    memory: {
        rss: string;
        heapUsed: string;
    };
    cpu: {
        user: string;
        system: string;
    };
}

interface DashboardOverviewProps {
    stats: DashboardStats | null;
    loading: boolean;
    onAddHospital: () => void;
    onAddAdmin: () => void;
    systemHealth: SystemHealth | null;
}

/**
 * Format a date into a relative time string (e.g. "2 hours ago", "3 days ago")
 */
const getRelativeTime = (dateStr: string): string => {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

const DashboardOverview: React.FC<DashboardOverviewProps> = ({ stats, loading, onAddHospital, onAddAdmin, systemHealth }) => {
    // ... existing loading check ...

    // ... existing getInitials helper ...

    return (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Key Metrics */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Hospitals</CardTitle>
                        <Building className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold tracking-tight">{stats?.totalHospitals || 0}</div>
                        <p className="text-xs text-muted-foreground">Active network hospitals</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Patients</CardTitle>
                        <Users className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold tracking-tight">{stats?.totalPatients || 0}</div>
                        <p className="text-xs text-muted-foreground">+ from all time</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Active Patients</CardTitle>
                        <Activity className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold tracking-tight">{stats?.activePatients || 0}</div>
                        <p className="text-xs text-muted-foreground">Currently admitted</p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Total Admins</CardTitle>
                        <UserPlus className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold tracking-tight">{stats?.totalAdmins || 0}</div>
                        <p className="text-xs text-muted-foreground">System administrators</p>
                    </CardContent>
                </Card>
            </div>

            {/* Main Content Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <Card className="col-span-4">
                    <CardHeader>
                        <CardTitle>Recent Activity</CardTitle>
                        <CardDescription>
                            Latest patient details and status updates.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-6">
                            {stats?.recentActivity.length === 0 ? (
                                <div className="text-center py-8 text-muted-foreground">
                                    No recent activity found.
                                </div>
                            ) : (
                                stats?.recentActivity.map((activity, i) => {
                                    const isNew = activity.type === 'admitted';
                                    return (
                                        <div key={i} className="flex items-center justify-between">
                                            <div className="flex items-center gap-4">
                                                <Avatar className="h-9 w-9">
                                                    <AvatarFallback className="bg-primary/10 text-primary text-xs">
                                                        {(activity.first_name?.charAt(0) || '').toUpperCase()}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <div className="space-y-1">
                                                    <p className="text-sm font-medium leading-none">
                                                        {activity.first_name} {activity.last_name}
                                                    </p>
                                                    <div className="flex items-center gap-2">
                                                        <p className="text-xs text-muted-foreground">
                                                            {activity.hospital_name}
                                                        </p>
                                                        <span className="text-muted-foreground text-[10px]">•</span>
                                                        <p className="text-xs text-muted-foreground">
                                                            {getRelativeTime(activity.event_time || activity.updated_at)}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                            <Badge variant={isNew ? "default" : "outline"} className={`font-normal text-xs ${!isNew ? "text-muted-foreground" : ""}`}>
                                                {isNew ? "Admitted" : "Updated"}
                                            </Badge>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </CardContent>
                </Card>

                {/* Quick Actions / System Status */}
                < Card className="col-span-3" >
                    <CardHeader>
                        <CardTitle>Overview</CardTitle>
                        <CardDescription>System health and quick links</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                                <div className="flex flex-col space-y-1">
                                    <span className="text-sm font-medium">System Status</span>
                                    <span className="text-xs text-muted-foreground">
                                        {systemHealth?.database === 'Connected'
                                            ? 'All systems operational'
                                            : 'System issues detected'}
                                    </span>
                                </div>
                                <div className={`h-2 w-2 rounded-full animate-pulse ${systemHealth?.database === 'Connected' ? 'bg-green-500' : 'bg-red-500'
                                    }`} />
                            </div>

                            {systemHealth && (
                                <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t">
                                    <div className="text-xs text-muted-foreground">
                                        <span className="font-semibold text-foreground">Database:</span> {systemHealth.database}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        <span className="font-semibold text-foreground">Uptime:</span> {systemHealth.uptime}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        <span className="font-semibold text-foreground">Memory:</span> {systemHealth.memory.heapUsed}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        <span className="font-semibold text-foreground">CPU:</span> {systemHealth.cpu.user}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ... existing Quick Action Buttons ... */}

                        <div className="grid grid-cols-2 gap-4">
                            <Button
                                variant="outline"
                                className="h-20 flex flex-col gap-2 bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer"
                                onClick={onAddHospital}
                            >
                                <Building className="h-5 w-5" />
                                <span className="text-xs">Add Hospital</span>
                            </Button>
                            <Button
                                variant="outline"
                                className="h-20 flex flex-col gap-2 bg-background hover:bg-accent hover:text-accent-foreground cursor-pointer"
                                onClick={onAddAdmin}
                            >
                                <UserPlus className="h-5 w-5" />
                                <span className="text-xs">Add Admin</span>
                            </Button>
                        </div>
                    </CardContent>
                </Card >
            </div >
        </div >
    );
};

export default DashboardOverview;

