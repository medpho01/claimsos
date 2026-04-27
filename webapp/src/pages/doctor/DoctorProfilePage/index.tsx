import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader, AlertCircle, Home, LogOut } from 'lucide-react';
import ApiService from '@/services/api';
import { GlobalNavbar } from '@/components/Navbar';

// Import tab components
import DoctorProfileForm from './components/ProfileForm';
import CredentialsManager from './components/CredentialsManager';
import HospitalAffiliations from './components/HospitalAffiliations';
import PublicSharingManager from './components/PublicSharingManager';

interface DoctorProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  profile_photo_url?: string;
  primary_specialization: string;
  secondary_specializations?: string[];
  nmc_registration_number?: string;
  state_registration_number?: string;
  registration_status: string;
  registration_method: string;
  is_public_profile_enabled: boolean;
  created_at: string;
  updated_at: string;
}

const DoctorProfilePage: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<DoctorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('profile');

  // Verify user is a doctor
  useEffect(() => {
    if (user && user.role !== 'doctor') {
      navigate('/login');
    }
  }, [user, navigate]);

  // Fetch doctor profile
  useEffect(() => {
    const fetchProfile = async () => {
      try {
        setLoading(true);
        setError(null);

        // Get current user's doctor profile
        const response = await ApiService.get('/doctors/me');

        if (response.data.success && response.data.data) {
          setProfile(response.data.data);
        } else {
          setError('Failed to load profile');
        }
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to load doctor profile';
        setError(errorMsg);
        console.error('Error loading profile:', err);
      } finally {
        setLoading(false);
      }
    };

    if (user) {
      fetchProfile();
    }
  }, [user]);

  const handleProfileUpdate = (updatedProfile: Partial<DoctorProfile>) => {
    setProfile((prev) => ({ ...prev, ...updatedProfile } as DoctorProfile));
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  if (!user || user.role !== 'doctor') {
    return (
      <>
        <GlobalNavbar />
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-16 flex items-center justify-center">
          <Alert variant="destructive" className="max-w-md">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Unauthorized access. Please log in as a doctor.</AlertDescription>
          </Alert>
        </div>
      </>
    );
  }

  if (loading) {
    return (
      <>
        <GlobalNavbar />
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-16 flex items-center justify-center">
          <Loader className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      </>
    );
  }

  if (error || !profile) {
    return (
      <>
        <GlobalNavbar />
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-16">
          <div className="max-w-4xl mx-auto px-6 py-8">
            <Button variant="outline" onClick={() => navigate('/')} className="mb-6 gap-2">
              <Home className="h-4 w-4" />
              Back to Home
            </Button>
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error || 'Profile not found. Please complete your registration.'}</AlertDescription>
            </Alert>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <GlobalNavbar />
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-16">
        <div className="max-w-5xl mx-auto px-6 py-8">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
                  {profile.profile_photo_url ? (
                    <img
                      src={profile.profile_photo_url}
                      alt={`${profile.first_name} ${profile.last_name}`}
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : (
                    <span className="text-2xl font-bold text-white">
                      {profile.first_name[0]}
                      {profile.last_name[0]}
                    </span>
                  )}
                </div>
                <div>
                  <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
                    Dr. {profile.first_name} {profile.last_name}
                  </h1>
                  <p className="text-slate-600 dark:text-slate-400">
                    {profile.primary_specialization} • Member since {new Date(profile.created_at).getFullYear()}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                onClick={handleLogout}
                className="gap-2 text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                <LogOut className="h-4 w-4" />
                Logout
              </Button>
            </div>
          </div>

          {/* Tabs */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-4 mb-8">
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
              <TabsTrigger value="hospitals">Hospitals</TabsTrigger>
              <TabsTrigger value="sharing">Public Profile</TabsTrigger>
            </TabsList>

            {/* Profile Tab */}
            <TabsContent value="profile" className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Professional Information</CardTitle>
                  <CardDescription>
                    Update your basic professional details and contact information
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <DoctorProfileForm
                    profile={profile}
                    onProfileUpdate={handleProfileUpdate}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Credentials Tab */}
            <TabsContent value="credentials" className="space-y-6">
              <CredentialsManager doctorId={profile.id} />
            </TabsContent>

            {/* Hospitals Tab */}
            <TabsContent value="hospitals" className="space-y-6">
              <HospitalAffiliations doctorId={profile.id} />
            </TabsContent>

            {/* Public Profile Tab */}
            <TabsContent value="sharing" className="space-y-6">
              <PublicSharingManager
                doctorId={profile.id}
                isPublic={profile.is_public_profile_enabled}
                onPublicStatusChange={(isPublic) =>
                  setProfile({ ...profile, is_public_profile_enabled: isPublic })
                }
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
};

export default DoctorProfilePage;
