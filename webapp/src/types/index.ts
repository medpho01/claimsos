export interface User {
    id: string;
    username: string;
    email: string;
    first_name: string;
    last_name: string;
    phone: string;
    role: "superadmin" | "admin" | "hospital";
    folder_id: string;
    is_active: boolean;
    created_at?: string;
}

export interface Patient {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    hospital_id: string;
    admission_type?: 'conservative' | 'surgical';
    admitted_at: string;
    discharged_at: string | null;
    folder_id: string;
    created_at: string;
    updated_at: string;
    // Hospital info for admins
    hospital_first_name?: string;
    hospital_last_name?: string;
    can_view?: boolean;
    can_edit?: boolean;
    can_discharge?: boolean;
}

export interface LoginResponse {
    accessToken: string;
    refreshToken: string;
    user: User;
}

export interface ApiResponse<T> {
    statusCode: number;
    data: T;
    message: string;
    success: boolean;
}

export interface HospitalAssignment {
    id: string;
    admin_id: string;
    hospital_id: string;
    assigned_by: string;
    can_view: boolean;
    can_edit: boolean;
    can_discharge: boolean;
    assigned_at: string;
    is_active: boolean;
}
