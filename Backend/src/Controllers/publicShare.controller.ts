import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import { pool } from '../DB/db.js';
import HospitalProfileService from '../Services/hospitalProfile.service.js';
import AttachmentService from '../Services/attachment.service.js';
import crypto from 'crypto';

class PublicShareController {
  /**
   * POST /hospitals/:hospitalId/shares
   * Generate shareable link for hospital profile
   */
  generateShareLink = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { expiresInDays, maxViews, visibleSections } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    // Validate hospital exists
    const hospitalRes = await pool.query(
      `SELECT id FROM hospital.hospitals WHERE id = $1`,
      [hospitalId]
    );

    if (hospitalRes.rows.length === 0) {
      throw new apiError(404, 'Hospital not found');
    }

    // Ensure hospital profile exists and enable public sharing
    await pool.query(
      `INSERT INTO hospital.hospital_profile (hospital_id, is_public_profile_enabled)
       VALUES ($1, true)
       ON CONFLICT (hospital_id)
       DO UPDATE SET is_public_profile_enabled = true
       WHERE hospital_profile.hospital_id = $1`,
      [hospitalId]
    );

    // Generate random token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;

    // Default visible sections if not specified
    const sections = visibleSections || {
      profile: true,
      attributes: true,
      contacts: true
    };

    // Create share token
    const result = await pool.query(
      `INSERT INTO hospital.public_share_tokens
       (token, resource_type, resource_id, is_active, expires_at, max_views, created_by, visible_sections)
       VALUES ($1, $2, $3, true, $4, $5, $6, $7)
       RETURNING *`,
      [
        token,
        'hospital_profile',
        hospitalId,
        expiresAt,
        maxViews || null,
        userId,
        JSON.stringify(sections)
      ]
    );

    const share = result.rows[0];

    // Construct share URL with proper fallback
    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5001';
    const shareUrl = `${baseUrl}/hospitals/share/${token}`;

