import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { AlertCircle, Save, Loader } from 'lucide-react';
import ApiService from '@/services/api';
import { SelectField } from '@/components/forms/SelectField';
import { MultiSelectField } from '@/components/forms/MultiSelectField';
import { useMasterOptions } from '@/hooks/useMasterOptions';
import { MASTER_CATEGORIES } from '@/constants/masterCategories';

interface ProfileFormProps {
  hospitalId: string;
  profile: any;
  onProfileUpdate: (profile: any) => void;
}

export default function ProfileForm({ hospitalId, profile, onProfileUpdate }: ProfileFormProps) {
  const [formData, setFormData] = useState({
    legal_name: '',
    address_line1: '',
    address_line2: '',
    city: '',
    district: '',
    state: '',
    pincode: '',
    website: '',
    email: '',
    phone: '',
    hospital_type: '',
    established_year: '',
    rohini_id: '',
    hfr_id: '',
    pan_number: '',
    gst_number: '',
    specialties: [] as string[],
    // Banking Details
    cheque_payable_name: '',
    bank_name: '',
    bank_branch: '',
    bank_address: '',
    account_type: '',
    account_number: '',
    ifsc_code: '',
    pan_name: '',
    micr_code: '',
  });

  // Load master options
  const { options: hospitalTypeOptions, loading: htLoading } = useMasterOptions(MASTER_CATEGORIES.HOSPITAL_TYPE);
  const { options: specialityOptions, loading: specLoading } = useMasterOptions(MASTER_CATEGORIES.SPECIALITY);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (profile) {
      // Handle specialties - could be string (legacy), array, or JSONB array
      let specialtiesArray: string[] = [];
      if (profile.specialties) {
        if (Array.isArray(profile.specialties)) {
          specialtiesArray = profile.specialties;
        } else if (typeof profile.specialties === 'string') {
          // Convert comma-separated string to array
          specialtiesArray = profile.specialties
            .split(',')
            .map((s: string) => s.trim())
            .filter((s: string) => s.length > 0);
        }
      }

      setFormData({
        legal_name: profile.legal_name || '',
        address_line1: profile.address_line1 || '',
        address_line2: profile.address_line2 || '',
        city: profile.city || '',
        district: profile.district || '',
        state: profile.state || '',
        pincode: profile.pincode || '',
        website: profile.website || '',
        email: profile.email || '',
        phone: profile.phone || '',
        hospital_type: profile.hospital_type || '',
        established_year: profile.established_year || '',
        rohini_id: profile.rohini_id || '',
        hfr_id: profile.hfr_id || '',
        pan_number: profile.pan_number || '',
        gst_number: profile.gst_number || '',
        specialties: specialtiesArray,
        // Banking Details
        cheque_payable_name: profile.cheque_payable_name || '',
        bank_name: profile.bank_name || '',
        bank_branch: profile.bank_branch || '',
        bank_address: profile.bank_address || '',
        account_type: profile.account_type || '',
        account_number: profile.account_number || '',
        ifsc_code: profile.ifsc_code || '',
        pan_name: profile.pan_name || '',
        micr_code: profile.micr_code || '',
      });
    }
  }, [profile]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
    setFormData(prev => ({
      ...prev,
      [name]: name.includes('beds') || name.includes('total') ? parseInt(value) || 0 : value,
    }));
  };

  // Handle specialties change (array)
  const handleSpecialtiesChange = (specialties: string[]) => {
    setFormData(prev => ({
      ...prev,
      specialties,
    }));
  };

  // Handle hospital type change
  const handleHospitalTypeChange = (value: string) => {
    setFormData(prev => ({
      ...prev,
      hospital_type: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);
      console.log('🔵 Form submission started with data:', formData);
      const response = await ApiService.updateHospitalProfile(hospitalId, formData);
      console.log('✅ API Response:', response);
      onProfileUpdate(response.data.data);
      setSuccess(true);
      setIsEditing(false);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error('❌ Error updating profile:', err);
      const errorMsg = err.response?.data?.message || err.message || 'Failed to update profile';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              {error}
            </div>
          </CardContent>
        </Card>
      )}

      {success && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="pt-6">
            <div className="text-green-600">Profile updated successfully</div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Hospital Profile</CardTitle>
              <CardDescription>Manage hospital basic information</CardDescription>
            </div>
            {!isEditing && (
              <Button onClick={() => setIsEditing(true)}>Edit Profile</Button>
            )}
          </div>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Basic Information */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Basic Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="legal_name">Legal Name *</Label>
                  <Input
                    id="legal_name"
                    name="legal_name"
                    value={formData.legal_name}
                    onChange={handleChange}
                    disabled={!isEditing}
                    required
                  />
                </div>


                <div className="space-y-2">
                  <SelectField
                    id="hospital_type"
                    label="Hospital Type"
                    value={formData.hospital_type}
                    options={hospitalTypeOptions}
                    onChange={handleHospitalTypeChange}
                    disabled={!isEditing || htLoading}
                    placeholder={htLoading ? 'Loading...' : 'Select hospital type'}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="established_year">Year Established</Label>
                  <Input
                    id="established_year"
                    name="established_year"
                    type="number"
                    value={formData.established_year}
                    onChange={handleChange}
                    disabled={!isEditing}
                    min="1900"
                    max={new Date().getFullYear()}
                  />
                </div>
              </div>
            </div>

            {/* Address Information */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Address</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="col-span-2 space-y-2">
                  <Label htmlFor="address_line1">Street Address Line 1</Label>
                  <Input
                    id="address_line1"
                    name="address_line1"
                    value={formData.address_line1}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="House number, street name"
                  />
                </div>

                <div className="col-span-2 space-y-2">
                  <Label htmlFor="address_line2">Street Address Line 2</Label>
                  <Input
                    id="address_line2"
                    name="address_line2"
                    value={formData.address_line2}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="Apartment, suite, etc. (optional)"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    name="city"
                    value={formData.city}
                    onChange={handleChange}
                    disabled={!isEditing}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="district">District</Label>
                  <Input
                    id="district"
                    name="district"
                    value={formData.district}
                    onChange={handleChange}
                    disabled={!isEditing}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="state">State/Province</Label>
                  <Input
                    id="state"
                    name="state"
                    value={formData.state}
                    onChange={handleChange}
                    disabled={!isEditing}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pincode">Postal Code</Label>
                  <Input
                    id="pincode"
                    name="pincode"
                    value={formData.pincode}
                    onChange={handleChange}
                    disabled={!isEditing}
                  />
                </div>
              </div>
            </div>

            {/* Contact Information */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Contact Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    name="phone"
                    value={formData.phone}
                    onChange={handleChange}
                    disabled={!isEditing}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    value={formData.email}
                    onChange={handleChange}
                    disabled={!isEditing}
                  />
                </div>

                <div className="col-span-2 space-y-2">
                  <Label htmlFor="website">Website</Label>
                  <Input
                    id="website"
                    name="website"
                    type="url"
                    value={formData.website}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="https://example.com"
                  />
                </div>
              </div>
            </div>

            {/* Registration & Government IDs */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Registration & Government IDs</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="rohini_id">Rohini ID</Label>
                  <Input
                    id="rohini_id"
                    name="rohini_id"
                    value={formData.rohini_id}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="Hospital Rohini ID"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="hfr_id">HFR ID</Label>
                  <Input
                    id="hfr_id"
                    name="hfr_id"
                    value={formData.hfr_id}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="Health Facility Registry ID"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pan_number">PAN Number</Label>
                  <Input
                    id="pan_number"
                    name="pan_number"
                    value={formData.pan_number}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="e.g., XXXXX1234X"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="gst_number">GST Number</Label>
                  <Input
                    id="gst_number"
                    name="gst_number"
                    value={formData.gst_number}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="e.g., 27XXXXXX123X1Z0"
                  />
                </div>
              </div>
            </div>

            {/* Specialties */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Specialties</h3>
              <div className="space-y-2">
                <MultiSelectField
                  id="specialties"
                  label="Specialities"
                  values={formData.specialties}
                  options={specialityOptions}
                  onChange={handleSpecialtiesChange}
                  disabled={!isEditing || specLoading}
                  loading={specLoading}
                  placeholder="Select specialities"
                />
              </div>
            </div>

            {/* Banking Details */}
            <div>
              <h3 className="text-lg font-semibold mb-4">Banking Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cheque_payable_name">Cheque Payable Name</Label>
                  <Input
                    id="cheque_payable_name"
                    name="cheque_payable_name"
                    value={formData.cheque_payable_name}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="Name for cheques"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="bank_name">Bank Name</Label>
                  <Input
                    id="bank_name"
                    name="bank_name"
                    value={formData.bank_name}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="e.g., HDFC Bank"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="bank_branch">Bank Branch</Label>
                  <Input
                    id="bank_branch"
                    name="bank_branch"
                    value={formData.bank_branch}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="Branch name or location"
                  />
                </div>

                <div className="col-span-2 space-y-2">
                  <Label htmlFor="bank_address">Bank Address</Label>
                  <Input
                    id="bank_address"
                    name="bank_address"
                    value={formData.bank_address}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="Full bank branch address"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="account_type">Account Type</Label>
                  <select
                    id="account_type"
                    name="account_type"
                    value={formData.account_type}
                    onChange={handleChange}
                    disabled={!isEditing}
                    className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-brand-600 disabled:bg-slate-100"
                  >
                    <option value="">Select Account Type</option>
                    <option value="savings">Savings</option>
                    <option value="current">Current</option>
                    <option value="nri">NRI</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="account_number">Account Number</Label>
                  <Input
                    id="account_number"
                    name="account_number"
                    value={formData.account_number}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="Bank account number"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ifsc_code">IFSC Code</Label>
                  <Input
                    id="ifsc_code"
                    name="ifsc_code"
                    value={formData.ifsc_code}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="11-character IFSC code"
                    maxLength={11}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pan_name">Name On PAN Card</Label>
                  <Input
                    id="pan_name"
                    name="pan_name"
                    value={formData.pan_name}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="PAN card holder name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="micr_code">MICR Code</Label>
                  <Input
                    id="micr_code"
                    name="micr_code"
                    value={formData.micr_code}
                    onChange={handleChange}
                    disabled={!isEditing}
                    placeholder="9-digit MICR code"
                    maxLength={9}
                  />
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            {isEditing && (
              <div className="flex gap-3 pt-4 border-t">
                <Button
                  type="submit"
                  disabled={loading}
                  className="gap-2"
                >
                  {loading ? (
                    <>
                      <Loader className="h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" />
                      Save Changes
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIsEditing(false)}
                  disabled={loading}
                >
                  Cancel
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
