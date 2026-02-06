import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import apiService from "../../../../services/api";
import { Hospital, Patient, HospitalPanel, HospitalUser, User } from "../../../../types";

interface UseHospitalDataParams {
    hospitalId: string | undefined;
    user: User | null;
}

interface UseHospitalDataReturn {
    hospital: Hospital | null;
    hospitalUsers: HospitalUser[];
    hospitalPanels: HospitalPanel[];
    loading: boolean;
    setHospitalPanels: React.Dispatch<React.SetStateAction<HospitalPanel[]>>;
    setHospitalUsers: React.Dispatch<React.SetStateAction<HospitalUser[]>>;
}

/**
 * Custom hook for fetching hospital data based on user role
 */
export const useHospitalData = ({
    hospitalId,
    user,
}: UseHospitalDataParams): UseHospitalDataReturn => {
    const navigate = useNavigate();
    const [hospital, setHospital] = useState<Hospital | null>(null);
    const [hospitalUsers, setHospitalUsers] = useState<HospitalUser[]>([]);
    const [hospitalPanels, setHospitalPanels] = useState<HospitalPanel[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            if (!user?.id || !hospitalId) return;
            try {
                setLoading(true);

                if (user.role === "admin") {
                    // Admin logic: get assigned hospitals to check permission and details
                    const hospitalsRes = await apiService.getAdminHospitals(user.id);
                    const foundHospital = hospitalsRes.data.data.find((h: any) => h.hospital_id === hospitalId);

                    if (!foundHospital) {
                        alert("Unauthorized or Hospital Not Found");
                        navigate("/dashboard");
                        return;
                    }

                    if (!foundHospital.can_view) {
                        alert("You do not have permission to view this hospital");
                        navigate("/dashboard");
                        return;
                    }
                    // Fetch hospital panels
                    try {
                        const panelsRes = await apiService.getHospitalPanelsDetailed(hospitalId!);
                        setHospitalPanels(panelsRes.data.data || []);
                    } catch (panelErr) {
                        console.log("No panels linked yet");
                    }
                    
                    setHospital(foundHospital);
                } else if (user.role === "superadmin") {
                    // Superadmin logic - fetch actual hospital entity
                    const [hospitalsRes] = await Promise.all([
                        apiService.getAllHospitals(),
                    ]);

                    const foundHospital = hospitalsRes.data.data.find((h: Hospital) => h.id === hospitalId);
                    setHospital(foundHospital || null);

                    // Fetch hospital panels
                    try {
                        const panelsRes = await apiService.getHospitalPanelsDetailed(hospitalId!);
                        setHospitalPanels(panelsRes.data.data || []);
                    } catch (panelErr) {
                        console.log("No panels linked yet");
                    }

                    // Fetch hospital users
                    try {
                        const usersRes = await apiService.getHospitalUsers(hospitalId!);
                        setHospitalUsers(usersRes.data.data || []);
                    } catch (usersErr) {
                        console.log("No users assigned yet");
                    }
                } else if (user.role === "hospital") {
                    // Hospital user logic - fetch their own hospital details
                    const myHospitalRes = await apiService.getMyHospital();
                    const myHospital = myHospitalRes.data.data;

                    console.log('Hospital Access Check:', {
                        urlId: hospitalId,
                        myHospitalId: myHospital.hospital_id, // Note: query returns hospital_id
                        fullObj: myHospital
                    });

                    // The query returns hospital_id, but we need to check against url param
                    // Also use loose equality for safety
                    if (String(myHospital.hospital_id) !== String(hospitalId)) {
                        console.error('Hospital ID mismatch');
                        alert("You can only access your assigned hospital");
                        navigate("/dashboard");
                        return;
                    }

                    // Transform to Hospital type structure if needed
                    setHospital({
                        id: myHospital.hospital_id,
                        name: myHospital.name,
                        city: myHospital.city,
                        drive_folder_id: myHospital.drive_folder_id,
                        created_at: '', // Not returned by endpoint currently
                    });

                    // Fetch hospital panels
                    try {
                        const panelsRes = await apiService.getHospitalPanels(hospitalId!);
                        setHospitalPanels(panelsRes.data.data || []);
                    } catch (panelErr) {
                        console.log("No panels linked yet");
                    }

                    // Fetch hospital users
                    try {
                        const usersRes = await apiService.getHospitalUsers(hospitalId!);
                        setHospitalUsers(usersRes.data.data || []);
                    } catch (usersErr) {
                        console.log("No users assigned yet");
                    }
                } else {
                    alert("You do not have permission to view this hospital");
                    navigate("/dashboard");
                    return;
                }
            } catch (err) {
                console.error("Failed to load hospital details", err);
            } finally {
                setLoading(false);
            }
        };

        if (hospitalId) {
            fetchData();
        }
    }, [hospitalId, user, navigate]);

    return {
        hospital,
        hospitalUsers,
        hospitalPanels,
        loading,
        setHospitalPanels,
        setHospitalUsers
    };
};
