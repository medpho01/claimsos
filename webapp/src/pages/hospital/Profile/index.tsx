import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader, AlertCircle, Home } from 'lucide-react';
import ApiService from '@/services/api';
import './HospitalProfilePage.css';

// Import feature components
import ProfileForm from './components/ProfileForm';
import AttributesManager from './components/AttributesManager';
import PanelsManager from './components/PanelsManager';
import DoctorsManager from './components/DoctorsManager';
import PublicSharingManager from './components/PublicSharingManager';

export default function HospitalProfilePage() {
  const { hospitalId } = useParams<{ hospitalId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [hospitalName, setHospitalName] = useState<string>('');
  const [activeTab, setActiveTab] = useState('profile');

  // Load hospital profile data
  useEffect(() => {
    if (!hospitalId) {
      navigate('/hospital/dashboard');
      return;
    }

    fetchProfile();
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

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-red-200 bg-red-50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-600" />
              <CardTitle className="text-red-600">Error Loading Profile</CardTitle>
            </div>
            <CardDescription className="text-red-600">{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={fetchProfile}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="p-6">
        <Card className="border-yellow-200 bg-yellow-50">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-yellow-600" />
              <CardTitle className="text-yellow-600">Profile Not Found</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/hospital/dashboard')}>Back to Dashboard</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="p-6 pb-0">
        <div className="max-w-7xl mx-auto">
          {/* Breadcrumb Navigation */}
          <nav className="breadcrumb-nav breadcrumb-nav-constrained">
            <button
              onClick={() => navigate('/')}
              className="breadcrumb-link"
            >
              <Home className="h-4 w-4" />
              Hospitals
            </button>
            <span className="breadcrumb-separator">&gt;</span>
            <button
              onClick={() => navigate(`/hospital/${hospitalId}`)}
              className="breadcrumb-link"
            >
              {hospitalName || 'Hospital'}
            </button>
            <span className="breadcrumb-separator">&gt;</span>
            <span className="breadcrumb-current">Manage Profile</span>
          </nav>
        </div>
      </div>

      <div className="p-6">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <div className="mb-6 flex items-stretch gap-4">
            <div className="w-14 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center flex-shrink-0">
              <span className="text-2xl font-bold text-white">
                {hospitalName?.[0]?.toUpperCase() || 'H'}
              </span>
            </div>
            <div>
              <h1 className="text-3xl font-bold text-slate-900">{hospitalName || 'Hospital'}</h1>
              <p className="text-sm text-slate-500 mt-2">Hospital Profile Management</p>
            </div>
          </div>

          {/* Tabs — UI Revamp PR C.1: brand-tinted active state */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-5 mb-6 bg-slate-100 dark:bg-slate-800/60">
              <TabsTrigger value="profile" className="data-[state=active]:bg-white data-[state=active]:text-brand-700 data-[state=active]:shadow-sm font-medium">Profile</TabsTrigger>
              <TabsTrigger value="attributes" className="data-[state=active]:bg-white data-[state=active]:text-brand-700 data-[state=active]:shadow-sm font-medium">Attributes</TabsTrigger>
              <TabsTrigger value="panels" className="data-[state=active]:bg-white data-[state=active]:text-brand-700 data-[state=active]:shadow-sm font-medium">Panels</TabsTrigger>
              <TabsTrigger value="doctors" className="data-[state=active]:bg-white data-[state=active]:text-brand-700 data-[state=active]:shadow-sm font-medium">Doctors</TabsTrigger>
              <TabsTrigger value="sharing" className="data-[state=active]:bg-white data-[state=active]:text-brand-700 data-[state=active]:shadow-sm font-medium">Sharing</TabsTrigger>
            </TabsList>

            {/* Profile Tab */}
            <TabsContent value="profile" className="space-y-4">
              <ProfileForm hospitalId={hospitalId!} profile={profile} onProfileUpdate={setProfile} />
            </TabsContent>

            {/* Attributes Tab */}
            <TabsContent value="attributes" className="space-y-4">
              <AttributesManager hospitalId={hospitalId!} />
            </TabsContent>

            {/* Panels Tab */}
            <TabsContent value="panels" className="space-y-4">
              <PanelsManager hospitalId={hospitalId!} />
            </TabsContent>

            {/* Doctors Tab */}
            <TabsContent value="doctors" className="space-y-4">
              <DoctorsManager hospitalId={hospitalId!} />
            </TabsContent>

            {/* Sharing Tab */}
            <TabsContent value="sharing" className="space-y-4">
              <PublicSharingManager hospitalId={hospitalId!} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
