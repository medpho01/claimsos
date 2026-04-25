import React, { useState, useEffect } from 'react';
import { Copy, Plus, Trash2, Eye, EyeOff, Loader, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import ApiService from '@/services/api';

interface ShareLink {
  id: string;
  token: string;
  created_at: string;
  created_by?: string;
  expires_at?: string;
  view_count?: number;
  last_viewed_at?: string;
  is_active: boolean;
}

interface PublicSharingManagerProps {
  doctorId: string;
  isPublic: boolean;
  onPublicStatusChange: (isPublic: boolean) => void;
}

const PublicSharingManager: React.FC<PublicSharingManagerProps> = ({
  doctorId,
  isPublic,
  onPublicStatusChange,
}) => {
  const [publicEnabled, setPublicEnabled] = useState(isPublic);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [linkToDelete, setLinkToDelete] = useState<ShareLink | null>(null);

  useEffect(() => {
    fetchShareLinks();
  }, [doctorId]);

  const fetchShareLinks = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await ApiService.get(`/doctors/${doctorId}/share-links`);
      const linksData = response.data?.data || [];
      setShareLinks(Array.isArray(linksData) ? linksData : []);
    } catch (err: any) {
      console.error('Error fetching share links:', err);
      if (err.response?.status !== 404) {
        setError(err.response?.data?.message || 'Failed to load share links');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePublic = async () => {
    try {
      setUpdating(true);
      setError(null);

      await ApiService.put(`/doctors/${doctorId}`, {
        is_public_profile_enabled: !publicEnabled,
      });

      setPublicEnabled(!publicEnabled);
      onPublicStatusChange(!publicEnabled);
      setSuccess(
        !publicEnabled
          ? 'Profile is now visible in the public directory'
          : 'Profile is no longer visible in the public directory'
      );
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update profile visibility');
    } finally {
      setUpdating(false);
    }
  };

  const handleGenerateShareLink = async () => {
    try {
      setUpdating(true);
      setError(null);

      const response = await ApiService.post(`/doctors/${doctorId}/share-links`, {
        expiresInDays: null,
      });

      if (response.data.success && response.data.data) {
        setShareLinks([...shareLinks, response.data.data]);
        setSuccess('Share link generated successfully');
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to generate share link');
    } finally {
      setUpdating(false);
    }
  };

  const handleDeleteShareLink = async (link: ShareLink) => {
    try {
      await ApiService.delete(`/doctors/${doctorId}/share-links/${link.id}`);
      setShareLinks(shareLinks.filter(l => l.id !== link.id));
      setLinkToDelete(null);
      setSuccess('Share link revoked');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete share link');
    }
  };

  const handleCopyLink = (token: string) => {
    const shareUrl = `${window.location.origin}/public-doctor/${token}`;
    navigator.clipboard.writeText(shareUrl);
    setCopied(token);
    setTimeout(() => setCopied(null), 2000);
  };

  const getShareUrl = (token: string) => {
    return `${window.location.origin}/public-doctor/${token}`;
  };

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-green-200 bg-green-50">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800">{success}</AlertDescription>
        </Alert>
      )}

      {/* Public Profile Toggle */}
      <Card>
        <CardHeader>
          <CardTitle>Public Profile Visibility</CardTitle>
          <CardDescription>
            Make your profile visible in the public doctor directory
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
            <div className="flex items-center gap-3">
              {publicEnabled ? (
                <Eye className="h-5 w-5 text-green-600" />
              ) : (
                <EyeOff className="h-5 w-5 text-slate-400" />
              )}
              <div>
                <p className="font-medium text-slate-900 dark:text-white">
                  {publicEnabled ? 'Profile is Public' : 'Profile is Private'}
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {publicEnabled
                    ? 'Your profile appears in the public doctor directory'
                    : 'Only people with a share link can see your profile'}
                </p>
              </div>
            </div>
            <Button
              onClick={handleTogglePublic}
              disabled={updating}
              variant={publicEnabled ? 'default' : 'outline'}
            >
              {updating ? (
                <>
                  <Loader className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : publicEnabled ? (
                'Make Private'
              ) : (
                'Make Public'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Share Links */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Share Links</CardTitle>
            <CardDescription>
              Generate private share links to share your profile directly
            </CardDescription>
          </div>
          <Button onClick={handleGenerateShareLink} disabled={updating} className="gap-2">
            <Plus className="h-4 w-4" />
            Generate Link
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader className="h-6 w-6 animate-spin text-blue-600" />
            </div>
          ) : shareLinks.length === 0 ? (
            <div className="p-8 text-center text-slate-600 dark:text-slate-400">
              <p className="mb-2">No share links yet</p>
              <p className="text-sm">Generate a share link to share your profile with specific people</p>
            </div>
          ) : (
            <div className="space-y-3">
              {shareLinks.map((link) => (
                <div
                  key={link.id}
                  className="p-4 border border-slate-200 dark:border-slate-700 rounded-lg"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                      <p className="text-sm font-mono text-slate-600 dark:text-slate-400 break-all">
                        {getShareUrl(link.token)}
                      </p>
                      <div className="flex flex-wrap gap-4 mt-2 text-xs text-slate-500 dark:text-slate-500">
                        {link.view_count !== undefined && (
                          <span>Views: {link.view_count}</span>
                        )}
                        {link.last_viewed_at && (
                          <span>Last viewed: {new Date(link.last_viewed_at).toLocaleDateString()}</span>
                        )}
                        <span>Created: {new Date(link.created_at).toLocaleDateString()}</span>
                        {link.expires_at && (
                          <span>Expires: {new Date(link.expires_at).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCopyLink(link.token)}
                      className="gap-2"
                    >
                      <Copy className="h-4 w-4" />
                      {copied === link.token ? 'Copied!' : 'Copy Link'}
                    </Button>
                    <AlertDialog open={linkToDelete?.id === link.id} onOpenChange={(open) => !open && setLinkToDelete(null)}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setLinkToDelete(link)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 gap-2"
                      >
                        <Trash2 className="h-4 w-4" />
                        Revoke
                      </Button>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Revoke Share Link</AlertDialogTitle>
                          <AlertDialogDescription>
                            People with this link will no longer be able to view your profile. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteShareLink(link)}
                            className="bg-red-600 hover:bg-red-700"
                          >
                            Revoke Link
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Privacy Information */}
      <Card className="border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950">
        <CardContent className="pt-6">
          <p className="text-sm text-blue-900 dark:text-blue-100">
            <span className="font-semibold">Privacy Notice:</span> Your verified credentials and professional
            information will be displayed on your public profile. Personal details like phone and email are only shown if you
            enable them. You control visibility through these settings.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default PublicSharingManager;
