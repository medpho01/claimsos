import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader,
  AlertCircle,
  Home,
  Activity,
  Settings as SettingsIcon,
} from 'lucide-react';
import ApiService from '@/services/api';
import { useHospitalDataContext } from '@/pages/hospital/context/HospitalDataContext';
import { useAuth } from '@/context/AuthContext';

// Feature components
import ProfileForm from './components/ProfileForm';
import AttributesManager from './components/AttributesManager';
import PanelsManager from './components/PanelsManager';
import DoctorsManager from './components/DoctorsManager';
import PublicSharingManager from './components/PublicSharingManager';
import HospitalUserList from '@/pages/superadmin/HospitalDetailsPage/components/HospitalUserList';
import AddUserModal from '@/components/modals/AddUserModal';

/**
 * UI Revamp — Hospital Configuration screens (wireframe screen-hw-hospital-profile,
 * hw-profile, hw-panels, hw-doctors, hw-users, hw-sharing).
 *
 * All six Configuration sub-screens share the same chrome: breadcrumb,
 * Operations/Configuration mode toggle (Configuration active), and
 * an underline tab strip. Content is swapped per active tab.
 *
 * Tabs (wireframe order):
 *   - profile     → Hospital profile (ProfileForm)
 *   - attributes  → Hospital attributes (AttributesManager)
 *   - panels      → Panel (PanelsManager)
 *   - doctors     → Doctors (DoctorsManager)
 *   - users       → Users (HospitalUserList) — was a separate /users route,
 *                   now also reachable here. The /portal/:id/users route
 *                   still works and lands the user on this same tab.
 *   - sharing     → Public sharing (PublicSharingManager)
 */

type TabKey = 'profile' | 'attributes' | 'panels' | 'doctors' | 'users' | 'sharing';

