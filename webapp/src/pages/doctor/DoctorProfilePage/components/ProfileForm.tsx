import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader, CheckCircle, AlertCircle } from 'lucide-react';
import ApiService from '@/services/api';

const profileSchema = z.object({
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().min(1, 'Last name is required'),
  email: z.string().email('Invalid email address'),
  phone: z.string().optional(),
  primary_specialization: z.string().min(1, 'Specialization is required'),
  nmc_registration_number: z.string().min(1, 'NMC Registration Number is required'),
  state_registration_number: z.string().optional(),
});

type ProfileFormData = z.infer<typeof profileSchema>;

interface DoctorProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  primary_specialization: string;
  nmc_registration_number?: string;
  state_registration_number?: string;
}

interface ProfileFormProps {
  profile: DoctorProfile;
  onProfileUpdate: (profile: Partial<DoctorProfile>) => void;
}

const DoctorProfileForm: React.FC<ProfileFormProps> = ({ profile, onProfileUpdate }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      first_name: profile.first_name,
      last_name: profile.last_name,
      email: profile.email,
      phone: profile.phone || '',
      primary_specialization: profile.primary_specialization,
      nmc_registration_number: profile.nmc_registration_number || '',
      state_registration_number: profile.state_registration_number || '',
    },
  });

  const onSubmit = async (data: ProfileFormData) => {
    try {
      setLoading(true);
      setError(null);
      setSuccess(false);

      const response = await ApiService.put(`/doctors/${profile.id}`, data);

      if (response.data.success && response.data.data) {
        onProfileUpdate(response.data.data);
        setSuccess(true);
        setTimeout(() => setSuccess(false), 3000);
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Failed to update profile';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-green-200 bg-green-50">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertDescription className="text-green-800">Profile updated successfully!</AlertDescription>
        </Alert>
      )}

      {/* Name Fields */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
            First Name *
          </label>
          <Input
            {...register('first_name')}
            placeholder="John"
            className="mt-1"
            disabled={loading}
          />
          {errors.first_name && (
            <p className="mt-1 text-sm text-red-600">{errors.first_name.message}</p>
          )}
        </div>
        <div>
          <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
            Last Name *
          </label>
          <Input
            {...register('last_name')}
            placeholder="Doe"
            className="mt-1"
            disabled={loading}
          />
          {errors.last_name && (
            <p className="mt-1 text-sm text-red-600">{errors.last_name.message}</p>
          )}
        </div>
      </div>

      {/* Email */}
      <div>
        <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Email Address *
        </label>
        <Input
          {...register('email')}
          type="email"
          placeholder="doctor@example.com"
          className="mt-1"
          disabled={loading}
        />
        {errors.email && (
          <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
        )}
      </div>

      {/* Phone */}
      <div>
        <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Phone Number
        </label>
        <Input
          {...register('phone')}
          type="tel"
          placeholder="+1 (555) 123-4567"
          className="mt-1"
          disabled={loading}
        />
        {errors.phone && (
          <p className="mt-1 text-sm text-red-600">{errors.phone.message}</p>
        )}
      </div>

      {/* Specialization */}
      <div>
        <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Primary Specialization *
        </label>
        <Input
          {...register('primary_specialization')}
          placeholder="e.g., Cardiology"
          className="mt-1"
          disabled={loading}
        />
        {errors.primary_specialization && (
          <p className="mt-1 text-sm text-red-600">{errors.primary_specialization.message}</p>
        )}
      </div>

      {/* Registration Numbers */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
            NMC Registration Number *
          </label>
          <Input
            {...register('nmc_registration_number')}
            placeholder="e.g., 1234567"
            className="mt-1"
            disabled={loading}
          />
          {errors.nmc_registration_number && (
            <p className="mt-1 text-sm text-red-600">{errors.nmc_registration_number.message}</p>
          )}
        </div>
        <div>
          <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
            State Registration Number
          </label>
          <Input
            {...register('state_registration_number')}
            placeholder="e.g., ABC123456"
            className="mt-1"
            disabled={loading}
          />
          {errors.state_registration_number && (
            <p className="mt-1 text-sm text-red-600">{errors.state_registration_number.message}</p>
          )}
        </div>
      </div>

      {/* Submit Button */}
      <div className="flex justify-end">
        <Button type="submit" disabled={loading} size="lg">
          {loading ? (
            <>
              <Loader className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            'Save Changes'
          )}
        </Button>
      </div>
    </form>
  );
};

export default DoctorProfileForm;
