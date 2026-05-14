import React, { useState, useEffect } from 'react';
import { Plus, Search, Trash2, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ApiService from '@/services/api';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { DoctorDetailsModal } from '@/components/DoctorDetailsTabs/DoctorDetailsModal';

interface HospitalDoctor {
  id: string;
  doctor_id: string;
  hospital_id: string;
  employment_type: string;
  department: string;
  specialization: string;
  designation: string;
  start_date: string;
  end_date?: string;
  status: string;
  employee_id?: string;
  hospital_phone?: string;
  hospital_email?: string;
  notes?: string;
  doctor?: {
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    primary_specialization: string;
    nmc_registration_number?: string;
  };
}

interface DoctorProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  primary_specialization: string;
  nmc_registration_number?: string;
  registration_status: string;
}

interface DoctorsManagerProps {
  hospitalId: string;
}

const DoctorsManager: React.FC<DoctorsManagerProps> = ({ hospitalId }) => {
  const [doctors, setDoctors] = useState<HospitalDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedDoctorForEdit, setSelectedDoctorForEdit] = useState<HospitalDoctor | null>(null);
  const [doctorToRemove, setDoctorToRemove] = useState<HospitalDoctor | null>(null);

  // Fetch hospital doctors
  const fetchDoctors = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await ApiService.get(`/hospitals/${hospitalId}/doctors`);
      // Extract doctors array from nested pagination response structure
      // Response structure: { data: { data: [...doctors], pagination: {...} } }
      const doctorsData = response.data?.data?.data || response.data?.data || [];
      setDoctors(Array.isArray(doctorsData) ? doctorsData : []);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load doctors');
      console.error('Error loading doctors:', err);
      setDoctors([]); // Ensure doctors is always an array
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDoctors();
  }, [hospitalId]);

  const handleRemoveDoctor = async (doctor: HospitalDoctor) => {
    try {
      // Use doctor_id (not junction table id) to delete the hospital-doctor relationship
      await ApiService.delete(`/hospitals/${hospitalId}/doctors/${doctor.doctor_id}`);
      setDoctors(doctors.filter(d => d.id !== doctor.id));
      setDoctorToRemove(null);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove doctor');
    }
  };

  const handleAddDoctorSuccess = () => {
    setIsAddDialogOpen(false);
    fetchDoctors();
  };

  const filteredDoctors = doctors.filter(doctor => {
    const searchLower = searchTerm.toLowerCase();
    const doctorName = doctor.doctor ?
      `${doctor.doctor.first_name} ${doctor.doctor.last_name}`.toLowerCase() :
      '';
    const department = (doctor.department || '').toLowerCase();
    const specialization = (doctor.specialization || '').toLowerCase();

    return doctorName.includes(searchLower) ||
           department.includes(searchLower) ||
           specialization.includes(searchLower);
  });

  return (
    <div className="space-y-6">
      {/* Header with Search and Add Button */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 flex items-center gap-2 bg-white rounded-lg border border-slate-200 px-3 py-2">
          <Search className="h-4 w-4 text-slate-400" />
          <Input
            placeholder="Search doctors by name, department, or specialization..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="border-0 focus-visible:ring-0"
          />
        </div>

        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Add Doctor
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add Doctor to Hospital</DialogTitle>
              <DialogDescription>
                Search for an existing doctor or create a new one to add to this hospital.
              </DialogDescription>
            </DialogHeader>
            <AddDoctorForm
              hospitalId={hospitalId}
              onSuccess={handleAddDoctorSuccess}
              onCancel={() => setIsAddDialogOpen(false)}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Doctors List */}
      {loading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <div className="text-slate-500">Loading doctors...</div>
          </CardContent>
        </Card>
      ) : filteredDoctors.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="text-slate-500 text-center">
              <p className="font-medium mb-2">No doctors found</p>
              <p className="text-sm">Add doctors to manage their hospital affiliation and credentials.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredDoctors.map((doctor) => (
            <Card key={doctor.id} className="overflow-hidden hover:shadow-md transition-shadow">
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                  {/* Doctor Info */}
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center flex-shrink-0">
                        <span className="text-white font-bold text-sm">
                          {doctor.doctor?.first_name?.[0]}{doctor.doctor?.last_name?.[0]}
                        </span>
                      </div>
                      <div>
                        <h3 className="font-semibold text-slate-900">
                          Dr. {doctor.doctor?.first_name} {doctor.doctor?.last_name}
                        </h3>
                        <p className="text-sm text-slate-500">{doctor.doctor?.email}</p>
                      </div>
                    </div>

                    {/* Details Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-slate-200">
                      <div>
                        <p className="text-xs font-medium text-slate-600 mb-1">Employment Type</p>
                        <p className="text-sm font-medium text-slate-900 capitalize">{doctor.employment_type || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-slate-600 mb-1">Department</p>
                        <p className="text-sm text-slate-900">{doctor.department || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-slate-600 mb-1">Designation</p>
                        <p className="text-sm text-slate-900">{doctor.designation || '—'}</p>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-slate-600 mb-1">Status</p>
                        <span className={`inline-block px-2 py-1 rounded-md text-xs font-medium ${
                          doctor.status === 'active'
                            ? 'bg-green-100 text-green-800'
                            : 'bg-slate-100 text-slate-800'
                        }`}>
                          {doctor.status || '—'}
                        </span>
                      </div>
                      {doctor.start_date && (
                        <div>
                          <p className="text-xs font-medium text-slate-600 mb-1 flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            Start Date
                          </p>
                          <p className="text-sm text-slate-900">{new Date(doctor.start_date).toLocaleDateString()}</p>
                        </div>
                      )}
                      {doctor.hospital_email && (
                        <div>
                          <p className="text-xs font-medium text-slate-600 mb-1">Hospital Email</p>
                          <p className="text-sm text-slate-900 truncate">{doctor.hospital_email}</p>
                        </div>
                      )}
                    </div>

                    {/* Doctor's Specialization */}
                    {doctor.doctor?.primary_specialization && (
                      <div className="mt-3 flex items-center gap-2 text-sm">
                        <Badge variant="outline">{doctor.doctor.primary_specialization}</Badge>
                        {doctor.specialization && doctor.specialization !== doctor.doctor.primary_specialization && (
                          <span className="text-slate-600">({doctor.specialization})</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedDoctorForEdit(doctor)}
                      className="gap-2"
                    >
                      View Details
                    </Button>
                    <AlertDialog open={doctorToRemove?.id === doctor.id} onOpenChange={(open) => !open && setDoctorToRemove(null)}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDoctorToRemove(doctor)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Remove
                      </Button>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove Doctor</AlertDialogTitle>
                          <AlertDialogDescription>
                            Are you sure you want to remove Dr. {doctor.doctor?.first_name} {doctor.doctor?.last_name} from this hospital? This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => handleRemoveDoctor(doctor)} className="bg-red-600 hover:bg-red-700">
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Doctor Details Modal - Using New Tabbed Component */}
      <DoctorDetailsModal
        open={!!selectedDoctorForEdit}
        onOpenChange={(open) => !open && setSelectedDoctorForEdit(null)}
        hospitalId={hospitalId}
        doctor={selectedDoctorForEdit}
        onSuccess={() => {
          setSelectedDoctorForEdit(null);
          fetchDoctors();
        }}
      />
    </div>
  );
};

// Add Doctor Form Component
interface AddDoctorFormProps {
  hospitalId: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const AddDoctorForm: React.FC<AddDoctorFormProps> = ({ hospitalId, onSuccess, onCancel }) => {
  const [mode, setMode] = useState<'search' | 'create'>('create');
  const [searchResults, setSearchResults] = useState<DoctorProfile[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [creatingDoctor, setCreatingDoctor] = useState(false);
  const [addingDoctor, setAddingDoctor] = useState(false);
  const [specializations, setSpecializations] = useState<string[]>([]);
  const [newDoctorData, setNewDoctorData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    primary_specialization: '',
    nmc_registration_number: '',
  });
  const [error, setError] = useState<string | null>(null);

  // Fetch specializations on mount
  useEffect(() => {
    const fetchSpecializations = async () => {
      try {
        const response = await ApiService.get('/specializations');
        const specs = response.data?.data || [];
        setSpecializations(Array.isArray(specs) ? specs : []);
      } catch (err) {
        console.error('Error fetching specializations:', err);
        // Fallback to common specializations
        setSpecializations([
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
        ]);
      }
    };
    fetchSpecializations();
  }, []);

  const handleSearch = async (term: string) => {
    setSearchTerm(term);
    if (term.length < 2) {
      setSearchResults([]);
      return;
    }

    try {
      setSearchLoading(true);
      const response = await ApiService.get(`/doctors/search?q=${encodeURIComponent(term)}`);
      // Extract doctors array from response: response.data.data.doctors
      const doctorsArray = response.data?.data?.doctors || response.data?.data || [];
      setSearchResults(Array.isArray(doctorsArray) ? doctorsArray : []);
    } catch (err) {
      console.error('Search error:', err);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleAddExistingDoctor = async (doctor: DoctorProfile) => {
    try {
      setAddingDoctor(true);
      setError(null);
      await ApiService.post(`/hospitals/${hospitalId}/doctors`, {
        doctor_id: doctor.id,
        employment_type: 'consultant',
      });
      setSearchResults([]);
      setSearchTerm('');
      onSuccess();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to add doctor');
    } finally {
      setAddingDoctor(false);
    }
  };

  const handleCreateNewDoctor = async () => {
    if (!newDoctorData.first_name || !newDoctorData.last_name || !newDoctorData.email) {
      setError('First name, last name, and email are required');
      return;
    }

    if (!newDoctorData.primary_specialization) {
      setError('Primary specialization is required');
      return;
    }

    try {
      setCreatingDoctor(true);
      setError(null);
      // Create doctor and associate with hospital in one operation
      const response = await ApiService.post(`/hospitals/${hospitalId}/doctors/create`, newDoctorData);
      if (response.data.success && response.data.data) {
        onSuccess();
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create doctor');
    } finally {
      setCreatingDoctor(false);
    }
  };

  return (
    <div className="space-y-4 py-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Mode Tabs */}
      <div className="flex gap-2 border-b border-slate-200 pb-4">
        <button
          onClick={() => {
            setMode('search');
            setSearchResults([]);
            setSearchTerm('');
            setError(null);
          }}
          className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
            mode === 'search'
              ? 'bg-brand-50 text-brand-700'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          Search Existing Doctor
        </button>
        <button
          onClick={() => {
            setMode('create');
            setNewDoctorData({
              first_name: '',
              last_name: '',
              email: '',
              phone: '',
              primary_specialization: '',
              nmc_registration_number: '',
            });
            setError(null);
          }}
          className={`px-4 py-2 font-medium text-sm rounded-lg transition-colors ${
            mode === 'create'
              ? 'bg-brand-50 text-brand-700'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          Create New Doctor
        </button>
      </div>

      {/* Search Mode */}
      {mode === 'search' && (
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-900">Search for Doctor</label>
            <div className="mt-2 relative">
              <Input
                placeholder="Search by name, NMC number, or email..."
                value={searchTerm}
                onChange={(e) => handleSearch(e.target.value)}
                className="w-full"
              />
              {searchLoading && (
                <div className="absolute right-3 top-3 text-slate-400 text-sm">Searching...</div>
              )}
            </div>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div className="border border-slate-200 rounded-lg max-h-64 overflow-y-auto bg-white">
              {searchResults.map((doctor) => (
                <div
                  key={doctor.id}
                  className="px-4 py-3 border-b border-slate-200 last:border-b-0 flex items-center justify-between"
                >
                  <div>
                    <div className="font-medium text-slate-900">
                      Dr. {doctor.first_name} {doctor.last_name}
                    </div>
                    <div className="text-sm text-slate-600">{doctor.email}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      {doctor.primary_specialization} {doctor.nmc_registration_number && `• NMC: ${doctor.nmc_registration_number}`}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleAddExistingDoctor(doctor)}
                    disabled={addingDoctor}
                    className="flex-shrink-0"
                  >
                    {addingDoctor ? 'Adding...' : 'Add'}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {searchTerm.length > 0 && searchResults.length === 0 && !searchLoading && (
            <div className="text-center py-8 text-slate-500">
              <p>No doctors found. Try a different search.</p>
            </div>
          )}
        </div>
      )}

      {/* Create New Doctor Mode */}
      {mode === 'create' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-slate-900">First Name *</label>
              <Input
                placeholder="First name"
                value={newDoctorData.first_name}
                onChange={(e) => setNewDoctorData({ ...newDoctorData, first_name: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-900">Last Name *</label>
              <Input
                placeholder="Last name"
                value={newDoctorData.last_name}
                onChange={(e) => setNewDoctorData({ ...newDoctorData, last_name: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-900">Email *</label>
            <Input
              type="email"
              placeholder="Email address"
              value={newDoctorData.email}
              onChange={(e) => setNewDoctorData({ ...newDoctorData, email: e.target.value })}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-900">Phone</label>
            <Input
              placeholder="Phone number"
              value={newDoctorData.phone}
              onChange={(e) => setNewDoctorData({ ...newDoctorData, phone: e.target.value })}
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-900">Primary Specialization *</label>
            <select
              value={newDoctorData.primary_specialization}
              onChange={(e) => setNewDoctorData({ ...newDoctorData, primary_specialization: e.target.value })}
              className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
            >
              <option value="">Select a specialization</option>
              {specializations.map((spec) => (
                <option key={spec} value={spec}>
                  {spec}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-900">NMC Registration Number</label>
            <Input
              placeholder="Medical Council registration number"
              value={newDoctorData.nmc_registration_number}
              onChange={(e) => setNewDoctorData({ ...newDoctorData, nmc_registration_number: e.target.value })}
              className="mt-1"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-200">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleCreateNewDoctor} disabled={creatingDoctor} className="flex-1">
              {creatingDoctor ? 'Creating Doctor...' : 'Create Doctor'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default DoctorsManager;
