import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, Loader, MapPin, Globe, Phone, Mail, CheckCircle, X } from 'lucide-react';
import ApiService from '@/services/api';

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

  useEffect(() => {
    fetchProfile();
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

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <Card>
          <CardContent className="pt-8 pb-8">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h1 className="text-4xl font-bold text-gray-900">{data.profile.legalName}</h1>
                {data.verifiedBadge && (
                  <div className="flex items-center gap-2 mt-2">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    <span className="text-green-600 font-medium">Verified Hospital</span>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Tabs */}
        <Card>
          <Tabs defaultValue="profile" className="w-full">
            <TabsList className="grid w-full grid-cols-2 border-b">
              <TabsTrigger value="profile" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600">Profile</TabsTrigger>
              <TabsTrigger value="attributes" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600">Attributes & Certifications</TabsTrigger>
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {data.attributes.map((attr, idx) => (
                      <Card key={idx}>
                        <CardContent className="pt-6">
                          <div className="space-y-3">
                            <div>
                              <h4 className="font-semibold text-gray-900">{attr.label || attr.key}</h4>
                              {attr.category && (
                                <p className="text-sm text-gray-500">{attr.category}</p>
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

                            {attr.verification_status && (
                              <div className="pt-2 border-t">
                                <div className="flex items-center gap-2">
                                  {attr.verification_status === 'verified_by_doc' || attr.verification_status === 'verified_by_image' || attr.verification_status === 'verified_manual' || attr.verification_status === 'automated_verified' ? (
                                    <>
                                      <CheckCircle className="h-5 w-5 text-green-600" />
                                      <span className="text-sm font-medium text-green-600">Verified</span>
                                    </>
                                  ) : (
                                    <span className="text-xs text-gray-500">Not verified</span>
                                  )}
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
        <div className="text-center text-sm text-gray-500 py-6">
          <p>This is a publicly shared hospital profile for informational purposes</p>
        </div>
      </div>
    </div>
  );
}
