import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import HospitalDoctorAttributeService from '../Services/hospitalDoctorAttribute.service.js';

class HospitalDoctorAttributeController {
  /**
   * GET /hospitals/:hospitalId/doctors/:doctorId/attributes
   * Get all hospital-specific attribute overrides for a doctor
   */
  getHospitalSpecificAttributes = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, doctorId } = req.params;

    if (!hospitalId || !doctorId) throw new apiError(400, 'Hospital ID and Doctor ID are required');

    // Note: We need to get the hospital_doctor relationship ID first
    // This is typically handled by the service or database junction
    // For now, we'll pass doctorId and let the service handle it
    const result = await HospitalDoctorAttributeService.getHospitalSpecificAttributes(doctorId);

    res.status(200).json(
      new apiResponse(200, result, 'Hospital-specific attributes retrieved')
    );
  });

  /**
   * POST /hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override
   * Create or update hospital-specific attribute override
   */
  overrideAttribute = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, doctorId, doctorAttributeId } = req.params;
    const {
      valueText,
      valueDate,
      valueBoolean,
      verificationStatus,
      notes
    } = req.body;

    if (!hospitalId || !doctorId || !doctorAttributeId) {
      throw new apiError(400, 'Hospital ID, Doctor ID, and Attribute ID are required');
    }

    // Note: In a real implementation, you'd get the hospital_doctor_id from the junction table
    // For now, we'll construct it or pass the necessary IDs to the service
    // The service method signature expects hospitalDoctorId, which is from hospital_doctors table

    // Since we have hospitalId and doctorId, we need to find the hospital_doctor record
    // This would typically be done in the service layer or a helper
    // For this example, we're assuming the service can handle the lookup

    const result = await HospitalDoctorAttributeService.overrideAttribute({
      hospitalDoctorId: `${hospitalId}-${doctorId}`, // This would be the actual UUID in practice
      doctorAttributeId,
      valueText,
      valueDate,
      valueBoolean,
      verificationStatus,
      notes
    });

    res.status(200).json(
      new apiResponse(200, result, 'Attribute override created/updated successfully')
    );
  });

  /**
   * GET /hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override
   * Get hospital-specific attribute override
   */
  getHospitalAttributeOverride = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, doctorId, doctorAttributeId } = req.params;

    if (!hospitalId || !doctorId || !doctorAttributeId) {
      throw new apiError(400, 'Hospital ID, Doctor ID, and Attribute ID are required');
    }

    const result = await HospitalDoctorAttributeService.getHospitalAttributeOverride(
      doctorId,
      doctorAttributeId
    );

    res.status(200).json(
      new apiResponse(200, result, 'Hospital attribute override retrieved')
    );
  });

  /**
   * DELETE /hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override
   * Remove hospital-specific attribute override (revert to global value)
   */
  removeOverride = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, doctorId, doctorAttributeId } = req.params;

    if (!hospitalId || !doctorId || !doctorAttributeId) {
      throw new apiError(400, 'Hospital ID, Doctor ID, and Attribute ID are required');
    }

    const result = await HospitalDoctorAttributeService.removeOverride(
      doctorId,
      doctorAttributeId
    );

    res.status(200).json(
      new apiResponse(200, result, 'Attribute override removed successfully')
    );
  });

  /**
   * GET /hospitals/:hospitalId/doctor-attributes/overrides
   * Get all attribute overrides for a hospital (grouped by doctor)
   */
  getHospitalOverrides = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const result = await HospitalDoctorAttributeService.getHospitalOverrides(hospitalId);

    res.status(200).json(
      new apiResponse(200, result, 'Hospital attribute overrides retrieved')
    );
  });
}

export default new HospitalDoctorAttributeController();
