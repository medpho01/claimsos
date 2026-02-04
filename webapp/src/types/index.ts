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

// New: Actual Hospital entity (not a user)
export interface Hospital {
    id: string;
    name: string;
    city?: string;
    drive_folder_id: string;
    created_at?: string;
    updated_at?: string;
}

// New: Master Panel (insurance/scheme type)
export interface Panel {
    id: string;
    name: string;
    created_at?: string;
}

// New: Panel linked to a hospital
export interface HospitalPanel {
    id: string;
    hospital_id: string;
    panel_id: string;
    panel_name?: string; // Joined from panels table
    whatsapp_group_id?: string;
    sheet_id?: string;
    sheet_name?: string;
    drive_folder_id?: string;
    contact?: string;
    total_count?:string|number;
}

// New: Hospital employee with panel access
export interface HospitalUser {
    hospital_id: string;
    user_id: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    role: string[]; // Array of panel IDs this user can access
    is_active?: boolean;
}

// New: Hospital user's hospital info (from getMyHospital)
export interface MyHospitalInfo {
    hospital_id: string;
    role: string[]; // Panel IDs user has access to
    name: string;
    city?: string;
    drive_folder_id: string;
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
    is_active: boolean;
    // Panel info
    panel_id?: string;
    hospital_panel_id?: string;
    panel_name?: string; // Joined
    beneficiary_id?: string;
    // Legacy PMJAY fields (now in claims)
    pmjay_case_number?: string;
    scheme?: string;
    treatment_procedure?: string;
    latest_status?: string;
    claim_amount?: number;
    // Claims fields
    treatment_plan?: string;
    claim_approved?: number;
    incentive?: number;
    deduction?: number;
    deduction_reason?: string;
    claim_settled?: number;
    claim_settled_date?: string;
    // Metadata
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
    hospital_id: string;
    name?:string;
    admin_id: string;
    assigned_by: string;
    can_view: boolean;
    can_edit: boolean;
    can_discharge: boolean;
    assigned_at: string;
    role: string[]; // Array of permission roles
}

