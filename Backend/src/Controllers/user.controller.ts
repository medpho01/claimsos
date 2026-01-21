import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'

class userController {
  // Get all users (for superadmin to see hospital users)
  getAllHospitalUsers = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const adminId = req.user?.id
      const userRole = req.user?.role

      if (!adminId) throw new apiError(401, 'Unauthorized')

      let users

      // Admin users can see all hospital users
      if (userRole === 'superadmin') {
        users = await pool.query(
          `SELECT id, username, email, first_name, last_name, phone, role, is_active, created_at
           FROM users 
           WHERE role = 'hospital'
           ORDER BY created_at DESC`
        )
      }else{
        throw new apiError(401,"Unathorized");
      }
      res
        .status(200)
        .json(new apiResponse(200, users?.rows, 'Successfully fetched users'))
    }
  )

  getAllUsersByHospital = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const adminId = req.user?.id
      const userRole = req.user?.role
      const hospitalId = req.params

      if (!adminId) throw new apiError(401, 'Unauthorized')

      let users

      // Admin users can see all hospital users
      if (userRole === 'superadmin') {
        users = await pool.query(
          `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.role, u.is_active, u.created_at
           FROM users as u join hopital_users as hu on u.id = hu.user_id where hu.hospital_id = $1 and u.role = 'hospital'
           ORDER BY u.created_at DESC`,[hospitalId]
        )
      }else{
        throw new apiError(401,"Unathorized");
      }
      res
        .status(200)
        .json(new apiResponse(200, users?.rows, 'Successfully fetched users'))
    }
  )

  // Get current user info
  getCurrentUser = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const userId = req.user?.id

      if (!userId) throw new apiError(401, 'Unauthorized')

      const userResult = await pool.query(
        'SELECT id, username, email, first_name, last_name, phone, role, is_active FROM users WHERE id = $1',
        [userId]
      )

      if (userResult.rowCount === 0) {
        throw new apiError(404, 'User not found')
      }

      res
        .status(200)
        .json(
          new apiResponse(
            200,
            userResult.rows[0],
            'Successfully fetched user info'
          )
        )
    }
  )

  // Toggle user active status (superadmin only)
  toggleUserStatus = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { userId } = req.params
      const { isActive } = req.body

      const result = await pool.query(
        "UPDATE users SET is_active = $1 WHERE id = $2 AND role = 'hospital' RETURNING id, username, first_name, last_name, is_active",
        [isActive, userId]
      )

      if (result.rowCount === 0) {
        throw new apiError(404, 'User not found or cannot be modified')
      }

      res
        .status(200)
        .json(
          new apiResponse(
            200,
            result.rows[0],
            'User status updated successfully'
          )
        )
    }
  )

  getUserHospitalRoles = asyncHandler(async (req:Request,res:Response,next:NextFunction)=>{
    const user = req.user;
    if(!user)throw new apiError(401,"Unathorized");
    const id = user.id;
    const role = user.role;

    if(role!="hospital")throw new apiError(403,"Forbidden");

    const query = `SELECT p.id AS panel_id, p.name AS panel_name FROM hospital_users as hu CROSS JOIN LATERAL unnest(hu.role) AS role_panel_id JOIN panels p ON p.id = role_panel_id::uuid WHERE hu.user_id = $1`
    const panelResponse = await pool.query(query,[id])

    res.status(200).json(new apiResponse(200,panelResponse.rows,"Successfully fetched panels"));
  })
}

export default userController
