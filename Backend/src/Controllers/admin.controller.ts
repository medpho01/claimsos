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
            )
            res.status(200).json(
                new apiResponse(
                    200,
                    admins.rows,
                    'Successfully fetched all admins'
                )
            )
        }
    )

    // Assign a hospital to an admin
    assignHospitalToAdmin = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const {
                adminId,
                hospitalId,
                canView,
                canEdit,
                canDischarge,
                role,
            } = req.body
            const superadminId = req.user?.id

            if (!adminId || !hospitalId) {
                throw new apiError(400, 'Admin ID and Hospital ID are required')
            }

            // Verify user exists
            const adminCheck = await pool.query(
                "SELECT id FROM users WHERE id = $1 and role = 'admin'",
                [adminId]
            )
            if (adminCheck.rowCount === 0) {
                throw new apiError(404, 'Admin user not found')
            }

            // Verify hospital exists and has hospital role
            const hospitalCheck = await pool.query(
                'SELECT id FROM hospitals WHERE id = $1',
                [hospitalId]
            )
            if (hospitalCheck.rowCount === 0) {
                throw new apiError(404, 'Hospital not found')
            }

            // Create assignment
            const assignment = await pool.query(
                `INSERT INTO hospital_assignments (admin_id, hospital_id, assigned_by, can_view, can_edit, can_discharge,role)
         VALUES ($1, $2, $3, $4, $5, $6,$7)
         ON CONFLICT (admin_id, hospital_id) 
         DO UPDATE SET can_view = $4, can_edit = $5, can_discharge = $6, assigned_at = NOW()
         RETURNING *`,
                [
                    adminId,
                    hospitalId,
                    superadminId,
                    canView ?? true,
                    canEdit ?? true,
                    canDischarge ?? true,
                    role ?? ['admin'],
                ]
            )

            res.status(201).json(
                new apiResponse(
                    201,
                    assignment.rows[0],
                    'Hospital assigned to admin successfully'
                )
            )
        }
    )

    // Remove hospital assignment from admin
    removeHospitalAssignment = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId, hospitalId } = req.body

            if (!adminId || !hospitalId) {
                throw new apiError(400, 'Admin ID and Hospital ID are required')
            }

            const result = await pool.query(
                'DELETE FROM hospital_assignments WHERE admin_id = $1 AND hospital_id = $2 RETURNING *',
                [adminId, hospitalId]
            )

            if (result.rowCount === 0) {
                throw new apiError(404, 'Hospital assignment not found')
            }

            res.status(200).json(
                new apiResponse(
                    200,
                    result.rows[0],
                    'Hospital assignment removed successfully'
                )
            )
        }
    )

    // Get all admins managing a specific hospital
    getHospitalAdmins = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { hospitalId } = req.params

            const admins = await pool.query(
                `SELECT 
          u.id, u.username, u.email, u.first_name, u.last_name, u.phone,
          ha.can_view, ha.can_edit, ha.can_discharge, ha.assigned_at, ha.is_active
         FROM hospital_assignments ha
         JOIN users u ON ha.admin_id = u.id
         WHERE ha.hospital_id = $1 AND ha.is_active = true
         ORDER BY ha.assigned_at DESC`,
                [hospitalId]
            )

            res.status(200).json(
                new apiResponse(
                    200,
                    admins.rows,
                    'Successfully fetched hospital admins'
                )
            )
        }
    )

    // Get all patients accessible by a specific admin
    getAdminPatients = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId } = req.params

            // Security check: Admins can only view their own patients
            if (req.user?.role === 'admin' && req.user.id !== adminId) {
                throw new apiError(
                    403,
                    "Unauthorized access to other admin's patients"
                )
            }

            const patients = await pool.query(
                `SELECT 
          p.id, p.first_name, p.last_name, p.phone, p.admitted_at, p.discharged_at, p.folder_id, p.created_at, p.admission_type,
          u.id as hospital_id, u.name as hospital_name,
          ha.can_view, ha.can_edit, ha.can_discharge
         FROM ipds p
         JOIN users u ON p.hospital_id = u.id
         JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
         WHERE ha.admin_id = $1 AND ha.is_active = true
         ORDER BY p.admitted_at DESC`,
                [adminId]
            )

            res.status(200).json(
                new apiResponse(
                    200,
                    patients.rows,
                    'Successfully fetched admin patients'
                )
            )
        }
    )

    // Update permission levels for an admin on a hospital
    updateHospitalPermissions = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { adminId, hospitalId, canView, canEdit, canDischarge } =
                req.body

            if (!adminId || !hospitalId) {
                throw new apiError(400, 'Admin ID and Hospital ID are required')
            }

            const result = await pool.query(
                `UPDATE hospital_assignments 
         SET can_view = COALESCE($3, can_view),
             can_edit = COALESCE($4, can_edit),
             can_discharge = COALESCE($5, can_discharge)
         WHERE admin_id = $1 AND hospital_id = $2
         RETURNING *`,
                [adminId, hospitalId, canView, canEdit, canDischarge]
            )

            if (result.rowCount === 0) {
                throw new apiError(404, 'Hospital assignment not found')
            }

            res.status(200).json(
                new apiResponse(
                    200,
                    result.rows[0],
                    'Permissions updated successfully'
                )
            )
        }
    )

    getAdminHospitals = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { adminId } = req.params

        if (!adminId) {
            throw new apiError(400, 'Admin ID is required')
        }

        const result = await pool.query(
            `SELECT DISTINCT hu.admin_id as admin_id,hu.hospital_id as hospital_id,hu.can_view as can_view,hu.can_edit as can_edit,hu.can_discharge as can_discharge,h.name as name, h.city as city, h.details as details from hospital_assignments hu JOIN hospitals h ON hu.hospital_id = h.id where admin_id = $1`,
            [adminId]
        )

        if (result.rowCount === 0) {
            res.status(200).json(
                new apiResponse(
                    200,
                    [],
                    'Hospitals fetched successfully'
                )
            )
        }

        res.status(200).json(
            new apiResponse(
                200,
                result.rows,
                'Hospitals fetched successfully'
            )
        )
    });

    // Get system-wide statistics for SuperAdmin Dashboard
    getSystemStats = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            // Parallelize queries for performance
            const [hospitalCount, patientCount, activePatientCount, recentActivity, adminCount] = await Promise.all([
                pool.query('SELECT COUNT(*) FROM hospitals'),
                pool.query('SELECT COUNT(*) FROM ipds'),
                pool.query("SELECT COUNT(*) FROM ipds WHERE is_active = true"),
                pool.query(`
                    (
                        SELECT p.created_at, p.updated_at, p.first_name, p.last_name, 
                               h.name as hospital_name, 'admitted' as type,
                               p.created_at as event_time
                        FROM ipds p
                        JOIN hospitals h ON p.hospital_id = h.id
                        ORDER BY p.created_at DESC
                        LIMIT 5
                    )
                    UNION ALL
                    (
                        SELECT p.created_at, p.updated_at, p.first_name, p.last_name, 
                               h.name as hospital_name, 'updated' as type,
                               p.updated_at as event_time
                        FROM ipds p
                        JOIN hospitals h ON p.hospital_id = h.id
                        WHERE p.updated_at != p.created_at
                        ORDER BY p.updated_at DESC
                        LIMIT 5
                    )
                    ORDER BY event_time DESC
                    LIMIT 5
                `),
                pool.query("SELECT COUNT(*) FROM users WHERE role = 'admin'")
            ]);

            const stats = {
                totalHospitals: parseInt(hospitalCount.rows[0].count),
                totalPatients: parseInt(patientCount.rows[0].count),
                activePatients: parseInt(activePatientCount.rows[0].count),
                totalAdmins: parseInt(adminCount.rows[0].count),
                recentActivity: recentActivity.rows.map(row => ({
                    ...row,
                    type: row.type
                }))
            };

            res.status(200).json(
                new apiResponse(
                    200,
                    stats,
                    'Successfully fetched system stats'
                )
            );
        }
    )
}

export default adminController
