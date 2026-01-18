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

  // checks patient access via hospital assignment
  checkAdminPermission = (
    permission: 'can_view' | 'can_edit' | 'can_discharge'
  ) => {
    return asyncHandler(
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const userId = req.user?.id
          const userRole = req.user?.role
          const patientId = req.params.id

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
               FROM patients p
               JOIN hospital_assignments ha ON p.hospital_id = ha.hospital_id
               WHERE p.id = $1 AND ha.admin_id = $2 AND ha.is_active = true`,
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
        const patientId = req.params.id||req.params.patientId||req.body.patientId

        if (!userId) throw new apiError(401, 'Unauthorized')
        if(!patientId)throw new apiError(400,"Patient id is required");

        if (userRole == 'superadmin') {
          next();
          return;
        }
        // Hospital users can access their own patients
        if (userRole != 'hospital') {
          throw new apiError(403, 'Access denied.')
        }

        const result = await pool.query(
          'SELECT hu.role, hu.hospital_id, hu.user_id, p.panel_id FROM hospital_users hu INNER JOIN patients p ON hu.hospital_id = p.hospital_id WHERE hu.user_id = $1 AND p.id = $2',
          [userId, patientId]
        )
        if(result.rows[0].role?.includes(result.rows[0].panel_id)){
          next();
          return;
        }
        throw new apiError(403, 'Forbidden');
      } catch (error) {
        throw error
      }
    }
  )
}
