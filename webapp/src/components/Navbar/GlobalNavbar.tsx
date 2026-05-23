import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Bell, LogOut, Moon, Search, Settings, Sun, User } from 'lucide-react';

interface GlobalNavbarProps {
  hospitalName?: string;
  showHospitalContext?: boolean;
}

/**
 * UI Revamp — GlobalNavbar rebuilt to match wireframe top bar.
 *
 * Wireframe blocks rendered:
 *   - Brand "C" tile + "ClaimsOS" wordmark + role badge
 *   - Global search input with ⌘K hint
 *   - Theme toggle (sun/moon, persists to localStorage)
 *   - Notifications bell with status dot
 *   - User chip with name + role label
 *
 * The search input has no live behavior wired yet — submitting it logs
 * the term and dispatches a custom event so future search providers
 * can subscribe. Notifications icon is a placeholder for the same
 * reason.
 */
export const GlobalNavbar: React.FC<GlobalNavbarProps> = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [searchTerm, setSearchTerm] = useState('');
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const stored = localStorage.getItem('claimsos.theme');
    if (stored === 'dark') return true;
    if (stored === 'light') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });

  // Apply theme on mount + when toggled
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    try {
      localStorage.setItem('claimsos.theme', isDark ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  }, [isDark]);

  // ⌘K / Ctrl+K focuses the search box
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const el = document.getElementById('global-search-input') as HTMLInputElement | null;
        el?.focus();
        el?.select();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = searchTerm.trim();
      if (!q) return;
      // TODO(wire-up): plug into real omni search. For now dispatch a
      // window event so an attached panel/page can react.
      window.dispatchEvent(new CustomEvent('claimsos:search', { detail: { q } }));
    },
    [searchTerm]
  );

  // Decide a contextual role label for the right-hand chip.
  let roleLabel = 'User';
  if (user?.role === 'superadmin') roleLabel = 'Super Admin';
  else if (user?.role === 'admin') roleLabel = 'Admin';
  else if (user?.role === 'hospital') roleLabel = 'Hospital';
  else if (user?.role === 'doctor') roleLabel = 'Doctor';

  // Compact role badge next to the wordmark (Super Admin / Admin / etc.)
  const roleBadge = user?.role ? (
    <span className="text-xs px-2 py-0.5 rounded bg-brand-700/10 text-brand-700 font-medium hidden sm:inline-block">
      {roleLabel}
    </span>
  ) : null;

  const initials = `${user?.first_name?.[0] || ''}${user?.last_name?.[0] || ''}`.toUpperCase() || 'U';

  // Brand click goes home for the current role
  const handleBrandClick = () => {
    if (user?.role === 'superadmin') navigate('/superadmin');
    else if (user?.role === 'hospital' && (user as any).hospital_id)
      navigate(`/portal/${(user as any).hospital_id}`);
    else if (user?.role === 'doctor') navigate('/doctor/profile');
    else navigate('/');
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-12 border-b border-slate-200 bg-white px-4 flex items-center justify-between dark:bg-slate-950 dark:border-slate-800">
      {/* LEFT — brand + role badge */}
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        <button
          onClick={handleBrandClick}
          className="flex items-center gap-2 hover:opacity-90 transition-opacity"
          aria-label="ClaimsOS home"
        >
          <div className="h-7 w-7 rounded bg-brand-600 text-white flex items-center justify-center font-bold text-sm shadow-sm">
            C
          </div>
          <span className="font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            ClaimsOS
          </span>
        </button>
        <span className="text-slate-300 mx-1 dark:text-slate-700 hidden sm:inline">/</span>
        {roleBadge}
      </div>

      {/* CENTER — global search */}
      <form
        onSubmit={handleSearchSubmit}
        className="flex-1 max-w-md mx-8 hidden md:block"
        role="search"
      >
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
          <input
            id="global-search-input"
            type="search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search hospitals, doctors, panels…"
            className="w-full h-8 rounded-md border border-slate-200 bg-slate-50 pl-8 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-brand-600/30 focus:border-brand-600 transition-shadow dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            aria-label="Search"
          />
          <span className="absolute right-2 top-1.5 text-[10px] text-slate-400 font-mono border border-slate-200 rounded px-1.5 py-0.5 dark:border-slate-700 dark:text-slate-500">
            ⌘K
          </span>
        </div>
      </form>

      {/* RIGHT — theme, notifications, user */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setIsDark((v) => !v)}
          className="h-8 w-8 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600 dark:hover:bg-slate-800 dark:text-slate-300 transition-colors"
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <button
          className="relative h-8 w-8 rounded-md hover:bg-slate-100 flex items-center justify-center text-slate-600 dark:hover:bg-slate-800 dark:text-slate-300 transition-colors"
          title="Notifications"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {/* TODO: drive dot visibility from notification count */}
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-danger-600 ring-2 ring-white dark:ring-slate-950" />
        </button>

        <div className="pl-3 border-l border-slate-200 dark:border-slate-800">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
                <Avatar className="h-7 w-7">
                  <AvatarImage src="" />
                  <AvatarFallback className="bg-brand-700 text-white text-[10px] font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="text-xs leading-tight text-left hidden lg:block">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {user?.first_name} {user?.last_name?.[0] && `${user.last_name[0]}.`}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400">{roleLabel}</div>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                {user?.first_name} {user?.last_name}
                <div className="text-xs text-slate-500 font-normal">{user?.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {user?.role === 'doctor' && (
                <DropdownMenuItem onClick={() => navigate('/doctor/profile')}>
                  <User className="mr-2 h-4 w-4" />
                  My profile
                </DropdownMenuItem>
              )}
              {user?.role === 'hospital' && (user as any).hospital_id && (
                <DropdownMenuItem
                  onClick={() => navigate(`/portal/${(user as any).hospital_id}/profile`)}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  Hospital settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleLogout} className="text-danger-700">
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
};
