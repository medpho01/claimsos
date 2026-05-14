import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import {
  generateAccessToken,
  generateRefreshToken,
} from '../Utils/tokens.util.js'
import { getIndianTimeISO } from '../Utils/indianTime.util.js'
import apiResponse from '../Utils/apiResponse.util.js'
import driveHandler from '../Services/driveUploader.service.js'
import fileName from '../Utils/fileName.util.js'
import { withTransaction } from '../Utils/transaction.util.js'

const DriveHandler = new driveHandler();
const FileName = new fileName();
import { auditService } from '../Services/audit.service.js';

class authController {
  login = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { userName, passWord } = req.body

      if (!userName || !passWord)
        throw new apiError(400, 'Both username and password are required')

      const cleanUserName = userName.trim();
      const cleanPassWord = passWord.trim();

      if (cleanUserName.includes('-') || cleanPassWord.includes('-'))
        throw new apiError(401, 'Incorrect credentials')
      const userResult = await pool.query(
        `SELECT u.id, u.username, u.password, u.first_name, u.last_name, u.email, u.phone, u.is_active, u.role, hu.hospital_id 
         FROM users u
         LEFT JOIN hospital_users hu ON u.id = hu.user_id
         WHERE u.username = $1`,
        [cleanUserName]
      )
      if (userResult.rowCount == 0) {
        throw new apiError(404, 'No user found')
      }
      const user = userResult.rows[0]
      const pass = user.password // hashed
      const isPassCorrect = await bcrypt.compare(cleanPassWord, pass)
      if (!isPassCorrect) throw new apiError(400, 'Wrong password')
      const loginTime = getIndianTimeISO()

      const accessToken = generateAccessToken(user.id, cleanUserName)
      const { token, expiresAt } = generateRefreshToken()
      const refreshToken = await bcrypt.hash(token, 10)
      const refreshTokenDetails = await pool.query(
        'select user_id,token_hash,expires_at from user_refresh_tokens where user_id = $1',
        [user.id]
      )
      if (refreshTokenDetails.rowCount != 0) {
        await pool.query(
          'update user_refresh_tokens set token_hash = $1 where user_id = $2',
          [refreshToken, refreshTokenDetails.rows[0].user_id]
        )
      } else {
        await pool.query(
          `INSERT INTO user_refresh_tokens (user_id, token_hash, expires_at, created_at) 
             VALUES ($1, $2, $3, $4)`,
          [user.id, refreshToken, expiresAt, loginTime]
        )
      }

      await pool.query('update users set last_login = $1 where id = $2', [
        loginTime,
        user.id,
      ])

      delete user.password

      // TODO: Re-enable when audit_logs table is created
      // await auditService.log({
      //   userId: user.id,
      //   action: 'LOGIN',
      //   entityType: 'user',
      //   entityId: user.id,
      //   details: { role: user.role },
      //   ipAddress: req.ip,
      //   userAgent: req.headers['user-agent'],
      // })

      res.status(200).json(
        new apiResponse(
          200,
          {
            accessToken,
            refreshToken: token,
            user,
          },
          'Login succesful'
        )
      )
    }
  )

  signUp = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const admin = req.user;
      if (!admin) throw new apiError(401, "Unauthorized");
      const { userName, firstName, email, phone, lastName, passWord, role, hospitalId, userRole } = req.body;
      const details = [userName, firstName, passWord]
      if (
        details.some((att: any) => att == null || att == undefined || att == '')
      )
        throw new apiError(400, 'Provide all required details')

      const userResults = await pool.query(
        'select id from users where username = $1 OR email = $2 OR phone = $3',
        [userName, email ?? "404", phone ?? "null"]
      )

      if (userResults.rowCount != 0)
        throw new apiError(400, 'User already exists')

      const password = await bcrypt.hash(passWord, 10);

      if (role == "superadmin") {
        await pool.query(
          'insert into users (username, first_name, last_name, password, phone, email, role) values ($1,$2,$3,$4,$5,$6,$7)',
          [userName, firstName, lastName, password, phone, email, 'superadmin']
        )
      } else if (role == "admin") {
        await pool.query(
          'insert into users (username, first_name, last_name, password, phone, email, role) values ($1,$2,$3,$4,$5,$6,$7)',
          [userName, firstName, lastName, password, phone, email, 'admin']
        )
      } else if (role == "hospital") {
        // BE H5: previously this path called pool.query twice and faked a
        // rollback with a manual DELETE — if the hospital_users INSERT threw
        // (FK violation on hospitalId, NOT NULL on role, etc.) the catch in
        // asyncHandler ran first and the orphaned user row stayed behind.
        // Run both writes through a single client inside BEGIN/COMMIT so a
        // failure on the second insert atomically rolls back the first.
        await withTransaction(async (client) => {
          const userRes = await client.query(
            'insert into users (username, first_name, last_name, password, phone, email, role) values ($1,$2,$3,$4,$5,$6,$7) returning id',
            [userName, firstName, lastName, password, phone, email, 'hospital']
          )
          if (userRes.rowCount == 0)
            throw new apiError(500, "Something went wrong while creating user. Please try again!")
          const id = userRes.rows[0].id;
          const hospitalUserRes = await client.query(
            "insert into hospital_users (hospital_id,user_id,role) values ($1,$2,$3) returning hospital_id",
            [hospitalId, id, userRole]
          );
          if (hospitalUserRes.rowCount == 0)
            throw new apiError(500, "Something went wrong while creating user. Please try again!");
        })
      } else {
        throw new apiError(400, "Provide the user type");
      }

      const userResult = await pool.query(
        'select id,username,first_name,last_name,email,phone from users where username = $1',
        [userName]
      )
      if (userResult.rowCount == 0)
        throw new apiError(500, 'Something went wrong while creating the user')

      const user = userResult.rows[0]

      res
        .status(201)
        .json(new apiResponse(201, user, 'Successfully created new user'))
    }
  )

  refreshAccessToken = asyncHandler(async (req, res) => {
    const { refreshToken } = req.body
    if (!refreshToken) throw new apiError(401, 'Refresh token is required')

    const oldAccessToken = req.headers['authorization']?.split(' ')[1]
    if (!oldAccessToken) throw new apiError(401, 'Old access token is required')

    const decodedOldToken = jwt.decode(oldAccessToken) as any
    const userId = decodedOldToken?.id
    if (!userId) throw new apiError(401, 'Invalid old access token')

    const currentIST = getIndianTimeISO()

    const tokenResult = await pool.query(
      'SELECT user_id,token_hash,expires_at FROM user_refresh_tokens WHERE user_id = $1',
      [userId]
    )

    if (tokenResult.rowCount === 0)
      throw new apiError(401, 'No refresh tokens found. Please log in again.')
    const tokenDetails = tokenResult.rows[0]
    const isTokenValid = await bcrypt.compare(
      refreshToken,
      tokenDetails.token_hash
    )
    if (!isTokenValid)
      throw new apiError(401, 'Refresh token is not valid. Please login again.')

    if (tokenDetails.expires_at < currentIST)
      throw new apiError(401, 'Refresh token expired. Please login again.')

    const userResult = await pool.query(
      'SELECT id, username, first_name, last_name, email, phone, is_active FROM users WHERE id = $1',
      [userId]
    )
    if (userResult.rowCount == 0) throw new apiError(404, "No user found");
    const user = userResult.rows[0]

    const accessToken = generateAccessToken(user.id, user.username)

    res.status(200).json(
      new apiResponse(
        200,
        {
          accessToken,
          refreshToken,
          user,
        },
        'Access token refreshed successfully'
      )
    )
  })
}

export default authController
