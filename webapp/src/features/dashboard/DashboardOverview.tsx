import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Users, Activity, UserPlus } from "lucide-react";

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
}

interface HospitalRow {
    id: string;
    name: string;
    city?: string;
    panels_count?: number;
    patients_count?: number;
}

interface AdminRow {
    id: string;
    first_name?: string;
    last_name?: string;
}

interface DashboardOverviewProps {
    stats: DashboardStats | null;
    loading: boolean;
    systemHealth: SystemHealth | null;
    hospitals: HospitalRow[];
    admins?: AdminRow[];
    currentUser?: { first_name?: string } | null;
    onAddHospital: () => void;
    onAddAdmin: () => void;
}

/**
 * UI Revamp — SuperAdmin dashboard rebuilt to match wireframe sa-dashboard.
 *
 * Visible blocks (driven by real data):
 *   - Greeting + network summary subtitle
 *   - Invite admin / + Add hospital actions
 *   - 4 KPI tiles (Total Hospitals / Total Patients / Active Patients / Total Admins)
 *   - Hospital health table (top 5 hospitals by patients_count, navigates to workspace)
 *   - Today's activity feed
 *
 * Hidden until backend wires them up (per "hide blocks we can't fill"):
 *   - Secondary KPIs (pending verification, expiring <30d, settled this week)
 *   - Needs attention queue (no aggregate endpoint exists)
 *   - System health card (kept as a footer line, not a card)
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

const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
};

const DashboardOverview: React.FC<DashboardOverviewProps> = ({
    stats,
    systemHealth,
    hospitals,
    admins = [],
    currentUser,
    onAddHospital,
    onAddAdmin,
}) => {
    const navigate = useNavigate();

    const topHospitals = useMemo(
        () =>
            [...hospitals]
                .sort(
                    (a, b) =>
                        (Number(b.patients_count) || 0) -
                        (Number(a.patients_count) || 0)
                )
                .slice(0, 5),
        [hospitals]
    );

    const networkSummary = [
        `${stats?.totalHospitals ?? hospitals.length} hospitals`,
        `${admins.length} admins`,
        stats?.totalPatients
            ? `${stats.totalPatients} patient records`
            : null,
    ]
        .filter(Boolean)
        .join(" · ");

    return (
        <div className="space-y-6">
            {/* Greeting + actions row */}
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                        {greeting()}
                        {currentUser?.first_name ? `, ${currentUser.first_name}` : ""}
                    </h1>
                    {networkSummary && (
                        <p className="text-sm text-slate-500 mt-1">{networkSummary}</p>
                    )}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={onAddAdmin}
                        className="h-9 px-3 border border-slate-200 dark:border-slate-700 rounded-md text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    >
                        Invite admin
                    </button>
                    <button
                        onClick={onAddHospital}
                        className="h-9 px-3 bg-brand-600 text-white rounded-md text-sm font-medium hover:bg-brand-700 transition-colors"
                    >
                        + Add hospital
                    </button>
                </div>
            </div>

            {/* Primary KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="Total Hospitals"
                    value={stats?.totalHospitals ?? hospitals.length}
                    note="Active network hospitals"
                    icon={<Building2 className="h-4 w-4 text-slate-400" />}
                />
                <KpiCard
                    label="Total Patients"
                    value={stats?.totalPatients ?? 0}
                    note="All-time"
                    icon={<Users className="h-4 w-4 text-slate-400" />}
                />
                <KpiCard
                    label="Active Patients"
                    value={stats?.activePatients ?? 0}
                    note="Currently admitted"
                    icon={<Activity className="h-4 w-4 text-slate-400" />}
                />
                <KpiCard
                    label="Total Admins"
                    value={stats?.totalAdmins ?? admins.length}
                    note="Operations users"
                    icon={<UserPlus className="h-4 w-4 text-slate-400" />}
                />
            </div>

            {/* Hospital health + Today's activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
                {/* Hospital health */}
                <div className="lg:col-span-2 bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
                    <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                        <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                            Hospital health
                        </h2>
                        <span className="text-xs text-slate-400">
                            top {topHospitals.length} by patients
                        </span>
                    </div>
                    {topHospitals.length === 0 ? (
                        <p className="px-5 py-6 text-sm text-slate-500">
                            No hospitals yet. Click <span className="font-medium">+ Add hospital</span> to get started.
                        </p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50/60 dark:bg-slate-800/40 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                                <tr>
                                    <th className="text-left px-5 py-2">Hospital</th>
                                    <th className="text-right px-3 py-2">Panels</th>
                                    <th className="text-right px-3 py-2">Patients</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {topHospitals.map((h) => (
                                    <tr
                                        key={h.id}
                                        className="hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer transition-colors"
                                        onClick={() => navigate(`/portal/${h.id}`)}
                                    >
                                        <td className="px-5 py-2.5">
                                            <div className="flex items-center gap-2">
                                                <div className="h-7 w-7 rounded bg-brand-700 text-white text-[11px] font-semibold flex items-center justify-center">
                                                    {(h.name || "?").charAt(0).toUpperCase()}
                                                </div>
                                                <span className="text-slate-900 dark:text-slate-100">{h.name}</span>
                                                {h.city && (
                                                    <span className="text-xs text-slate-500 ml-1">· {h.city}</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                                            {h.panels_count ?? 0}
                                        </td>
                                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                                            {h.patients_count ?? 0}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Today's activity */}
                <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
                    <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                        <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                            Today's activity
                        </h2>
                    </div>
                    {stats?.recentActivity?.length ? (
                        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                            {stats.recentActivity.slice(0, 6).map((a, i) => {
                                const ts = a.event_time || a.updated_at;
                                const isAdmit = a.type === "admitted";
                                return (
                                    <li key={i} className="px-5 py-2.5">
                                        <div className="text-sm text-slate-900 dark:text-slate-100">
                                            <span className="font-medium">
                                                {a.first_name} {a.last_name}
                                            </span>{" "}
                                            <span className="text-slate-500">
                                                {isAdmit ? "admitted at" : "updated at"}{" "}
                                            </span>
                                            <span className="text-slate-700 dark:text-slate-200">
                                                {a.hospital_name}
                                            </span>
                                        </div>
                                        <div className="text-xs text-slate-400 mt-0.5">
                                            {getRelativeTime(ts)}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="px-5 py-6 text-sm text-slate-500">
                            No recent activity.
                        </p>
                    )}
                </div>
            </div>

            {/* System health footer */}
            {systemHealth && (
                <div className="text-xs text-slate-400 flex items-center gap-2">
                    <span
                        className={`h-1.5 w-1.5 rounded-full ${
                            systemHealth.database === "Connected"
                                ? "bg-ok-600"
                                : "bg-danger-600"
                        }`}
                    />
                    {systemHealth.database === "Connected"
                        ? "All systems operational"
                        : "System issues detected"}
                    {systemHealth.uptime && <span>· uptime {systemHealth.uptime}</span>}
                </div>
            )}
        </div>
    );
};

// ────────────────── helper ──────────────────

interface KpiCardProps {
    label: string;
    value: number | string;
    note: string;
    icon: React.ReactNode;
}
const KpiCard: React.FC<KpiCardProps> = ({ label, value, note, icon }) => (
    <div className="bg-white rounded-lg border border-slate-200 p-4 dark:bg-slate-900 dark:border-slate-800">
        <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                {label}
            </div>
            {icon}
        </div>
        <div className="text-3xl font-semibold tabular-nums mt-2 text-slate-900 dark:text-slate-50">
            {value}
        </div>
        <p className="text-xs text-slate-500 mt-0.5">{note}</p>
    </div>
);

export default DashboardOverview;