    res.status(201).json(
      new apiResponse(201, {
        ...share,
        shareUrl
      }, 'Share link generated successfully')
    );
  });

  /**
   * GET /share/:token
   * Access public hospital profile via share link
   */
  accessPublicProfile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { token } = req.params;

    if (!token) {
      throw new apiError(400, 'Share token required');
    }

    // Get share token
    const tokenRes = await pool.query(
      `SELECT * FROM hospital.public_share_tokens
       WHERE token = $1 AND is_active = true AND resource_type = 'hospital_profile'`,
      [token]
    );

    if (tokenRes.rows.length === 0) {
      throw new apiError(404, 'Share link not found or expired');
    }

    const share = tokenRes.rows[0];

    // Check expiry
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      throw new apiError(403, 'Share link has expired');
    }

    // Check max views
    if (share.max_views && share.view_count >= share.max_views) {
      throw new apiError(403, 'Share link view limit reached');
    }

    // Get profile with filtering
    const profile = await HospitalProfileService.getPublicProfile(share.resource_id);

    // Update view count and last accessed
    await pool.query(
      `UPDATE hospital.public_share_tokens
       SET view_count = view_count + 1, last_viewed_at = NOW()
       WHERE id = $1`,
      [share.id]
    );

    // Parse visible sections from JSONB
    const visibleSections = share.visible_sections || {};

    // Filter based on share settings
    const filtered = {
      ...profile,
      attributes: visibleSections.attributes !== false ? profile.attributes : [],
      contacts: visibleSections.contacts !== false ? profile.contacts : []
    };

    res.status(200).json(
      new apiResponse(200, filtered, 'Profile accessed via share link')
    );
  });

  /**
   * GET /hospitals/:hospitalId/shares
   * List share links for hospital
   */
  getShareLinks = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    const result = await pool.query(
      `SELECT id, token, resource_type, is_active, created_at, expires_at, max_views, view_count, last_viewed_at, visible_sections
       FROM hospital.public_share_tokens
       WHERE resource_type = 'hospital_profile' AND resource_id = $1
       ORDER BY created_at DESC`,
      [hospitalId]
    );

    // Construct share URLs with proper fallback
    const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5001';

    const shares = result.rows.map(share => ({
      ...share,
      shareUrl: `${baseUrl}/hospitals/share/${share.token}`,
      isExpired: share.expires_at ? new Date(share.expires_at) < new Date() : false
    }));

    res.status(200).json(
      new apiResponse(200, shares, `Retrieved ${shares.length} share links`)
    );
  });

  /**
   * PUT /hospitals/:hospitalId/shares/:shareId
   * Update share link settings
   */
  updateShareLink = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, shareId } = req.params;
    const { isActive, maxViews, expiresAt, visibleSections } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }

    if (maxViews !== undefined) {
      updates.push(`max_views = $${paramIndex++}`);
      values.push(maxViews);
    }

    if (expiresAt !== undefined) {
      updates.push(`expires_at = $${paramIndex++}`);
      values.push(expiresAt);
    }

    if (visibleSections !== undefined) {
      updates.push(`visible_sections = $${paramIndex++}`);
      values.push(JSON.stringify(visibleSections));
    }

    if (updates.length === 0) {
      throw new apiError(400, 'No updates provided');
    }

    values.push(shareId);
    values.push(hospitalId);

    const result = await pool.query(
      `UPDATE hospital.public_share_tokens
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex} AND resource_id = $${paramIndex + 1} AND resource_type = 'hospital_profile'
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Share link not found');
    }

    res.status(200).json(
      new apiResponse(200, result.rows[0], 'Share link updated')
    );
  });

  /**
   * DELETE /hospitals/:hospitalId/shares/:shareId
   * Revoke share link
   */
  revokeShareLink = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, shareId } = req.params;

    const result = await pool.query(
      `DELETE FROM hospital.public_share_tokens
       WHERE id = $1 AND resource_id = $2 AND resource_type = 'hospital_profile'
       RETURNING id`,
      [shareId, hospitalId]
    );

    if (result.rows.length === 0) {
      throw new apiError(404, 'Share link not found');
    }

    res.status(200).json(
      new apiResponse(200, { revoked: true }, 'Share link revoked')
    );
  });

  /**
   * GET /hospitals/:hospitalId/public
   * Get public hospital directory listing
   */
  getPublicDirectory = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { page, limit, search, verification } = req.query;

    const pageNum = parseInt(page as string) || 1;
    const pageSize = Math.min(parseInt(limit as string) || 20, 100);
    const offset = (pageNum - 1) * pageSize;

    let query = `
      SELECT h.id, h.name, hp.city, hp.state, hp.hospital_type,
             hp.verification_level, hp.verification_status,
             (SELECT COUNT(*) FROM hospital.hospital_attributes ha
              WHERE ha.hospital_id = h.id
              AND ha.verification_status IN ('verified_by_doc', 'verified_by_image', 'verified_manual', 'automated_verified')) as verified_count
      FROM hospital.hospitals h
      LEFT JOIN hospital.hospital_profile hp ON h.id = hp.hospital_id
      WHERE hp.is_public_profile_enabled = true
    `;

    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND (h.name ILIKE $${paramIndex} OR hp.city ILIKE $${paramIndex} OR hp.state ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (verification) {
      query += ` AND hp.verification_level = $${paramIndex}`;
      params.push(verification);
      paramIndex++;
    }

    query += ` ORDER BY hp.verification_level DESC, h.name ASC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, offset);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) as total
      FROM hospital.hospitals h
      LEFT JOIN hospital.hospital_profile hp ON h.id = hp.hospital_id
      WHERE hp.is_public_profile_enabled = true
    `;

    const countParams: any[] = [];
    let countParamIndex = 1;

    if (search) {
      countQuery += ` AND (h.name ILIKE $${countParamIndex} OR hp.city ILIKE $${countParamIndex} OR hp.state ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }

    if (verification) {
      countQuery += ` AND hp.verification_level = $${countParamIndex}`;
      countParams.push(verification);
    }

    const countResult = await pool.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    res.status(200).json(
      new apiResponse(200, {
        hospitals: result.rows,
        pagination: {
          page: pageNum,
          limit: pageSize,
          total,
          pages: Math.ceil(total / pageSize)
        }
      }, 'Public directory retrieved')
    );
  });

  /**
   * GET /share/:token/documents/:documentId/download
   * Download document using share token
   */
  downloadDocumentByToken = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { token, documentId } = req.params;

    console.log(`[DOWNLOAD] Token: ${token}, DocumentId: ${documentId}`);

    // Validate share token
    const tokenRes = await pool.query(
      `SELECT * FROM hospital.public_share_tokens
       WHERE token = $1 AND is_active = true AND resource_type = 'hospital_profile'`,
      [token]
    );

    if (tokenRes.rows.length === 0) {
      console.log(`[DOWNLOAD] Token not found or inactive`);
      throw new apiError(404, 'Share link not found or expired');
    }

    const share = tokenRes.rows[0];
    console.log(`[DOWNLOAD] Token valid, Hospital ID: ${share.resource_id}`);

    // Check if share link has expired
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      console.log(`[DOWNLOAD] Share link expired`);
      throw new apiError(403, 'Share link has expired');
    }

    // Verify document belongs to this hospital
    const docRes = await pool.query(
      `SELECT hd.* FROM hospital.hospital_documents hd
       JOIN hospital.hospital_attribute_documents had ON hd.id = had.document_id
       JOIN hospital.hospital_attributes ha ON had.hospital_attribute_id = ha.id
       WHERE hd.id = $1 AND ha.hospital_id = $2`,
      [documentId, share.resource_id]
    );

    if (docRes.rows.length === 0) {
      console.log(`[DOWNLOAD] Document not found or doesn't belong to hospital`);
      throw new apiError(404, 'Document not found');
    }

    console.log(`[DOWNLOAD] Document found, starting download...`);

    // Update view count
    await pool.query(
      `UPDATE hospital.public_share_tokens
       SET view_count = view_count + 1, last_viewed_at = NOW()
       WHERE id = $1`,
      [share.id]
    );

    try {
      // Download document from S3
      const { buffer, fileName, mimeType } = await AttachmentService.downloadDocument(documentId);

      console.log(`[DOWNLOAD] File fetched from S3, size: ${buffer.length}, name: ${fileName}`);

      // Return document as download
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.send(buffer);

      console.log(`[DOWNLOAD] File sent successfully`);
    } catch (s3Error) {
      console.error(`[DOWNLOAD] S3 download failed:`, s3Error);
      throw new apiError(500, 'Failed to download file from storage');
    }
  });

  /**
   * GET /share/:token/documents/:documentId/preview
   * Preview document using share token
   */
  previewDocumentByToken = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { token, documentId } = req.params;

    // Validate share token
    const tokenRes = await pool.query(
      `SELECT * FROM hospital.public_share_tokens
       WHERE token = $1 AND is_active = true AND resource_type = 'hospital_profile'`,
      [token]
    );

    if (tokenRes.rows.length === 0) {
      throw new apiError(404, 'Share link not found or expired');
    }

    const share = tokenRes.rows[0];

    // Check if share link has expired
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      throw new apiError(403, 'Share link has expired');
    }

    // Verify document belongs to this hospital
    const docRes = await pool.query(
      `SELECT hd.* FROM hospital.hospital_documents hd
       JOIN hospital.hospital_attribute_documents had ON hd.id = had.document_id
       JOIN hospital.hospital_attributes ha ON had.hospital_attribute_id = ha.id
       WHERE hd.id = $1 AND ha.hospital_id = $2`,
      [documentId, share.resource_id]
    );

    if (docRes.rows.length === 0) {
      throw new apiError(404, 'Document not found');
    }

    // Update view count
    await pool.query(
      `UPDATE hospital.public_share_tokens
       SET view_count = view_count + 1, last_viewed_at = NOW()
       WHERE id = $1`,
      [share.id]
    );

    // Download document from S3
    const { buffer, fileName, mimeType } = await AttachmentService.downloadDocument(documentId);

    // Return document for preview (inline)
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(buffer);
  });
}

export default new PublicShareController();
