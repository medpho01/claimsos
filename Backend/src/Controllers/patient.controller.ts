
import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import { getIndianTimeISO } from '../Utils/indianTime.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import fileName from '../Utils/fileName.util.js'
import driveHandler from '../Services/driveUploader.service.js'

const FileName = new fileName();
const DriveHandler = new driveHandler();
class patientController {
    addPatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { firstName, lastName, phone, admittedAt, hospitalId, admissionType } = req.body;
        const userId = req.user?.id;
        const userRole = req.user?.role;

        console.log('[ADD PATIENT] Request received:', { firstName, lastName, phone, userId, role: userRole });

        if (!userId) throw new apiError(401, "No user found please Log in again");

        let targetHospitalId = userId;

        // Superadmin must provide hospitalId
        if (userRole === 'superadmin') {
            if (!hospitalId) {
                throw new apiError(400, "Hospital ID is required for superadmins to create patients");
            }
            targetHospitalId = hospitalId;
        }
        // Admin must provide hospitalId and have permission
        else if (userRole === 'admin') {
            if (!hospitalId) {
                throw new apiError(400, "Hospital ID is required for admins to create patients");
            }

            // Check permission
            const permissionCheck = await pool.query(
                `SELECT can_edit FROM hospital_assignments 
                 WHERE admin_id = $1 AND hospital_id = $2 AND is_active = true`,
                [userId, hospitalId]
            );

            if (permissionCheck.rowCount === 0 || !permissionCheck.rows[0].can_edit) {
                throw new apiError(403, "Unauthorized. You do not have permission to add patients to this hospital.");
            }
            targetHospitalId = hospitalId;
        }
        // Hospital user uses their own id

        // Use current timestamp if admittedAt is not provided
        const admissionDate = admittedAt || getIndianTimeISO();

        console.log('[ADD PATIENT] Creating Drive folder...');

        // Get the hospital's folder_id for creating patient subfolder
        let folderParentId = req.user.folder_id;
        if (userRole === 'admin' || userRole === 'superadmin') {
            const hospitalInfo = await pool.query('SELECT folder_id FROM users WHERE id = $1', [targetHospitalId]);
            if ((hospitalInfo.rowCount ?? 0) > 0 && hospitalInfo.rows[0].folder_id) {
                folderParentId = hospitalInfo.rows[0].folder_id;
            } else {
                throw new apiError(400, "Target hospital does not have a Drive folder configured");
            }
        }

        const folder = await DriveHandler.createFolder(FileName.patientFolderName(firstName, admissionDate), folderParentId);
        console.log('[ADD PATIENT] Drive folder created:', folder.fileId);

        console.log('[ADD PATIENT] Inserting patient into database...');
        const patient = await pool.query("INSERT INTO PATIENTS (first_name,last_name,phone,admitted_at,hospital_id,folder_id,admission_type) values ($1,$2,$3,$4,$5,$6,$7) returning id,first_name,last_name,phone,admitted_at,folder_id,admission_type",
            [firstName, lastName, phone, admissionDate, targetHospitalId, folder.fileId, admissionType]
        )

        if (patient.rowCount == 0) throw new apiError(500, "Server Error. Couldn't create new patient.");

        console.log('[ADD PATIENT] Patient created successfully:', patient.rows[0].id);

