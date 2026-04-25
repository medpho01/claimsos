import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader, AlertCircle, CheckCircle2, Share2, FileText, BarChart3 } from 'lucide-react';
import ApiService from '@/services/api';

interface HospitalOperationsCardProps {
  hospitalId: string;
}

interface ProfileStats {
  verification_status?: string;
  verification_level?: string;
  total_attributes?: number;
  verified_attributes?: number;
  pending_attributes?: number;
  total_documents?: number;
}

interface SharingStats {
  active_shares?: number;
  total_views?: number;
  last_viewed?: string;
}

export default function HospitalOperationsCard({ hospitalId }: HospitalOperationsCardProps) {
  const navigate = useNavigate();
  const [profileStats, setProfileStats] = useState<ProfileStats | null>(null);
  const [sharingStats, setSharingStats] = useState<SharingStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStats();
  }, [hospitalId]);

  const fetchStats = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch profile stats
      const profileRes = await ApiService.getHospitalProfile(hospitalId);
      setProfileStats({
        verification_status: profileRes.data.data?.verification_status,
        verification_level: profileRes.data.data?.verification_level,
        total_attributes: profileRes.data.data?.attributes_count || 0,
        verified_attributes: profileRes.data.data?.verified_attributes_count || 0,
        pending_attributes: profileRes.data.data?.pending_attributes_count || 0,
        total_documents: profileRes.data.data?.documents_count || 0,
      });

      // Fetch sharing stats
      const sharingRes = await ApiService.getShareLinks(hospitalId);
      const shares = sharingRes.data.data || [];
      const activeShares = shares.filter((s: any) => s.is_active).length;
      const totalViews = shares.reduce((sum: number, s: any) => sum + (s.view_count || 0), 0);
      const lastViewed = shares
        .filter((s: any) => s.last_viewed)
        .sort((a: any, b: any) => new Date(b.last_viewed).getTime() - new Date(a.last_viewed).getTime())[0]
        ?.last_viewed;

      setSharingStats({
        active_shares: activeShares,
        total_views: totalViews,
        last_viewed: lastViewed,
      });
    } catch (err: any) {
      console.error('Error fetching operations stats:', err);
      setError('Could not load hospital operations data');
    } finally {
      setLoading(false);
    }
  };

  if (error) {
    return (
      <Card className="border-yellow-200 bg-yellow-50 mb-6">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-yellow-700">
            <AlertCircle className="h-5 w-5" />
            <span className="text-sm">{error}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mb-6 space-y-4">
      {/* Section Header */}
      <div className="px-2">
        <h2 className="text-xl font-bold text-slate-900">Hospital Operations</h2>
        <p className="text-sm text-slate-500 mt-1">Manage your hospital profile, documents, and public sharing</p>
      </div>

      {/* Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Profile Management Card */}
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <FileText className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">Profile Management</CardTitle>
                  <CardDescription>Manage hospital information & attributes</CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader className="h-5 w-5 animate-spin text-blue-600" />
              </div>
            ) : (
              <>
                {/* Status Badge */}
                {profileStats?.verification_status && (
                  <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg">
                    {profileStats.verification_status === 'verified' ? (
                      <>
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-slate-900">Verified</p>
                          <p className="text-xs text-slate-600">Level {profileStats.verification_level || 'N/A'}</p>
                        </div>
                      </>
                    ) : (
                      <>
                        <BarChart3 className="h-5 w-5 text-yellow-600" />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-slate-900">Pending Verification</p>
                          <p className="text-xs text-slate-600">{profileStats.pending_attributes} items to verify</p>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-2xl font-bold text-blue-600">{profileStats?.total_attributes || 0}</p>
                    <p className="text-xs text-slate-600">Attributes</p>
                  </div>
                  <div className="p-3 bg-purple-50 rounded-lg">
                    <p className="text-2xl font-bold text-purple-600">{profileStats?.total_documents || 0}</p>
                    <p className="text-xs text-slate-600">Documents</p>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="default"
                    className="flex-1 gap-2"
                    onClick={() => navigate(`/portal/${hospitalId}/profile`)}
                  >
                    <FileText className="h-4 w-4" />
                    Manage Profile
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => navigate(`/portal/${hospitalId}/profile?tab=documents`)}
                  >
                    View Docs
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Public Sharing Card */}
        <Card className="hover:shadow-md transition-shadow">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Share2 className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">Public Sharing</CardTitle>
                  <CardDescription>Share your profile publicly</CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader className="h-5 w-5 animate-spin text-green-600" />
              </div>
            ) : (
              <>
                {/* Share Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-green-50 rounded-lg">
                    <p className="text-2xl font-bold text-green-600">{sharingStats?.active_shares || 0}</p>
                    <p className="text-xs text-slate-600">Active Links</p>
                  </div>
                  <div className="p-3 bg-emerald-50 rounded-lg">
                    <p className="text-2xl font-bold text-emerald-600">{sharingStats?.total_views || 0}</p>
                    <p className="text-xs text-slate-600">Total Views</p>
                  </div>
                </div>

                {/* Last Viewed */}
                {sharingStats?.last_viewed && (
                  <div className="p-3 bg-slate-50 rounded-lg">
                    <p className="text-sm font-medium text-slate-900">Last Viewed</p>
                    <p className="text-xs text-slate-600">
                      {new Date(sharingStats.last_viewed).toLocaleDateString()} at{' '}
                      {new Date(sharingStats.last_viewed).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                )}

                {sharingStats?.active_shares === 0 && (
                  <div className="p-3 bg-slate-50 rounded-lg text-center">
                    <p className="text-sm text-slate-600">No active share links yet</p>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="default"
                    className="flex-1 gap-2"
                    onClick={() => navigate(`/portal/${hospitalId}/profile?tab=sharing`)}
                  >
                    <Share2 className="h-4 w-4" />
                    Manage Shares
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => navigate('/hospitals')}
                  >
                    Directory
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
