import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
    LayoutDashboard,
    Users,
    Building,
    Grid3X3,
    Settings,
    List,
    FileText,
    LogOut,
} from 'lucide-react';

/**
 * UI Revamp — shared SuperAdmin sidebar (wireframe side-rail).
 *
 * Used both in-place on /superadmin (where it drives the local
 * activeTab state) and on /portal/:id when the logged-in user is a
 * SuperAdmin — so the SA always sees the same nav rail, with the
 * hospital workspace rendering as content inside.
 *
 * Two modes:
 *   - `activeTab` + `onTabChange` provided → controlled mode used by
 *     SuperAdminPage. Click handlers call `onTabChange(...)`.
 *   - both omitted → stateless mode used everywhere else. Click
 *     persists the chosen tab to localStorage (same key SuperAdminPage
 *     reads) and navigates to /superadmin, which restores it on mount.
 *
 * Optional `counts` shows numeric badges next to nav items.
 */

export type SaTab =
    | 'dashboard'
    | 'admins'
    | 'hospitals'
    | 'panels'
    | 'hospitalAttributes'
    | 'panelAttributes'
    | 'doctorAttributes'
    | 'masterOptions';

interface SuperAdminSidebarProps {
    activeTab?: SaTab;
    onTabChange?: (tab: SaTab) => void;
    counts?: {
        admins?: number;
        hospitals?: number;
        panels?: number;
        hospitalAttributes?: number;
        panelAttributes?: number;
        doctorAttributes?: number;
        masterOptions?: number;
    };
}

