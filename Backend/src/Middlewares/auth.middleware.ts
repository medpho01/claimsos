import { pool } from '../DB/db.js'
import jwt from 'jsonwebtoken'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'

type DecodedToken = {
  id: string
  userName: string
  role: string
}

declare global {
  namespace Express {
    interface Request {
      user?: any
    }
  }
}

export default class authMiddleware {
  // Generic auth check - allows any valid user
  checkAuth = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const oldAccessToken = req.headers['authorization']?.split(' ')[1]
        if (!oldAccessToken)
          throw new apiError(401, 'Unauthorized request. Access token missing.')
        const decoded = jwt.verify(
          oldAccessToken,
          process.env.ACCESS_TOKEN_SECRET!
        ) as DecodedToken
        const userResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE id = $1',
          [decoded.id]
        )
        if (userResult.rowCount === 0) {
          throw new apiError(401, 'Invalid Access Token. User does not exist.')
        }
        req.user = userResult.rows[0]
        next()
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          throw new apiError(401, 'Access token expired')
        }
        throw error
      }
    }
  )

  checkHospital = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const oldAccessToken = req.headers['authorization']?.split(' ')[1]
        if (!oldAccessToken)
          throw new apiError(401, 'Unauthorized request. Access token missing.')
        const decoded = jwt.verify(
          oldAccessToken,
          process.env.ACCESS_TOKEN_SECRET!
        ) as DecodedToken
        const userResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE id = $1',
          [decoded.id]
        )
        if (userResult.rowCount === 0) {
          throw new apiError(401, 'Invalid Access Token. User does not exist.')
        }
        const user = userResult.rows[0]
        // Allow superadmin, admin, and hospital users
        if (
          user.role !== 'hospital' &&
          user.role !== 'superadmin' &&
          user.role !== 'admin'
        ) {
          throw new apiError(403, 'Unauthorized: Hospital access required')
        }
        req.user = user
        next()
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          throw new apiError(401, 'Access token expired')
        }
        throw error
      }
    }
  )

  checkSuperAdmin = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const oldAccessToken = req.headers['authorization']?.split(' ')[1]
        if (!oldAccessToken)
          throw new apiError(401, 'Unauthorized request. Access token missing.')
        const decoded = jwt.verify(
          oldAccessToken,
          process.env.ACCESS_TOKEN_SECRET!
        ) as DecodedToken
        const userResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE id = $1',
          [decoded.id]
        )
        if (userResult.rowCount === 0) {
          throw new apiError(401, 'Invalid Access Token. User does not exist.')
        }
        const user = userResult.rows[0]
        if (user.role != 'superadmin')
          throw new apiError(403, 'Unauthorized. Superadmin access required.')
        req.user = user
        next()
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          throw new apiError(401, 'Access token expired')
        }
        throw error
      }
    }
  )

  checkAdmin = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const oldAccessToken = req.headers['authorization']?.split(' ')[1]
        if (!oldAccessToken)
          throw new apiError(401, 'Unauthorized request. Access token missing.')
        const decoded = jwt.verify(
          oldAccessToken,
          process.env.ACCESS_TOKEN_SECRET!
        ) as DecodedToken
        const userResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE id = $1',
          [decoded.id]
        )
        if (userResult.rowCount === 0) {
          throw new apiError(401, 'Invalid Access Token. User does not exist.')
        }
        const user = userResult.rows[0]
        if (user.role != 'admin')
          throw new apiError(403, 'Unauthorized. Admin access required.')
        req.user = user
        next()
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          throw new apiError(401, 'Access token expired')
        }
        throw error
      }
    }
  )

  // allows both superadmin and admin roles
  checkSuperAdminOrAdmin = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const oldAccessToken = req.headers['authorization']?.split(' ')[1]
        if (!oldAccessToken)
          throw new apiError(401, 'Unauthorized request. Access token missing.')
        const decoded = jwt.verify(
          oldAccessToken,
          process.env.ACCESS_TOKEN_SECRET!
        ) as DecodedToken
        const userResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE id = $1',
          [decoded.id]
        )
        if (userResult.rowCount === 0) {
          throw new apiError(401, 'Invalid Access Token. User does not exist.')
        }
        const user = userResult.rows[0]
        if (user.role !== 'superadmin' && user.role !== 'admin') {
          throw new apiError(
            403,
            'Unauthorized. Superadmin or Admin access required.'
          )
        }
        req.user = user
        next()
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          throw new apiError(401, 'Access token expired')
        }
        throw error
      }
    }
  )

  // Allows superadmin, admin, and hospital users with proper panel access to view patient data
  checkPatientViewAccess = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const oldAccessToken = req.headers['authorization']?.split(' ')[1]
        if (!oldAccessToken)
          throw new apiError(401, 'Unauthorized request. Access token missing.')
        const decoded = jwt.verify(
          oldAccessToken,
          process.env.ACCESS_TOKEN_SECRET!
        ) as DecodedToken
        const userResult = await pool.query(
          'SELECT id, username, email, role FROM users WHERE id = $1',
          [decoded.id]
        )
        if (userResult.rowCount === 0) {
          throw new apiError(401, 'Invalid Access Token. User does not exist.')
        }
        const user = userResult.rows[0]
        req.user = user

        // Superadmin and admin have full access
        if (user.role === 'superadmin' || user.role === 'admin') {
          next()
          return
        }

        // Hospital users need to verify panel access
        if (user.role === 'hospital') {
          const patientId = req.params?.patientId || req.params?.id || req.body?.patientId
          if (!patientId) {
            throw new apiError(400, 'Patient ID is required')
          }

          // Check if hospital user has access to this patient's panel (or has 'admin' role within hospital)
          const accessCheck = await pool.query(
            `SELECT hu.role, p.panel_id 
             FROM hospital_users hu 
             INNER JOIN ipds p ON hu.hospital_id = p.hospital_id 
             WHERE hu.user_id = $1 AND p.id = $2`,
            [user.id, patientId]
          )

          if (accessCheck.rowCount === 0) {
            throw new apiError(403, 'Access denied. You do not have access to this patient.')
          }

          const userRoles = accessCheck.rows[0].role || []
          const patientPanelId = accessCheck.rows[0].panel_id

          // Allow if user has 'admin' role within hospital OR has access to the specific panel
          if (userRoles.includes('admin') || userRoles.includes(patientPanelId)) {
            next()
            return
          }

          throw new apiError(403, 'Access denied. You do not have access to this panel.')
        }

        throw new apiError(403, 'Unauthorized role')
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          throw new apiError(401, 'Access token expired')
        }
        throw error
      }
    }
  )

  // checks patient access via hospital assignment
  checkAdminPermission = (
    permission: 'can_view' | 'can_edit' | 'can_discharge'
  ) => {
    return asyncHandler(
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const userId = req.user?.id
          const userRole = req.user?.role
          const patientId = req.params?.id || req.params?.patientId || req.body?.patientId || req.body?.id;

          if (!userId) throw new apiError(401, 'Unauthorized')

          // Superadmins have access to all patients
          if (userRole === 'superadmin') {
            next()
            return
          }

          // Hospital users can access their own patients
          if (userRole === 'hospital') {
            throw new apiError(403, 'Access denied. Admin access required')
          }

          // Admins need to check via hospital assignment
          if (userRole === 'admin') {
            const accessCheck = await pool.query(
              `SELECT ha.${permission} 
               FROM ipds p
               JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
               WHERE p.id = $1 AND ha.admin_id = $2`,
              [patientId, userId]
            )
            if (
              accessCheck.rowCount === 0 ||
              !accessCheck.rows[0][permission]
            ) {
              throw new apiError(
                403,
                `Access denied. Missing ${permission} permission.`
              )
            }
            next()
            return
          }

          throw new apiError(403, 'Unauthorized role')
        } catch (error) {
          throw error
        }
      }
    )
  }


  checkHospitalUserPermission = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user?.id
        const userRole = req.user?.role
        const patientId = req.params?.id || req.params?.patientId || req.body?.patientId || req.body?.id

        if (!userId) throw new apiError(401, 'Unauthorized')
        if (!patientId) throw new apiError(400, "Patient id is required");

        if (userRole == 'superadmin') {
          next();
          return;
        }
        // Hospital users can access their own patients
        if (userRole != 'hospital') {
          throw new apiError(403, 'Access denied.')
        }

        const result = await pool.query(
          'SELECT hu.role, hu.hospital_id, hu.user_id, p.panel_id FROM hospital_users hu INNER JOIN ipds p ON hu.hospital_id = p.hospital_id WHERE hu.user_id = $1 AND p.id = $2',
          [userId, patientId]
        )
        // Guard the row deref — without this, a hospital user trying to view
        // a patient in a different hospital would dereference rows[0] on a
        // zero-row result and 500 (Cannot read properties of undefined)
        // instead of returning 403. Fail closed.
        if (result.rowCount === 0) {
          throw new apiError(403, 'Forbidden');
        }
        if (result.rows[0].role?.includes(result.rows[0].panel_id)) {
          next();
          return;
        }
        throw new apiError(403, 'Forbidden');
      } catch (error) {
        throw error
      }
    }
  )


  checkPatientEditAccess = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userRole = req.user?.role

        if (userRole === 'superadmin') {
          return next()
        }

        if (userRole === 'admin') {
          // Use the existing checkAdminPermission logic for admins
          return this.checkAdminPermission('can_edit')(req, res, next)
        }

        if (userRole === 'hospital') {
          // Use the existing checkHospitalUserPermission logic for hospital users
          return this.checkHospitalUserPermission(req, res, next)
        }

        throw new apiError(403, 'Unauthorized role')
      } catch (error) {
        throw error
      }
    }
  )

  /**
   * Tenant-isolation gate for `:hospitalId`-scoped routes.
   *
   * Must run AFTER `checkAuth` (which sets `req.user`). Allows:
   *   - superadmin: unrestricted
   *   - admin: only if hospital_assignments(admin_id, hospital_id) exists
   *   - hospital: only if hospital_users(user_id, hospital_id) exists
   * Anything else (doctor self-service, missing role, no row): 403.
   *
   * Backend review C2/C3/H16/M31 — the new hospital-profile / attribute /
   * document / panel-attribute / public-share routes were only guarded by
   * `checkAuth`, so any authenticated user could read or mutate any other
   * hospital's data. This middleware closes that gap.
   *
   * The `:hospitalId` URL param is the canonical source; falls back to
   * body.hospitalId for the small number of routes that put it in the body.
   */
  checkHospitalAccess = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id
      const userRole = req.user?.role
      const hospitalId =
        req.params?.hospitalId || req.body?.hospitalId

      if (!userId) throw new apiError(401, 'Unauthorized')
      if (!hospitalId) throw new apiError(400, 'hospitalId is required')

      // Superadmin: full access
      if (userRole === 'superadmin') {
        return next()
      }

      // Admin: must be assigned to this hospital
      if (userRole === 'admin') {
        const r = await pool.query(
          `SELECT 1 FROM hospital_assignments
           WHERE admin_id = $1 AND hospital_id = $2`,
          [userId, hospitalId]
        )
        if (r.rowCount === 0) {
          throw new apiError(403, 'Forbidden — admin is not assigned to this hospital')
        }
        return next()
      }

      // Hospital user: must belong to this hospital
      if (userRole === 'hospital') {
        const r = await pool.query(
          `SELECT 1 FROM hospital_users
           WHERE user_id = $1 AND hospital_id = $2`,
          [userId, hospitalId]
        )
        if (r.rowCount === 0) {
          throw new apiError(403, 'Forbidden — not a member of this hospital')
        }
        return next()
      }

      // Doctor / any other role: not allowed on hospital-scoped routes
      throw new apiError(403, 'Forbidden — role cannot access hospital resources')
    }
  )

  /**
   * Tenant-isolation gate for `:doctorId`-scoped routes.
   *
   * Must run AFTER `checkAuth`. Allows:
   *   - superadmin: unrestricted
   *   - admin: only if the doctor is linked to at least one hospital the
   *     admin is assigned to (hospital_doctors ∩ hospital_assignments)
   *   - hospital: only if the doctor is linked to a hospital the user
   *     belongs to (hospital_doctors ∩ hospital_users)
   * Anything else (doctor self-service or unknown role): 403.
   *
   * Note on doctor self-service: when a doctor self-registers, we don't
   * yet have a clean way to map req.user.id -> doctor.id (the doctor row
   * doesn't store the auth user_id). Until that mapping lands we conservatively
   * block doctor-role from this endpoint. The two existing doctor-self
   * routes (/doctors/me, /doctors/me PUT) don't use :doctorId so they're
   * unaffected.
   *
   * Backend review C1 — companion to checkHospitalAccess.
   */
  checkDoctorAccess = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id
      const userRole = req.user?.role
      const doctorId = req.params?.doctorId

      if (!userId) throw new apiError(401, 'Unauthorized')
      if (!doctorId) throw new apiError(400, 'doctorId is required')

      if (userRole === 'superadmin') {
        return next()
      }

      if (userRole === 'admin') {
        const r = await pool.query(
          `SELECT 1 FROM hospital.hospital_doctors hd
           JOIN hospital_assignments ha
             ON ha.hospital_id = hd.hospital_id
           WHERE hd.doctor_id = $1 AND ha.admin_id = $2
           LIMIT 1`,
          [doctorId, userId]
        )
        if (r.rowCount === 0) {
          throw new apiError(403, 'Forbidden — doctor not in admin-assigned hospital')
        }
        return next()
      }

      if (userRole === 'hospital') {
        const r = await pool.query(
          `SELECT 1 FROM hospital.hospital_doctors hd
           JOIN hospital_users hu
             ON hu.hospital_id = hd.hospital_id
           WHERE hd.doctor_id = $1 AND hu.user_id = $2
           LIMIT 1`,
          [doctorId, userId]
        )
        if (r.rowCount === 0) {
          throw new apiError(403, 'Forbidden — doctor not in your hospital')
        }
        return next()
      }

      throw new apiError(403, 'Forbidden — role cannot access doctor resources')
    }
  )
}
