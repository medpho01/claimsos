import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface AddDoctorInput {
  hospitalId: string;
  doctorId: string;
  employmentType: string;
  department?: string;
  specialization?: string;
  designation?: string;
  startDate?: string;
  endDate?: string;
  employeeId?: string;
  notes?: string;
  hospitalPhone?: string;
  hospitalEmail?: string;
}

interface UpdateDoctorInput {
  employmentType?: string;
  department?: string;
  specialization?: string;
  designation?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  employeeId?: string;
  notes?: string;
  hospitalPhone?: string;
  hospitalEmail?: string;
}

class HospitalDoctorService {
  /**
   * Add doctor to hospital
   */
  async addDoctorToHospital(input: AddDoctorInput) {
    const {
      hospitalId,
      doctorId,
      employmentType,
      department,
      specialization,
      designation,
      startDate,
      endDate,
      employeeId,
      notes,
      hospitalPhone,
      hospitalEmail
    } = input;

    // Verify hospital exists
    const hospitalRes = await pool.query(
      `SELECT id FROM hospital.hospitals WHERE id = $1`,
      [hospitalId]
    );

    if (hospitalRes.rows.length === 0) {
      throw new apiError(404, 'Hospital not found');
    }

    // Verify doctor exists
    const doctorRes = await pool.query(
      `SELECT id FROM hospital.doctors WHERE id = $1`,
      [doctorId]
    );

    if (doctorRes.rows.length === 0) {
      throw new apiError(404, 'Doctor not found');
    }

    // Check if doctor already in hospital
    const existingRes = await pool.query(
      `SELECT id FROM hospital.hospital_doctors WHERE hospital_id = $1 AND doctor_id = $2`,
      [hospitalId, doctorId]
    );

    if (existingRes.rows.length > 0) {
      throw new apiError(409, 'Doctor already associated with this hospital');
    }

    const result = await pool.query(
      `INSERT INTO hospital.hospital_doctors (
        hospital_id,
        doctor_id,
        employment_type,
        department,
        specialization,
        designation,
        start_date,
        end_date,
        employee_id,
        notes,
        hospital_phone,
        hospital_email
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        hospitalId,
        doctorId,
        employmentType,
        department || null,
        specialization || null,
        designation || null,
        startDate || null,
        endDate || null,
        employeeId || null,
        notes || null,
        hospitalPhone || null,
        hospitalEmail || null
      ]
    );

    return this.formatHospitalDoctorResponse(result.rows[0]);
  }

  /**
   * Get hospital-doctor relationship
   */
  async getHospitalDoctor(hospitalId: string, doctorId: string) {
    const result = await pool.query(
      `SELECT hd.*, d.*
       FROM hospital.hospital_doctors hd
       JOIN hospital.doctors d ON hd.doctor_id = d.id
       WHERE hd.hospital_id = $1 AND hd.doctor_id = $2`,
      [hospitalId, doctorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Hospital-doctor relationship not found');
    }

    return this.formatHospitalDoctorResponse(result.rows[0]);
  }

  /**
   * Update hospital-doctor information
   */
  async updateHospitalDoctorInfo(
    hospitalId: string,
    doctorId: string,
    updates: UpdateDoctorInput
  ) {
    const updateFields = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.employmentType) {
      updateFields.push(`employment_type = $${paramIndex++}`);
      values.push(updates.employmentType);
    }

    if (updates.department !== undefined) {
      updateFields.push(`department = $${paramIndex++}`);
      values.push(updates.department);
    }

    if (updates.specialization !== undefined) {
      updateFields.push(`specialization = $${paramIndex++}`);
      values.push(updates.specialization);
    }

    if (updates.designation !== undefined) {
      updateFields.push(`designation = $${paramIndex++}`);
      values.push(updates.designation);
    }

    if (updates.startDate !== undefined) {
      updateFields.push(`start_date = $${paramIndex++}`);
      values.push(updates.startDate);
    }

    if (updates.endDate !== undefined) {
      updateFields.push(`end_date = $${paramIndex++}`);
      values.push(updates.endDate);
    }

    if (updates.status) {
      updateFields.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }

    if (updates.employeeId !== undefined) {
      updateFields.push(`employee_id = $${paramIndex++}`);
      values.push(updates.employeeId);
    }

    if (updates.notes !== undefined) {
      updateFields.push(`notes = $${paramIndex++}`);
      values.push(updates.notes);
    }

    if (updates.hospitalPhone !== undefined) {
      updateFields.push(`hospital_phone = $${paramIndex++}`);
      values.push(updates.hospitalPhone);
    }

    if (updates.hospitalEmail !== undefined) {
      updateFields.push(`hospital_email = $${paramIndex++}`);
      values.push(updates.hospitalEmail);
    }

    if (updateFields.length === 0) {
      return await this.getHospitalDoctor(hospitalId, doctorId);
    }

    updateFields.push(`updated_at = NOW()`);
    values.push(hospitalId);
    values.push(doctorId);

    const result = await pool.query(
      `UPDATE hospital.hospital_doctors
       SET ${updateFields.join(', ')}
       WHERE hospital_id = $${paramIndex++} AND doctor_id = $${paramIndex++}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Hospital-doctor relationship not found');
    }

    return this.formatHospitalDoctorResponse(result.rows[0]);
  }

