import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import apiService from "../../../../services/api";
import { Hospital, Patient, HospitalPanel, HospitalUser, User, Doctor } from "../../../../types";
import { toast } from 'sonner';

interface UseHospitalDataParams {
    hospitalId: string | undefined;
    user: User | null;
    initialHospital?: Hospital | null;
}

interface UseHospitalDataReturn {
    hospital: Hospital | null;
    hospitalUsers: HospitalUser[];
    hospitalPanels: HospitalPanel[];
    hospitalDoctors: Doctor[];
    loading: boolean;
    setHospitalPanels: React.Dispatch<React.SetStateAction<HospitalPanel[]>>;
    setHospitalUsers: React.Dispatch<React.SetStateAction<HospitalUser[]>>;
    setHospitalDoctors: React.Dispatch<React.SetStateAction<Doctor[]>>;
    refetch: () => Promise<void>;
    refetchUsers: () => Promise<void>;
    refetchDoctors: () => Promise<void>;
}

/**
 * Custom hook for fetching hospital data based on user role
 */
export const useHospitalData = ({
    hospitalId,
    user,
    initialHospital,
}: UseHospitalDataParams): UseHospitalDataReturn => {
    const navigate = useNavigate();
    const [hospital, setHospital] = useState<Hospital | null>(initialHospital || null);
    const [hospitalUsers, setHospitalUsers] = useState<HospitalUser[]>([]);
    const [hospitalPanels, setHospitalPanels] = useState<HospitalPanel[]>([]);
    const [hospitalDoctors, setHospitalDoctors] = useState<Doctor[]>([]);
    const [loading, setLoading] = useState(true);

    const fetchUsers = useCallback(async () => {
        if (!hospitalId || !user) return;
        // Only fetch users for superadmin and hospital roles, as per original logic
        if (user.role === "superadmin" || user.role === "hospital") {
            try {
                const usersRes = await apiService.getHospitalUsers(hospitalId);
                setHospitalUsers(usersRes.data.data || []);
            } catch (usersErr) {
                console.log("No users assigned yet");
            }
        }
    }, [hospitalId, user]);

    const fetchDoctors = useCallback(async () => {
        if (!hospitalId || !user) return;
        try {
            const doctorsRes = await apiService.getDoctors(hospitalId);
            setHospitalDoctors(doctorsRes.data.data || []);
        } catch (err) {
            console.log("Failed to load hospital doctors", err);
        }
    }, [hospitalId, user]);

    const fetchHospitalData = useCallback(async () => {
        if (!user?.id || !hospitalId) return;
        try {
            setLoading(true);

            if (user.role === "admin") {
                // Admin: fetch permission check and panels in parallel
                const [hospitalsRes, panelsRes, doctorsRes] = await Promise.all([
                    apiService.getAdminHospitals(user.id),
                    apiService.getHospitalPanelsDetailed(hospitalId!).catch(() => ({ data: { data: [] } })),
                    apiService.getDoctors(hospitalId!).catch(() => ({ data: { data: [] } })),
                ]);

                const foundHospital = hospitalsRes.data.data.find((h: any) => h.hospital_id === hospitalId);

                if (!foundHospital) {
                    toast.error("Unauthorized or Hospital Not Found");
                    navigate("/dashboard");
                    return;
                }

                if (!foundHospital.can_view) {
                    toast.error("You do not have permission to view this hospital");
                    navigate("/dashboard");
                    return;
                }

                setHospital(foundHospital);
                setHospitalPanels(panelsRes.data?.data || []);
                setHospitalDoctors(doctorsRes.data?.data || []);
            } else if (user.role === "superadmin") {
                // Fetch latest data even if initialHospital exists to ensure "details" are fresh
                const promises: Promise<any>[] = [
                    apiService.getHospitalPanelsDetailed(hospitalId!).catch(() => ({ data: { data: [] } })),
                    fetchUsers(),
                    apiService.getHospitalById(hospitalId!),
                    fetchDoctors()
                ];

                const results = await Promise.all(promises);

                setHospitalPanels(results[0].data?.data || []);
                // Update hospital from API if we fetched it successfully
                if (results[2] && results[2].data?.data) {
                    setHospital(results[2].data.data);
                }
            } else if (user.role === "hospital") {
                // Hospital user: fetch everything in parallel
                const [myHospitalRes, panelsRes] = await Promise.all([
                    apiService.getMyHospital(),
                    apiService.getHospitalPanels(hospitalId!).catch(() => ({ data: { data: [] } })),
                    fetchUsers(),
                    fetchDoctors()
                ]);

                const myHospital = myHospitalRes.data.data;

                if (String(myHospital.hospital_id) !== String(hospitalId)) {
                    console.error('Hospital ID mismatch');
                    toast.error("You can only access your assigned hospital");
                    navigate("/dashboard");
                    return;
                }

                setHospital({
                    id: myHospital.hospital_id,
                    name: myHospital.name,
                    city: myHospital.city,
                    drive_folder_id: myHospital.drive_folder_id,
                    details: myHospital.details,
                    created_at: '',
                });
                setHospitalPanels(panelsRes.data?.data || []);
            } else {
                toast.error("You do not have permission to view this hospital");
                navigate("/dashboard");
                return;
            }
        } catch (err) {
            console.error("Failed to load hospital details", err);
        } finally {
            setLoading(false);
        }
    }, [hospitalId, user, navigate, fetchUsers, initialHospital]);

    useEffect(() => {
        if (hospitalId) {
            fetchHospitalData();
        }
    }, [hospitalId, fetchHospitalData]);

    return {
        hospital,
        hospitalUsers,
        hospitalPanels,
        hospitalDoctors,
        loading,
        setHospitalPanels,
        setHospitalUsers,
        setHospitalDoctors,
        refetch: fetchHospitalData,
        refetchUsers: fetchUsers,
        refetchDoctors: fetchDoctors
    };
};
