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

const DriveHandler = new driveHandler();
const FileName = new fileName();

class authController {
  login = asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const { userName, passWord } = req.body
      if (userName.includes('-') || passWord.includes('-'))
        throw new apiError(401, 'Incorrect credentials')
      if (!userName || !passWord)
        throw new apiError(401, 'Both username and password are required')
      const userResult = await pool.query(
        'select id,username,password,role from users where username = $1',
        [userName]
      )
      if (userResult.rowCount == 0) throw new apiError(401, 'No user found')
      const user = userResult.rows[0]
      const pass = user.password
      const isPassCorrect = await bcrypt.compare(passWord, pass)
      if (!isPassCorrect) throw new apiError(401, 'Wrong password')
      const loginTime = getIndianTimeISO()

      const accessToken = generateAccessToken(user.id, userName, user.role)
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
      const { userName, firstName, role, email, phone, lastName, passWord, hospitalGroupId } =
        req.body
      const details = [userName, firstName, role, phone, passWord]
      if (
        details.some((att: any) => att == null || att == undefined || att == '')
      )
        throw new apiError(401, 'Provide all required details')

      const userResults = await pool.query(
        'select id from users where username = $1 OR email = $2 OR phone = $3',
        [userName, email, phone]
      )
      if (userResults.rowCount != 0)
        throw new apiError(401, 'User already exists')

      const password = await bcrypt.hash(passWord, 10)

      const folder = await DriveHandler.createFolder(FileName.folderName(firstName), admin.folder_id);

      await pool.query(
        'insert into users (username, first_name, last_name, password, phone, email, role, folder_id, hospital_group_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [userName, firstName, lastName, password, phone, email, role, folder.fileId, hospitalGroupId]
      )
      const userResult = await pool.query(
        'select id,username,first_name,last_name,role,email,phone,hospital_group_id from users where username = $1',
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
      'SELECT id, phone, first_name, role FROM users WHERE id = $1',
      [userId]
    )
    const user = userResult.rows[0]

    const accessToken = generateAccessToken(user.id, user.username, user.role)

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
