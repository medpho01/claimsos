import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import HospitalProfileService from '../Services/hospitalProfile.service.js';
import AttributeService from '../Services/attribute.service.js';

class HospitalProfileController {
  /**
   * GET /hospital-profiles/:hospitalId
   * Get hospital profile with all related data
   */
  getProfile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const profile = await HospitalProfileService.getFullProfile(hospitalId);

    res.status(200).json(
      new apiResponse(200, profile, 'Hospital profile retrieved successfully')
    );
  });

  /**
   * POST /hospital-profiles/:hospitalId
   * Create or update hospital profile
   */
  updateProfile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const input = req.body;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const profile = await HospitalProfileService.updateProfile(hospitalId, {
      hospitalId,
      ...input
    });

    res.status(200).json(
      new apiResponse(200, profile, 'Hospital profile updated successfully')
    );
  });

  /**
   * GET /hospital-profiles/:hospitalId/public
   * Get public hospital profile (verified badge, public attributes only)
   */
  getPublicProfile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const publicProfile = await HospitalProfileService.getPublicProfile(hospitalId);

    res.status(200).json(
      new apiResponse(200, publicProfile, 'Public profile retrieved successfully')
    );
  });

  /**
   * GET /hospital-profiles/search
   * Search hospitals by name, city, state
   */
  searchHospitals = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { q, limit } = req.query;

    if (!q || typeof q !== 'string') {
      throw new apiError(400, 'Search query required');
    }

    const results = await HospitalProfileService.searchHospitals(q, parseInt(limit as string) || 20);

    res.status(200).json(
      new apiResponse(200, results, `Found ${results.length} hospitals`)
    );
  });

  /**
   * GET /hospital-profiles/:hospitalId/summary
   * Get profile summary (name, city, verification status, stats)
   */
  getProfileSummary = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const profile = await HospitalProfileService.getOrCreateProfile(hospitalId);
    const attributes = await AttributeService.getHospitalAttributes(hospitalId);

    const verified = attributes.filter(a =>
      ['verified_by_doc', 'verified_by_image', 'verified_manual', 'automated_verified'].includes(a.verificationStatus)
    ).length;

    const summary = {
      hospitalId: profile.hospital_id,
      legalName: profile.legal_name,
      city: profile.city,
      state: profile.state,
      verificationLevel: profile.verification_level,
      verificationStatus: profile.verification_status,
      isPublic: profile.is_public_profile_enabled,
      stats: {
        totalAttributes: attributes.length,
        verifiedAttributes: verified,
        verificationPercentage: attributes.length > 0 ? Math.round((verified / attributes.length) * 100) : 0
      }
    };

    res.status(200).json(
      new apiResponse(200, summary, 'Profile summary retrieved')
    );
  });

  /**
   * PUT /hospital-profiles/:hospitalId/publish
   * Enable public profile
   */
  publishProfile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { sections } = req.body;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const profile = await HospitalProfileService.updateProfile(hospitalId, {
      hospitalId,
      isPublicProfileEnabled: true,
      ...sections && { publicProfileSections: sections }
    });

    res.status(200).json(
      new apiResponse(200, profile, 'Profile published successfully')
    );
  });

  /**
   * PUT /hospital-profiles/:hospitalId/unpublish
   * Disable public profile
   */
  unpublishProfile = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const profile = await HospitalProfileService.updateProfile(hospitalId, {
      hospitalId,
      isPublicProfileEnabled: false
    });

    res.status(200).json(
      new apiResponse(200, profile, 'Profile unpublished')
    );
  });
}

export default new HospitalProfileController();
