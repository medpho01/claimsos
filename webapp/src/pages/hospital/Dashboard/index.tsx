import React, { useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useHospitalDataContext } from "../../hospital/context/HospitalDataContext";
import { motion } from "framer-motion";
import {
    Activity,
    Settings as SettingsIcon,
    Share2,
    MoreHorizontal,
    Home,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * UI Revamp PR I.* — Hospital workspace Overview (wireframe `hw-overview`).
 *
 * Replaces the legacy stat-card dashboard with the full wireframe layout:
 *   - Breadcrumb
 *   - Rich workspace header (S avatar, name, location/UUID/onboarded date,
 *     share-link + ... menu, profile/expiry/panels/IPDs status pills)
 *   - Operations / Configuration mode toggle (Operations is the daily-work
 *     view rendered here; Configuration navigates to /portal/:id/profile)
 *   - Overview / Patients sub-tabs (underline style)
 *   - 4 KPI tiles, Patient pipeline funnel, Needs attention sidebar,
 *     Recent activity feed, Top panels by volume, Verification queue.
 *
 * Data: hospital name/location/dates and panel counts come from the live
 * HospitalDataContext. KPIs and activity feeds use placeholder values
 * marked with TODO until the backend exposes a workspace-stats endpoint.
 */
const HospitalDashboard: React.FC = () => {
    const { hospitalId } = useParams<{ hospitalId: string }>();
    const navigate = useNavigate();

    const { hospital, hospitalPanels } = useHospitalDataContext();

    // Live numbers from context
    const panelCount = hospitalPanels.length;
    const admittedTotal = useMemo(
        () =>
            hospitalPanels.reduce(
                (sum, p) => sum + (Number((p as any).admitted_count) || 0),
                0
            ),
        [hospitalPanels]
    );
    const totalPatients = useMemo(
        () => hospitalPanels.reduce((sum, p) => sum + (Number(p.total_count) || 0), 0),
        [hospitalPanels]
    );

    // TODO(workspace-stats): wire to backend. Placeholder until then.
    // QA M4 — until the workspace-stats endpoint ships we hide tiles that
    // would otherwise render "—" / "Activity feed will appear here" /
    // "SLA tracking coming soon". Half a dashboard of placeholders made
    // the product feel half-built. Only the Admitted KPI + pipeline +
    // Top panels are real today.
    const SHOW_PLACEHOLDER_TILES = false;
    const kpis = {
        admitted: admittedTotal,
        inPreAuth: 0,
        settledWeekRupees: 0,
        doctors: 0,
    };
    const pipeline = {
        preAuth: kpis.inPreAuth,
        admitted: admittedTotal,
        submitted: 0,
        queried: 0,
        settledWeek: 0,
    };
    const profilePct = 0; // TODO: derive from attribute completeness
    const docsExpired = 0;
    const docsExpiringSoon = 0;

    if (!hospital) return null;

    const initial = (hospital.name || "?").charAt(0).toUpperCase();
    const onboardedDate = (hospital as any).created_at
        ? new Date((hospital as any).created_at).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric",
          })
        : "—";

    return (
        <motion.div
            className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6 space-y-4"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
        >
            {/* Breadcrumb */}
            <nav className="text-sm text-slate-500 flex items-center gap-1.5">
                <Home className="h-3.5 w-3.5" />
                <button
                    onClick={() => navigate("/")}
                    className="hover:text-brand-700 cursor-pointer"
                >
                    Hospitals
                </button>
                <span className="text-slate-300">/</span>
                <span className="font-medium text-slate-900">{hospital.name}</span>
            </nav>

            {/* Workspace header card */}
            <div className="bg-white border border-slate-200 rounded-lg p-5 dark:bg-slate-900 dark:border-slate-800">
                <div className="flex items-start justify-between gap-6">
                    <div className="flex items-start gap-4">
                        <div className="h-14 w-14 rounded-lg bg-brand-700 text-white text-xl font-semibold flex items-center justify-center shrink-0">
                            {initial}
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                                {hospital.name}
                            </h1>
                            <div className="flex items-center gap-2 mt-1 text-sm text-slate-500 flex-wrap">
                                {(hospital as any).city && (
                                    <>
                                        <span className="inline-flex items-center gap-1">
                                            📍 {(hospital as any).city}
                                        </span>
                                        <span>·</span>
                                    </>
                                )}
                                <span className="font-mono text-xs">
                                    {hospital.id.slice(0, 8)}-{hospital.id.slice(9, 13)}
                                </span>
                                <span>·</span>
                                <span>Onboarded {onboardedDate}</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 text-xs"
                            onClick={() => navigate(`/portal/${hospitalId}/profile`)}
                        >
                            <Share2 className="h-3.5 w-3.5" />
                            Generate share link
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
                <div className="flex items-center gap-2 mt-4 text-xs flex-wrap">
                    <span className={profilePct >= 80 ? "pill pill-ok" : "pill pill-muted"}>
                        Profile {profilePct}%
                    </span>
                    {docsExpired > 0 && (
                        <span className="pill pill-danger">{docsExpired} doc expired</span>
                    )}
                    {docsExpiringSoon > 0 && (
                        <span className="pill pill-warn">
                            {docsExpiringSoon} expiring &lt;30d
                        </span>
                    )}
                    <span className="pill pill-info">{panelCount} panels</span>
                    {/* QA H-1: was {totalPatients} (=sum of total_count) labelled
                        "IPDs admitted" — but the Patients page filters by
                        status='admitted' which is the admitted_count metric.
                        Pin both metrics to the same source. */}
                    <span className="pill pill-info">{admittedTotal} admitted</span>
                </div>
            </div>

            {/* Mode toggle */}
            <div className="flex items-center justify-between">
                <div className="inline-flex p-[3px] gap-[2px] rounded-md bg-slate-100 border border-slate-200 dark:bg-slate-900 dark:border-slate-700">
                    <button
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] text-xs font-medium bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.06),0_0_0_1px_rgba(15,23,42,.04)] dark:bg-slate-800 dark:text-slate-50"
                        aria-pressed="true"
                    >
                        <Activity className="h-3.5 w-3.5" />
                        Operations
                    </button>
                    <button
                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400"
                        onClick={() => navigate(`/portal/${hospitalId}/profile`)}
                    >
                        <SettingsIcon className="h-3.5 w-3.5" />
                        Configuration
                    </button>
                </div>
                <span className="text-xs text-slate-500 hidden sm:inline">
                    Daily work — admissions, claims, documents
                </span>
            </div>

            {/* Sub-tabs (underline style) */}
            <div className="border-b border-slate-200 dark:border-slate-800 flex items-center gap-1 text-sm">
                <button className="px-3 py-2 text-slate-900 dark:text-slate-50 font-medium border-b-2 border-brand-600">
                    Overview
                </button>
                <button
                    className="px-3 py-2 text-slate-500 border-b-2 border-transparent hover:text-slate-900 dark:hover:text-slate-100 transition-colors"
                    onClick={() => navigate(`/portal/${hospitalId}/patients`)}
                >
                    Patients{" "}
                    <span className="ml-1 text-[11px] text-slate-400">{totalPatients}</span>
                </button>
            </div>

            {/* KPI tiles */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiTile label="Admitted" value={kpis.admitted} />
                {SHOW_PLACEHOLDER_TILES && (
                    <>
                        <KpiTile
                            label="In pre-auth"
                            value={kpis.inPreAuth}
                            accent="warn"
                        />
                        <KpiTile
                            label="Settled (wk)"
                            value={
                                kpis.settledWeekRupees
                                    ? `₹${(kpis.settledWeekRupees / 100000).toFixed(1)}L`
                                    : "—"
                            }
                            accent="ok"
                        />
                        <KpiTile label="Doctors" value={kpis.doctors || "—"} />
                    </>
                )}
            </div>

            {/* Main grid: pipeline (2 cols) + right column */}
            <div className={`grid grid-cols-1 gap-4 lg:gap-6 ${SHOW_PLACEHOLDER_TILES ? 'lg:grid-cols-3' : ''}`}>
                {/* Patient pipeline */}
                <div className={`${SHOW_PLACEHOLDER_TILES ? 'lg:col-span-2' : ''} bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800`}>
                    <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                        <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                            Patient pipeline
                        </h2>
                        <button
                            onClick={() => navigate(`/portal/${hospitalId}/patients`)}
                            className="text-xs text-brand-600 hover:underline"
                        >
                            Open patients →
                        </button>
                    </div>
                    <div className="px-5 py-4">
                        <div className="flex gap-3">
                            <PipelineStage label="Pre-auth" value={pipeline.preAuth} tone="info" />
                            <PipelineStage label="Admitted" value={pipeline.admitted} tone="info" />
                            <PipelineStage label="Submitted" value={pipeline.submitted} tone="info" />
                            <PipelineStage label="Queried" value={pipeline.queried} tone="warn" />
                            <PipelineStage label="Settled (wk)" value={pipeline.settledWeek} tone="ok" />
                        </div>
                    </div>
                    {SHOW_PLACEHOLDER_TILES && (
                        <div className="border-t border-slate-100 dark:border-slate-800 px-5 py-3 text-sm flex items-center justify-between">
                            <span className="text-slate-500">
                                Median time-in-pre-auth: <span className="font-medium text-slate-900 dark:text-slate-100">—</span>
                            </span>
                            <span className="text-xs text-slate-400">SLA tracking coming soon</span>
                        </div>
                    )}
                </div>

                {/* Right column: Needs attention + Recent activity */}
                {SHOW_PLACEHOLDER_TILES && (
                <div className="space-y-4 lg:space-y-6">
                    <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
                        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                            <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                                Needs attention
                            </h2>
                        </div>
                        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                            <li className="px-5 py-3 text-sm text-slate-500">
                                Nothing flagged. Verifications and expiry alerts will appear here.
                            </li>
                        </ul>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
                        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
                            <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                                Recent activity
                            </h2>
                        </div>
                        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                            <li className="px-5 py-3 text-sm text-slate-500">
                                Activity feed will appear here.
                            </li>
                        </ul>
                    </div>
                </div>
                )}
            </div>

            {/* Bottom row: Top panels + Verification queue */}
            <div className={`grid grid-cols-1 gap-4 lg:gap-6 ${SHOW_PLACEHOLDER_TILES ? 'lg:grid-cols-2' : ''}`}>
                <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
                    <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                        <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                            Top panels by volume
                        </h2>
                        <button
                            onClick={() => navigate(`/portal/${hospitalId}/panels`)}
                            className="text-xs text-brand-600 hover:underline"
                        >
                            All panels →
                        </button>
                    </div>
                    {hospitalPanels.length === 0 ? (
                        <p className="px-5 py-4 text-sm text-slate-500">No panels yet.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                                {hospitalPanels
                                    .slice()
                                    .sort(
                                        (a: any, b: any) =>
                                            (Number(b.total_count) || 0) - (Number(a.total_count) || 0)
                                    )
                                    .slice(0, 4)
                                    .map((p: any) => (
                                        <tr
                                            key={p.panel_id || p.id}
                                            className="hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                                            onClick={() =>
                                                navigate(
                                                    `/portal/${hospitalId}/panel/${p.panel_id || p.id}`
                                                )
                                            }
                                        >
                                            <td className="px-5 py-2.5 text-slate-900 dark:text-slate-100">
                                                {p.panel_name || p.name}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-200">
                                                {p.total_count || 0}
                                            </td>
                                            <td className="px-3 py-2.5 w-20">
                                                {Number(p.admitted_count) > 0 ? (
                                                    <span className="pill pill-warn">Active</span>
                                                ) : (
                                                    <span className="pill pill-muted">Idle</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    )}
                </div>
                {SHOW_PLACEHOLDER_TILES && (
                    <div className="bg-white border border-slate-200 rounded-lg dark:bg-slate-900 dark:border-slate-800">
                        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                            <h2 className="font-semibold text-sm text-slate-900 dark:text-slate-50">
                                Verification queue
                            </h2>
                            <button
                                onClick={() => navigate(`/portal/${hospitalId}/profile`)}
                                className="text-xs text-brand-600 hover:underline"
                            >
                                Open profile →
                            </button>
                        </div>
                        <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                            <li className="px-5 py-3 text-slate-500">
                                Verification stats will appear once data is wired up.
                            </li>
                        </ul>
                    </div>
                )}
            </div>
        </motion.div>
    );
};

// — local components —

interface KpiTileProps {
    label: string;
    value: string | number;
    accent?: "ok" | "warn";
}
const KpiTile: React.FC<KpiTileProps> = ({ label, value, accent }) => {
    const valueClass =
        accent === "ok"
            ? "text-ok-600"
            : accent === "warn"
            ? "text-warn-700"
            : "text-slate-900 dark:text-slate-50";
    return (
        <div className="bg-white border border-slate-200 rounded-lg p-4 dark:bg-slate-900 dark:border-slate-800">
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                {label}
            </div>
            <div className={`text-3xl font-semibold tabular-nums mt-2 ${valueClass}`}>{value}</div>
        </div>
    );
};

interface PipelineStageProps {
    label: string;
    value: number;
    tone: "info" | "warn" | "ok";
}
const PipelineStage: React.FC<PipelineStageProps> = ({ label, value, tone }) => {
    const bg = { info: "bg-info-50", warn: "bg-warn-50", ok: "bg-ok-50" }[tone];
    const text = { info: "text-info-700", warn: "text-warn-700", ok: "text-ok-700" }[tone];
    return (
        <div className={`flex-1 rounded p-3 text-center ${bg}`}>
            <div className={`text-[10px] uppercase tracking-wider font-semibold ${text}`}>
                {label}
            </div>
            <div className={`text-2xl font-semibold tabular-nums mt-1 ${text}`}>{value}</div>
        </div>
    );
};

export default HospitalDashboard;
