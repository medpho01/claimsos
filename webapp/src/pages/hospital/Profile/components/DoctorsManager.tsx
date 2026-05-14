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
      {/* UI Revamp: bordered search wrapper inherits dark mode + brand focus ring */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 flex items-center gap-2 bg-white dark:bg-slate-900 rounded-md border border-slate-200 dark:border-slate-700 px-3 h-9 focus-within:ring-2 focus-within:ring-brand-600/30 focus-within:border-brand-600">
          <Search className="h-4 w-4 text-slate-400 shrink-0" />
          <Input
            placeholder="Search doctors by name, department, or specialization..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none h-8 px-0 bg-transparent text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
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
        /* UI Revamp J.8: replace card grid with wireframe hw-doctors table */
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden dark:bg-slate-900 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-50/80 dark:bg-slate-800/40 text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              <tr>
                <th className="text-left px-4 py-2">Doctor</th>
                <th className="text-left px-3 py-2">Department</th>
                <th className="text-left px-3 py-2">NMC #</th>
                <th className="text-left px-3 py-2">Employment</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="px-3 py-2 w-32"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredDoctors.map((doctor) => {
                const fn = doctor.doctor?.first_name || '';
                const ln = doctor.doctor?.last_name || '';
                const initials = `${fn[0] || ''}${ln[0] || ''}`.toUpperCase() || '?';
                const isActive = (doctor.status || 'active') === 'active';
                return (
                  <tr
                    key={doctor.id}
                    className="hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer transition-colors"
                    onClick={() => setSelectedDoctorForEdit(doctor)}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 rounded-full bg-brand-700 text-white text-xs font-semibold flex items-center justify-center shrink-0">
                          {initials}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                            Dr. {fn} {ln}
                          </div>
                          {doctor.doctor?.primary_specialization && (
                            <div className="text-xs text-slate-500 truncate">
                              {doctor.doctor.primary_specialization}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-700 dark:text-slate-200">
                      {doctor.department || '—'}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-700 dark:text-slate-300">
                      {(doctor.doctor as any)?.nmc_registration_number || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-700 dark:text-slate-200">
                      <span className="capitalize">{doctor.employment_type || '—'}</span>
                      {doctor.designation && (
                        <span className="text-slate-500"> · {doctor.designation}</span>
                      )}
                      {doctor.start_date && (
                        <div className="text-slate-500">
                          since {new Date(doctor.start_date).getFullYear()}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`pill ${isActive ? 'pill-ok' : 'pill-muted'}`}>
                        {doctor.status || 'active'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex items-center gap-1 justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedDoctorForEdit(doctor);
                          }}
                          className="text-xs"
                        >
                          View
                        </Button>
                        <AlertDialog
                          open={doctorToRemove?.id === doctor.id}
                          onOpenChange={(open) => !open && setDoctorToRemove(null)}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDoctorToRemove(doctor);
                            }}
                            className="text-danger-700 hover:text-danger-700 hover:bg-danger-50 dark:hover:bg-danger-700/20"
                            aria-label="Remove doctor"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Remove Doctor</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to remove Dr. {fn} {ln} from this hospital? This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleRemoveDoctor(doctor)}
                                className="bg-danger-600 hover:bg-danger-700 text-white"
                              >
                                Remove
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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

  // Fetch specializations on mount.
  //
  // Previously hit GET /specializations which doesn't exist (no Backend route
  // mounted at that path), so the catch path ran every time and the user got
  // the hardcoded 15-item fallback while a 404 was logged on every render.
  // Use the live master-options endpoint instead — the Master Options page
  // already curates the canonical 58-item speciality list there.
  useEffect(() => {
    const fetchSpecializations = async () => {
      try {
        const response = await ApiService.get('/master-options/by-category/speciality');
        const specs = response.data?.data || [];
        // Master options returns rows of { code, label, description }. The form
        // here just needs label strings — extract them.
        const labels = Array.isArray(specs) ? specs.map((s: any) => s.label || s.code).filter(Boolean) : [];
        setSpecializations(labels);
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
              ? 'bg-brand-600 text-white'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700'
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
