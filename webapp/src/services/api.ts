import axios, { AxiosInstance } from "axios";

const API_BASE_URL =
    process.env.NODE_ENV === "production"
        ? "/api/v1"
        : "http://localhost:8000/api/v1";

const API_V2_BASE_URL =
    process.env.NODE_ENV === "production"
        ? "/api/v2"
        : "http://localhost:8000/api/v2";

class ApiService {
    private api: AxiosInstance;
    private apiV2: AxiosInstance;
    private isRefreshing = false;
    private refreshSubscribers: ((token: string) => void)[] = [];

    constructor() {
        this.api = axios.create({
            baseURL: API_BASE_URL,
            headers: {
                "Content-Type": "application/json",
            },
        });

        this.apiV2 = axios.create({
            baseURL: API_V2_BASE_URL,
            headers: {
                "Content-Type": "application/json",
            },
        });

        // Add auth interceptors to both V1 and V2 instances
        this.setupInterceptors(this.api);
        this.setupInterceptors(this.apiV2);
    }

    private setupInterceptors(instance: AxiosInstance) {
        // Add request interceptor to include auth token
        instance.interceptors.request.use(
            (config) => {
                const token = localStorage.getItem("accessToken");
                if (token) {
                    config.headers.Authorization = `Bearer ${token}`;
                }
                return config;
            },
            (error) => Promise.reject(error)
        );

        // Add response interceptor for token refresh with mutex pattern
        instance.interceptors.response.use(
            (response) => response,
            async (error) => {
                const originalRequest = error.config;

                // Only handle 401 errors and prevent infinite retry loops
                if (error.response?.status === 401 && !originalRequest._retry) {
                    originalRequest._retry = true;

                    // If already refreshing, wait for the refresh to complete
                    if (this.isRefreshing) {
                        return new Promise((resolve) => {
                            this.refreshSubscribers.push((newToken: string) => {
                                originalRequest.headers.Authorization = `Bearer ${newToken}`;
                                resolve(instance(originalRequest));
                            });
                        });
                    }

                    // Start refreshing
                    this.isRefreshing = true;

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

                            // Notify all waiting requests with the new token
                            this.refreshSubscribers.forEach((callback) => callback(accessToken));
                            this.refreshSubscribers = [];

                            originalRequest.headers.Authorization = `Bearer ${accessToken}`;
                            return instance(originalRequest);
                        } else {
                            // No tokens available, redirect to login
                            localStorage.clear();
                            window.location.href = "/login";
                            return Promise.reject(error);
                        }
                    } catch (refreshError) {
                        // Refresh failed, clear tokens and redirect
                        this.refreshSubscribers = [];
                        localStorage.clear();
                        window.location.href = "/login";
                        return Promise.reject(refreshError);
                    } finally {
                        this.isRefreshing = false;
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
    getHospitalPanelPatients(hospitalId: string, panelId: string, pageNumber: number = 1, status: string = 'all', search: string = '') {
        let url = `/patient/getPatients?page=${pageNumber}&hospitalId=${hospitalId}&panelId=${panelId}&status=${status}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        return this.api.get(url);
    }

    getHospitalAllPatients(hospitalId: string) {
        return this.api.get(`/patient/getPatients?hospitalId=${hospitalId}`);
    }

    getTabCounts(hospitalId: string, panelId: string, search: string = '') {
        let url = `/patient/getTabCounts?hospitalId=${hospitalId}&panelId=${panelId}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        return this.api.get(url);
    }

    getPatientsSummary(hospitalId: string) {
        return this.api.get(`/hospitals/getPanelsSummary/${hospitalId}`);
    }

    getAllPatientsOld() {
        return this.api.get("/patient/getAllPatients");
    }

    addPatient(patientData: {
        firstName: string;
        lastName?: string;
        phone: string;
        admittedAt?: string;
        hospitalId?: string;
        panelId?: string;
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

    generatePDF(id: string) {
        return this.api.get(`/uploads/generatePDF/${id}`);
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

    toggleUserStatus(userId: string, isActive: boolean) {
        return this.api.patch(`/user/${userId}/toggle-status`, { isActive });
    }

    // Get system stats for dashboard
    getSystemStats() {
        return this.api.get("/admin/stats");
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

    // Get patient photos from Google Drive (admin/superadmin only) — V1 Legacy
    getPatientPhotos(patientId: string) {
        return this.api.get(`/uploads/admin/photos/${patientId}`);
    }

    getThumbnailUrl(fileId: string) {
        return `${API_BASE_URL}/uploads/proxy/${fileId}`;
    }

    // Delete a file from Google Drive (admin/superadmin only) — V1 Legacy
    deleteFile(fileId: string) {
        return this.api.delete(`/uploads/admin/file/${fileId}`);
    }

    // ========== V2 S3 Upload Endpoints ==========

    // Upload photos to S3 (V2)
    uploadPhotosV2(patientId: string, files: File[], category?: string) {
        const formData = new FormData();
        formData.append("patientId", patientId);
        if (category) {
            formData.append("category", category);
        }
        files.forEach((file) => {
            formData.append("files", file);
        });

        return this.apiV2.post("/uploads/photos", formData, {
            headers: {
                "Content-Type": "multipart/form-data",
            },
        });
    }

    // Get photos with presigned S3 URLs (V2)
    getPhotosV2(patientId: string, category?: string) {
        const params = category ? `?category=${category}` : "";
        return this.apiV2.get(`/uploads/photos/${patientId}${params}`);
    }

    // Get photo metadata only - instant, no URL generation (V2)
    getPhotosMetaV2(patientId: string) {
        return this.apiV2.get(`/uploads/photos/${patientId}/meta`);
    }

    // Batch delete photos from S3 + Drive (V2)
    deletePhotosV2(patientId: string, fileIds: string[]) {
        return this.apiV2.delete(`/uploads/photos`, {
            data: { patientId, fileId: fileIds },
        });
    }

    // Get file counts per category (V2)
    getFileCountsV2(patientId: string) {
        return this.apiV2.get(`/uploads/getFileCounts/${patientId}`);
    }

    // Upload files as admin/superadmin (with optional category for subfolder)
    uploadFilesAsAdmin(patientId: string, files: File[], category?: string, customName?: string) {
        const formData = new FormData();
        formData.append("patientId", patientId);
        if (category) {
            formData.append("category", category);
        }
        if (customName) {
            formData.append("customName", customName);
        }
        files.forEach((file) => {
            formData.append("files", file);
        });

        return this.api.post("/uploads/admin/upload", formData, {
            headers: {
                "Content-Type": "multipart/form-data",
            },
        });
    }

    // ========== Hospital Management ==========

    // Get all hospitals (actual hospital entities, not users)
    getAllHospitals() {
        return this.api.get("/hospitals/getAllHospitals");
    }

    // Get a specific hospital by ID
    getHospitalById(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}`);
    }

    // Add a new hospital
    addHospital(data: { name: string; city: string; driveFolderId?: string }) {
        return this.api.post("/hospitals/addHospital", data);
    }

    // ========== Master Panel Management ==========

    // Get all master panels (insurance types)
    getAllMasterPanels() {
        return this.api.get("/hospitals/panel/all");
    }

    // Create a new master panel
    createMasterPanel(name: string) {
        return this.api.post("/hospitals/panel/create", { name });
    }

    // ========== Hospital Panel Linking ==========

    // Get panels linked to a hospital
    getHospitalPanels(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels`);
    }

    getHospitalPanelsDetailed(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels/details`);
    }

    // Link a panel to a hospital (creates drive folder, syncs permissions)
    linkPanelToHospital(data: {
        hospitalId: string;
        panelId: string;
        contact?: string;
        sheetId?: string;
        sheetName?: string;
        whatsAppGroupId?: string;
    }) {
        return this.api.post("/hospitals/addPanel", data);
    }

    // ========== Hospital User Management ==========

    // Get users assigned to a hospital
    getHospitalUsers(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/users`);
    }

    updateHospitalUserRole(hospitalId: string, userId: string, role: string[]) {
        return this.api.patch(`/hospitals/${hospitalId}/users/${userId}/role`, { role });
    }

    // Get current hospital user's hospital info (self-service)
    getMyHospital() {
        return this.api.get("/hospitals/my-hospital");
    }

    // Health Check
    getSystemHealth() {
        return this.api.get('/health');
    }
}

export default new ApiService();