  /**
   * Remove doctor from hospital
   */
  async removeDoctorFromHospital(hospitalId: string, doctorId: string) {
    const result = await pool.query(
      `DELETE FROM hospital.hospital_doctors
       WHERE hospital_id = $1 AND doctor_id = $2
       RETURNING id`,
      [hospitalId, doctorId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Hospital-doctor relationship not found');
    }

    return { deleted: true };
  }

  /**
   * Get all doctors for a hospital (with doctor attributes)
   */
  async getHospitalDoctorsWithAttributes(hospitalId: string) {
    const result = await pool.query(
      `SELECT hd.*, d.*
       FROM hospital.hospital_doctors hd
       JOIN hospital.doctors d ON hd.doctor_id = d.id
       WHERE hd.hospital_id = $1 AND hd.status = 'active'
       ORDER BY d.first_name, d.last_name`,
      [hospitalId]
    );

    // Get attributes for each doctor
    const doctorsWithAttrs = await Promise.all(
      result.rows.map(async (row) => {
        const attrsRes = await pool.query(
          `SELECT da.*, dad.label, dad.category
           FROM hospital.doctor_attributes da
           LEFT JOIN hospital.doctor_attribute_definitions dad ON da.attribute_key = dad.key
           WHERE da.doctor_id = $1
           ORDER BY dad.category`,
          [row.doctor_id]
        );

        return {
          ...this.formatHospitalDoctorResponse(row),
          attributes: attrsRes.rows.map(attr => ({
            id: attr.id,
            attributeKey: attr.attribute_key,
            label: attr.label,
            category: attr.category,
            verificationStatus: attr.verification_status,
            expiresAt: attr.expires_at
          }))
        };
      })
    );

    return doctorsWithAttrs;
  }

  /**
   * Format hospital-doctor response
   */
  private formatHospitalDoctorResponse(raw: any) {
    return {
      id: raw.id,
      hospital_id: raw.hospital_id,
      doctor_id: raw.doctor_id,
      employment_type: raw.employment_type,
      department: raw.department,
      specialization: raw.specialization,
      designation: raw.designation,
      start_date: raw.start_date,
      end_date: raw.end_date,
      status: raw.status,
      employee_id: raw.employee_id,
      notes: raw.notes,
      hospital_phone: raw.hospital_phone,
      hospital_email: raw.hospital_email,
      // Nested doctor object with doctor's personal info
      doctor: {
        id: raw.doctor_id,
        first_name: raw.first_name,
        last_name: raw.last_name,
        email: raw.email,
        phone: raw.phone,
        nmc_registration_number: raw.nmc_registration_number,
        primary_specialization: raw.primary_specialization
      }
    };
  }
}

export default new HospitalDoctorService();
