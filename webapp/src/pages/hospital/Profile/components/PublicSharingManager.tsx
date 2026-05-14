import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertCircle, Copy, Trash2, Plus, Loader, Share2, Eye, Calendar } from 'lucide-react';
import ApiService from '@/services/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface PublicSharingManagerProps {
  hospitalId: string;
}

interface ShareLink {
  id: string;
  token: string;
  shareUrl: string;
  created_at: string;
  created_by?: string;
  expires_at?: string;
  view_count: number;
  last_viewed_at?: string;
  is_active: boolean;
}

export default function PublicSharingManager({ hospitalId }: PublicSharingManagerProps) {
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showRevokeDialog, setShowRevokeDialog] = useState(false);
  const [revokeShareId, setRevokeShareId] = useState<string>('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    expiresAt: '',
    description: '',
  });

  useEffect(() => {
    fetchShareLinks();
  }, [hospitalId]);

  const fetchShareLinks = async () => {
    try {
      setLoading(true);
      const response = await ApiService.getShareLinks(hospitalId);
      setShareLinks(response.data.data || []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load share links');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateShare = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSharing(true);

      // Convert expiration date to days
      let expiresInDays = undefined;
      if (formData.expiresAt) {
        const expiryDate = new Date(formData.expiresAt);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expiryDate.setHours(0, 0, 0, 0);
        expiresInDays = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 3600 * 24));

        if (expiresInDays <= 0) {
          setError('Expiration date must be in the future');
          setSharing(false);
          return;
        }
      }

      await ApiService.generateShareLink(hospitalId, {
        expiresInDays,
      });
      setSuccess('Share link created successfully');
      setShowCreateDialog(false);
      setFormData({ expiresAt: '', description: '' });
      await fetchShareLinks();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create share link');
    } finally {
      setSharing(false);
    }
  };

  const handleCopyLink = (url: string, linkId: string) => {
    navigator.clipboard.writeText(url);
    setCopiedId(linkId);
    setSuccess('Link copied to clipboard');
    setTimeout(() => {
      setCopiedId(null);
      setSuccess(null);
    }, 2000);
  };

  const handleRevokeLink = async () => {
    if (!revokeShareId) return;

    try {
      setLoading(true);
      await ApiService.revokeShareLink(hospitalId, revokeShareId);
      await fetchShareLinks();
      setSuccess('Share link revoked successfully');
      setShowRevokeDialog(false);
      setRevokeShareId('');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to revoke share link');
    } finally {
      setLoading(false);
    }
  };

  const getExpirationStatus = (expiresAt?: string) => {
    if (!expiresAt) return { text: 'No expiration', color: 'text-gray-600', bg: 'bg-gray-100' };

    const expiryDate = new Date(expiresAt);
    const now = new Date();
    const daysRemaining = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 3600 * 24));

    if (daysRemaining < 0) {
      return { text: 'Expired', color: 'text-red-600', bg: 'bg-red-100' };
    } else if (daysRemaining < 7) {
      return { text: `Expires in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`, color: 'text-red-600', bg: 'bg-red-100' };
    } else {
      return { text: `Expires in ${daysRemaining} days`, color: 'text-yellow-600', bg: 'bg-yellow-100' };
    }
  };

  if (loading && !shareLinks.length) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center justify-center">
          <Loader className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              {error}
            </div>
          </CardContent>
        </Card>
      )}

      {success && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="pt-6">
            <div className="text-green-600">{success}</div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Public Profile Sharing</CardTitle>
              <CardDescription>Generate shareable links to your hospital profile</CardDescription>
            </div>
            <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Create Share Link
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {shareLinks.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <Share2 className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No share links created yet</p>
              <p className="text-sm mt-1">Create a share link to make your profile publicly accessible</p>
            </div>
          ) : (
            <div className="space-y-4">
              {shareLinks.map(link => {
                const expStatus = getExpirationStatus(link.expires_at);
                return (
                  <div key={link.id} className="p-4 border rounded-lg space-y-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <h4 className="font-semibold">Share Link</h4>
                          {!link.is_active && (
                            <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded font-medium">
                              Revoked
                            </span>
                          )}
                        </div>

                        {/* Share Link URL */}
                        <div className="space-y-2 mb-3">
                          <Label className="text-xs text-gray-600">Public URL</Label>
                          <div className="flex gap-2">
                            <Input
                              readOnly
                              value={link.shareUrl}
                              className="bg-gray-50 text-sm font-mono"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleCopyLink(link.shareUrl, link.id)}
                              className="gap-1"
                            >
                              <Copy className="h-4 w-4" />
                              {copiedId === link.id ? 'Copied' : 'Copy'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Link Details */}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm py-3 border-t">
                      <div>
                        <span className="text-gray-600">Created: </span>
                        <span className="font-medium">{new Date(link.created_at).toLocaleDateString()}</span>
                      </div>

                      <div className="flex items-center gap-1">
                        <Eye className="h-4 w-4 text-gray-400" />
                        <span className="text-gray-600">Views: </span>
                        <span className="font-medium">{link.view_count}</span>
                      </div>

                      <div className={`px-2 py-1 rounded text-xs font-medium ${expStatus.bg} ${expStatus.color}`}>
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {expStatus.text}
                        </div>
                      </div>

                      {link.last_viewed_at && (
                        <div className="col-span-2 md:col-span-3">
                          <span className="text-gray-600">Last viewed: </span>
                          <span className="font-medium">{new Date(link.last_viewed_at).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2 pt-2 border-t">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(link.shareUrl, '_blank')}
                        disabled={!link.is_active}
                        className="gap-1 flex-1"
                      >
                        <Eye className="h-4 w-4" />
                        Preview
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setRevokeShareId(link.id);
                          setShowRevokeDialog(true);
                        }}
                        className="gap-1 text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="h-4 w-4" />
                        Revoke
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Share Link Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Share Link</DialogTitle>
            <DialogDescription>
              Generate a public link to share your hospital profile
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateShare} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="description">Description (Optional)</Label>
              <Input
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="e.g., Share with Partners"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="expiresAt">Expiration Date (Optional)</Label>
              <Input
                id="expiresAt"
                type="date"
                value={formData.expiresAt}
                onChange={(e) => setFormData({ ...formData, expiresAt: e.target.value })}
              />
              <p className="text-xs text-gray-500">
                Leave blank for no expiration
              </p>
            </div>

            <div className="bg-brand-50 p-3 rounded-lg text-sm text-brand-700">
              <p className="font-medium mb-1">Share Link Benefits:</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>View count tracking</li>
                <li>Customizable expiration</li>
                <li>Revocable anytime</li>
                <li>Secure token-based access</li>
              </ul>
            </div>

            <div className="flex gap-2 pt-4">
              <Button type="submit" disabled={sharing} className="flex-1">
                {sharing ? 'Creating...' : 'Create Link'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreateDialog(false)}
                disabled={sharing}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Revoke Confirmation Dialog */}
      <Dialog open={showRevokeDialog} onOpenChange={setShowRevokeDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke Share Link</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke this share link? Access will be immediately revoked and the link will no longer work.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2 pt-4">
            <Button
              variant="destructive"
              onClick={handleRevokeLink}
              disabled={loading}
              className="flex-1"
            >
              {loading ? 'Revoking...' : 'Revoke'}
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowRevokeDialog(false)}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
