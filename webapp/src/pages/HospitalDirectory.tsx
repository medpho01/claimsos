import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, Search, Loader, MapPin, Users, Bed, Globe, Star } from 'lucide-react';
import { GlobalNavbar } from '@/components/Navbar';
import ApiService from '@/services/api';

interface HospitalDirectoryItem {
  id: string;
  legal_name: string;
  short_name?: string;
  type?: string;
  city?: string;
  state?: string;
  total_beds?: number;
  icu_beds?: number;
  verification_level?: string;
  verification_status?: string;
  website?: string;
  description?: string;
  share_token?: string;
  public_views?: number;
}

export default function HospitalDirectory() {
  const [hospitals, setHospitals] = useState<HospitalDirectoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [verificationFilter, setVerificationFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const pageSize = 12;

  useEffect(() => {
    fetchHospitals();
  }, [searchQuery, verificationFilter, currentPage]);

  const fetchHospitals = async () => {
    try {
      setLoading(true);
      const response = await ApiService.getPublicHospitalDirectory(
        currentPage,
        pageSize,
        searchQuery,
        verificationFilter !== 'all' ? verificationFilter : undefined
      );

      setHospitals(response.data.data?.hospitals || []);
      setTotalPages(response.data.data?.totalPages || 1);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load hospital directory');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  };

  const getVerificationBadge = (level?: string, status?: string) => {
    if (!status) return null;

    switch (status) {
      case 'verified':
        return (
          <div className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium">
            <Star className="h-3 w-3" />
            Verified
          </div>
        );
      case 'pending':
        return (
          <div className="px-2 py-1 bg-yellow-100 text-yellow-700 rounded text-xs font-medium">
            Pending Verification
          </div>
        );
      default:
        return (
          <div className="px-2 py-1 bg-gray-100 text-gray-700 rounded text-xs font-medium">
            Unverified
          </div>
        );
    }
  };

  return (
    <>
      <GlobalNavbar showHospitalContext={false} />
      <div className="min-h-screen bg-gray-50 p-6 pt-16">
        <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900">Hospital Directory</h1>
          <p className="text-gray-600 mt-2">Search and discover hospitals in our network</p>
        </div>

        {/* Search and Filters */}
        <Card className="mb-6">
          <CardContent className="pt-6 space-y-4">
            <div className="flex gap-3 items-center">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  placeholder="Search hospitals by name or location..."
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button
                variant={verificationFilter === 'all' ? 'default' : 'outline'}
                onClick={() => {
                  setVerificationFilter('all');
                  setCurrentPage(1);
                }}
                size="sm"
              >
                All Hospitals
              </Button>
              <Button
                variant={verificationFilter === 'verified' ? 'default' : 'outline'}
                onClick={() => {
                  setVerificationFilter('verified');
                  setCurrentPage(1);
                }}
                size="sm"
              >
                Verified Only
              </Button>
              <Button
                variant={verificationFilter === 'pending' ? 'default' : 'outline'}
                onClick={() => {
                  setVerificationFilter('pending');
                  setCurrentPage(1);
                }}
                size="sm"
              >
                Pending Verification
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Error Message */}
        {error && (
          <Card className="mb-6 border-red-200 bg-red-50">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-red-600">
                <AlertCircle className="h-5 w-5" />
                {error}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Loading State */}
        {loading ? (
          <Card>
            <CardContent className="pt-12 pb-12 flex items-center justify-center">
              <Loader className="h-8 w-8 animate-spin text-brand-600" />
            </CardContent>
          </Card>
        ) : hospitals.length === 0 ? (
          <Card>
            <CardContent className="pt-12 pb-12">
              <div className="text-center text-gray-500">
                <p>No hospitals found</p>
                <p className="text-sm mt-1">Try adjusting your search or filters</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Hospital Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
              {hospitals.map(hospital => (
                <Card key={hospital.id} className="hover:shadow-lg transition-shadow">
                  <CardHeader>
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-lg">{hospital.legal_name}</CardTitle>
                          {hospital.short_name && (
                            <CardDescription className="text-sm">{hospital.short_name}</CardDescription>
                          )}
                        </div>
                        {getVerificationBadge(hospital.verification_level, hospital.verification_status)}
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-4">
                    {/* Description */}
                    {hospital.description && (
                      <p className="text-sm text-gray-600 line-clamp-2">
                        {hospital.description}
                      </p>
                    )}

                    {/* Hospital Details */}
                    <div className="space-y-2 text-sm">
                      {hospital.city && hospital.state && (
                        <div className="flex items-center gap-2 text-gray-600">
                          <MapPin className="h-4 w-4" />
                          <span>{hospital.city}, {hospital.state}</span>
                        </div>
                      )}

                      {hospital.type && (
                        <div className="flex items-center gap-2 text-gray-600">
                          <span className="font-medium">Type:</span>
                          <span>{hospital.type}</span>
                        </div>
                      )}

                      {hospital.total_beds && (
                        <div className="flex items-center gap-2 text-gray-600">
                          <Bed className="h-4 w-4" />
                          <span>{hospital.total_beds} beds {hospital.icu_beds ? `(${hospital.icu_beds} ICU)` : ''}</span>
                        </div>
                      )}

                      {hospital.public_views !== undefined && (
                        <div className="flex items-center gap-2 text-gray-600">
                          <Users className="h-4 w-4" />
                          <span>{hospital.public_views} views</span>
                        </div>
                      )}
                    </div>

                    {/* Website */}
                    {hospital.website && (
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-gray-400" />
                        <a
                          href={hospital.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 hover:underline text-sm truncate"
                        >
                          {hospital.website}
                        </a>
                      </div>
                    )}

                    {/* Action Button */}
                    <div className="pt-2">
                      <Button
                        onClick={() => {
                          if (hospital.share_token) {
                            window.open(`/public-profile/${hospital.share_token}`, '_blank');
                          } else {
                            window.location.href = `/hospital/${hospital.id}`;
                          }
                        }}
                        className="w-full"
                        variant="outline"
                      >
                        View Profile
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>

                <div className="flex items-center gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                    <Button
                      key={page}
                      variant={currentPage === page ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setCurrentPage(page)}
                      className="w-10 h-10"
                    >
                      {page}
                    </Button>
                  ))}
                </div>

                <Button
                  variant="outline"
                  onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </>
  );
}
