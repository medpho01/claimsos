import { pool } from '../DB/db.js';
import apiError from '../Utils/errorHandler.util.js';

interface HospitalProfileInput {
  hospitalId: string;
  legalName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  district?: string;
  state?: string;
  pincode?: string;
  website?: string;
  email?: string;
  phone?: string;
  hospitalType?: string;
  specialties?: string[];
  verificationLevel?: string;
  isPublicProfileEnabled?: boolean;
}

class HospitalProfileService {
  /**
   * Get or create hospital profile
   */
  async getOrCreateProfile(hospitalId: string) {
    try {
      process.stderr.write(`[DEBUG] getOrCreateProfile called with ${hospitalId}\n`);
      const result = await pool.query(
        `SELECT * FROM hospital.hospital_profile WHERE hospital_id = $1`,
        [hospitalId]
      );
      process.stderr.write(`[DEBUG] Query returned ${result.rows.length} rows\n`);

      if (result.rows.length > 0) {
        return result.rows[0];
      }

      // Create new profile if it doesn't exist
      process.stderr.write(`[DEBUG] Creating new profile for ${hospitalId}\n`);
      const newProfile = await pool.query(
        `INSERT INTO hospital.hospital_profile (hospital_id)
         VALUES ($1) RETURNING *`,
        [hospitalId]
      );
      process.stderr.write(`[DEBUG] New profile created\n`);

      return newProfile.rows[0];
    } catch (err) {
      process.stderr.write(`[ERROR] getOrCreateProfile failed: ${err instanceof Error ? err.message : String(err)}\n`);
      throw err;
    }
  }

  /**
   * Get hospital profile with all related data
   */
  async getFullProfile(hospitalId: string) {
    const profile = await this.getOrCreateProfile(hospitalId);

    // Get hospital basic info
    let hospitalRes: { rows: any[] } = { rows: [{ id: hospitalId, name: '', city: '' }] };
    try {
      hospitalRes = await pool.query(
        `SELECT id, name, city FROM hospital.hospitals WHERE id = $1`,
        [hospitalId]
      );
    } catch (err) {
      console.error('Error fetching hospital info:', err);
    }

    // Get all attributes
    let attributesRes: { rows: any[] } = { rows: [] };
    try {
      attributesRes = await pool.query(
        `SELECT ha.*, ad.label, ad.category, ad.data_type
         FROM hospital.hospital_attributes ha
         LEFT JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
         WHERE ha.hospital_id = $1
         ORDER BY ad.category, ad.sort_order`,
        [hospitalId]
      );
    } catch (err) {
      console.error('Error fetching attributes:', err);
    }

    // Get key contacts
    let contactsRes: { rows: any[] } = { rows: [] };
    try {
      contactsRes = await pool.query(
        `SELECT * FROM hospital.hospital_key_contacts
         WHERE hospital_id = $1
         ORDER BY is_primary DESC, contact_type`,
        [hospitalId]
      );
    } catch (err) {
      console.error('Error fetching contacts:', err);
    }

    // Get panel empanelments
    let panelsRes: { rows: any[] } = { rows: [] };
    try {
      panelsRes = await pool.query(
        `SELECT pe.*, p.name as panel_name
         FROM hospital.panel_empanelments pe
         LEFT JOIN hospital.panels p ON pe.panel_id = p.id
         WHERE pe.hospital_id = $1
         ORDER BY pe.empanelment_status DESC`,
        [hospitalId]
      );
    } catch (err) {
      console.error('Error fetching panels:', err);
    }

    return {
      profile,
      hospital: hospitalRes.rows[0],
      attributes: attributesRes.rows,
      contacts: contactsRes.rows,
      panels: panelsRes.rows,
      verificationStatus: profile.verification_status,
      isPublic: profile.is_public_profile_enabled
    };
  }

