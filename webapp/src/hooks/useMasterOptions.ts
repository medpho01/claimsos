import { useState, useEffect } from 'react';
import ApiService from '@/services/api';

interface MasterOption {
  value: string;
  label: string;
  description?: string;
}

interface MasterOptionData {
  id: string;
  category: string;
  code: string;
  label: string;
  description?: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface UseMasterOptionsReturn {
  options: MasterOption[];
  loading: boolean;
  error: string | null;
}

/**
 * Custom hook to fetch master options by category
 * Used for dropdown/select field values
 *
 * @param category - The category of options to fetch (e.g., 'hospital_type', 'speciality')
 * @returns Object with options, loading state, and error
 *
 * @example
 * const { options, loading, error } = useMasterOptions('hospital_type');
 */
export const useMasterOptions = (category: string): UseMasterOptionsReturn => {
  const [options, setOptions] = useState<MasterOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!category) {
      setOptions([]);
      return;
    }

    const fetchOptions = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await ApiService.get(`/master-options/by-category/${category}`);

        if (response?.data?.data && Array.isArray(response.data.data)) {
          // Transform database format to select component format
          const transformedOptions: MasterOption[] = response.data.data.map((opt: MasterOptionData) => ({
            value: opt.code,
            label: opt.label,
            description: opt.description,
          }));

          setOptions(transformedOptions);
        } else {
          setError(`Invalid response format for category: ${category}`);
        }
      } catch (err: any) {
        const errorMessage = err?.response?.data?.error ||
                            err?.message ||
                            `Failed to load options for category: ${category}`;
        console.error(`Error fetching master options for ${category}:`, err);
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchOptions();
  }, [category]);

  return { options, loading, error };
};

export default useMasterOptions;
