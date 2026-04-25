import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Building2, AlertCircle, Loader } from 'lucide-react';
import ApiService from '@/services/api';

interface HospitalAffiliation {
  id: string;
  hospital_id: string;
  doctor_id: string;
  employment_type: string;
  department: string;
  specialization: string;
  designation: string;
  start_date?: string;
  end_date?: string;
  status: string;
  hospital?: {
    id: string;
    name: string;
    legal_name: string;
    city?: string;
    state?: string;
  };
}

interface HospitalAffiliationsProps {
  doctorId: string;
}

const HospitalAffiliations: React.FC<HospitalAffiliationsProps> = ({ doctorId }) => {
  const [affiliations, setAffiliations] = useState<HospitalAffiliation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAffiliations();
  }, [doctorId]);

  const fetchAffiliations = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await ApiService.get(`/doctors/${doctorId}/hospitals`);
      const affData = response.data?.data || [];
      setAffiliations(Array.isArray(affData) ? affData : []);
    } catch (err: any) {
      console.error('Error fetching affiliations:', err);
      // Don't show error if it's just 404 (no affiliations yet)
      if (err.response?.status !== 404) {
        setError(err.response?.data?.message || 'Failed to load hospital affiliations');
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader className="h-6 w-6 animate-spin text-blue-600" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-6">
          Hospital Affiliations
        </h2>

        {affiliations.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Building2 className="h-12 w-12 text-slate-300 mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
                No Hospital Affiliations
              </h3>
              <p className="text-slate-600 dark:text-slate-400 text-center max-w-md">
                You haven't been added to any hospitals yet. Hospital administrators can add you to their network.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {affiliations.map((affiliation) => (
              <Card key={affiliation.id}>
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-xl font-semibold text-slate-900 dark:text-white">
                        {affiliation.hospital?.name || affiliation.hospital?.legal_name}
                      </h3>
                      <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                        {affiliation.hospital?.city && affiliation.hospital?.state
                          ? `${affiliation.hospital.city}, ${affiliation.hospital.state}`
                          : 'Location not specified'}
                      </p>
                    </div>
                    <Badge
                      variant={affiliation.status === 'active' ? 'default' : 'secondary'}
                      className="capitalize"
                    >
                      {affiliation.status}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-200 dark:border-slate-700">
                    <div>
                      <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        Designation
                      </p>
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        {affiliation.designation}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        Department
                      </p>
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        {affiliation.department}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        Specialization
                      </p>
                      <p className="text-sm font-medium text-slate-900 dark:text-white">
                        {affiliation.specialization}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        Employment Type
                      </p>
                      <Badge variant="outline" className="capitalize">
                        {affiliation.employment_type}
                      </Badge>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                        Since
                      </p>
                      <p className="text-sm text-slate-900 dark:text-white">
                        {affiliation.start_date
                          ? new Date(affiliation.start_date).toLocaleDateString()
                          : 'Not specified'}
                      </p>
                    </div>

                    {affiliation.end_date && (
                      <div>
                        <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                          Until
                        </p>
                        <p className="text-sm text-slate-900 dark:text-white">
                          {new Date(affiliation.end_date).toLocaleDateString()}
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default HospitalAffiliations;
