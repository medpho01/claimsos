import axios, { AxiosInstance } from "axios";

const API_BASE_URL = "http://localhost:8000/api/v1";

class ApiService {
    private api: AxiosInstance;

    constructor() {
        this.api = axios.create({
            baseURL: API_BASE_URL,
            headers: {
                "Content-Type": "application/json",
            },
        });

        // Add request interceptor to include auth token
        this.api.interceptors.request.use(
            (config) => {
                const token = localStorage.getItem("accessToken");
                if (token) {
                    config.headers.Authorization = `Bearer ${token}`;
                }
                return config;
            },
            (error) => Promise.reject(error)
        );

        // Add response interceptor for token refresh
        this.api.interceptors.response.use(
            (response) => response,
            async (error) => {
                const originalRequest = error.config;

                if (error.response?.status === 401 && !originalRequest._retry) {
                    originalRequest._retry = true;

                    try {
                        const refreshToken = localStorage.getItem("refreshToken");
                        const oldAccessToken = localStorage.getItem("accessToken");

                        if (refreshToken && oldAccessToken) {
                            const response = await axios.post(
                                `${API_BASE_URL}/auth/refreshAccessToken`,
                                { refreshToken },
                                {
                                    headers: {
                                        Authorization: `Bearer ${oldAccessToken}`,
                                    },
                                }
                            );

                            const { accessToken } = response.data.data;
                            localStorage.setItem("accessToken", accessToken);

                            originalRequest.headers.Authorization = `Bearer ${accessToken}`;
                            return this.api(originalRequest);
                        }
                    } catch (refreshError) {
                        localStorage.clear();
                        window.location.href = "/login";
                        return Promise.reject(refreshError);
                    }
                }

                return Promise.reject(error);
            }
        );
    }

    // Auth endpoints
    login(username: string, password: string) {
        return this.api.post("/auth/login", {
            userName: username,
            passWord: password,
        });
    }

    signup(userData: {
        userName: string;
        passWord: string;
        firstName: string;
        lastName?: string;
        email: string;
        phone: string;
        role: string;
        hospitalGroupId?: string;
    }) {
        return this.api.post("/auth/signup", userData);
    }

    // Patient endpoints
    getAllPatients() {
        return this.api.get("/patient/getAllPatients");
    }

    addPatient(patientData: {
        firstName: string;
        lastName?: string;
        phone: string;
        admittedAt?: string;
        hospitalId?: string;
        admissionType?: 'conservative' | 'surgical';
    }) {
        return this.api.post("/patient/addPatient", patientData);
    }

    updatePatient(
        id: string,
        patientData: {
            firstName: string;
            lastName?: string;
            phone: string;
            admittedAt: string;
            admissionType?: 'conservative' | 'surgical';
            pmjayCaseNumber?: string;
            scheme?: string;
            treatmentProcedure?: string;
            latestStatus?: string;
            claimAmount?: number;
        }
    ) {
        return this.api.patch(`/patient/${id}`, patientData);
    }

    dischargePatient(id: string, dischargedAt: string) {
        return this.api.patch(`/patient/${id}/discharge`, { dischargedAt });
    }

    deletePatient(id: string) {
        return this.api.delete(`/patient/${id}`);
    }

    togglePatientActiveStatus(patientId: string, isActive: boolean) {
        return this.api.patch(`/patient/${patientId}/toggle-active`, { isActive });
    }

    // Upload endpoints
    uploadFiles(patientId: string, files: File[]) {
        const formData = new FormData();
        formData.append("patientId", patientId);
        files.forEach((file) => {
            formData.append("files", file);
        });

        return this.api.post("/uploads/upload", formData, {
            headers: {
                "Content-Type": "multipart/form-data",
            },
        });
    }

    // Admin management endpoints
    getAllAdmins() {
        return this.api.get("/admin/admins");
    }

    getAllHospitalUsers() {
        return this.api.get("/admin/hospitals");
    }

    assignHospitalToAdmin(data: {
        adminId: string;
        hospitalId: string;
        canView?: boolean;
        canEdit?: boolean;
        canDischarge?: boolean;
    }) {
        return this.api.post("/admin/assign-hospital", data);
    }

    removeHospitalAssignment(adminId: string, hospitalId: string) {
        return this.api.delete("/admin/remove-assignment", {
            data: { adminId, hospitalId },
        });
    }

    getAdminHospitals(adminId: string) {
        return this.api.get(`/admin/admin/${adminId}/hospitals`);
    }

    getAdminPatients(adminId: string) {
        return this.api.get(`/admin/admin/${adminId}/patients`);
    }

    getAllUsers() {
        return this.api.get("/user/all");
    }

    updateHospitalPermissions(data: {
        adminId: string;
        hospitalId: string;
        canView?: boolean;
        canEdit?: boolean;
        canDischarge?: boolean;
    }) {
        return this.api.patch("/admin/update-permissions", data);
    }

    // Get patient photos from Google Drive (admin/superadmin only)
    getPatientPhotos(patientId: string) {
        return this.api.get(`/uploads/admin/photos/${patientId}`);
    }
}

export default new ApiService();