export const SuperAdminSidebar: React.FC<SuperAdminSidebarProps> = ({
    activeTab,
    onTabChange,
    counts = {},
}) => {
    const navigate = useNavigate();
    const location = useLocation();
    const { user, logout } = useAuth();

    const isControlled = typeof onTabChange === 'function';

    // When stateless (called from /portal/:id), nothing in this page's
    // URL marks the active tab — so we don't highlight any item.
    const effectiveActive = isControlled ? activeTab : undefined;

    // Sprint 2D: each sidebar tab gets its own URL so deep links, "open in
    // new tab", and bookmarks all work. Was navigate('/superadmin') + a
    // localStorage handoff — the URL never changed and the route ate the
    // tab choice on a hard reload. The slug map mirrors SuperAdminPage's
    // tabKeyToSlug to keep camelCase keys / kebab-case URLs aligned.
    const TAB_SLUGS: Record<SaTab, string> = {
        dashboard: 'dashboard',
        admins: 'admins',
        hospitals: 'hospitals',
        panels: 'master-panels',
        hospitalAttributes: 'hospital-attributes',
        panelAttributes: 'panel-attributes',
        doctorAttributes: 'doctor-attributes',
        masterOptions: 'master-options',
    };
    const go = (tab: SaTab) => {
        if (isControlled) {
            onTabChange!(tab);
            return;
        }
        try {
            // Keep the localStorage hint for compat with any code still
            // reading it; the URL is now the source of truth.
            localStorage.setItem('superadmin_active_tab', tab);
        } catch {
            /* ignore */
        }
        navigate(`/superadmin/${TAB_SLUGS[tab]}`);
    };

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    const itemClasses = (tab: SaTab) =>
        `w-full justify-start gap-2.5 font-medium ${
            effectiveActive === tab
                ? 'bg-brand-700 text-white hover:bg-brand-700 hover:text-white'
                : 'text-slate-700 dark:text-slate-300'
        }`;

    const badgeClasses = (tab: SaTab) =>
        `ml-auto ${effectiveActive === tab ? 'border-white/30 text-white' : ''}`;

    const role = user?.role === 'superadmin' ? 'Super Admin' : 'Admin';

    // Visual hint that we're on a non-/superadmin page: dim the active highlight
    // (effectiveActive is undefined off /superadmin)
    const onSuperAdmin = location.pathname.startsWith('/superadmin');

    return (
        <aside className="hidden w-64 flex-col border-r border-slate-200 bg-white py-6 dark:border-slate-800 dark:bg-slate-950 md:flex shrink-0">
            <nav className="flex-1 overflow-y-auto px-3 space-y-1">
                {/* PLATFORM group */}
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500">
                    Platform
                </div>
                <Button
                    variant="ghost"
                    className={itemClasses('dashboard')}
                    onClick={() => go('dashboard')}
                >
                    <LayoutDashboard className="h-4 w-4" />
                    Dashboard
                </Button>
                <Button
                    variant="ghost"
                    className={itemClasses('admins')}
                    onClick={() => go('admins')}
                >
                    <Users className="h-4 w-4" />
                    Admin Users
                    {counts.admins !== undefined && (
                        <Badge
                            variant={effectiveActive === 'admins' ? 'outline' : 'secondary'}
                            className={badgeClasses('admins')}
                        >
                            {counts.admins}
                        </Badge>
                    )}
                </Button>
                <Button
                    variant="ghost"
                    className={itemClasses('hospitals')}
                    onClick={() => go('hospitals')}
                >
                    <Building className="h-4 w-4" />
                    Hospitals
                    {counts.hospitals !== undefined && (
                        <Badge
                            variant={effectiveActive === 'hospitals' ? 'outline' : 'secondary'}
                            className={badgeClasses('hospitals')}
                        >
                            {counts.hospitals}
                        </Badge>
                    )}
                </Button>

                {/* CONFIGURATORS group */}
                <div className="px-3 pt-5 pb-1 text-[10px] uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500">
                    Configurators
                </div>
                <Button
                    variant="ghost"
                    className={itemClasses('panels')}
                    onClick={() => go('panels')}
                >
                    <Grid3X3 className="h-4 w-4" />
                    Master Panels
                    {counts.panels !== undefined && (
                        <Badge
                            variant={effectiveActive === 'panels' ? 'outline' : 'secondary'}
                            className={badgeClasses('panels')}
                        >
                            {counts.panels}
                        </Badge>
                    )}
                </Button>
                <Button
                    variant="ghost"
                    className={itemClasses('hospitalAttributes')}
                    onClick={() => go('hospitalAttributes')}
                >
                    <Settings className="h-4 w-4" />
                    Hospital Attributes
                    {counts.hospitalAttributes !== undefined && (
                        <Badge
                            variant={
                                effectiveActive === 'hospitalAttributes' ? 'outline' : 'secondary'
                            }
                            className={badgeClasses('hospitalAttributes')}
                        >
                            {counts.hospitalAttributes}
                        </Badge>
                    )}
                </Button>
                <Button
                    variant="ghost"
                    className={itemClasses('panelAttributes')}
                    onClick={() => go('panelAttributes')}
                >
                    <List className="h-4 w-4" />
                    Panel Attributes
                    {counts.panelAttributes !== undefined && (
                        <Badge
                            variant={
                                effectiveActive === 'panelAttributes' ? 'outline' : 'secondary'
                            }
                            className={badgeClasses('panelAttributes')}
                        >
                            {counts.panelAttributes}
                        </Badge>
                    )}
                </Button>
                <Button
                    variant="ghost"
                    className={itemClasses('doctorAttributes')}
                    onClick={() => go('doctorAttributes')}
                >
                    <FileText className="h-4 w-4" />
                    Doctor Attributes
                    {counts.doctorAttributes !== undefined && (
                        <Badge
                            variant={
                                effectiveActive === 'doctorAttributes' ? 'outline' : 'secondary'
                            }
                            className={badgeClasses('doctorAttributes')}
                        >
                            {counts.doctorAttributes}
                        </Badge>
                    )}
                </Button>
                <Button
                    variant="ghost"
                    className={itemClasses('masterOptions')}
                    onClick={() => go('masterOptions')}
                >
                    <Settings className="h-4 w-4" />
                    Master Options
                    {counts.masterOptions !== undefined && (
                        <Badge
                            variant={
                                effectiveActive === 'masterOptions' ? 'outline' : 'secondary'
                            }
                            className={badgeClasses('masterOptions')}
                        >
                            {counts.masterOptions}
                        </Badge>
                    )}
                </Button>

                {/* When viewing a hospital workspace, give a "Back to dashboard" hint */}
                {!onSuperAdmin && (
                    <div className="pt-4 mt-4 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 px-3">
                        Viewing a hospital workspace
                    </div>
                )}
            </nav>

            {/* Footer */}
            <div className="border-t border-slate-200 dark:border-slate-800 px-3 pt-3 mt-3">
                <div className="flex items-center gap-3 px-2 pb-3">
                    <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs bg-brand-600 text-white">
                            {user &&
                                (user.first_name?.[0] || '') + (user.last_name?.[0] || '')}
                        </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col min-w-0">
                        <span className="text-sm font-medium truncate">
                            {user?.first_name} {user?.last_name}
                        </span>
                        <span className="text-xs text-muted-foreground">{role}</span>
                    </div>
                </div>
                <Button
                    variant="ghost"
                    className="w-full justify-start gap-2.5 font-medium text-slate-600 hover:bg-danger-50 hover:text-danger-700 dark:text-slate-300 dark:hover:bg-danger-700/20 dark:hover:text-danger-50"
                    onClick={handleLogout}
                >
                    <LogOut className="h-4 w-4" />
                    Log out
                </Button>
            </div>
        </aside>
    );
};

export default SuperAdminSidebar;
