import { pool } from '../DB/db.js'
import jwt from 'jsonwebtoken'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import { getIndianTimeISO } from '../Utils/indianTime.util.js'
import apiResponse from '../Utils/apiResponse.util.js'

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
        req.user = user
        next();
        
      } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
          throw new apiError(401, 'Access token expired')
        }
        throw new apiError(401, 'Invalid Access Token')
      }
    }
  )
}
