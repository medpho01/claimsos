import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, Loader, MapPin, Globe, Phone, Mail, CheckCircle, X, FileText, Eye, Download, Star, Building2, Shield, FileJson, Copy, Check } from 'lucide-react';
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
    'bg-brand-600',
    'bg-purple-600',
    'bg-green-600',
    'bg-red-600',
    'bg-brand-600',
    'bg-cyan-600',
    'bg-teal-600',
    'bg-amber-600'
  ];
  const charCode = initials.charCodeAt(0);
  return colors[charCode % colors.length];
};

// Helper function to get API base URL (matches ApiService configuration)
const getApiBaseUrl = () => {
  if (process.env.NODE_ENV === "production") {
    return `${window.location.origin}/api/v1`;
  }
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  return `${protocol}//${hostname}:6001/api/v1`;
};

// Helper function to download a public document by share token
const downloadPublicDocument = async (token: string, documentId: string, fileName: string) => {
  try {
    const apiBaseUrl = getApiBaseUrl();
    const response = await fetch(`${apiBaseUrl}/share/${token}/documents/${documentId}/download`, {
      method: 'GET',
      headers: {
        'Accept': '*/*'
      }
    });

    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Error downloading document:', error);
    alert('Failed to download document. Please try again.');
  }
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
    shareToken?: string;
  } | null>(null);
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());

  // Use ref to prevent double fetch in React.StrictMode (development only)
  const hasFetchedRef = useRef(false);

  // Generate standard JSON export format for global use
  const generateJsonExport = () => {
    if (!data) return null;

    const apiBaseUrl = getApiBaseUrl();
    const jsonData = {
      exportDate: new Date().toISOString(),
      dataFormat: "Finclarity Hospital Profile Standard v1.0",
      hospital: {
        profile: {
          legalName: data.profile.legalName,
          hospitalType: data.profile.hospitalType,
          establishedYear: data.profile.establishedYear,
          specialties: data.profile.specialties || [],
          verified: data.verifiedBadge || false,
          verificationLevel: data.profile.verificationLevel || null,
          verificationStatus: data.profile.verificationStatus || null,
        },
        location: {
          addressLine1: data.profile.addressLine1 || null,
          addressLine2: data.profile.addressLine2 || null,
          city: data.profile.city || null,
          district: data.profile.district || null,
          state: data.profile.state || null,
          pincode: data.profile.pincode || null,
        },
        contact: {
          phone: data.profile.phone || null,
          email: data.profile.email || null,
          website: data.profile.website || null,
        },
        registration: {
          rohiniId: data.profile.rohiniId || null,
          hfrId: data.profile.hfrId || null,
          panNumber: data.profile.panNumber || null,
          gstNumber: data.profile.gstNumber || null,
        },
        banking: {
          bankName: data.profile.bankName || null,
          bankBranch: data.profile.bankBranch || null,
          accountNumber: data.profile.accountNumber || null,
          ifscCode: data.profile.ifscCode || null,
          accountType: data.profile.accountType || null,
        },
      },
      attributes: (data.attributes || []).map((attr: any) => ({
        key: attr.attribute_key || null,
        label: attr.label || null,
        category: attr.category || null,
        value: attr.value_text || attr.value_integer || attr.value_date || attr.value_boolean || null,
        verificationStatus: attr.verification_status || null,
        expiresAt: attr.expires_at || null,
        certificateNumber: attr.certificate_number || null,
        issuingAuthority: attr.issuing_authority || null,
        documents: (attr.documents || []).map((doc: any) => ({
          fileName: doc.fileName || null,
          mimeType: doc.mimeType || null,
          fileSize: doc.fileSize || null,
          isPrimary: doc.isPrimary || false,
          downloadUrl: `${apiBaseUrl}/share/${token}/documents/${doc.documentId}/download`,
        })),
        documentCount: (attr.documents || []).length,
      })),
      contacts: (data.contacts || []).map((contact: any) => ({
        type: contact.contact_type || null,
        name: contact.name || null,
        designation: contact.designation || null,
        phone: contact.phone || null,
        email: contact.email || null,
      })),
    };

    return jsonData;
  };

  const handleDownloadJson = () => {
    const jsonData = generateJsonExport();
    if (!jsonData || !data) return;

    const fileName = `${data.profile.legalName.replace(/\s+/g, '_')}_profile_${new Date().toISOString().split('T')[0]}.json`;
    const element = document.createElement('a');
    element.setAttribute('href', `data:text/json;charset=utf-8,${encodeURIComponent(JSON.stringify(jsonData, null, 2))}`);
    element.setAttribute('download', fileName);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const handleCopyJson = async () => {
    const jsonData = generateJsonExport();
    if (!jsonData) return;

    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonData, null, 2));
      setCopiedToClipboard(true);
      setTimeout(() => setCopiedToClipboard(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Format display values - convert snake_case keys to readable labels
  const formatDisplayValue = (value: string): string => {
    if (!value) return value;
    return value
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  // Get unique categories from attributes
  const getAttributeCategories = () => {
    const categories = new Set<string>();
    data?.attributes?.forEach((attr: any) => {
      if (attr.category) {
        categories.add(attr.category);
      }
    });
    return Array.from(categories).sort();
  };

  // Group attributes by category
  const getAttributesByCategory = () => {
    const grouped: Record<string, any[]> = {};
    data?.attributes?.forEach((attr: any) => {
      const cat = attr.category || 'Other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(attr);
    });
    return grouped;
  };

  // Toggle category filter
  const toggleCategory = (category: string) => {
    const newSet = new Set(selectedCategories);
    if (newSet.has(category)) {
      newSet.delete(category);
    } else {
      newSet.add(category);
    }
    setSelectedCategories(newSet);
  };

  // Reset category filters (show all)
  const resetFilters = () => {
    setSelectedCategories(new Set());
  };

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
          <Loader className="h-8 w-8 animate-spin text-brand-600 mx-auto mb-4" />
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
      {/* Top Action Bar */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-40 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          {/* Finclarity Branding */}
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-brand-600 to-brand-700 flex items-center justify-center flex-shrink-0 shadow-md">
              <Building2 className="h-6 w-6 text-white font-bold" />
            </div>
            <p className="text-lg font-bold text-gray-900">Finclarity</p>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <Button
              onClick={handleCopyJson}
              variant="outline"
              size="sm"
              className="gap-2"
              title="Copy JSON to clipboard"
            >
              {copiedToClipboard ? (
                <>
                  <Check className="h-4 w-4" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy JSON
                </>
              )}
            </Button>
            <Button
              onClick={handleDownloadJson}
              variant="outline"
              size="sm"
              className="gap-2"
              title="Download profile as JSON"
            >
              <FileJson className="h-4 w-4" />
              Download JSON
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Hero Header Card with Prominent Verification */}
        <Card className="border-0 shadow-xl bg-gradient-to-r from-white to-brand-50 overflow-hidden">
          {/* Verification Banner */}
          {data.verifiedBadge && (
            <div className="bg-gradient-to-r from-green-600 to-emerald-600 px-6 py-4 flex items-center justify-between">
              <div>
                <p className="text-white font-bold text-lg">VERIFIED HOSPITAL</p>
                <p className="text-green-100 text-sm">All credentials have been verified by <a href="https://www.finclarity.ai" target="_blank" rel="noopener noreferrer" className="underline hover:text-white font-semibold">Finclarity</a></p>
              </div>
              <CheckCircle className="h-6 w-6 text-white flex-shrink-0" />
            </div>
          )}

          {/* UI Revamp: wireframe public-hospital — compact header, brand-700 square avatar */}
          <CardContent className="pt-6 pb-6">
            <div className="flex flex-col lg:flex-row lg:items-start gap-6">
              <div className="h-20 w-20 rounded-lg bg-brand-700 flex items-center justify-center text-white font-semibold text-2xl shadow-sm flex-shrink-0">
                {hospitalInitials}
              </div>

              <div className="flex-1">
                <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50 mb-3 leading-tight tracking-tight">{data.profile.legalName}</h1>

                {/* Info Badges */}
                <div className="flex flex-wrap items-center gap-3 mb-6">
                  {data.profile.hospitalType && (
                    <span className="px-4 py-2 bg-gradient-to-r from-brand-50 to-brand-50 text-brand-700 rounded-full font-semibold text-sm border border-brand-50">
                      {formatDisplayValue(data.profile.hospitalType)}
                    </span>
                  )}
                  {data.profile.establishedYear && (
                    <span className="px-4 py-2 bg-gray-100 text-gray-700 rounded-full font-medium text-sm">
                      Est. {data.profile.establishedYear}
                    </span>
                  )}
                  {data.profile.specialties && data.profile.specialties.length > 0 && (
                    <span className="px-4 py-2 bg-brand-50 text-brand-700 rounded-full font-medium text-sm">
                      {data.profile.specialties.length} Specialties
                    </span>
                  )}
                </div>

                {/* Location and Contact */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  {data.profile.city && data.profile.state && (
                    <div className="flex items-start gap-2">
                      <MapPin className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-gray-600 text-xs font-medium uppercase">Location</p>
                        <p className="text-gray-900 font-medium">{data.profile.city}, {data.profile.state}</p>
                      </div>
                    </div>
                  )}
                  {data.profile.phone && (
                    <div className="flex items-start gap-2">
                      <Phone className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-gray-600 text-xs font-medium uppercase">Phone</p>
                        <a href={`tel:${data.profile.phone}`} className="text-brand-600 hover:underline font-medium">
                          {data.profile.phone}
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Verification Status Card - Right Side */}
              {!data.verifiedBadge && (
                <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3 flex-shrink-0 max-w-sm">
                  <div className="flex items-start gap-2 mb-2">
                    <AlertCircle className="h-4 w-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                    <p className="font-semibold text-sm text-yellow-900">Pending Verification</p>
                  </div>
                  <p className="text-xs text-yellow-800 leading-relaxed">
                    This hospital is currently under verification. Check back soon for updated credentials.
                  </p>
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
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-brand-600 data-[state=active]:bg-white"
              >
                Profile Details
              </TabsTrigger>
              <TabsTrigger
                value="attributes"
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-brand-600 data-[state=active]:bg-white"
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
                        <a href={`tel:${data.profile.phone}`} className="text-brand-600 hover:underline">
                          {data.profile.phone}
                        </a>
                      ) : '—'}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-600 block mb-1">Email</label>
                    <p className="text-gray-900">
                      {data.profile.email ? (
                        <a href={`mailto:${data.profile.email}`} className="text-brand-600 hover:underline">
                          {data.profile.email}
                        </a>
                      ) : '—'}
                    </p>
                  </div>
                  <div className="col-span-2">
                    <label className="text-sm font-medium text-gray-600 block mb-1">Website</label>
                    <p className="text-gray-900">
                      {data.profile.website ? (
                        <a href={data.profile.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">
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
                          <p className="text-sm font-medium text-brand-600 mb-1">{contact.contact_type}</p>
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
                              <a href={`tel:${contact.phone}`} className="text-brand-600 hover:underline">
                                {contact.phone}
                              </a>
                            </div>
                          )}
                          {contact.email && (
                            <div className="flex items-center gap-2">
                              <Mail className="h-4 w-4 text-gray-400" />
                              <a href={`mailto:${contact.email}`} className="text-brand-600 hover:underline">
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

            </TabsContent>

            {/* Attributes Tab */}
            <TabsContent value="attributes" className="space-y-6 p-6">
              {data.attributes && data.attributes.length > 0 ? (
                <div>
                  {/* Header and Stats */}
                  <div className="mb-8">
                    <h3 className="text-lg font-semibold mb-3 text-gray-900">Hospital Attributes & Certifications</h3>
                    <p className="text-sm text-gray-600 mb-4">
                      <span className="font-semibold text-green-600">
                        {data.attributes.filter((a: any) => {
                          const status = a.verification_status;
                          return status === 'verified_by_doc' || status === 'verified_by_image' || status === 'verified_manual' || status === 'automated_verified';
                        }).length}
                      </span>
                      {' '}of{' '}
                      <span className="font-semibold">{data.attributes.length}</span>
                      {' '}attributes verified
                    </p>

                    {/* Category Filters */}
                    {getAttributeCategories().length > 0 && (
                      <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                        <div className="flex items-center justify-between mb-3">
                          <p className="text-sm font-semibold text-gray-700">Filter by Category</p>
                          {selectedCategories.size > 0 && (
                            <button
                              onClick={resetFilters}
                              className="text-xs text-brand-600 hover:underline font-medium"
                            >
                              Reset Filters
                            </button>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {getAttributeCategories().map((category) => {
                            const isSelected = selectedCategories.has(category);
                            const catAttrs = getAttributesByCategory()[category] || [];
                            const verifiedCount = catAttrs.filter((a: any) => {
                              const status = a.verification_status;
                              return status === 'verified_by_doc' || status === 'verified_by_image' || status === 'verified_manual' || status === 'automated_verified';
                            }).length;

                            return (
                              <button
                                key={category}
                                onClick={() => toggleCategory(category)}
                                className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                                  isSelected
                                    ? 'bg-brand-600 text-white'
                                    : 'bg-white text-gray-700 border border-gray-300 hover:border-brand-600'
                                }`}
                              >
                                {formatDisplayValue(category)}
                                <span className="ml-2 text-xs opacity-75">({verifiedCount}/{catAttrs.length})</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Attributes by Category */}
                  <div className="space-y-8">
                    {Object.entries(getAttributesByCategory()).map(([category, attrs]) => {
                      // Skip this category if filters are active and it's not selected
                      if (selectedCategories.size > 0 && !selectedCategories.has(category)) {
                        return null;
                      }

                      return (
                        <div key={category}>
                          {/* Category Header */}
                          <div className="mb-4 pb-3 border-b-2 border-gray-200">
                            <h4 className="text-lg font-bold text-gray-900">{formatDisplayValue(category)}</h4>
                            <p className="text-xs text-gray-500 mt-1">
                              {(attrs as any[]).filter((a: any) => {
                                const status = a.verification_status;
                                return status === 'verified_by_doc' || status === 'verified_by_image' || status === 'verified_manual' || status === 'automated_verified';
                              }).length} of {(attrs as any[]).length} verified
                            </p>
                          </div>

                          {/* Attributes in Category */}
                          <div className="space-y-4 mb-8">
                            {(attrs as any[]).map((attr, idx) => {
                              const isVerified = attr.verification_status === 'verified_by_doc' ||
                                               attr.verification_status === 'verified_by_image' ||
                                               attr.verification_status === 'verified_manual' ||
                                               attr.verification_status === 'automated_verified';
                              return (
                      <Card key={idx} className={isVerified ? 'border-l-4 border-l-green-500 shadow-md' : 'border-l-4 border-l-yellow-400'}>
                        <CardContent className="pt-6">
                          <div className="space-y-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-2 flex-wrap">
                                  <h4 className="font-bold text-lg text-gray-900">{attr.label || attr.key}</h4>
                                  {isVerified ? (
                                    <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs font-bold px-3 py-1 rounded-full">
                                      <CheckCircle className="h-3.5 w-3.5" />
                                      VERIFIED
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 bg-yellow-100 text-yellow-700 text-xs font-bold px-3 py-1 rounded-full">
                                      <AlertCircle className="h-3.5 w-3.5" />
                                      PENDING VERIFICATION
                                    </span>
                                  )}
                                  {attr.documents && attr.documents.length > 0 && (
                                    <span className="inline-block bg-brand-50 text-brand-700 text-xs font-semibold px-2.5 py-1 rounded">
                                      {attr.documents.length} {attr.documents.length === 1 ? 'document' : 'documents'}
                                    </span>
                                  )}
                                </div>
                                {attr.category && (
                                  <p className="text-xs uppercase font-medium text-gray-500 mb-1">{attr.category}</p>
                                )}
                              </div>
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
                                  <span className="ml-2 inline-block bg-brand-50 text-brand-700 text-xs px-2 py-1 rounded">
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
                                              shareToken: token || undefined,
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
                                              // Use public download endpoint with token
                                              if (token) {
                                                await downloadPublicDocument(token, doc.documentId, doc.fileName);
                                              } else {
                                                // Fallback to authenticated download
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
                                              }
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
                            );
                            })}
                          </div>
                        </div>
                      );
                    })}
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
          <div className="bg-gradient-to-r from-brand-50 to-brand-50 rounded-lg p-6 mb-8">
            <div className="flex items-start gap-4">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-brand-600 to-brand-700 flex items-center justify-center flex-shrink-0">
                <Building2 className="h-6 w-6 text-white" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">Powered by <a href="https://www.finclarity.ai" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:text-brand-700 underline">Finclarity</a></h3>
                <p className="text-sm text-gray-600">
                  This hospital profile is part of <a href="https://www.finclarity.ai" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:text-brand-700 underline">Finclarity</a>'s healthcare credentials platform, providing verified and transparent hospital information.
                </p>
              </div>
            </div>
          </div>

          <div className="text-center text-xs text-gray-500 py-6">
            <p>This is a publicly shared hospital profile for informational purposes</p>
            <p className="mt-2">© 2024 <a href="https://www.finclarity.ai" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:text-brand-700 underline">Finclarity</a>. All rights reserved.</p>
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
          hospitalId={token ? undefined : data.profile.id}
          shareToken={previewFile.shareToken}
          onDownload={() => {
            // Handle download from modal
            if (previewFile.shareToken && previewFile.documentId) {
              downloadPublicDocument(previewFile.shareToken, previewFile.documentId, previewFile.fileName);
            }
          }}
        />
      )}
    </div>
  )
}
