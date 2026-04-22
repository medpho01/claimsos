import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, Loader, MapPin, Globe, Phone, Mail, CheckCircle, X, FileText, Eye, Download, Star, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ApiService from '@/services/api';
import FilePreviewModal from '@/components/FilePreviewModal';

// Helper function to get initials for hospital icon
const getInitials = (name: string): string => {
  return name
    .split(' ')
    .map((word) => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

// Helper function to get color based on initials
const getInitialColor = (initials: string): string => {
  const colors = [
    'bg-blue-600',
    'bg-purple-600',
    'bg-green-600',
    'bg-red-600',
    'bg-indigo-600',
    'bg-cyan-600',
    'bg-teal-600',
    'bg-amber-600'
  ];
  const charCode = initials.charCodeAt(0);
  return colors[charCode % colors.length];
};

interface PublicProfileData {
  profile: {
    id: string;
    legalName: string;
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    district?: string;
    state?: string;
    pincode?: string;
    website?: string;
    email?: string;
    phone?: string;
    hospitalType?: string;
    establishedYear?: number;
    rohiniId?: string;
    hfrId?: string;
    panNumber?: string;
    gstNumber?: string;
    specialties?: string[];
    chequePayableName?: string;
    bankName?: string;
    bankBranch?: string;
    bankAddress?: string;
    accountType?: string;
    accountNumber?: string;
    ifscCode?: string;
    panName?: string;
    micrCode?: string;
    verificationLevel?: string;
    verificationStatus?: string;
  };
  attributes: any[];
  contacts: any[];
  verifiedBadge?: boolean;
}

export default function PublicHospitalProfile() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewFile, setPreviewFile] = useState<{
    fileName: string;
    mimeType: string;
    documentId?: string;
  } | null>(null);

  // Use ref to prevent double fetch in React.StrictMode (development only)
  const hasFetchedRef = useRef(false);

  useEffect(() => {
    // Only fetch once per token change, prevent StrictMode double-call
    if (!hasFetchedRef.current && token) {
      hasFetchedRef.current = true;
      fetchProfile();
    }
  }, [token]);

  const fetchProfile = async () => {
    if (!token) {
      setError('Invalid share link');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const response = await ApiService.accessSharedProfile(token);
      setData(response.data.data);
    } catch (err: any) {
      if (err.response?.status === 404) {
        setError('This share link is no longer valid or has expired');
      } else {
        setError(err.response?.data?.message || 'Failed to load hospital profile');
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader className="h-8 w-8 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Loading hospital profile...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-4xl mx-auto">
          <Card className="border-red-200 bg-red-50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 text-red-600">
                <AlertCircle className="h-6 w-6" />
                <div>
                  <p className="font-semibold">Error Loading Profile</p>
                  <p className="text-sm">{error}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!data || !data.profile) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-4xl mx-auto">
          <Card>
            <CardContent className="pt-6 text-center text-gray-500">
              No profile data available
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const renderValue = (value: any) => {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') {
      return value ? <span className="flex items-center gap-1 text-green-600"><CheckCircle className="h-4 w-4" /> Yes</span> : <span className="flex items-center gap-1 text-red-600"><X className="h-4 w-4" /> No</span>;
    }
    return String(value);
  };

  const hospitalInitials = getInitials(data.profile.legalName);
  const initialColor = getInitialColor(hospitalInitials);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Hero Header Card */}
        <Card className="border-0 shadow-lg bg-white">
          <CardContent className="pt-8 pb-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-6">
              {/* Hospital Icon */}
              <div className={`${initialColor} h-24 w-24 rounded-lg flex items-center justify-center text-white font-bold text-3xl shadow-md flex-shrink-0`}>
                {hospitalInitials}
              </div>

              {/* Hospital Info */}
              <div className="flex-1">
                <h1 className="text-4xl font-bold text-gray-900 mb-3">{data.profile.legalName}</h1>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  {data.profile.hospitalType && (
                    <span className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-full font-medium">
                      {data.profile.hospitalType}
                    </span>
                  )}
                  {data.profile.establishedYear && (
                    <span className="flex items-center gap-1 text-gray-600">
                      <span className="font-medium">Est. {data.profile.establishedYear}</span>
                    </span>
                  )}
                  {data.profile.city && data.profile.state && (
                    <span className="flex items-center gap-1.5 text-gray-600">
                      <MapPin className="h-4 w-4 text-gray-400 flex-shrink-0" />
                      <span>{data.profile.city}, {data.profile.state}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Verified Badge */}
              {data.verifiedBadge && (
                <div className="flex items-center gap-2 px-4 py-2 bg-green-50 rounded-lg border border-green-200 flex-shrink-0">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  <span className="text-green-700 font-medium text-sm">Verified</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tabs */}
        <Card className="border-0 shadow-lg bg-white">
          <Tabs defaultValue="profile" className="w-full">
            <TabsList className="grid w-full grid-cols-2 border-b bg-gray-50 rounded-none">
              <TabsTrigger
                value="profile"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:bg-white"
              >
                Profile Details
              </TabsTrigger>
              <TabsTrigger
                value="attributes"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:bg-white"
              >
                Certifications & Documents
              </TabsTrigger>
            </TabsList>

            {/* Profile Tab */}
            <TabsContent value="profile" className="space-y-6 p-6">
              {/* Basic Information */}
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900">Basic Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white p-4 rounded-lg border">
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Legal Name</label>
                    <p className="text-gray-900">{renderValue(data.profile.legalName)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Hospital Type</label>
                    <p className="text-gray-900">{renderValue(data.profile.hospitalType)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Established Year</label>
                    <p className="text-gray-900">{renderValue(data.profile.establishedYear)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Specialties</label>
                    <p className="text-gray-900">{renderValue(data.profile.specialties ? (Array.isArray(data.profile.specialties) ? data.profile.specialties.join(', ') : data.profile.specialties) : null)}</p>
                  </div>
                </div>
              </div>

              {/* Address Information */}
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900">Address</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white p-4 rounded-lg border">
                  <div className="col-span-2">
                    <label className="text-sm font-medium text-gray-600 block mb-1">Street Address Line 1</label>
                    <p className="text-gray-900">{renderValue(data.profile.addressLine1)}</p>
                  </div>
                  <div className="col-span-2">
                    <label className="text-sm font-medium text-gray-600 block mb-1">Street Address Line 2</label>
                    <p className="text-gray-900">{renderValue(data.profile.addressLine2)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">City</label>
                    <p className="text-gray-900">{renderValue(data.profile.city)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">District</label>
                    <p className="text-gray-900">{renderValue(data.profile.district)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">State</label>
                    <p className="text-gray-900">{renderValue(data.profile.state)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Postal Code</label>
                    <p className="text-gray-900">{renderValue(data.profile.pincode)}</p>
                  </div>
                </div>
              </div>

              {/* Contact Information */}
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900">Contact Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white p-4 rounded-lg border">
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Phone</label>
                    <p className="text-gray-900">
                      {data.profile.phone ? (
                        <a href={`tel:${data.profile.phone}`} className="text-blue-600 hover:underline">
                          {data.profile.phone}
                        </a>
                      ) : '—'}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Email</label>
                    <p className="text-gray-900">
                      {data.profile.email ? (
                        <a href={`mailto:${data.profile.email}`} className="text-blue-600 hover:underline">
                          {data.profile.email}
                        </a>
                      ) : '—'}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <label className="text-sm font-medium text-gray-600 block mb-1">Website</label>
                    <p className="text-gray-900">
                      {data.profile.website ? (
                        <a href={data.profile.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                          {data.profile.website}
                        </a>
                      ) : '—'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Registration & Government IDs */}
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900">Registration & Government IDs</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white p-4 rounded-lg border">
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Rohini ID</label>
                    <p className="text-gray-900">{renderValue(data.profile.rohiniId)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">HFR ID</label>
                    <p className="text-gray-900">{renderValue(data.profile.hfrId)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">PAN Number</label>
                    <p className="text-gray-900">{renderValue(data.profile.panNumber)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">GST Number</label>
                    <p className="text-gray-900">{renderValue(data.profile.gstNumber)}</p>
                  </div>
                </div>
              </div>

              {/* Banking Details */}
              <div>
                <h3 className="text-lg font-semibold mb-4 text-gray-900">Banking Details</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-white p-4 rounded-lg border">
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Cheque Payable Name</label>
                    <p className="text-gray-900">{renderValue(data.profile.chequePayableName)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Bank Name</label>
                    <p className="text-gray-900">{renderValue(data.profile.bankName)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Bank Branch</label>
                    <p className="text-gray-900">{renderValue(data.profile.bankBranch)}</p>
                  </div>
                  <div className="col-span-2">
                    <label className="text-sm font-medium text-gray-600 block mb-1">Bank Address</label>
                    <p className="text-gray-900">{renderValue(data.profile.bankAddress)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Account Type</label>
                    <p className="text-gray-900 capitalize">{renderValue(data.profile.accountType)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Account Number</label>
                    <p className="text-gray-900">{renderValue(data.profile.accountNumber)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">IFSC Code</label>
                    <p className="text-gray-900">{renderValue(data.profile.ifscCode)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">MICR Code</label>
                    <p className="text-gray-900">{renderValue(data.profile.micrCode)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Name on PAN Card</label>
                    <p className="text-gray-900">{renderValue(data.profile.panName)}</p>
                  </div>
                </div>
              </div>

              {/* Key Contacts */}
              {data.contacts && data.contacts.length > 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4 text-gray-900">Key Contacts</h3>
                  <div className="space-y-3">
                    {data.contacts.map((contact, idx) => (
                      <div key={idx} className="p-4 bg-white rounded-lg border">
                        {contact.contact_type && (
                          <p className="text-sm font-medium text-blue-600 mb-1">{contact.contact_type}</p>
                        )}
                        {contact.name && (
                          <p className="text-gray-900 font-semibold mb-1">{contact.name}</p>
                        )}
                        {contact.designation && (
                          <p className="text-sm text-gray-600 mb-3">{contact.designation}</p>
                        )}
                        <div className="flex flex-wrap gap-4 text-sm">
                          {contact.phone && (
                            <div className="flex items-center gap-2">
                              <Phone className="h-4 w-4 text-gray-400" />
                              <a href={`tel:${contact.phone}`} className="text-blue-600 hover:underline">
                                {contact.phone}
                              </a>
                            </div>
                          )}
                          {contact.email && (
                            <div className="flex items-center gap-2">
                              <Mail className="h-4 w-4 text-gray-400" />
                              <a href={`mailto:${contact.email}`} className="text-blue-600 hover:underline">
                                {contact.email}
                              </a>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Verification Status */}
              {data.profile.verificationLevel && (
                <div>
                  <h3 className="text-lg font-semibold mb-4 text-gray-900">Verification Status</h3>
                  <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="text-sm font-medium text-blue-900 block mb-1">Verification Level</label>
                        <p className="text-blue-900 font-medium capitalize">{renderValue(data.profile.verificationLevel)}</p>
                      </div>
                      {data.profile.verificationStatus && (
                        <div>
                          <label className="text-sm font-medium text-blue-900 block mb-1">Verification Status</label>
                          <p className="text-blue-900 font-medium capitalize">{renderValue(data.profile.verificationStatus)}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>

            {/* Attributes Tab */}
            <TabsContent value="attributes" className="space-y-6 p-6">
              {data.attributes && data.attributes.length > 0 ? (
                <div>
                  <h3 className="text-lg font-semibold mb-4 text-gray-900">Hospital Attributes & Certifications</h3>
                  <div className="space-y-4">
                    {data.attributes.map((attr, idx) => (
                      <Card key={idx}>
                        <CardContent className="pt-6">
                          <div className="space-y-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <h4 className="font-semibold text-gray-900">{attr.label || attr.key}</h4>
                                  {attr.documents && attr.documents.length > 0 && (
                                    <span className="inline-block bg-blue-100 text-blue-800 text-xs font-medium px-2 py-0.5 rounded">
                                      {attr.documents.length} {attr.documents.length === 1 ? 'doc' : 'docs'}
                                    </span>
                                  )}
                                </div>
                                {attr.category && (
                                  <p className="text-sm text-gray-500">{attr.category}</p>
                                )}
                              </div>
                              {attr.verification_status && (
                                <div className="flex items-center gap-2">
                                  {attr.verification_status === 'verified_by_doc' || attr.verification_status === 'verified_by_image' || attr.verification_status === 'verified_manual' || attr.verification_status === 'automated_verified' ? (
                                    <>
                                      <CheckCircle className="h-5 w-5 text-green-600" />
                                      <span className="text-sm font-medium text-green-600">Verified</span>
                                    </>
                                  ) : (
                                    <span className="text-xs text-gray-500">Pending</span>
                                  )}
                                </div>
                              )}
                            </div>

                            {attr.value_boolean !== null && attr.value_boolean !== undefined && (
                              <div>
                                <label className="text-sm font-medium text-gray-600 block mb-1">Value</label>
                                <p className="text-gray-900">
                                  {renderValue(attr.value_boolean)}
                                </p>
                              </div>
                            )}

                            {attr.value_text && (
                              <div>
                                <label className="text-sm font-medium text-gray-600 block mb-1">Value</label>
                                <p className="text-gray-900">{attr.value_text}</p>
                              </div>
                            )}

                            {attr.value_integer && (
                              <div>
                                <label className="text-sm font-medium text-gray-600 block mb-1">Value</label>
                                <p className="text-gray-900">{attr.value_integer}</p>
                              </div>
                            )}

                            {attr.value_date && (
                              <div>
                                <label className="text-sm font-medium text-gray-600 block mb-1">Value</label>
                                <p className="text-gray-900">{new Date(attr.value_date).toLocaleDateString()}</p>
                              </div>
                            )}

                            {attr.expires_at && (
                              <div>
                                <label className="text-sm font-medium text-gray-600 block mb-1">Expires</label>
                                <p className="text-gray-900">{new Date(attr.expires_at).toLocaleDateString()}</p>
                              </div>
                            )}

                            {attr.certificate_number && (
                              <div>
                                <label className="text-sm font-medium text-gray-600 block mb-1">Certificate Number</label>
                                <p className="text-gray-900">{attr.certificate_number}</p>
                              </div>
                            )}

                            {attr.issuing_authority && (
                              <div>
                                <label className="text-sm font-medium text-gray-600 block mb-1">Issuing Authority</label>
                                <p className="text-gray-900">{attr.issuing_authority}</p>
                              </div>
                            )}

                            {/* Documents Section */}
                            {attr.documents && attr.documents.length > 0 && (
                              <div className="pt-3 border-t">
                                <p className="text-xs font-semibold text-gray-700 mb-3">
                                  Documents
                                  <span className="ml-2 inline-block bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded">
                                    {attr.documents.length}
                                  </span>
                                </p>
                                <div className="space-y-2">
                                  {attr.documents.map((doc: any) => (
                                    <div key={doc.id} className="flex items-center gap-2 p-2 bg-gray-50 rounded border border-gray-200">
                                      {doc.isPrimary && (
                                        <span title="Primary document" className="text-yellow-500">
                                          <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                                        </span>
                                      )}
                                      <FileText className="h-4 w-4 text-gray-400" />
                                      <span className="flex-1 text-sm text-gray-700 truncate">{doc.fileName}</span>
                                      <div className="flex gap-1">
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => {
                                            setPreviewFile({
                                              fileName: doc.fileName,
                                              mimeType: doc.mimeType,
                                              documentId: doc.documentId,
                                            });
                                            setShowPreviewModal(true);
                                          }}
                                          className="gap-1"
                                          title="Preview document"
                                        >
                                          <Eye className="h-3 w-3" />
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={async () => {
                                            try {
                                              const response = await ApiService.downloadDocument(data.profile.id, doc.documentId);
                                              const blob = new Blob([response.data], { type: doc.mimeType });
                                              const url = window.URL.createObjectURL(blob);
                                              const link = document.createElement('a');
                                              link.href = url;
                                              link.setAttribute('download', doc.fileName);
                                              document.body.appendChild(link);
                                              link.click();
                                              link.parentNode?.removeChild(link);
                                              window.URL.revokeObjectURL(url);
                                            } catch (err) {
                                              console.error('Failed to download document:', err);
                                              alert('Failed to download document');
                                            }
                                          }}
                                          className="gap-1"
                                          title="Download document"
                                        >
                                          <Download className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-gray-500">No attributes or certifications available</p>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </Card>

        {/* Footer */}
        <div className="mt-12 pt-8 border-t border-gray-200">
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-6 mb-8">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-600 to-blue-700 flex items-center justify-center flex-shrink-0">
                <Building2 className="h-6 w-6 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">Powered by Finclarity</h3>
                <p className="text-sm text-gray-600">
                  This hospital profile is part of Finclarity's healthcare credentials platform, providing verified and transparent hospital information.
                </p>
              </div>
            </div>
          </div>

          <div className="text-center text-xs text-gray-500 py-6">
            <p>This is a publicly shared hospital profile for informational purposes</p>
            <p className="mt-2">© 2024 Finclarity. All rights reserved.</p>
          </div>
        </div>
      </div>

      {/* File Preview Modal */}
      {previewFile && data && (
        <FilePreviewModal
          open={showPreviewModal}
          onOpenChange={setShowPreviewModal}
          fileName={previewFile.fileName}
          mimeType={previewFile.mimeType}
          documentId={previewFile.documentId}
          hospitalId={data.profile.id}
        />
      )}
    </div>
  );
}
