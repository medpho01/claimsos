import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Check, Clock, XCircle, Loader } from 'lucide-react';
import ApiService from '@/services/api';

interface VerificationDashboardProps {
  hospitalId: string;
}

interface VerificationItem {
  id: string;
  key: string;
  name: string;
  category: string;
  status: 'pending' | 'verified' | 'rejected';
  verified_date?: string;
  verified_by?: string;
  rejection_reason?: string;
}

interface VerificationChecklistItem {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'completed' | 'rejected';
  category: string;
  completed_date?: string;
  notes?: string;
}

export default function VerificationDashboard({ hospitalId }: VerificationDashboardProps) {
  const [verificationData, setVerificationData] = useState<any>(null);
  const [verificationItems, setVerificationItems] = useState<VerificationItem[]>([]);
  const [checklist, setChecklist] = useState<VerificationChecklistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  useEffect(() => {
    fetchVerificationData();
  }, [hospitalId]);

  const fetchVerificationData = async () => {
    try {
      setLoading(true);
      const [dashRes, checklistRes, unverifiedRes] = await Promise.all([
        ApiService.getVerificationDashboard(hospitalId),
        ApiService.getVerificationChecklist(hospitalId),
        ApiService.getUnverifiedAttributes(hospitalId),
      ]);

      setVerificationData(dashRes.data.data);
      setChecklist(checklistRes.data.data || []);

      // Map unverified attributes as verification items
      const items: VerificationItem[] = (unverifiedRes.data.data || []).map((attr: any) => ({
        id: attr.id,
        key: attr.attribute_key,
        name: attr.definition?.display_name || attr.attribute_key,
        category: attr.definition?.category || 'General',
        status: attr.verification_status || 'pending',
        verified_date: attr.verified_at,
        verified_by: attr.verified_by,
        rejection_reason: attr.rejection_reason,
      }));

      setVerificationItems(items);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load verification data');
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'verified':
        return <Check className="h-5 w-5 text-green-600" />;
      case 'rejected':
        return <XCircle className="h-5 w-5 text-red-600" />;
      default:
        return <Clock className="h-5 w-5 text-yellow-600" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'verified':
        return 'bg-green-50 border-green-200';
      case 'rejected':
        return 'bg-red-50 border-red-200';
      default:
        return 'bg-yellow-50 border-yellow-200';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'verified':
        return <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded font-medium">Verified</span>;
      case 'rejected':
        return <span className="px-2 py-1 bg-red-100 text-red-700 text-xs rounded font-medium">Rejected</span>;
      default:
        return <span className="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs rounded font-medium">Pending</span>;
    }
  };

  const categories = ['all', ...Array.from(new Set(verificationItems.map(item => item.category)))];
  const filteredItems = selectedCategory === 'all'
    ? verificationItems
    : verificationItems.filter(item => item.category === selectedCategory);

  if (loading) {
    return (
      <Card>
        <CardContent className="pt-6 flex items-center justify-center">
          <Loader className="h-6 w-6 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
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

      {/* Overall Status Summary */}
      {verificationData && (
        <Card>
          <CardHeader>
            <CardTitle>Verification Status</CardTitle>
            <CardDescription>Overall hospital verification progress</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Status Metrics */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Card className="bg-brand-50 border-brand-50">
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-brand-600">
                      {verificationData.total_items}
                    </div>
                    <div className="text-sm text-brand-700 mt-1">Total Items</div>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-green-50 border-green-200">
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-600">
                      {verificationData.verified_count}
                    </div>
                    <div className="text-sm text-green-700 mt-1">Verified</div>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-yellow-50 border-yellow-200">
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-yellow-600">
                      {verificationData.pending_count}
                    </div>
                    <div className="text-sm text-yellow-700 mt-1">Pending</div>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-red-50 border-red-200">
                <CardContent className="pt-6">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-red-600">
                      {verificationData.rejected_count}
                    </div>
                    <div className="text-sm text-red-700 mt-1">Rejected</div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Progress Bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Verification Progress</span>
                <span className="text-sm font-bold">
                  {verificationData.total_items > 0
                    ? Math.round((verificationData.verified_count / verificationData.total_items) * 100)
                    : 0}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-green-600 h-2 rounded-full transition-all"
                  style={{
                    width: verificationData.total_items > 0
                      ? `${(verificationData.verified_count / verificationData.total_items) * 100}%`
                      : '0%'
                  }}
                ></div>
              </div>
            </div>

            {/* Status Text */}
            <div className="bg-gray-50 p-4 rounded-lg">
              <p className="text-sm text-gray-700">
                <span className="font-semibold">{verificationData.verified_count}</span> out of{' '}
                <span className="font-semibold">{verificationData.total_items}</span> items verified.{' '}
                {verificationData.pending_count > 0 && (
                  <>
                    <span className="font-semibold">{verificationData.pending_count}</span> items pending verification.
                  </>
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Verification Checklist */}
      {checklist.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Verification Checklist</CardTitle>
            <CardDescription>Required items for hospital verification</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {checklist.map(item => (
                <div
                  key={item.id}
                  className={`p-4 border rounded-lg ${getStatusColor(item.status)}`}
                >
                  <div className="flex items-start gap-3">
                    {getStatusIcon(item.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold">{item.title}</h4>
                        {getStatusBadge(item.status)}
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{item.description}</p>
                      {item.completed_date && (
                        <p className="text-xs text-gray-500 mt-2">
                          Completed: {new Date(item.completed_date).toLocaleDateString()}
                        </p>
                      )}
                      {item.notes && (
                        <p className="text-xs text-gray-600 mt-2 italic">{item.notes}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Verification Items by Category */}
      <Card>
        <CardHeader>
          <CardTitle>Verification Items</CardTitle>
          <CardDescription>Details of all items requiring verification</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Category Filter */}
          <div className="flex gap-2 flex-wrap">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  selectedCategory === cat
                    ? 'bg-brand-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {cat === 'all' ? 'All Categories' : cat}
              </button>
            ))}
          </div>

          {/* Items List */}
          {filteredItems.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              No items in this category
            </div>
          ) : (
            <div className="space-y-3">
              {filteredItems.map(item => (
                <div
                  key={item.id}
                  className={`p-4 border rounded-lg ${getStatusColor(item.status)}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 flex-1">
                      {getStatusIcon(item.status)}
                      <div className="flex-1 min-w-0">
                        <h4 className="font-semibold">{item.name}</h4>
                        <p className="text-sm text-gray-600">{item.key}</p>
                      </div>
                    </div>
                    {getStatusBadge(item.status)}
                  </div>

                  {item.verified_date && (
                    <div className="mt-3 text-xs text-gray-600 space-y-1">
                      <p>Verified on: {new Date(item.verified_date).toLocaleDateString()}</p>
                      {item.verified_by && <p>Verified by: {item.verified_by}</p>}
                    </div>
                  )}

                  {item.rejection_reason && (
                    <div className="mt-3 p-2 bg-red-100 rounded text-xs text-red-700">
                      <p className="font-medium">Rejection Reason:</p>
                      <p>{item.rejection_reason}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
