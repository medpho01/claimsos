import type { Request, Response, NextFunction } from 'express';
import asyncHandler from '../Utils/asyncHandler.util.js';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';
import HospitalDoctorService from '../Services/hospitalDoctor.service.js';
import DoctorService from '../Services/doctor.service.js';

class HospitalDoctorController {
  /**
   * GET /hospitals/:hospitalId/doctors
   * Get all doctors for a hospital
   */
  getHospitalDoctors = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');

    const result = await HospitalDoctorService.getHospitalDoctorsWithAttributes(hospitalId);

    // Implement pagination if needed
    const pageNum = parseInt(page as string) || 1;
    const limitNum = parseInt(limit as string) || 50;
    const startIndex = (pageNum - 1) * limitNum;
    const endIndex = startIndex + limitNum;

    const paginatedResult = {
      data: result.slice(startIndex, endIndex),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: result.length,
        pages: Math.ceil(result.length / limitNum)
      }
    };

    res.status(200).json(
      new apiResponse(200, paginatedResult, 'Hospital doctors retrieved successfully')
    );
  });

  /**
   * POST /hospitals/:hospitalId/doctors/create
   * Create a new doctor and add them to hospital in one operation
   */
  createAndAddDoctorToHospital = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const {
      first_name,
      last_name,
      email,
      phone,
      primary_specialization,
      nmc_registration_number,
      employment_type = 'consultant',
      department,
      specialization,
      designation,
      start_date,
      end_date,
      employee_id,
      notes,
      hospital_phone,
      hospital_email
    } = req.body;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');
    if (!first_name || !last_name || !email) {
      throw new apiError(400, 'First name, last name, and email are required');
    }

    // Step 1: Create the doctor using registerDoctor with admin context (userId = null for admin-created)
    const createdDoctor = await DoctorService.registerDoctor({
      firstName: first_name,
      lastName: last_name,
      email,
      phone,
      primarySpecialization: primary_specialization,
      nmcRegistrationNumber: nmc_registration_number
    }, null); // userId = null indicates admin_created

    if (!createdDoctor || !createdDoctor.id) {
      throw new apiError(500, 'Failed to create doctor');
    }

    // Step 2: Add the doctor to the hospital
    const result = await HospitalDoctorService.addDoctorToHospital({
      hospitalId,
      doctorId: createdDoctor.id,
      employmentType: employment_type,
      department,
      specialization,
      designation,
      startDate: start_date,
      endDate: end_date,
      employeeId: employee_id,
      notes,
      hospitalPhone: hospital_phone,
      hospitalEmail: hospital_email
    });

    res.status(201).json(
      new apiResponse(201, result, 'Doctor created and added to hospital successfully')
    );
  });

  /**
   * POST /hospitals/:hospitalId/doctors
   * Add doctor to hospital
   */
  addDoctorToHospital = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId } = req.params;
    const {
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
    } = req.body;

    if (!hospitalId) throw new apiError(400, 'Hospital ID is required');
    if (!doctorId) throw new apiError(400, 'Doctor ID is required');
    if (!employmentType) throw new apiError(400, 'Employment type is required');

    const result = await HospitalDoctorService.addDoctorToHospital({
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
    });

    res.status(201).json(
      new apiResponse(201, result, 'Doctor added to hospital successfully')
    );
  });

  /**
   * GET /hospitals/:hospitalId/doctors/:doctorId
   * Get hospital-doctor relationship
   */
  getHospitalDoctor = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, doctorId } = req.params;

    if (!hospitalId || !doctorId) throw new apiError(400, 'Hospital ID and Doctor ID are required');

    const result = await HospitalDoctorService.getHospitalDoctor(hospitalId, doctorId);

    res.status(200).json(
      new apiResponse(200, result, 'Hospital-doctor relationship retrieved')
    );
  });

  /**
   * PUT /hospitals/:hospitalId/doctors/:doctorId
   * Update hospital-doctor relationship
   */
  updateHospitalDoctor = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, doctorId } = req.params;
    const updates = req.body;

    if (!hospitalId || !doctorId) throw new apiError(400, 'Hospital ID and Doctor ID are required');

    const result = await HospitalDoctorService.updateHospitalDoctorInfo(
      hospitalId,
      doctorId,
      updates
    );

    res.status(200).json(
      new apiResponse(200, result, 'Hospital-doctor relationship updated successfully')
    );
  });

  /**
   * DELETE /hospitals/:hospitalId/doctors/:doctorId
   * Remove doctor from hospital
   */
  removeDoctorFromHospital = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { hospitalId, doctorId } = req.params;

    if (!hospitalId || !doctorId) throw new apiError(400, 'Hospital ID and Doctor ID are required');

    const result = await HospitalDoctorService.removeDoctorFromHospital(hospitalId, doctorId);

    res.status(200).json(
      new apiResponse(200, result, 'Doctor removed from hospital successfully')
    );
  });
}

export default new HospitalDoctorController();
