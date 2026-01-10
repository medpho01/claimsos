import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'

class adminController {
    // Get all admin users
    getAllAdmins = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const admins = await pool.query(
                `SELECT id, username, email, first_name, last_name, phone, is_active, created_at 
         FROM users 
         WHERE role = 'admin' 
         ORDER BY created_at DESC`
            );
            res.status(200).json(
                new apiResponse(200, admins.rows, 'Successfully fetched all admins')
            );
        }
    )

    // Get all hospital users
    getAllHospitals = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const hospitals = await pool.query(
                `SELECT id, username, email, first_name, last_name, phone, is_active, folder_id, created_at 
         FROM users 
         WHERE role = 'hospital' 
         ORDER BY created_at DESC`
            );
            res.status(200).json(
                new apiResponse(200, hospitals.rows, 'Successfully fetched all hospitals')
            );
        }
    )

    // Assign a hospital to an admin
    assignHospitalToAdmin = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId, hospitalId, canView, canEdit, canDischarge } = req.body;
            const superadminId = req.user?.id;

            if (!adminId || !hospitalId) {
                throw new apiError(400, 'Admin ID and Hospital ID are required');
            }

            // Verify admin exists and has admin role
            const adminCheck = await pool.query(
                'SELECT id, role FROM users WHERE id = $1',
                [adminId]
            );
            if (adminCheck.rowCount === 0 || adminCheck.rows[0].role !== 'admin') {
                throw new apiError(404, 'Admin user not found');
            }

            // Verify hospital exists and has hospital role
            const hospitalCheck = await pool.query(
                'SELECT id, role FROM users WHERE id = $1',
                [hospitalId]
            );
            if (hospitalCheck.rowCount === 0 || hospitalCheck.rows[0].role !== 'hospital') {
                throw new apiError(404, 'Hospital user not found');
            }

            // Create assignment
            const assignment = await pool.query(
                `INSERT INTO hospital_assignments (admin_id, hospital_id, assigned_by, can_view, can_edit, can_discharge)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (admin_id, hospital_id) 
         DO UPDATE SET can_view = $4, can_edit = $5, can_discharge = $6, is_active = true, assigned_at = NOW()
         RETURNING *`,
                [adminId, hospitalId, superadminId, canView ?? true, canEdit ?? true, canDischarge ?? true]
            );

            res.status(201).json(
                new apiResponse(201, assignment.rows[0], 'Hospital assigned to admin successfully')
            );
        }
    )

    // Remove hospital assignment from admin
    removeHospitalAssignment = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId, hospitalId } = req.body;

            if (!adminId || !hospitalId) {
                throw new apiError(400, 'Admin ID and Hospital ID are required');
            }

            const result = await pool.query(
                'DELETE FROM hospital_assignments WHERE admin_id = $1 AND hospital_id = $2 RETURNING *',
                [adminId, hospitalId]
            );

            if (result.rowCount === 0) {
                throw new apiError(404, 'Hospital assignment not found');
            }

            res.status(200).json(
                new apiResponse(200, result.rows[0], 'Hospital assignment removed successfully')
            );
        }
    )

    // Get hospitals assigned to a specific admin
    getAdminHospitals = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId } = req.params;

            const hospitals = await pool.query(
                `SELECT 
          u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.folder_id,
          ha.can_view, ha.can_edit, ha.can_discharge, ha.assigned_at, ha.is_active
         FROM hospital_assignments ha
         JOIN users u ON ha.hospital_id = u.id
         WHERE ha.admin_id = $1 AND ha.is_active = true
         ORDER BY ha.assigned_at DESC`,
                [adminId]
            );

            res.status(200).json(
                new apiResponse(200, hospitals.rows, 'Successfully fetched admin hospitals')
            );
        }
    )

    // Get all admins managing a specific hospital
    getHospitalAdmins = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params;

            const admins = await pool.query(
                `SELECT 
          u.id, u.username, u.email, u.first_name, u.last_name, u.phone,
          ha.can_view, ha.can_edit, ha.can_discharge, ha.assigned_at, ha.is_active
         FROM hospital_assignments ha
         JOIN users u ON ha.admin_id = u.id
         WHERE ha.hospital_id = $1 AND ha.is_active = true
         ORDER BY ha.assigned_at DESC`,
                [hospitalId]
            );

            res.status(200).json(
                new apiResponse(200, admins.rows, 'Successfully fetched hospital admins')
            );
        }
    )

    // Get all patients accessible by a specific admin
    getAdminPatients = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId } = req.params;

            // Security check: Admins can only view their own patients
            if (req.user?.role === 'admin' && req.user.id !== adminId) {
                throw new apiError(403, "Unauthorized access to other admin's patients");
            }

            const patients = await pool.query(
                `SELECT 
          p.id, p.first_name, p.last_name, p.phone, p.admitted_at, p.discharged_at, p.folder_id, p.created_at,
          u.id as hospital_id, u.first_name as hospital_first_name, u.last_name as hospital_last_name,
          ha.can_view, ha.can_edit, ha.can_discharge
         FROM patients p
         JOIN users u ON p.hospital_id = u.id
         JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
         WHERE ha.admin_id = $1 AND ha.is_active = true
         ORDER BY p.admitted_at DESC`,
                [adminId]
            );

            res.status(200).json(
                new apiResponse(200, patients.rows, 'Successfully fetched admin patients')
            );
        }
    )

    // Update permission levels for an admin on a hospital
    updateHospitalPermissions = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId, hospitalId, canView, canEdit, canDischarge } = req.body;

            if (!adminId || !hospitalId) {
                throw new apiError(400, 'Admin ID and Hospital ID are required');
            }

            const result = await pool.query(
                `UPDATE hospital_assignments 
         SET can_view = COALESCE($3, can_view),
             can_edit = COALESCE($4, can_edit),
             can_discharge = COALESCE($5, can_discharge)
         WHERE admin_id = $1 AND hospital_id = $2
         RETURNING *`,
                [adminId, hospitalId, canView, canEdit, canDischarge]
            );

            if (result.rowCount === 0) {
                throw new apiError(404, 'Hospital assignment not found');
            }

            res.status(200).json(
                new apiResponse(200, result.rows[0], 'Permissions updated successfully')
            );
        }
    )
}

export default adminController
