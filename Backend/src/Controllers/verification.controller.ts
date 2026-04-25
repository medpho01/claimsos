import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import VerificationService from '../Services/verification.service.js';

class VerificationController {
  /**
   * GET /hospitals/:hospitalId/verification/dashboard
   * Get verification dashboard with stats and pending items
   */
  getVerificationDashboard = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const dashboard = await VerificationService.getVerificationDashboard(hospitalId);

    res.status(200).json(
      new apiResponse(200, dashboard, 'Verification dashboard retrieved')
    );
  });

  /**
   * GET /hospitals/:hospitalId/verification/checklist
   * Get verification checklist (basic or empanelment)
   */
  getVerificationChecklist = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { type } = req.query;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const checklist = await VerificationService.getVerificationChecklist(
      hospitalId,
      (type as 'basic' | 'empanelment') || 'basic'
    );

    res.status(200).json(
      new apiResponse(200, checklist, 'Verification checklist retrieved')
    );
  });

  /**
   * POST /hospitals/:hospitalId/verification/evidence
   * Submit evidence for attribute verification
   */
  submitEvidence = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { attributeId, documentId, evidenceType, caption } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    if (!attributeId || !documentId || !evidenceType) {
      throw new apiError(400, 'attributeId, documentId, and evidenceType are required');
    }

    if (!['photo', 'document', 'manual_confirmation'].includes(evidenceType)) {
      throw new apiError(400, 'Invalid evidence type');
    }

    const evidence = await VerificationService.submitEvidence({
      hospitalAttributeId: attributeId,
      documentId,
      evidenceType,
      caption,
      uploadedBy: userId
    });

    res.status(201).json(
      new apiResponse(201, evidence, 'Evidence submitted for review')
    );
  });

  /**
   * GET /hospitals/:hospitalId/verification/evidence/:attributeId
   * Get evidence for attribute
   */
  getAttributeEvidence = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { attributeId } = req.params;

    if (!attributeId) throw new apiError(400, 'Attribute ID is required');

    const evidence = await VerificationService.getAttributeEvidence(attributeId);

    res.status(200).json(
      new apiResponse(200, evidence, `Retrieved ${evidence.length} evidence items`)
    );
  });

  /**
   * PUT /hospitals/:hospitalId/verification/evidence/:evidenceId
   * Review evidence (accept or reject)
   */
  reviewEvidence = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { evidenceId } = req.params;
    const { status, notes } = req.body;
    const reviewedBy = req.user?.id;

    if (!evidenceId) throw new apiError(400, 'Evidence ID is required');
    if (!reviewedBy) {
      throw new apiError(401, 'Unauthorized');
    }

    if (!['accepted', 'rejected'].includes(status)) {
      throw new apiError(400, 'Status must be accepted or rejected');
    }

    const result = await VerificationService.reviewEvidence(
      evidenceId,
      status,
      reviewedBy,
      notes
    );

    res.status(200).json(
      new apiResponse(200, result, `Evidence ${status}`)
    );
  });

  /**
   * GET /admin/verification/summary
   * Get verification summary across all hospitals (admin only)
   */
  getVerificationSummary = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    // Check admin role
    if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
      throw new apiError(403, 'Admin access required');
    }

    const summary = await VerificationService.getVerificationSummary();

    res.status(200).json(
      new apiResponse(200, summary, 'Verification summary retrieved')
    );
  });

  /**
   * PUT /admin/hospitals/:hospitalId/verification/level
   * Set hospital verification level (admin only)
   */
  setVerificationLevel = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { verificationLevel, verificationStatus, notes } = req.body;
    const verifiedBy = req.user?.id;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');
    if (!verifiedBy) {
      throw new apiError(401, 'Unauthorized');
    }

    if (req.user?.role !== 'superadmin' && req.user?.role !== 'admin') {
      throw new apiError(403, 'Admin access required');
    }

    if (!verificationLevel || !verificationStatus) {
      throw new apiError(400, 'verificationLevel and verificationStatus are required');
    }

    const result = await VerificationService.setVerificationLevel(
      hospitalId,
      verificationLevel,
      verificationStatus,
      verifiedBy,
      notes
    );

    res.status(200).json(
      new apiResponse(200, result, 'Verification level updated')
    );
  });

  /**
   * GET /hospitals/:hospitalId/verification/pending
   * Get items pending admin review
   */
  getPendingReview = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const pending = {
      evidenceReview: [],
      attributesNeedingVerification: [],
      expiringCertificates: []
    };

    // In a full impl, would query pending evidence, attributes, and expiring certs
    // For now, return structure

    res.status(200).json(
      new apiResponse(200, pending, 'Pending items retrieved')
    );
  });

  /**
   * POST /hospitals/:hospitalId/verification/submit
   * Submit hospital for verification (sets status to pending)
   */
  submitForVerification = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const userId = req.user?.id;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');
    if (!userId) {
      throw new apiError(401, 'Unauthorized');
    }

    // Set verification status to pending
    const result = await VerificationService.setVerificationLevel(
      hospitalId,
      'basic',
      'pending',
      userId,
      'Submitted for verification'
    );

    res.status(200).json(
      new apiResponse(200, result, 'Hospital submitted for verification')
    );
  });

  /**
   * GET /hospitals/:hospitalId/verification/progress
   * Get verification progress percentage
   */
  getVerificationProgress = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const dashboard = await VerificationService.getVerificationDashboard(hospitalId);

    const progress = {
      overallPercentage: dashboard.stats.verificationPercentage,
      verified: dashboard.stats.verified,
      total: dashboard.stats.total,
      basicChecklist: {
        total: dashboard.checklists.basic.length,
        completed: dashboard.checklists.basic.filter(i => !i.needsAction).length,
        percentage: dashboard.checklists.basic.length > 0
          ? Math.round((dashboard.checklists.basic.filter(i => !i.needsAction).length / dashboard.checklists.basic.length) * 100)
          : 0
      },
      empanelmentChecklist: {
        total: dashboard.checklists.empanelment.length,
        completed: dashboard.checklists.empanelment.filter(i => !i.needsAction).length,
        percentage: dashboard.checklists.empanelment.length > 0
          ? Math.round((dashboard.checklists.empanelment.filter(i => !i.needsAction).length / dashboard.checklists.empanelment.length) * 100)
          : 0
      }
    };

    res.status(200).json(
      new apiResponse(200, progress, 'Verification progress retrieved')
    );
  });
}

export default new VerificationController();
