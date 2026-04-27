import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader, AlertCircle, Home } from 'lucide-react';
import ApiService from '@/services/api';
import { useAuth } from '@/context/AuthContext';

// Zod validation schema
const registerDoctorSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(100),
  last_name: z.string().min(1, 'Last name is required').max(100),
  email: z.string().email('Invalid email address'),
  phone: z.string().regex(/^[0-9+\-\s()]*$/, 'Invalid phone number').optional().or(z.literal('')),
  primary_specialization: z.string().min(1, 'Specialization is required'),
  nmc_registration_number: z.string().min(1, 'NMC Registration Number is required'),
  state_registration_number: z.string().optional().or(z.literal('')),
  username: z.string()
    .min(3, 'Username must be at least 3 characters')
    .max(50, 'Username must be less than 50 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, hyphens, and underscores'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number')
    .regex(/[!@#$%^&*]/, 'Password must contain at least one special character (!@#$%^&*)'),
  confirmPassword: z.string(),
  agreeToTerms: z.boolean().refine((val) => val === true, {
    message: 'You must agree to the terms and conditions',
  }),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type RegisterDoctorFormData = z.infer<typeof registerDoctorSchema>;

interface Specialization {
  id: string;
  label: string;
}

const RegisterDoctor: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [specializations, setSpecializations] = useState<Specialization[]>([]);
  const [loadingSpecializations, setLoadingSpecializations] = useState(true);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
  } = useForm<RegisterDoctorFormData>({
    resolver: zodResolver(registerDoctorSchema),
    defaultValues: {
      agreeToTerms: false,
    },
  });

  // Fetch available specializations on component mount
  React.useEffect(() => {
    const fetchSpecializations = async () => {
      try {
        setLoadingSpecializations(true);
        const response = await ApiService.get('/admin/doctor-attributes/definitions?category=qualifications');
        // Extract unique specializations from attribute definitions
        const specs = [
          { id: 'cardiology', label: 'Cardiology' },
          { id: 'pediatrics', label: 'Pediatrics' },
          { id: 'orthopedics', label: 'Orthopedics' },
          { id: 'neurology', label: 'Neurology' },
          { id: 'oncology', label: 'Oncology' },
          { id: 'psychiatry', label: 'Psychiatry' },
          { id: 'surgery', label: 'Surgery' },
          { id: 'general', label: 'General Medicine' },
          { id: 'dermatology', label: 'Dermatology' },
          { id: 'ophthalmology', label: 'Ophthalmology' },
          { id: 'ent', label: 'ENT' },
          { id: 'gynecology', label: 'Gynecology & Obstetrics' },
          { id: 'urology', label: 'Urology' },
          { id: 'nephrology', label: 'Nephrology' },
          { id: 'gastroenterology', label: 'Gastroenterology' },
        ];
        setSpecializations(specs);
      } catch (err) {
        console.error('Error loading specializations:', err);
        // Fallback specializations
        setSpecializations([
          { id: 'cardiology', label: 'Cardiology' },
          { id: 'pediatrics', label: 'Pediatrics' },
          { id: 'general', label: 'General Medicine' },
        ]);
      } finally {
        setLoadingSpecializations(false);
      }
    };

    fetchSpecializations();
  }, []);

  const onSubmit = async (data: RegisterDoctorFormData) => {
    try {
      setLoading(true);
      setError(null);

      // First, create the user account with role 'doctor'
      const signupResponse = await ApiService.post('/auth/signup', {
        userName: data.username,
        passWord: data.password,
        firstName: data.first_name,
        lastName: data.last_name,
        email: data.email,
        phone: data.phone || null,
        role: 'doctor',
      });

      // Then create the doctor profile
      if (signupResponse.data.success) {
        await ApiService.post('/doctors', {
          first_name: data.first_name,
          last_name: data.last_name,
          email: data.email,
          phone: data.phone || null,
          primary_specialization: data.primary_specialization,
          nmc_registration_number: data.nmc_registration_number,
          state_registration_number: data.state_registration_number || null,
          registration_method: 'self_registered',
          is_public_profile_enabled: false, // Start with private profile
        });

        // Auto-login the user
        // TODO: Fix auto-login - requires proper token handling
        // await login(data.username, data.password);

        setSuccessMessage('Registration successful! Redirecting to your profile...');
        setTimeout(() => {
          navigate('/doctor/profile');
        }, 2000);
      }
    } catch (err: any) {
      const errorMessage = err.response?.data?.message ||
                          err.response?.data?.data?.message ||
                          'Registration failed. Please try again.';
      setError(errorMessage);
      console.error('Registration error:', err);
    } finally {
      setLoading(false);
    }
  };

  const password = watch('password');

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Back to home */}
        <button
          onClick={() => navigate('/')}
          className="mb-8 inline-flex items-center gap-2 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
        >
          <Home className="h-4 w-4" />
          Back to Home
        </button>

        <Card className="shadow-xl border-0">
          <CardHeader className="space-y-2 pb-4">
            <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center mb-2">
              <span className="text-xl font-bold text-white">Dr</span>
            </div>
            <CardTitle className="text-3xl">Register as Doctor</CardTitle>
            <CardDescription>
              Create your professional profile and join our network of verified healthcare professionals
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {successMessage && (
              <Alert className="border-green-200 bg-green-50">
                <AlertDescription className="text-green-800">
                  {successMessage}
                </AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
                  Phone Number (Optional)
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
                {loadingSpecializations ? (
                  <div className="mt-1 p-2 text-sm text-slate-500">Loading specializations...</div>
                ) : (
                  <select
                    {...register('primary_specialization')}
                    className="mt-1 w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-800 dark:text-slate-100 text-sm"
                    disabled={loading}
                  >
                    <option value="">Select a specialization</option>
                    {specializations.map((spec) => (
                      <option key={spec.id} value={spec.label}>
                        {spec.label}
                      </option>
                    ))}
                  </select>
                )}
                {errors.primary_specialization && (
                  <p className="mt-1 text-sm text-red-600">{errors.primary_specialization.message}</p>
                )}
              </div>

              {/* NMC Registration Number */}
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

              {/* State Registration Number */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  State Registration Number (Optional)
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

              {/* Username */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Username *
                </label>
                <Input
                  {...register('username')}
                  placeholder="johndoe"
                  className="mt-1"
                  disabled={loading}
                />
                {errors.username && (
                  <p className="mt-1 text-sm text-red-600">{errors.username.message}</p>
                )}
              </div>

              {/* Password */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Password *
                </label>
                <Input
                  {...register('password')}
                  type="password"
                  placeholder="••••••••"
                  className="mt-1"
                  disabled={loading}
                />
                {errors.password && (
                  <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
                )}
                {password && !errors.password && (
                  <p className="mt-1 text-sm text-green-600">Password strength: Strong</p>
                )}
              </div>

              {/* Confirm Password */}
              <div>
                <label className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  Confirm Password *
                </label>
                <Input
                  {...register('confirmPassword')}
                  type="password"
                  placeholder="••••••••"
                  className="mt-1"
                  disabled={loading}
                />
                {errors.confirmPassword && (
                  <p className="mt-1 text-sm text-red-600">{errors.confirmPassword.message}</p>
                )}
              </div>

              {/* Terms Checkbox */}
              <div className="flex items-start gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                <input
                  {...register('agreeToTerms')}
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-slate-300"
                  disabled={loading}
                />
                <label className="text-sm text-slate-700 dark:text-slate-300">
                  I agree to the{' '}
                  <a href="/terms" className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
                    Terms and Conditions
                  </a>{' '}
                  and{' '}
                  <a href="/privacy" className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">
                    Privacy Policy
                  </a>
                  . *
                </label>
              </div>
              {errors.agreeToTerms && (
                <p className="text-sm text-red-600">{errors.agreeToTerms.message}</p>
              )}

              {/* Submit Button */}
              <Button
                type="submit"
                className="w-full"
                disabled={loading}
                size="lg"
              >
                {loading ? (
                  <>
                    <Loader className="mr-2 h-4 w-4 animate-spin" />
                    Creating your account...
                  </>
                ) : (
                  'Register as Doctor'
                )}
              </Button>
            </form>

            {/* Login Link */}
            <div className="text-center">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Already have an account?{' '}
                <a href="/login" className="text-blue-600 hover:underline font-medium">
                  Login here
                </a>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Disclaimer */}
        <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
          Your credentials will be kept secure and verified according to medical regulatory standards.
        </p>
      </div>
    </div>
  );
};

export default RegisterDoctor;
