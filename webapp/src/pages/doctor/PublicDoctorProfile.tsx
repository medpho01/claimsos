import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GlobalNavbar } from '@/components/Navbar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader, AlertCircle, Home, Download, Share2, CheckCircle, Clock, FileText, Building2, Award } from 'lucide-react';
import ApiService from '@/services/api';

interface DoctorAttribute {
  id: string;
  attribute_key: string;
  label?: string;
  category?: string;
  value_text?: string;
  value_date?: string;
  value_boolean?: boolean;
  certificate_number?: string;
  issuing_authority?: string;
  issued_at?: string;
  expires_at?: string;
  verification_status: string;
  verified_at?: string;
  created_at?: string;
}

interface HospitalAffiliation {
  id: string;
  hospital_id: string;
  doctor_id: string;
  employment_type: string;
  department: string;
  specialization: string;
  designation: string;
  start_date?: string;
  status: string;
  hospital?: {
    name: string;
    legal_name: string;
    city?: string;
    state?: string;
  };
}

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
  is_public_profile_enabled: boolean;
  created_at: string;
  attributes?: DoctorAttribute[];
  hospital_affiliations?: HospitalAffiliation[];
}

const PublicDoctorProfile: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [doctor, setDoctor] = useState<DoctorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>('qualifications');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fetchDoctorProfile = async () => {
      try {
        setLoading(true);
        setError(null);

        if (!token) {
          setError('Invalid profile link');
          return;
        }

        const response = await ApiService.get(`/public/doctor/${token}`);

        if (response.data.success && response.data.data) {
          setDoctor(response.data.data);
        } else {
          setError('Doctor profile not found');
        }
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || 'Failed to load doctor profile';
        setError(errorMsg);
        console.error('Error loading doctor profile:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchDoctorProfile();
  }, [token]);

  const handleShare = () => {
    const url = window.location.href;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = () => {
    if (!doctor) return;

    const exportData = {
      doctor: {
        name: `Dr. ${doctor.first_name} ${doctor.last_name}`,
        email: doctor.email,
        phone: doctor.phone,
        specialization: doctor.primary_specialization,
        nmc_registration: doctor.nmc_registration_number,
        registration_status: doctor.registration_status,
        profile_generated_at: new Date().toISOString(),
      },
      attributes: doctor.attributes || [],
      affiliations: doctor.hospital_affiliations || [],
    };

    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${doctor.first_name}-${doctor.last_name}-profile.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const groupAttributesByCategory = (attributes?: DoctorAttribute[]) => {
    if (!attributes) return {};

    return attributes.reduce(
      (acc, attr) => {
        const category = attr.category || 'other';
        if (!acc[category]) {
          acc[category] = [];
        }
        acc[category].push(attr);
        return acc;
      },
      {} as Record<string, DoctorAttribute[]>
    );
  };

  const getCategoryIcon = (category: string) => {
    const icons: Record<string, React.ReactNode> = {
      qualifications: <Award className="h-5 w-5" />,
      licenses: <FileText className="h-5 w-5" />,
      registrations: <CheckCircle className="h-5 w-5" />,
      compliance: <CheckCircle className="h-5 w-5" />,
      experience: <Award className="h-5 w-5" />,
    };
    return icons[category] || <FileText className="h-5 w-5" />;
  };

  const getCategoryLabel = (category: string) => {
    const labels: Record<string, string> = {
      qualifications: 'Qualifications',
      licenses: 'Licenses & Registration',
      registrations: 'Registrations',
      compliance: 'Compliance',
      experience: 'Experience',
    };
    return labels[category] || category;
  };

  const getVerificationStatusColor = (status: string) => {
    switch (status) {
      case 'verified':
      case 'verified_by_doc':
      case 'verified_by_image':
      case 'verified_by_online':
      case 'verified_manual':
      case 'auto_verified':
        return 'bg-green-100 text-green-800';
      case 'pending_review':
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'rejected':
        return 'bg-red-100 text-red-800';
      case 'expired':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-slate-100 text-slate-800';
    }
  };

  const getVerificationStatusLabel = (status: string) => {
    const labels: Record<string, string> = {
      verified_by_doc: 'Verified by Document',
      verified_by_image: 'Verified by Image',
      verified_by_online: 'Verified Online',
      verified_manual: 'Verified Manually',
      auto_verified: 'Auto Verified',
      unverified: 'Unverified',
      pending_review: 'Pending Review',
      rejected: 'Rejected',
      expired: 'Expired',
    };
    return labels[status] || status;
  };

  if (loading) {
    return (
      <>
        <GlobalNavbar />
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-16 flex items-center justify-center">
          <Loader className="h-8 w-8 animate-spin text-brand-600" />
        </div>
      </>
    );
  }

  if (error || !doctor) {
    return (
      <>
        <GlobalNavbar />
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-16">
          <div className="max-w-4xl mx-auto px-6 py-8">
            <Button variant="outline" onClick={() => navigate('/doctors')} className="mb-6 gap-2">
              <Home className="h-4 w-4" />
              Back to Directory
            </Button>
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error || 'Doctor profile not found'}</AlertDescription>
            </Alert>
          </div>
        </div>
      </>
    );
  }

  const attributesByCategory = groupAttributesByCategory(doctor.attributes);

  return (
    <>
      <GlobalNavbar />
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-16">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* Back Button */}
          <Button variant="outline" onClick={() => navigate('/doctors')} className="mb-6 gap-2">
            <Home className="h-4 w-4" />
            Back to Directory
          </Button>

          {/* Profile Header */}
          <Card className="mb-8 overflow-hidden">
            <CardContent className="p-8">
              <div className="flex items-start gap-8 mb-8">
                {/* Avatar */}
                <div className="w-24 h-24 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center flex-shrink-0">
                  {doctor.profile_photo_url ? (
                    <img
                      src={doctor.profile_photo_url}
                      alt={`${doctor.first_name} ${doctor.last_name}`}
                      className="w-full h-full rounded-full object-cover"
                    />
                  ) : (
                    <span className="text-3xl font-bold text-white">
                      {doctor.first_name[0]}
                      {doctor.last_name[0]}
                    </span>
                  )}
                </div>

                {/* Basic Info */}
                <div className="flex-1">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-2">
                        Dr. {doctor.first_name} {doctor.last_name}
                      </h1>
                      <p className="text-lg text-slate-600 dark:text-slate-400">
                        {doctor.primary_specialization}
                      </p>
                    </div>
                    {doctor.registration_status === 'active' && (
                      <Badge className="bg-green-100 text-green-800">Verified</Badge>
                    )}
                  </div>

                  {/* Contact Info */}
                  <div className="space-y-2 mb-4">
                    {doctor.email && (
                      <p className="text-sm text-slate-600 dark:text-slate-400">
                        <span className="font-medium">Email:</span> {doctor.email}
                      </p>
                    )}
                    {doctor.phone && (
                      <p className="text-sm text-slate-600 dark:text-slate-400">
                        <span className="font-medium">Phone:</span> {doctor.phone}
                      </p>
                    )}
                  </div>

                  {/* Registration Numbers */}
                  {(doctor.nmc_registration_number || doctor.state_registration_number) && (
                    <div className="grid grid-cols-2 gap-4 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
                      {doctor.nmc_registration_number && (
                        <div>
                          <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                            NMC Registration
                          </p>
                          <p className="text-sm font-mono text-slate-900 dark:text-white">
                            {doctor.nmc_registration_number}
                          </p>
                        </div>
                      )}
                      {doctor.state_registration_number && (
                        <div>
                          <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                            State Registration
                          </p>
                          <p className="text-sm font-mono text-slate-900 dark:text-white">
                            {doctor.state_registration_number}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2 pt-4 border-t border-slate-200 dark:border-slate-700">
                <Button variant="outline" onClick={handleShare} className="gap-2">
                  <Share2 className="h-4 w-4" />
                  {copied ? 'Copied!' : 'Share Profile'}
                </Button>
                <Button variant="outline" onClick={handleExport} className="gap-2">
                  <Download className="h-4 w-4" />
                  Export Profile
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Secondary Specializations */}
          {doctor.secondary_specializations && doctor.secondary_specializations.length > 0 && (
            <Card className="mb-8">
              <CardHeader>
                <CardTitle className="text-lg">Specializations</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {doctor.secondary_specializations.map((spec) => (
                    <Badge key={spec} variant="secondary">
                      {spec}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Credentials & Attributes */}
          {Object.keys(attributesByCategory).length > 0 && (
            <Card className="mb-8">
              <CardHeader>
                <CardTitle>Credentials & Qualifications</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {Object.entries(attributesByCategory).map(([category, attributes]) => (
                  <div key={category} className="border-b border-slate-200 dark:border-slate-700 pb-4 last:border-b-0">
                    <button
                      onClick={() =>
                        setExpandedCategory(expandedCategory === category ? null : category)
                      }
                      className="w-full flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        {getCategoryIcon(category)}
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {getCategoryLabel(category)}
                        </span>
                        <Badge variant="secondary">{attributes.length}</Badge>
                      </div>
                      <Clock className={`h-5 w-5 transition-transform ${expandedCategory === category ? 'rotate-180' : ''}`} />
                    </button>

                    {expandedCategory === category && (
                      <div className="mt-4 space-y-3">
                        {attributes.map((attr) => (
                          <div key={attr.id} className="p-4 border border-slate-200 dark:border-slate-700 rounded-lg">
                            <div className="flex items-start justify-between mb-2">
                              <h4 className="font-medium text-slate-900 dark:text-white">
                                {attr.label || attr.attribute_key}
                              </h4>
                              <Badge className={getVerificationStatusColor(attr.verification_status)}>
                                {getVerificationStatusLabel(attr.verification_status)}
                              </Badge>
                            </div>

                            {attr.value_text && (
                              <p className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                                {attr.value_text}
                              </p>
                            )}

                            {attr.certificate_number && (
                              <div className="text-sm text-slate-600 dark:text-slate-400 mb-2">
                                <p>
                                  <span className="font-medium">Certificate #:</span> {attr.certificate_number}
                                </p>
                                {attr.issuing_authority && (
                                  <p>
                                    <span className="font-medium">Issued by:</span> {attr.issuing_authority}
                                  </p>
                                )}
                              </div>
                            )}

                            <div className="text-xs text-slate-500 dark:text-slate-500 space-y-1">
                              {attr.issued_at && (
                                <p>
                                  <span className="font-medium">Issued:</span>{' '}
                                  {new Date(attr.issued_at).toLocaleDateString()}
                                </p>
                              )}
                              {attr.expires_at && (
                                <p className={attr.expires_at < new Date().toISOString() ? 'text-red-600' : ''}>
                                  <span className="font-medium">Expires:</span>{' '}
                                  {new Date(attr.expires_at).toLocaleDateString()}
                                </p>
                              )}
                              {attr.verified_at && (
                                <p className="text-green-600">
                                  <span className="font-medium">Verified:</span>{' '}
                                  {new Date(attr.verified_at).toLocaleDateString()}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Hospital Affiliations */}
          {doctor.hospital_affiliations && doctor.hospital_affiliations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="h-5 w-5" />
                  Hospital Affiliations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4">
                  {doctor.hospital_affiliations.map((affiliation) => (
                    <div key={affiliation.id} className="p-4 border border-slate-200 dark:border-slate-700 rounded-lg">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <h4 className="font-semibold text-slate-900 dark:text-white">
                            {affiliation.hospital?.name || affiliation.hospital?.legal_name}
                          </h4>
                          <p className="text-sm text-slate-600 dark:text-slate-400">
                            {affiliation.hospital?.city && affiliation.hospital?.state
                              ? `${affiliation.hospital.city}, ${affiliation.hospital.state}`
                              : ''}
                          </p>
                        </div>
                        <Badge
                          variant={affiliation.status === 'active' ? 'default' : 'secondary'}
                        >
                          {affiliation.status}
                        </Badge>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mt-3 text-sm text-slate-600 dark:text-slate-400">
                        <div>
                          <p className="font-medium">Designation</p>
                          <p>{affiliation.designation}</p>
                        </div>
                        <div>
                          <p className="font-medium">Department</p>
                          <p>{affiliation.department}</p>
                        </div>
                        <div>
                          <p className="font-medium">Employment Type</p>
                          <p className="capitalize">{affiliation.employment_type}</p>
                        </div>
                        <div>
                          <p className="font-medium">Since</p>
                          <p>
                            {affiliation.start_date
                              ? new Date(affiliation.start_date).toLocaleDateString()
                              : 'Not specified'}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
};

export default PublicDoctorProfile;
