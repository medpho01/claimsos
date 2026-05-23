import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface OverrideAttributeInput {
  hospitalDoctorId: string;
  doctorAttributeId: string;
  valueText?: string;
  valueDate?: string;
  valueBoolean?: boolean;
  verificationStatus?: string;
  notes?: string;
}

class HospitalDoctorAttributeService {
  /**
   * Override attribute for hospital-doctor relationship
   */
  async overrideAttribute(input: OverrideAttributeInput) {
    const {
      hospitalDoctorId,
      doctorAttributeId,
      valueText,
      valueDate,
      valueBoolean,
      verificationStatus,
      notes
    } = input;

    // Verify hospital_doctor exists
    const hdRes = await pool.query(
      `SELECT id FROM hospital_doctors WHERE id = $1`,
      [hospitalDoctorId]
    );

    if (hdRes.rows.length === 0) {
      throw new apiError(404, 'Hospital-doctor relationship not found');
    }

    // Verify doctor_attribute exists
    const daRes = await pool.query(
      `SELECT id FROM doctor_attributes WHERE id = $1`,
      [doctorAttributeId]
    );

    if (daRes.rows.length === 0) {
      throw new apiError(404, 'Doctor attribute not found');
    }

    const result = await pool.query(
      `INSERT INTO hospital_doctor_attributes (
        hospital_doctor_id,
        doctor_attribute_id,
        override_value_text,
        override_value_date,
        override_value_boolean,
        hospital_verification_status,
        hospital_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (hospital_doctor_id, doctor_attribute_id)
      DO UPDATE SET
        override_value_text = $3,
        override_value_date = $4,
        override_value_boolean = $5,
        hospital_verification_status = $6,
        hospital_notes = $7,
        updated_at = NOW()
      RETURNING *`,
      [
        hospitalDoctorId,
        doctorAttributeId,
        valueText || null,
        valueDate || null,
        valueBoolean !== undefined ? valueBoolean : null,
        verificationStatus || null,
        notes || null
      ]
    );

    return this.formatOverrideResponse(result.rows[0]);
  }

  /**
   * Get hospital-specific attributes for a hospital-doctor
   */
  async getHospitalSpecificAttributes(hospitalDoctorId: string) {
    const result = await pool.query(
      `SELECT hda.*, da.attribute_key, dad.label, dad.category
       FROM hospital_doctor_attributes hda
       JOIN doctor_attributes da ON hda.doctor_attribute_id = da.id
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       WHERE hda.hospital_doctor_id = $1
       ORDER BY dad.category`,
      [hospitalDoctorId]
    );

    return result.rows.map(override => ({
      ...this.formatOverrideResponse(override),
      attributeKey: override.attribute_key,
      label: override.label,
      category: override.category
    }));
  }

  /**
   * Get hospital override for specific attribute
   */
  async getHospitalAttributeOverride(hospitalDoctorId: string, doctorAttributeId: string) {
    const result = await pool.query(
      `SELECT hda.*, da.attribute_key, dad.label, da.value_text as global_value_text
       FROM hospital_doctor_attributes hda
       JOIN doctor_attributes da ON hda.doctor_attribute_id = da.id
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       WHERE hda.hospital_doctor_id = $1 AND hda.doctor_attribute_id = $2`,
      [hospitalDoctorId, doctorAttributeId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Hospital attribute override not found');
    }

    return {
      ...this.formatOverrideResponse(result.rows[0]),
      attributeKey: result.rows[0].attribute_key,
      label: result.rows[0].label,
      globalValue: result.rows[0].global_value_text
    };
  }

  /**
   * Remove hospital override (revert to global attribute)
   */
  async removeOverride(hospitalDoctorId: string, doctorAttributeId: string) {
    const result = await pool.query(
      `DELETE FROM hospital_doctor_attributes
       WHERE hospital_doctor_id = $1 AND doctor_attribute_id = $2
       RETURNING id`,
      [hospitalDoctorId, doctorAttributeId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Hospital attribute override not found');
    }

    return { deleted: true };
  }

  /**
   * Get all overrides for a hospital
   */
  async getHospitalOverrides(hospitalId: string) {
    const result = await pool.query(
      `SELECT hda.*, hd.hospital_id, da.attribute_key, dad.label, d.first_name, d.last_name
       FROM hospital_doctor_attributes hda
       JOIN hospital_doctors hd ON hda.hospital_doctor_id = hd.id
       JOIN doctor_attributes da ON hda.doctor_attribute_id = da.id
       LEFT JOIN doctor_attribute_definitions dad ON da.attribute_key = dad.key
       JOIN doctors d ON da.doctor_id = d.id
       WHERE hd.hospital_id = $1
       ORDER BY d.first_name, d.last_name, dad.category`,
      [hospitalId]
    );

    // Group by doctor
    const grouped: Record<string, any[]> = {};
    result.rows.forEach(override => {
      const doctorKey = `${override.first_name} ${override.last_name} (${override.doctor_id})`;
      if (!grouped[doctorKey]) {
        grouped[doctorKey] = [];
      }
      grouped[doctorKey].push({
        ...this.formatOverrideResponse(override),
        attributeKey: override.attribute_key,
        label: override.label
      });
    });

    return { overrides: result.rows, grouped };
  }

  /**
   * Format override response
   */
  private formatOverrideResponse(raw: any) {
    return {
      id: raw.id,
      hospitalDoctorId: raw.hospital_doctor_id,
      doctorAttributeId: raw.doctor_attribute_id,
      overrideValueText: raw.override_value_text,
      overrideValueDate: raw.override_value_date,
      overrideValueBoolean: raw.override_value_boolean,
      hospitalVerificationStatus: raw.hospital_verification_status,
      hospitalVerifiedBy: raw.hospital_verified_by,
      hospitalVerifiedAt: raw.hospital_verified_at,
      hospitalNotes: raw.hospital_notes,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at
    };
  }
}

export default new HospitalDoctorAttributeService();