  /**
   * Update hospital profile
   */
  async updateProfile(hospitalId: string, input: any) {
    const updates = [];
    const values = [];
    let paramIndex = 1;

    // Handle both camelCase and snake_case field names
    const data = input;

    if (data.legal_name !== undefined || data.legalName !== undefined) {
      updates.push(`legal_name = $${paramIndex++}`);
      values.push(data.legal_name || data.legalName);
    }
    if (data.address_line1 !== undefined || data.addressLine1 !== undefined) {
      updates.push(`address_line1 = $${paramIndex++}`);
      values.push(data.address_line1 || data.addressLine1);
    }
    if (data.address_line2 !== undefined || data.addressLine2 !== undefined) {
      updates.push(`address_line2 = $${paramIndex++}`);
      values.push(data.address_line2 || data.addressLine2);
    }
    if (data.city !== undefined) {
      updates.push(`city = $${paramIndex++}`);
      values.push(data.city);
    }
    if (data.district !== undefined) {
      updates.push(`district = $${paramIndex++}`);
      values.push(data.district);
    }
    if (data.state !== undefined) {
      updates.push(`state = $${paramIndex++}`);
      values.push(data.state);
    }
    if (data.pincode !== undefined) {
      updates.push(`pincode = $${paramIndex++}`);
      values.push(data.pincode);
    }
    if (data.website !== undefined) {
      updates.push(`website = $${paramIndex++}`);
      values.push(data.website);
    }
    if (data.email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      values.push(data.email);
    }
    if (data.phone !== undefined) {
      updates.push(`phone = $${paramIndex++}`);
      values.push(data.phone);
    }
    if (data.hospital_type !== undefined || data.hospitalType !== undefined) {
      updates.push(`hospital_type = $${paramIndex++}`);
      values.push(data.hospital_type || data.hospitalType);
    }
    if (data.established_year !== undefined || data.establishedYear !== undefined) {
      updates.push(`established_year = $${paramIndex++}`);
      values.push(data.established_year || data.establishedYear);
    }
    if (data.rohini_id !== undefined || data.rohiniId !== undefined) {
      updates.push(`rohini_id = $${paramIndex++}`);
      values.push(data.rohini_id || data.rohiniId);
    }
    if (data.hfr_id !== undefined || data.hfrId !== undefined) {
      updates.push(`hfr_id = $${paramIndex++}`);
      values.push(data.hfr_id || data.hfrId);
    }
    if (data.pan_number !== undefined || data.panNumber !== undefined) {
      updates.push(`pan_number = $${paramIndex++}`);
      values.push(data.pan_number || data.panNumber);
    }
    if (data.gst_number !== undefined || data.gstNumber !== undefined) {
      updates.push(`gst_number = $${paramIndex++}`);
      values.push(data.gst_number || data.gstNumber);
    }
    if (data.specialties !== undefined) {
      updates.push(`specialties = $${paramIndex++}`);
      values.push(typeof data.specialties === 'string' ? data.specialties.split(',').map((s: string) => s.trim()) : data.specialties);
    }

    // Banking Details Fields
    if (data.cheque_payable_name !== undefined || data.chequePayableName !== undefined) {
      updates.push(`cheque_payable_name = $${paramIndex++}`);
      values.push(data.cheque_payable_name || data.chequePayableName);
    }
    if (data.bank_name !== undefined || data.bankName !== undefined) {
      updates.push(`bank_name = $${paramIndex++}`);
      values.push(data.bank_name || data.bankName);
    }
    if (data.bank_branch !== undefined || data.bankBranch !== undefined) {
      updates.push(`bank_branch = $${paramIndex++}`);
      values.push(data.bank_branch || data.bankBranch);
    }
    if (data.bank_address !== undefined || data.bankAddress !== undefined) {
      updates.push(`bank_address = $${paramIndex++}`);
      values.push(data.bank_address || data.bankAddress);
    }
    if (data.account_type !== undefined || data.accountType !== undefined) {
      updates.push(`account_type = $${paramIndex++}`);
      values.push(data.account_type || data.accountType);
    }
    if (data.account_number !== undefined || data.accountNumber !== undefined) {
      updates.push(`account_number = $${paramIndex++}`);
      values.push(data.account_number || data.accountNumber);
    }
    if (data.ifsc_code !== undefined || data.ifscCode !== undefined) {
      updates.push(`ifsc_code = $${paramIndex++}`);
      values.push(data.ifsc_code || data.ifscCode);
    }
    if (data.pan_name !== undefined || data.panName !== undefined) {
      updates.push(`pan_name = $${paramIndex++}`);
      values.push(data.pan_name || data.panName);
    }
    if (data.micr_code !== undefined || data.micrCode !== undefined) {
      updates.push(`micr_code = $${paramIndex++}`);
      values.push(data.micr_code || data.micrCode);
    }

    if (data.is_public_profile_enabled !== undefined || data.isPublicProfileEnabled !== undefined) {
      updates.push(`is_public_profile_enabled = $${paramIndex++}`);
      values.push(data.is_public_profile_enabled || data.isPublicProfileEnabled);
    }

    if (updates.length === 0) {
      return await this.getOrCreateProfile(hospitalId);
    }

    updates.push(`updated_at = NOW()`);
    values.push(hospitalId);

    const result = await pool.query(
      `UPDATE hospital.hospital_profile SET ${updates.join(', ')}
       WHERE hospital_id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Hospital profile not found');
    }

    return result.rows[0];
  }

  /**
   * Get public hospital profile (filtered view)
   */
  async getPublicProfile(hospitalId: string) {
    const profileRes = await pool.query(
      `SELECT * FROM hospital.hospital_profile
       WHERE hospital_id = $1 AND is_public_profile_enabled = true`,
      [hospitalId]
    );

    if (profileRes.rows.length === 0) {
      throw new apiError(404, 'Public profile not available');
    }

    const profile = profileRes.rows[0];

    // Get all attributes (verified and unverified) for public sharing WITH documents
    const attributesRes = await pool.query(
      `SELECT
        ha.*,
        ad.label,
        ad.category,
        ad.data_type,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', had.id,
              'documentId', had.document_id,
              'fileName', hd.file_name,
              'fileSize', hd.file_size_bytes,
              'mimeType', hd.mime_type,
              'uploadedAt', had.added_at,
              'isPrimary', had.is_primary
            ) ORDER BY had.is_primary DESC, had.added_at DESC
          ) FILTER (WHERE hd.id IS NOT NULL),
          '[]'::json
        ) as documents
       FROM hospital.hospital_attributes ha
       LEFT JOIN hospital.attribute_definitions ad ON ha.attribute_key = ad.key
       LEFT JOIN hospital.hospital_attribute_documents had ON ha.id = had.hospital_attribute_id
       LEFT JOIN hospital.hospital_documents hd ON had.document_id = hd.id
       WHERE ha.hospital_id = $1
       GROUP BY ha.id, ha.attribute_key, ha.hospital_id, ha.value_boolean, ha.value_text,
                ha.value_integer, ha.value_date, ha.certificate_number, ha.issuing_authority,
                ha.issued_at, ha.expires_at, ha.verification_status, ha.verification_method,
                ha.verified_by, ha.verified_at, ha.verification_notes, ha.created_at, ha.updated_at,
                ad.label, ad.category, ad.data_type, ad.sort_order, ad.key
       ORDER BY ad.category, ad.sort_order`,
      [hospitalId]
    );

    // Get public contacts only
    const contactsRes = await pool.query(
      `SELECT contact_type, name, designation, email, phone
       FROM hospital.hospital_key_contacts
       WHERE hospital_id = $1 AND is_public = true`,
      [hospitalId]
    );

    return {
      profile: {
        id: profile.id,
        legalName: profile.legal_name,
        addressLine1: profile.address_line1,
        addressLine2: profile.address_line2,
        city: profile.city,
        district: profile.district,
        state: profile.state,
        pincode: profile.pincode,
        website: profile.website,
        email: profile.email,
        phone: profile.phone,
        hospitalType: profile.hospital_type,
        establishedYear: profile.established_year,
        rohiniId: profile.rohini_id,
        hfrId: profile.hfr_id,
        panNumber: profile.pan_number,
        gstNumber: profile.gst_number,
        specialties: profile.specialties,
        // Banking Details
        chequePayableName: profile.cheque_payable_name,
        bankName: profile.bank_name,
        bankBranch: profile.bank_branch,
        bankAddress: profile.bank_address,
        accountType: profile.account_type,
        accountNumber: profile.account_number,
        ifscCode: profile.ifsc_code,
        panName: profile.pan_name,
        micrCode: profile.micr_code,
        // Verification Info
        verificationLevel: profile.verification_level,
        verificationStatus: profile.verification_status
      },
      attributes: attributesRes.rows,
      contacts: contactsRes.rows,
      verifiedBadge: profile.verification_status === 'verified'
    };
  }

  /**
   * Search hospitals (for public directory)
   */
  async searchHospitals(query: string, limit: number = 20) {
    const result = await pool.query(
      `SELECT
        h.id, h.name, hp.city, hp.state, hp.hospital_type,
        hp.verification_level, hp.verification_status,
        COUNT(DISTINCT ha.id) as attributes_count
       FROM hospital.hospitals h
       LEFT JOIN hospital.hospital_profile hp ON h.id = hp.hospital_id
       LEFT JOIN hospital.hospital_attributes ha ON h.id = ha.hospital_id AND ha.verification_status IN ('verified_by_doc', 'verified_by_image', 'verified_manual', 'automated_verified')
       WHERE hp.is_public_profile_enabled = true
       AND (h.name ILIKE $1 OR hp.city ILIKE $1 OR hp.state ILIKE $1)
       GROUP BY h.id, h.name, hp.id
       ORDER BY hp.verification_level DESC, h.name
       LIMIT $2`,
      [`%${query}%`, limit]
    );

    return result.rows;
  }
}

export default new HospitalProfileService();