export default function HospitalProfilePage() {
  const { hospitalId } = useParams<{ hospitalId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [hospitalName, setHospitalName] = useState<string>('');
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    const t = new URLSearchParams(location.search).get('tab');
    return (t && ['profile', 'attributes', 'panels', 'doctors', 'users', 'sharing'].includes(t)
      ? (t as TabKey)
      : 'profile');
  });

  // Hospital users + panels (for the Users tab + tab-count badges)
  const {
    hospital,
    hospitalUsers,
    hospitalPanels,
    setHospitalUsers,
  } = useHospitalDataContext();
  const { user } = useAuth();
  const [showAddUser, setShowAddUser] = useState(false);

  useEffect(() => {
    if (!hospitalId) {
      navigate('/');
      return;
    }
    fetchProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hospitalId]);

  const fetchProfile = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await ApiService.getHospitalProfile(hospitalId!);
      const profileData = response.data.data.profile;
      setProfile(profileData);
      setHospitalName(profileData?.legal_name || '');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load hospital profile');
      console.error('Error loading profile:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddUserSuccess = () => {
    setShowAddUser(false);
    if (hospitalId) {
      ApiService.getHospitalUsers(hospitalId).then((res) => {
        setHospitalUsers(res.data.data || []);
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader className="h-8 w-8 animate-spin text-brand-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-danger-100 bg-danger-50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-danger-700" />
              <CardTitle className="text-danger-700">Error loading profile</CardTitle>
            </div>
            <CardDescription className="text-danger-700">{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={fetchProfile} className="bg-brand-600 hover:bg-brand-700 text-white">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="p-6">
        <Card className="border-warn-100 bg-warn-50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-warn-700" />
              <CardTitle className="text-warn-700">Profile not found</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => navigate(`/portal/${hospitalId}`)}
              className="bg-brand-600 hover:bg-brand-700 text-white"
            >
              Back to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'profile',    label: 'Hospital profile' },
    { key: 'attributes', label: 'Hospital attributes' },
    { key: 'panels',     label: 'Panel',             count: hospitalPanels?.length },
    { key: 'doctors',    label: 'Doctors' },
    { key: 'users',      label: 'Users',             count: hospitalUsers?.length },
    { key: 'sharing',    label: 'Public sharing' },
  ];

  return (
    <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-6 space-y-4">
      {/* Breadcrumb */}
      <nav className="text-sm text-slate-500 flex items-center gap-1.5 flex-wrap">
        <Home className="h-3.5 w-3.5" />
        <button onClick={() => navigate('/')} className="hover:text-brand-700">
          Hospitals
        </button>
        <span className="text-slate-300">/</span>
        <button
          onClick={() => navigate(`/portal/${hospitalId}`)}
          className="hover:text-brand-700"
        >
          {hospitalName || 'Hospital'}
        </button>
        <span className="text-slate-300">/</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">
          Configuration
        </span>
      </nav>

      {/* Mode toggle (Configuration active) */}
      <div className="flex items-center justify-between">
        <div className="inline-flex p-[3px] gap-[2px] rounded-md bg-slate-100 border border-slate-200 dark:bg-slate-900 dark:border-slate-700">
          <button
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400"
            onClick={() => navigate(`/portal/${hospitalId}`)}
          >
            <Activity className="h-3.5 w-3.5" />
            Operations
          </button>
          <button
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[5px] text-xs font-medium bg-white text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,.06),0_0_0_1px_rgba(15,23,42,.04)] dark:bg-slate-800 dark:text-slate-50"
            aria-pressed="true"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            Configuration
          </button>
        </div>
      </div>

      {/* Underline tab strip */}
      <div className="border-b border-slate-200 dark:border-slate-800 flex items-center gap-1 text-sm overflow-x-auto">
        {tabs.map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => {
              // Sprint 2D: persist the active tab in the URL so deep links,
              // bookmarks, and "open in new tab" all land on the same view
              // instead of resetting to the default profile tab.
              setActiveTab(key);
              const params = new URLSearchParams(location.search);
              params.set('tab', key);
              navigate(
                { pathname: location.pathname, search: params.toString() },
                { replace: true },
              );
            }}
            className={`px-3 py-2 border-b-2 transition-colors shrink-0 ${
              activeTab === key
                ? 'text-slate-900 dark:text-slate-50 font-medium border-brand-600'
                : 'text-slate-500 border-transparent hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {label}
            {typeof count === 'number' && (
              <span className="ml-1.5 text-[11px] text-slate-400">{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Active tab content */}
      <div className="space-y-4">
        {activeTab === 'profile' && (
          <ProfileForm hospitalId={hospitalId!} profile={profile} onProfileUpdate={setProfile} />
        )}
        {activeTab === 'attributes' && <AttributesManager hospitalId={hospitalId!} />}
        {activeTab === 'panels' && <PanelsManager hospitalId={hospitalId!} />}
        {activeTab === 'doctors' && <DoctorsManager hospitalId={hospitalId!} />}
        {activeTab === 'users' && (
          <HospitalUserList
            panels={hospitalPanels}
            users={hospitalUsers}
            loading={false}
            refreshing={false}
            user={user}
            hospital={hospital}
            onAddUser={() => setShowAddUser(true)}
            onUserClick={() => {}}
            onUserUpdate={(updated: any) => {
              setHospitalUsers((prev) =>
                prev.map((u) => (u.user_id === updated.user_id ? updated : u))
              );
            }}
            onRefresh={async () => {
              if (!hospitalId) return;
              const res = await ApiService.getHospitalUsers(hospitalId);
              setHospitalUsers(res.data.data || []);
            }}
          />
        )}
        {activeTab === 'sharing' && <PublicSharingManager hospitalId={hospitalId!} />}
      </div>

      {/* Add user modal (only used when Users tab is active) */}
      {showAddUser && (
        <AddUserModal
          onClose={() => setShowAddUser(false)}
          onSuccess={handleAddUserSuccess}
          role="hospital"
          hospitalId={hospitalId!}
          panels={hospitalPanels}
        />
      )}
    </div>
  );
}
