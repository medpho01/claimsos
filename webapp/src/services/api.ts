import axios, { AxiosInstance } from "axios";

// Dynamically construct API URLs based on environment and current host
const getApiBaseUrl = () => {
    if (process.env.NODE_ENV === "production") {
        return "/api/v1";
    }

    // For development, use the current host with port 6001 (docker backend port)
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:6001/api/v1`;
};

const getApiV2BaseUrl = () => {
    if (process.env.NODE_ENV === "production") {
        return "/api/v2";
    }

    // For development, use the current host with port 6001 (docker backend port)
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:6001/api/v2`;
};

const API_BASE_URL = getApiBaseUrl();
const API_V2_BASE_URL = getApiV2BaseUrl();

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
        // Add request interceptor to include auth token and handle FormData
        instance.interceptors.request.use(
            (config) => {
                const token = localStorage.getItem("accessToken");
                if (token) {
                    config.headers.Authorization = `Bearer ${token}`;
                }

                // CRITICAL: If request body is FormData, remove the default JSON Content-Type header
                // so axios can properly auto-detect and set multipart/form-data with boundary
                if (config.data instanceof FormData) {
                    // Delete the default "Content-Type: application/json" header
                    // axios will auto-detect FormData and set the proper multipart header
                    delete config.headers['Content-Type'];
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
    addHospital(data: { name: string; city: string; driveFolderId?: string; details?: any }) {
        return this.api.post("/hospitals/addHospital", data);
    }

    // Update hospital details
    updateHospital(hospitalId: string, data: { name?: string; city?: string; details?: any }) {
        return this.api.patch(`/hospitals/updateHospital/${hospitalId}`, data);
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

    // ========== Hospital Documents ==========

    uploadHospitalDocs(hospitalId: string, files: File[], category?: string, panelId?: string) {
        const formData = new FormData();
        formData.append("hospitalId", hospitalId);
        if (category) {
            formData.append("category", category);
        }
        if (panelId) {
            formData.append("panelId", panelId);
        }
        files.forEach((file) => {
            formData.append("files", file);
        });

        return this.api.post("/hospital-docs/upload", formData, {
            headers: {
                "Content-Type": "multipart/form-data",
            },
        });
    }

    getHospitalDocs(hospitalId: string, category?: string, panelId?: string) {
        let params = new URLSearchParams();
        if (category) params.append("category", category);
        if (panelId) params.append("panelId", panelId);
        const queryString = params.toString() ? `?${params.toString()}` : "";
        return this.api.get(`/hospital-docs/${hospitalId}${queryString}`);
    }

    deleteHospitalDoc(docId: string) {
        return this.api.delete(`/hospital-docs/${docId}`);
    }

    // ========== Hospital Doctors ==========

    getDoctors(hospitalId: string) {
        return this.api.get(`/doctors/hospital/${hospitalId}`);
    }

    addDoctor(data: {
        hospitalId: string;
        firstName: string;
        lastName?: string;
        age?: number;
        speciality?: string;
        phone?: string;
        yearsOfExp?: number;
    }) {
        return this.api.post('/doctors', data);
    }

    deleteDoctor(doctorId: string) {
        return this.api.delete(`/doctors/${doctorId}`);
    }

    uploadDoctorDoc(
        doctorId: string,
        file: File,
        meta: { documentName: string; documentCategory: string; documentType: string; attributeKey?: string }
    ) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("documentName", meta.documentName);
        formData.append("documentCategory", meta.documentCategory);
        formData.append("documentType", meta.documentType);
        if (meta.attributeKey) formData.append("attributeKey", meta.attributeKey);

        // The request interceptor strips the default JSON Content-Type so axios sets
        // multipart/form-data with proper boundary
        return this.api.post(`/doctors/${doctorId}/docs`, formData);
    }

    // Backward-compat: upload multiple files in sequence
    async uploadDoctorDocs(doctorId: string, files: File[], customNames: string[]) {
        const results: any[] = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i]!;
            const name = (customNames[i] && customNames[i]!.trim()) || file.name;
            const res = await this.uploadDoctorDoc(doctorId, file, {
                documentName: name,
                documentCategory: 'general',
                documentType: 'other',
            });
            results.push(res.data?.data);
        }
        return { data: { data: { documents: results, documentIds: results.map(r => r?.id).filter(Boolean) } } };
    }

    getDoctorDocs(doctorId: string) {
        return this.api.get(`/doctors/${doctorId}/docs`);
    }

    downloadDoctorDoc(doctorId: string, documentId: string) {
        return this.api.get(`/doctors/${doctorId}/docs/${documentId}/download`, {
            responseType: 'blob'
        });
    }

    deleteDoctorDoc(docId: string) {
        return this.api.delete(`/doctors/docs/${docId}`);
    }

    // ========== Hospital Profile Management ==========

    // Get hospital profile with all related data
    getHospitalProfile(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/profile`);
    }

    // Get hospital profile summary (quick view)
    getHospitalProfileSummary(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/profile/summary`);
    }

    // Update hospital profile
    updateHospitalProfile(hospitalId: string, data: any) {
        return this.api.put(`/hospitals/${hospitalId}/profile`, data);
    }

    // Get public hospital profile
    getPublicHospitalProfile(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/profile/public`);
    }

    // Publish/unpublish profile
    publishHospitalProfile(hospitalId: string, sections?: any) {
        return this.api.put(`/hospitals/${hospitalId}/profile/publish`, { sections });
    }

    unpublishHospitalProfile(hospitalId: string) {
        return this.api.put(`/hospitals/${hospitalId}/profile/unpublish`, {});
    }

    // Search hospitals
    searchHospitals(q: string, limit?: number) {
        return this.api.get(`/hospitals/search`, {
            params: { q, limit: limit || 20 }
        });
    }

    // ========== Attribute Management ==========

    // Get all attribute definitions
    getAttributeDefinitions(category?: string) {
        return this.api.get(`/attributes/definitions`, {
            params: category ? { category } : {}
        });
    }

    // Get single attribute definition
    getAttributeDefinition(key: string) {
        return this.api.get(`/attributes/definitions/${key}`);
    }

    // Get hospital attributes
    getHospitalAttributes(hospitalId: string, category?: string, status?: string) {
        const params: any = {};
        if (category) params.category = category;
        if (status) params.status = status;
        return this.api.get(`/hospitals/${hospitalId}/attributes`, { params });
    }

    // Get single hospital attribute
    getAttribute(hospitalId: string, attributeKey: string) {
        return this.api.get(`/hospitals/${hospitalId}/attributes/${attributeKey}`);
    }

    // Set attribute value
    setAttribute(hospitalId: string, attributeKey: string, data: any) {
        return this.api.post(`/hospitals/${hospitalId}/attributes/${attributeKey}`, data);
    }

    // Get unverified attributes
    getUnverifiedAttributes(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/attributes/status/unverified`);
    }

    // Get expiring attributes
    getExpiringAttributes(hospitalId: string, days?: number) {
        return this.api.get(`/hospitals/${hospitalId}/attributes/status/expiring`, {
            params: days ? { days } : {}
        });
    }

    // Get expired attributes
    getExpiredAttributes(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/attributes/status/expired`);
    }

    // Verify attribute
    verifyAttribute(hospitalId: string, attributeKey: string, method: string, notes?: string) {
        return this.api.put(`/hospitals/${hospitalId}/attributes/${attributeKey}/verify`, {
            method,
            notes
        });
    }

    // Reject attribute
    rejectAttribute(hospitalId: string, attributeKey: string, reason: string) {
        return this.api.put(`/hospitals/${hospitalId}/attributes/${attributeKey}/reject`, { reason });
    }

    // Update attribute by key (uses the same endpoint as setAttribute)
    updateAttribute(hospitalId: string, attributeKey: string, data: any) {
        return this.api.post(`/hospitals/${hospitalId}/attributes/${attributeKey}`, data);
    }

    // Delete attribute
    deleteAttribute(hospitalId: string, attributeKey: string) {
        return this.api.delete(`/hospitals/${hospitalId}/attributes/${attributeKey}`);
    }

    // Add document to attribute
    addDocumentToAttribute(hospitalId: string, attributeKey: string, documentId: string) {
        return this.api.post(`/hospitals/${hospitalId}/attributes/${attributeKey}/documents`, {
            documentId
        });
    }

    // Remove document from attribute
    removeDocumentFromAttribute(hospitalId: string, attributeKey: string, documentId: string) {
        return this.api.delete(`/hospitals/${hospitalId}/attributes/${attributeKey}/documents/${documentId}`);
    }

    // Set document as primary for attribute
    setPrimaryDocument(hospitalId: string, attributeKey: string, documentId: string) {
        return this.api.put(`/hospitals/${hospitalId}/attributes/${attributeKey}/documents/${documentId}/primary`);
    }

    // ========== Panel Attribute Management ==========

    // Get all panel attribute definitions
    getPanelAttributeDefinitions(category?: string) {
        return this.api.get(`/admin/panel-attributes/definitions`, {
            params: category ? { category } : {}
        });
    }

    // Get panel attribute definitions grouped by category
    getPanelAttributeDefinitionsByCategory() {
        return this.api.get(`/admin/panel-attributes/definitions/by-category`);
    }

    // Get single panel attribute definition
    getPanelAttributeDefinition(id: string) {
        return this.api.get(`/admin/panel-attributes/definitions/${id}`);
    }

    // Get panel attributes for hospital-panel relationship
    getPanelAttributes(hospitalId: string, panelId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels/${panelId}/attributes`);
    }

    // Get single panel attribute
    getPanelAttribute(hospitalId: string, panelId: string, attributeId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}`);
    }

    // Set/create panel attribute value
    setPanelAttribute(hospitalId: string, panelId: string, data: any) {
        return this.api.post(`/hospitals/${hospitalId}/panels/${panelId}/attributes`, data);
    }

    // Update panel attribute value
    updatePanelAttribute(hospitalId: string, panelId: string, attributeId: string, data: any) {
        return this.api.put(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}`, data);
    }

    // Delete panel attribute
    deletePanelAttribute(hospitalId: string, panelId: string, attributeId: string) {
        return this.api.delete(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}`);
    }

    // Set multiple panel attributes at once
    setMultiplePanelAttributes(hospitalId: string, panelId: string, attributes: any[]) {
        return this.api.post(`/hospitals/${hospitalId}/panels/${panelId}/attributes/bulk`, { attributes });
    }

    // Get complete panel information with all attributes
    getCompletePanelInfo(hospitalId: string, panelId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels/${panelId}/details`);
    }

    // ========== Panel Attribute Document Management ==========

    // Get documents for panel attribute
    getPanelAttributeDocuments(hospitalId: string, panelId: string, attributeId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents`);
    }

    // Get single document for panel attribute
    getPanelAttributeDocument(hospitalId: string, panelId: string, attributeId: string, docId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents/${docId}`);
    }

    // Add document to panel attribute
    addPanelAttributeDocument(hospitalId: string, panelId: string, attributeId: string, documentId: string, metadata?: any) {
        return this.api.post(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents`, {
            document_id: documentId,
            ...metadata
        });
    }

    // Update panel attribute document metadata
    updatePanelAttributeDocument(hospitalId: string, panelId: string, attributeId: string, docId: string, metadata?: any) {
        return this.api.put(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents/${docId}`, metadata);
    }

    // Remove document from panel attribute
    removePanelAttributeDocument(hospitalId: string, panelId: string, attributeId: string, docId: string) {
        return this.api.delete(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents/${docId}`);
    }

    // Set document as primary for panel attribute
    setPanelAttributeDocumentPrimary(hospitalId: string, panelId: string, attributeId: string, docId: string) {
        return this.api.put(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents/${docId}/primary`);
    }

    // Get expiring documents for panel attribute
    getExpiringPanelAttributeDocuments(hospitalId: string, panelId: string, attributeId: string, withinDays?: number) {
        return this.api.get(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents/expiring`, {
            params: withinDays ? { withinDays } : {}
        });
    }

    // Get expired documents for panel attribute
    getExpiredPanelAttributeDocuments(hospitalId: string, panelId: string, attributeId: string) {
        return this.api.get(`/hospitals/${hospitalId}/panels/${panelId}/attributes/${attributeId}/documents/expired`);
    }

    // ========== Document Management ==========

    // Upload document
    uploadDocument(hospitalId: string, formData: FormData) {
        return this.api.post(`/hospitals/${hospitalId}/documents/upload`, formData, {
            headers: {
                "Content-Type": "multipart/form-data",
            },
        });
    }

    // Get hospital documents
    getHospitalDocuments(hospitalId: string, category?: string, type?: string, attributeKey?: string) {
        const params: any = {};
        if (category) params.category = category;
        if (type) params.type = type;
        if (attributeKey) params.attributeKey = attributeKey;
        return this.api.get(`/hospitals/${hospitalId}/documents`, { params });
    }

    // Get single document
    getDocument(hospitalId: string, documentId: string) {
        return this.api.get(`/hospitals/${hospitalId}/documents/${documentId}`);
    }

    // Download document
    downloadDocument(hospitalId: string, documentId: string) {
        return this.api.get(`/hospitals/${hospitalId}/documents/${documentId}/download`, {
            responseType: 'blob'
        });
    }

    // Update document
    updateDocument(hospitalId: string, documentId: string, data: any) {
        return this.api.put(`/hospitals/${hospitalId}/documents/${documentId}`, data);
    }

    // Delete document
    deleteDocument(hospitalId: string, documentId: string) {
        return this.api.delete(`/hospitals/${hospitalId}/documents/${documentId}`);
    }

    // Submit for extraction
    submitForExtraction(hospitalId: string, documentId: string, autoApply?: boolean) {
        return this.api.post(`/hospitals/${hospitalId}/documents/${documentId}/extract`, { autoApply });
    }

    // Get extraction results
    getExtraction(hospitalId: string, documentId: string) {
        return this.api.get(`/hospitals/${hospitalId}/documents/${documentId}/extraction`);
    }

    // Approve extraction
    approveExtraction(hospitalId: string, documentId: string, mappings: any) {
        return this.api.post(`/hospitals/${hospitalId}/documents/${documentId}/extraction/approve`, { mappings });
    }

    // Link document to attribute
    linkDocumentToAttribute(hospitalId: string, documentId: string, attributeKey: string) {
        return this.api.put(`/hospitals/${hospitalId}/documents/${documentId}/link/${attributeKey}`, {});
    }

    // Get storage usage
    getStorageUsage(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/documents/storage-usage`);
    }

    // ========== Verification Management ==========

    // Get verification dashboard
    getVerificationDashboard(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/verification/dashboard`);
    }

    // Get verification checklist
    getVerificationChecklist(hospitalId: string, type?: string) {
        return this.api.get(`/hospitals/${hospitalId}/verification/checklist`, {
            params: type ? { type } : {}
        });
    }

    // Get verification progress
    getVerificationProgress(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/verification/progress`);
    }

    // Submit for verification
    submitForVerification(hospitalId: string) {
        return this.api.post(`/hospitals/${hospitalId}/verification/submit`, {});
    }

    // Submit evidence
    submitEvidence(hospitalId: string, data: any) {
        return this.api.post(`/hospitals/${hospitalId}/verification/evidence`, data);
    }

    // Get attribute evidence
    getAttributeEvidence(hospitalId: string, attributeId: string) {
        return this.api.get(`/hospitals/${hospitalId}/verification/evidence/${attributeId}`);
    }

    // Review evidence
    reviewEvidence(hospitalId: string, evidenceId: string, status: string, notes?: string) {
        return this.api.put(`/hospitals/${hospitalId}/verification/evidence/${evidenceId}`, {
            status,
            notes
        });
    }

    // Get pending review items
    getPendingReview(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/verification/pending`);
    }

    // ========== Public Sharing ==========

    // Generate share link
    generateShareLink(hospitalId: string, data: any) {
        return this.api.post(`/hospitals/${hospitalId}/shares`, data);
    }

    // Get share links for hospital
    getShareLinks(hospitalId: string) {
        return this.api.get(`/hospitals/${hospitalId}/shares`);
    }

    // Update share link
    updateShareLink(hospitalId: string, shareId: string, data: any) {
        return this.api.put(`/hospitals/${hospitalId}/shares/${shareId}`, data);
    }

    // Revoke share link
    revokeShareLink(hospitalId: string, shareId: string) {
        return this.api.delete(`/hospitals/${hospitalId}/shares/${shareId}`);
    }

    // Access shared profile (public, no auth required)
    accessSharedProfile(token: string) {
        return axios.get(`${API_BASE_URL}/share/${token}`);
    }

    // Get public hospital directory
    getPublicHospitalDirectory(page?: number, limit?: number, search?: string, verification?: string) {
        const params: any = {};
        if (page) params.page = page;
        if (limit) params.limit = limit;
        if (search) params.search = search;
        if (verification) params.verification = verification;
        return this.api.get(`/hospitals/public/directory`, { params });
    }

    // ========== Doctor Management ==========

    // Get doctor profile
    getDoctor(doctorId: string) {
        return this.api.get(`/doctors/${doctorId}`);
    }

    // Update doctor personal information
    updateDoctor(doctorId: string, data: any) {
        return this.api.put(`/admin/doctors/${doctorId}`, data);
    }

    // Get hospital doctor relationship
    getHospitalDoctor(hospitalId: string, doctorId: string) {
        return this.api.get(`/hospitals/${hospitalId}/doctors/${doctorId}`);
    }

    // Update hospital doctor relationship
    updateHospitalDoctor(hospitalId: string, doctorId: string, data: any) {
        return this.api.put(`/hospitals/${hospitalId}/doctors/${doctorId}`, data);
    }

    // ========== Doctor Attribute Definitions ==========

    // Get doctor attribute definitions (grouped by category)
    getDoctorAttributeDefinitionsGrouped() {
        return this.api.get(`/admin/doctor-attributes/definitions/grouped`);
    }

    // Get doctor attribute definitions
    getDoctorAttributeDefinitions(category?: string) {
        return this.api.get(`/admin/doctor-attributes/definitions`, {
            params: category ? { category } : {}
        });
    }

    // ========== Doctor Attributes (Credentials) ==========

    // Get doctor attributes
    getDoctorAttributes(doctorId: string, category?: string) {
        return this.api.get(`/doctors/${doctorId}/attributes`, {
            params: category ? { category } : {}
        });
    }

    // Get single doctor attribute
    getDoctorAttribute(doctorId: string, attributeId: string) {
        return this.api.get(`/doctors/${doctorId}/attributes/${attributeId}`);
    }

    // Set/update doctor attribute
    setDoctorAttribute(doctorId: string, attributeKey: string, data: any) {
        return this.api.post(`/doctors/${doctorId}/attributes/${attributeKey}`, data);
    }

    // Delete doctor attribute
    deleteDoctorAttribute(doctorId: string, attributeId: string) {
        return this.api.delete(`/doctors/${doctorId}/attributes/${attributeId}`);
    }

    // ========== Doctor Attribute Document Management ==========

    // Add document to doctor attribute
    addAttributeDocument(doctorId: string, attributeId: string, file: File) {
        const formData = new FormData();
        formData.append('file', file);
        return this.api.post(`/doctors/${doctorId}/attributes/${attributeId}/documents`, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
    }

    // Add document to doctor attribute by ID (legacy)
    addDoctorAttributeDocument(doctorId: string, attributeId: string, documentId: string) {
        return this.api.post(`/doctors/${doctorId}/attributes/${attributeId}/documents`, {
            documentId
        });
    }

    // Remove document from doctor attribute
    removeAttributeDocument(doctorId: string, attributeId: string, documentId: string) {
        return this.api.delete(`/doctors/${doctorId}/attributes/${attributeId}/documents/${documentId}`);
    }

    // Remove document from doctor attribute (legacy)
    removeDoctorAttributeDocument(doctorId: string, attributeId: string, documentId: string) {
        return this.api.delete(`/doctors/${doctorId}/attributes/${attributeId}/documents/${documentId}`);
    }

    // ========== Generic REST Methods for Dynamic Endpoints ==========

    // Generic GET method
    get(url: string, config?: any) {
        return this.api.get(url, config);
    }

    // Generic POST method
    post(url: string, data?: any, config?: any) {
        return this.api.post(url, data, config);
    }

    // Generic PUT method
    put(url: string, data?: any, config?: any) {
        return this.api.put(url, data, config);
    }

    // Generic PATCH method
    patch(url: string, data?: any, config?: any) {
        return this.api.patch(url, data, config);
    }

    // Generic DELETE method
    delete(url: string, config?: any) {
        return this.api.delete(url, config);
    }
}

export default new ApiService();
