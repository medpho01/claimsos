import React, { useState, useEffect } from 'react';
import { Plus, Trash2, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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

interface DoctorAttribute {
  id: string;
  attribute_key: string;
  label?: string;
  category?: string;
  value_text?: string;
  value_date?: string;
  certificate_number?: string;
  issuing_authority?: string;
  issued_at?: string;
  expires_at?: string;
  verification_status: string;
  verified_at?: string;
}

interface AttributeDefinition {
  id: string;
  key: string;
  label: string;
  category: string;
  data_type: string;
  requires_document?: boolean;
}

interface CredentialsManagerProps {
  doctorId: string;
}

const CredentialsManager: React.FC<CredentialsManagerProps> = ({ doctorId }) => {
  const [credentials, setCredentials] = useState<DoctorAttribute[]>([]);
  const [definitions, setDefinitions] = useState<AttributeDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [credentialToDelete, setCredentialToDelete] = useState<DoctorAttribute | null>(null);
  const [formData, setFormData] = useState({
    attribute_key: '',
    value_text: '',
    value_date: '',
    certificate_number: '',
    issuing_authority: '',
    issued_at: '',
    expires_at: '',
  });

  // Fetch credentials and definitions
  useEffect(() => {
    fetchCredentials();
  }, [doctorId]);

  const fetchCredentials = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch credentials
      const credsResponse = await ApiService.get(`/doctors/${doctorId}/attributes`);
      const credsData = credsResponse.data?.data || [];
      setCredentials(Array.isArray(credsData) ? credsData : []);

      // Fetch attribute definitions
      const defsResponse = await ApiService.get('/admin/doctor-attributes/definitions');
      const defsData = defsResponse.data?.data || [];
      setDefinitions(Array.isArray(defsData) ? defsData : []);
    } catch (err: any) {
      console.error('Error fetching credentials:', err);
      setError(err.response?.data?.message || 'Failed to load credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleAddCredential = async () => {
    if (!formData.attribute_key) {
      setError('Please select a credential type');
      return;
    }

    try {
      const submitData: any = {
        value_text: formData.value_text || null,
        value_date: formData.value_date || null,
      };

      if (formData.certificate_number) submitData.certificate_number = formData.certificate_number;
      if (formData.issuing_authority) submitData.issuing_authority = formData.issuing_authority;
      if (formData.issued_at) submitData.issued_at = formData.issued_at;
      if (formData.expires_at) submitData.expires_at = formData.expires_at;

      await ApiService.post(
        `/doctors/${doctorId}/attributes/${formData.attribute_key}`,
        submitData
      );

      setFormData({
        attribute_key: '',
        value_text: '',
        value_date: '',
        certificate_number: '',
        issuing_authority: '',
        issued_at: '',
        expires_at: '',
      });
      setIsAddDialogOpen(false);
      setError(null);
      fetchCredentials();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to add credential');
    }
  };

  const handleDeleteCredential = async (credential: DoctorAttribute) => {
    try {
      await ApiService.delete(
        `/doctors/${doctorId}/attributes/${credential.attribute_key}`
      );
      setCredentials(credentials.filter(c => c.id !== credential.id));
      setCredentialToDelete(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete credential');
    }
  };

  const groupCredentialsByCategory = () => {
    return credentials.reduce(
      (acc, cred) => {
        const category = cred.category || 'other';
        if (!acc[category]) {
          acc[category] = [];
        }
        acc[category].push(cred);
        return acc;
      },
      {} as Record<string, DoctorAttribute[]>
    );
  };

  const getVerificationStatusColor = (status: string) => {
    switch (status) {
      case 'verified':
      case 'verified_by_doc':
      case 'auto_verified':
        return 'bg-green-100 text-green-800';
      case 'pending_review':
        return 'bg-yellow-100 text-yellow-800';
      case 'expired':
        return 'bg-orange-100 text-orange-800';
      case 'rejected':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-slate-100 text-slate-800';
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <div className="text-slate-500">Loading credentials...</div>
        </CardContent>
      </Card>
    );
  }

  const groupedCredentials = groupCredentialsByCategory();
  const categories = Object.keys(groupedCredentials);

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Your Credentials</h2>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Add Credential
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add New Credential</DialogTitle>
              <DialogDescription>Add a qualification, license, or certification</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Credential Type */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Credential Type *
                </label>
                <select
                  value={formData.attribute_key}
                  onChange={(e) => setFormData({ ...formData, attribute_key: e.target.value })}
                  className="mt-1 w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-800 dark:text-white text-sm"
                >
                  <option value="">Select a credential type</option>
                  {definitions.map((def) => (
                    <option key={def.id} value={def.key}>
                      {def.label} ({def.category})
                    </option>
                  ))}
                </select>
              </div>

              {/* Value/Text */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Value/Details
                </label>
                <Input
                  placeholder="e.g., Doctor of Medicine"
                  value={formData.value_text}
                  onChange={(e) => setFormData({ ...formData, value_text: e.target.value })}
                  className="mt-1"
                />
              </div>

              {/* Certificate Number */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Certificate Number
                </label>
                <Input
                  placeholder="e.g., CERT-12345"
                  value={formData.certificate_number}
                  onChange={(e) => setFormData({ ...formData, certificate_number: e.target.value })}
                  className="mt-1"
                />
              </div>

              {/* Issuing Authority */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Issuing Authority
                </label>
                <Input
                  placeholder="e.g., Medical Council of India"
                  value={formData.issuing_authority}
                  onChange={(e) => setFormData({ ...formData, issuing_authority: e.target.value })}
                  className="mt-1"
                />
              </div>

              {/* Dates */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Issued Date
                  </label>
                  <Input
                    type="date"
                    value={formData.issued_at}
                    onChange={(e) => setFormData({ ...formData, issued_at: e.target.value })}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    Expiry Date
                  </label>
                  <Input
                    type="date"
                    value={formData.expires_at}
                    onChange={(e) => setFormData({ ...formData, expires_at: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>

              {/* Submit */}
              <div className="flex gap-2 pt-4 border-t border-slate-200 dark:border-slate-700">
                <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleAddCredential} className="flex-1">
                  Add Credential
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {categories.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="h-12 w-12 text-slate-300 mb-4" />
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
              No Credentials Yet
            </h3>
            <p className="text-slate-600 dark:text-slate-400 text-center">
              Start adding your qualifications, licenses, and certifications to build your professional profile.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {categories.map((category) => (
            <Card key={category}>
              <CardHeader>
                <CardTitle className="text-lg capitalize">{category}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {groupedCredentials[category].map((cred) => (
                  <div key={cred.id} className="p-4 border border-slate-200 dark:border-slate-700 rounded-lg">
                    <div className="flex items-start justify-between mb-2">
                      <h4 className="font-semibold text-slate-900 dark:text-white">
                        {cred.label || cred.attribute_key}
                      </h4>
                      <Badge className={getVerificationStatusColor(cred.verification_status)}>
                        {cred.verification_status === 'verified_by_doc'
                          ? 'Verified'
                          : cred.verification_status === 'unverified'
                          ? 'Unverified'
                          : cred.verification_status}
                      </Badge>
                    </div>

                    {cred.value_text && (
                      <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                        {cred.value_text}
                      </p>
                    )}

                    <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1 mb-3">
                      {cred.certificate_number && (
                        <p>
                          <span className="font-medium">Cert #:</span> {cred.certificate_number}
                        </p>
                      )}
                      {cred.issuing_authority && (
                        <p>
                          <span className="font-medium">Issued by:</span> {cred.issuing_authority}
                        </p>
                      )}
                      {cred.issued_at && (
                        <p>
                          <span className="font-medium">Issued:</span> {new Date(cred.issued_at).toLocaleDateString()}
                        </p>
                      )}
                      {cred.expires_at && (
                        <p
                          className={
                            cred.expires_at < new Date().toISOString()
                              ? 'text-red-600'
                              : ''
                          }
                        >
                          <span className="font-medium">Expires:</span>{' '}
                          {new Date(cred.expires_at).toLocaleDateString()}
                        </p>
                      )}
                    </div>

                    <AlertDialog open={credentialToDelete?.id === cred.id} onOpenChange={(open) => !open && setCredentialToDelete(null)}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCredentialToDelete(cred)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 w-full"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </Button>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete Credential</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to delete this credential? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteCredential(cred)}
                            className="bg-red-600 hover:bg-red-700"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default CredentialsManager;