        res.status(201).json(new apiResponse(201, patient.rows[0], "Patient created successfully"));
    })

    getAllPatients = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.id;
        const userRole = req.user?.role;

        if (!userId) throw new apiError(401, "No user found please Log in again");

        let allPatients;

        // Superadmins see all patients
        if (userRole === 'superadmin') {
            allPatients = await pool.query(
                `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.folder_id, p.admission_type, p.is_active,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name
                 FROM patients p
                 LEFT JOIN users u ON p.hospital_id = u.id
                 ORDER BY p.admitted_at DESC`
            );
        }
        // Admins see patients from their assigned hospitals
        else if (userRole === 'admin') {
            allPatients = await pool.query(
                `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.folder_id, p.admission_type, p.is_active,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        ha.can_view, ha.can_edit, ha.can_discharge
                 FROM patients p
                 JOIN users u ON p.hospital_id = u.id
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 WHERE ha.admin_id = $1 AND ha.is_active = true
                 ORDER BY p.admitted_at DESC`,
                [userId]
            );
        }
        // Hospital users see only their own patients
        else {
            allPatients = await pool.query(
                "SELECT id, first_name, last_name, admitted_at, discharged_at, hospital_id, phone, folder_id, admission_type, is_active FROM patients WHERE hospital_id = $1 ORDER BY admitted_at DESC",
                [userId]
            );
        }

        res.status(200).json(new apiResponse(200, allPatients.rows, "successfully fetched all patients"));
    })

    getActivePatients = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.id;
        const userRole = req.user?.role;

        if (!userId) throw new apiError(401, "No user found please Log in again");

        let activePatients;

        // Superadmins see all patients
        if (userRole === 'superadmin') {
            activePatients = await pool.query(
                `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.folder_id, p.admission_type, p.is_active,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name
                 FROM patients p
                 LEFT JOIN users u ON p.hospital_id = u.id where p.is_active = true
                 ORDER BY p.admitted_at DESC`
            );
        }
        // Admins see patients from their assigned hospitals
        else if (userRole === 'admin') {
            activePatients = await pool.query(
                `SELECT p.id, p.first_name, p.last_name, p.admitted_at, p.discharged_at, p.hospital_id, p.phone, p.folder_id, p.admission_type, p.is_active,
                        u.first_name as hospital_first_name, u.last_name as hospital_last_name,
                        ha.can_view, ha.can_edit, ha.can_discharge
                 FROM patients p
                 JOIN users u ON p.hospital_id = u.id
                 JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
                 WHERE ha.admin_id = $1 AND ha.is_active = true and p.is_active = true
                 ORDER BY p.admitted_at DESC`,
                [userId]
            );
        }
        // Hospital users see only their own patients
        else {
            activePatients = await pool.query(
                "SELECT id, first_name, last_name, admitted_at, discharged_at, hospital_id, phone, folder_id, admission_type, is_active FROM patients WHERE hospital_id = $1 and is_active = true ORDER BY admitted_at DESC",
                [userId]
            );
        }

        res.status(200).json(new apiResponse(200, activePatients.rows, "successfully fetched active patients"));
    })

    updatePatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { firstName, lastName, phone, admittedAt, admissionType } = req.body;
        const userId = req.user?.id;
        const userRole = req.user?.role;

        if (!userId || !admittedAt) throw new apiError(401, "No user found please Log in again");

        // Role-based authorization
        if (userRole === 'hospital') {
            const checkOwnership = await pool.query(
                "SELECT id FROM patients WHERE id = $1 AND hospital_id = $2",
                [id, userId]
            );
            if (checkOwnership.rowCount === 0) throw new apiError(404, "Patient not found or unauthorized");
        }
        else if (userRole === 'admin') {
            // Admins are already checked by middleware for 'can_edit' permission on this patient's hospital
            // But we double check existence
            const patientExists = await pool.query("SELECT id FROM patients WHERE id = $1", [id]);
            if (patientExists.rowCount === 0) throw new apiError(404, "Patient not found");
        }
        else if (userRole === 'superadmin') {
            // Superadmin can edit anyone
            const patientExists = await pool.query("SELECT id FROM patients WHERE id = $1", [id]);
            if (patientExists.rowCount === 0) throw new apiError(404, "Patient not found");
        }

        const updatedPatient = await pool.query(
            "UPDATE patients SET first_name = $1, last_name = $2, phone = $3, updated_at = NOW(), admitted_at = $5, admission_type = $6 WHERE id = $4 RETURNING id, first_name, last_name, phone, admitted_at, folder_id, admission_type, discharged_at",
            [firstName, lastName, phone, id, admittedAt, admissionType]
        );

        res.status(200).json(new apiResponse(200, updatedPatient.rows[0], "Patient updated successfully"));
    })

    dischargePatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { dischargedAt } = req.body;
        const userId = req.user?.id;
        const userRole = req.user?.role;

        if (!userId) throw new apiError(401, "No user found please Log in again");

        // Role-based authorization
        if (userRole === 'hospital') {
            const checkOwnership = await pool.query(
                "SELECT id FROM patients WHERE id = $1 AND hospital_id = $2",
                [id, userId]
            );
            if (checkOwnership.rowCount === 0) throw new apiError(404, "Patient not found or unauthorized");
        }
        else if (userRole === 'admin') {
            // Admins are already checked by middleware for 'can_discharge' permission
            const patientExists = await pool.query("SELECT id FROM patients WHERE id = $1", [id]);
            if (patientExists.rowCount === 0) throw new apiError(404, "Patient not found");
        }
        else if (userRole === 'superadmin') {
            const patientExists = await pool.query("SELECT id FROM patients WHERE id = $1", [id]);
            if (patientExists.rowCount === 0) throw new apiError(404, "Patient not found");
        }

        const updatedPatient = await pool.query(
            "UPDATE patients SET discharged_at = $1, updated_at = NOW() WHERE id = $2 RETURNING id, first_name, last_name, phone, admitted_at, discharged_at, folder_id",
            [dischargedAt, id]
        );

        res.status(200).json(new apiResponse(200, updatedPatient.rows[0], "Patient discharged successfully"));
    })

    deletePatient = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const userId = req.user?.id;

        if (!userId) throw new apiError(401, "No user found please Log in again");

        // Verify the patient belongs to this hospital
        const checkOwnership = await pool.query(
            "SELECT id FROM patients WHERE id = $1 AND hospital_id = $2",
            [id, userId]
        );

        if (checkOwnership.rowCount === 0) {
            throw new apiError(404, "Patient not found or unauthorized");
        }

        // Hard delete - consider soft delete in production
        await pool.query("DELETE FROM patients WHERE id = $1", [id]);

        res.status(200).json(new apiResponse(200, null, "Patient deleted successfully"));
    })

    togglePatientActiveStatus = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        const { isActive } = req.body;
        const userId = req.user?.id;
        const userRole = req.user?.role;

        if (!userId) throw new apiError(401, "No user found please Log in again");

        // Validate isActive is provided
        if (typeof isActive !== 'boolean') {
            throw new apiError(400, "isActive must be a boolean value");
        }

        // Check if patient exists and get their hospital_id
        const patientCheck = await pool.query(
            "SELECT id, hospital_id, is_active FROM patients WHERE id = $1",
            [id]
        );

        if (patientCheck.rowCount === 0) {
            throw new apiError(404, "Patient not found");
        }

        const patient = patientCheck.rows[0];

        // Role-based authorization - only admin and superadmin can toggle
        if (userRole === 'hospital') {
            // Hospital users cannot toggle patient active status
            throw new apiError(403, "Unauthorized: Only admins can modify patient active status");
        } else if (userRole === 'admin') {
            // Admins can toggle patients from their assigned hospitals
            const permissionCheck = await pool.query(
                `SELECT can_edit FROM hospital_assignments 
                 WHERE admin_id = $1 AND hospital_id = $2 AND is_active = true`,
                [userId, patient.hospital_id]
            );

            if (permissionCheck.rowCount === 0 || !permissionCheck.rows[0].can_edit) {
                throw new apiError(403, "Unauthorized: You do not have permission to modify this patient");
            }
        }
        // Superadmins can toggle any patient - no additional check needed

        // Update the is_active status
        const updatedPatient = await pool.query(
            `UPDATE patients 
             SET is_active = $1, updated_at = NOW() 
             WHERE id = $2 
             RETURNING id, first_name, last_name, phone, admitted_at, discharged_at, folder_id, admission_type, is_active`,
            [isActive, id]
        );

        res.status(200).json(new apiResponse(200, updatedPatient.rows[0], `Patient ${isActive ? 'activated' : 'deactivated'} successfully`));
    })
}

export default patientController
