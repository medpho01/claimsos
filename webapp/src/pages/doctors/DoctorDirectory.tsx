import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, Loader, AlertCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ApiService from '@/services/api';
import { GlobalNavbar } from '@/components/Navbar';

interface DoctorItem {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  primary_specialization: string;
  nmc_registration_number: string;
  registration_status: string;
  created_at: string;
  hospital_count?: number;
  share_token?: string;
}

interface DirectoryResponse {
  success: boolean;
  data: {
    total: number;
    page: number;
    limit: number;
    data: DoctorItem[];
  };
}

const DoctorDirectory: React.FC = () => {
  const navigate = useNavigate();
  const [doctors, setDoctors] = useState<DoctorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSpecialization, setSelectedSpecialization] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('active');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalDoctors, setTotalDoctors] = useState(0);
  const [specializations, setSpecializations] = useState<string[]>([]);
  const [loadingSpecs, setLoadingSpecs] = useState(true);

  const ITEMS_PER_PAGE = 12;

  // Fetch doctors from API
  const fetchDoctors = async (page: number = 1, search: string = '', spec: string = '', status: string = 'active') => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({
        page: page.toString(),
        limit: ITEMS_PER_PAGE.toString(),
        public_only: 'true',
      });

      if (search) params.append('q', search);
      if (spec) params.append('specialization', spec);
      if (status) params.append('registration_status', status);

      const response = await ApiService.get(`/doctors/public/directory?${params.toString()}`);

      if (response.data.success && response.data.data) {
        const { doctors, pagination } = response.data.data;
        setDoctors(Array.isArray(doctors) ? doctors : []);
        setTotalDoctors(pagination?.total || 0);
        setTotalPages(Math.ceil((pagination?.total || 0) / ITEMS_PER_PAGE));
        setCurrentPage(page);
      }
    } catch (err: any) {
      console.error('Error fetching doctors:', err);
      setError(err.response?.data?.message || 'Failed to load doctors. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Fetch available specializations
  useEffect(() => {
    const fetchSpecializations = async () => {
      try {
        setLoadingSpecs(true);
        // Fallback specializations list
        const specs = [
          'Cardiology',
          'Pediatrics',
          'Orthopedics',
          'Neurology',
          'Oncology',
          'Psychiatry',
          'Surgery',
          'General Medicine',
          'Dermatology',
          'Ophthalmology',
          'ENT',
          'Gynecology & Obstetrics',
          'Urology',
          'Nephrology',
          'Gastroenterology',
        ];
        setSpecializations(specs);
      } catch (err) {
        console.error('Error loading specializations:', err);
      } finally {
        setLoadingSpecs(false);
      }
    };

    fetchSpecializations();
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    fetchDoctors(1, '', '', 'active');
  }, []);

  const handleSearch = (term: string) => {
    setSearchTerm(term);
    setCurrentPage(1);
    fetchDoctors(1, term, selectedSpecialization, selectedStatus);
  };

  const handleSpecializationChange = (spec: string) => {
    setSelectedSpecialization(spec);
    setCurrentPage(1);
    fetchDoctors(1, searchTerm, spec, selectedStatus);
  };

  const handleStatusChange = (status: string) => {
    setSelectedStatus(status);
    setCurrentPage(1);
    fetchDoctors(1, searchTerm, selectedSpecialization, status);
  };

  const handlePageChange = (newPage: number) => {
    fetchDoctors(newPage, searchTerm, selectedSpecialization, selectedStatus);
  };

  const handleDoctorClick = (doctor: DoctorItem) => {
    // Navigate to public profile if share token exists, otherwise use doctor ID
    if (doctor.share_token) {
      navigate(`/public-profile/${doctor.share_token}`);
    } else {
      navigate(`/doctor/${doctor.id}/profile`);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 text-green-800';
      case 'inactive':
        return 'bg-slate-100 text-slate-800';
      case 'pending_verification':
        return 'bg-yellow-100 text-yellow-800';
      case 'suspended':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-slate-100 text-slate-800';
    }
  };

  return (
    <>
      <GlobalNavbar />
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 pt-12">
        {/* UI Revamp: tighter wireframe header */}
        <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <div className="max-w-7xl mx-auto px-6 py-6">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              Find healthcare professionals
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              {totalDoctors} verified doctor{totalDoctors === 1 ? '' : 's'} across the network
            </p>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-6 py-8">
          {/* Search and Filters */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            {/* Search Bar */}
            <div className="md:col-span-2">
              <div className="relative">
                <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
                <Input
                  placeholder="Search by name, NMC number, or email..."
                  value={searchTerm}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            {/* Specialization Filter */}
            <div>
              <select
                value={selectedSpecialization}
                onChange={(e) => handleSpecializationChange(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 dark:text-white text-sm font-medium"
              >
                <option value="">All Specializations</option>
                {specializations.map((spec) => (
                  <option key={spec} value={spec}>
                    {spec}
                  </option>
                ))}
              </select>
            </div>

            {/* Status Filter */}
            <div>
              <select
                value={selectedStatus}
                onChange={(e) => handleStatusChange(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 dark:text-white text-sm font-medium"
              >
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="pending_verification">Pending Verification</option>
              </select>
            </div>
          </div>

          {/* Error Alert */}
          {error && (
            <Alert variant="destructive" className="mb-8">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Results Summary */}
          <div className="mb-6">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Showing {doctors.length > 0 ? (currentPage - 1) * ITEMS_PER_PAGE + 1 : 0} to{' '}
              {Math.min(currentPage * ITEMS_PER_PAGE, totalDoctors)} of {totalDoctors} doctors
            </p>
          </div>

          {/* Loading State */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader className="h-8 w-8 animate-spin text-brand-600" />
            </div>
          ) : doctors.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <AlertCircle className="h-12 w-12 text-slate-300 mb-4" />
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
                  No Doctors Found
                </h3>
                <p className="text-slate-600 dark:text-slate-400 text-center max-w-md">
                  Try adjusting your search criteria or explore other specializations
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Doctor Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
                {doctors.map((doctor) => (
                  <Card
                    key={doctor.id}
                    className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer"
                    onClick={() => handleDoctorClick(doctor)}
                  >
                    <CardContent className="p-6">
                      {/* Doctor Avatar & Name */}
                      <div className="flex items-start gap-4 mb-4">
                        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-brand-600 to-brand-700 flex items-center justify-center flex-shrink-0">
                          <span className="text-white font-bold text-lg">
                            {doctor.first_name[0]}
                            {doctor.last_name[0]}
                          </span>
                        </div>
                        <div className="flex-1">
                          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                            Dr. {doctor.first_name} {doctor.last_name}
                          </h3>
                          <p className="text-sm text-slate-500 dark:text-slate-400 truncate">
                            {doctor.email}
                          </p>
                        </div>
                      </div>

                      {/* Specialization */}
                      <div className="mb-4">
                        <p className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">
                          Specialization
                        </p>
                        <Badge variant="secondary" className="w-fit">
                          {doctor.primary_specialization}
                        </Badge>
                      </div>

                      {/* NMC Number */}
                      <div className="mb-4 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                        <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
                          NMC Registration
                        </p>
                        <p className="text-sm font-mono text-slate-900 dark:text-white">
                          {doctor.nmc_registration_number.slice(-4).padStart(
                            doctor.nmc_registration_number.length,
                            '*'
                          )}
                        </p>
                      </div>

                      {/* Status & Details */}
                      <div className="flex items-center justify-between">
                        <Badge className={`text-xs ${getStatusColor(doctor.registration_status)}`}>
                          {doctor.registration_status === 'active'
                            ? 'Verified'
                            : doctor.registration_status === 'pending_verification'
                            ? 'Pending'
                            : 'Inactive'}
                        </Badge>
                        {doctor.hospital_count && (
                          <span className="text-xs text-slate-600 dark:text-slate-400">
                            {doctor.hospital_count} hospitals
                          </span>
                        )}
                      </div>

                      {/* View Profile Link */}
                      <Button
                        variant="outline"
                        className="w-full mt-4"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDoctorClick(doctor);
                        }}
                      >
                        View Profile
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mb-8">
                  <Button
                    variant="outline"
                    onClick={() => handlePageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                    size="sm"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>

                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                    <Button
                      key={page}
                      variant={currentPage === page ? 'default' : 'outline'}
                      onClick={() => handlePageChange(page)}
                      size="sm"
                      className="min-w-10"
                    >
                      {page}
                    </Button>
                  ))}

                  <Button
                    variant="outline"
                    onClick={() => handlePageChange(currentPage + 1)}
                    disabled={currentPage === totalPages}
                    size="sm"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default DoctorDirectory;
