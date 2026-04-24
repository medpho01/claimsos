// TypeScript interfaces for the tabbed doctor details modal

export interface DoctorPersonalInfo {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  primary_specialization?: string;
  nmc_registration_number?: string;
  registration_status?: string;
}

export interface HospitalDoctorAssignment {
  id: string;
  hospital_id: string;
  doctor_id: string;
  employment_type: 'fulltime' | 'parttime' | 'consultant' | 'visiting' | 'resident' | 'associate' | 'empanelled';
  department: string;
  specialization?: string;
  designation?: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  employee_id?: string;
  hospital_phone?: string;
  hospital_email?: string;
  notes?: string;
}

export interface DoctorAttribute {
  id: string;
  doctor_id: string;
  attribute_key: string;
  label?: string;
  category?: string;
  data_type?: 'text' | 'date' | 'boolean' | 'document' | 'textarea';
  value_text?: string;
  value_date?: string;
  value_boolean?: boolean;
  certificate_number?: string;
  issuing_authority?: string;
  issued_at?: string;
  expires_at?: string;
  verification_status?: string;
  documents?: AttributeDocument[];
}

export interface AttributeDocument {
  id: string;
  document_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  is_primary?: boolean;
}

export interface AttributeDefinition {
  id: string;
  key: string;
  label: string;
  category: string;
  data_type: 'text' | 'date' | 'boolean' | 'document' | 'textarea';
  is_required: boolean;
  has_expiry: boolean;
  requires_document: boolean;
  can_verify_by_document?: boolean;
  description?: string;
  is_active?: boolean;
}

export interface AttributeDefinitionsGrouped {
  [category: string]: AttributeDefinition[];
}

export interface TabStatus {
  isDirty: boolean;
  isSaving: boolean;
  error: string | null;
  success: boolean;
}

export interface PersonalInfoFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  primarySpecialization: string;
}

export interface HospitalAssignmentFormData {
  employmentType: string;
  department: string;
  designation: string;
  specialization: string;
  startDate: string;
  endDate: string;
  status: string;
  employeeId: string;
  hospitalPhone: string;
  hospitalEmail: string;
  notes: string;
}

export interface CredentialFormData {
  attributeKey: string;
  valueText: string;
  valueDate: string;
  valueBoolean: boolean;
  certificateNumber: string;
  issuingAuthority: string;
  issuedAt: string;
  expiresAt: string;
}
