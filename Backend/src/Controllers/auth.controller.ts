import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
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
        await auditService.log({
          userId: null,
          action: 'LOGIN_FAILED',
          entityType: 'user',
          details: { reason: 'no_such_user', username: cleanUserName },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        })
        throw new apiError(404, 'No user found')
      }
      const user = userResult.rows[0]
      const pass = user.password // hashed
      const isPassCorrect = await bcrypt.compare(cleanPassWord, pass)
      if (!isPassCorrect) {
        await auditService.log({
          userId: user.id,
          action: 'LOGIN_FAILED',
          entityType: 'user',
          entityId: user.id,
          details: { reason: 'wrong_password', username: cleanUserName },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        })
        throw new apiError(400, 'Wrong password')
      }
      const loginTime = getIndianTimeISO()

      // BE M19 + prod-readiness #2: per-device refresh-token rotation with an
      // explicit deviceId so the refresh path can do an indexed (user_id,
      // device_id) lookup instead of bcrypt-scanning every row for the user.
      //
      // Migration 011 added `device_id UUID`, `user_agent TEXT`, `last_used_at`
      // plus a partial-unique index on (user_id, device_id) WHERE device_id
      // IS NOT NULL. We mint a fresh deviceId per login here, embed it as a
      // claim in the access token, and stamp the user_agent on the row for
      // a future "active sessions" UI. Tokens minted before this change have
      // no deviceId — refreshAccessToken falls back to the legacy bcrypt
      // scan for those.
      const deviceId = uuidv4()
      const accessToken = generateAccessToken(user.id, cleanUserName, deviceId)
      const { token, expiresAt } = generateRefreshToken()
      const refreshToken = await bcrypt.hash(token, 10)
      await pool.query(
        `INSERT INTO user_refresh_tokens
           (user_id, token_hash, expires_at, created_at, device_id, user_agent, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $4)`,
        [
          user.id,
          refreshToken,
          expiresAt,
          loginTime,
          deviceId,
          req.headers['user-agent']?.toString().slice(0, 500) ?? null,
        ]
      )

      await pool.query('update users set last_login = $1 where id = $2', [
        loginTime,
        user.id,
      ])

      delete user.password

      // Sprint 1B: audit_logs table exists (migration 010) and auditService
      // is wired but had no callers — every security-relevant event needs to
      // leave a trail. Login success is the first hook.
      await auditService.log({
        userId: user.id,
        action: 'LOGIN_SUCCESS',
        entityType: 'user',
        entityId: user.id,
        details: { role: user.role, username: user.username },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      })

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

  // BE M19: refresh-token rotation. The previous implementation
  //   (1) only stored ONE token per user (clobbering other devices), and
  //   (2) re-returned the SAME refresh token to the client on every refresh,
  // so a leaked refresh token was usable for the full expiry window. Now we
  // verify the presented token against the user's rows, delete the matching
  // row, and issue a brand-new refresh token in its place — all inside a
  // single transaction so a crash mid-rotation can't leave the device in a
  // half-rotated state. Response SHAPE is unchanged (the frontend reads
  // `accessToken` from `data` and tolerates the `refreshToken` field being
  // either the old or the new value), so live browser sessions survive.
  refreshAccessToken = asyncHandler(async (req, res) => {
    const { refreshToken } = req.body
    if (!refreshToken) throw new apiError(401, 'Refresh token is required')

    const oldAccessToken = req.headers['authorization']?.split(' ')[1]
    if (!oldAccessToken) throw new apiError(401, 'Old access token is required')

    const decodedOldToken = jwt.decode(oldAccessToken) as any
    const userId = decodedOldToken?.id
    if (!userId) throw new apiError(401, 'Invalid old access token')
    const deviceId: string | undefined = decodedOldToken?.deviceId

    const currentIST = getIndianTimeISO()

    // Prod-readiness #2: fast path when the access token carries a deviceId
    // claim. Migration 011's partial-unique index on (user_id, device_id)
    // gives us an O(1) lookup; we still bcrypt-compare the candidate hash
    // (otherwise possessing any access token would forge a refresh), but
    // we do it exactly once instead of once per device. Tokens minted
    // before this change have no deviceId — fall back to the legacy scan.
    let matchedHash: string | null = null
    let matchedExpiresAt: Date | null = null

    if (deviceId) {
      const fast = await pool.query(
        'SELECT token_hash, expires_at FROM user_refresh_tokens WHERE user_id = $1 AND device_id = $2',
        [userId, deviceId]
      )
      if ((fast.rowCount ?? 0) > 0) {
        const row = fast.rows[0]
        const ok = await bcrypt.compare(refreshToken, row.token_hash)
        if (ok) {
          matchedHash = row.token_hash
          matchedExpiresAt = row.expires_at
        }
      }
    }

    if (!matchedHash) {
      // Legacy O(N) bcrypt scan path: only fires for sessions that pre-date
      // the deviceId rollout. Once those refresh tokens age out (7 days
      // default) this branch becomes dead code and can be removed.
      const tokenResult = await pool.query(
        'SELECT user_id, token_hash, expires_at FROM user_refresh_tokens WHERE user_id = $1 AND device_id IS NULL',
        [userId]
      )
      for (const row of tokenResult.rows) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await bcrypt.compare(refreshToken, row.token_hash)
        if (ok) {
          matchedHash = row.token_hash
          matchedExpiresAt = row.expires_at
          break
        }
      }
    }

    if (!matchedHash || !matchedExpiresAt)
      throw new apiError(401, 'Refresh token is not valid. Please login again.')

    // expires_at comes back as a Date from pg; compare via timestamps so we
    // don't rely on the implicit string/Date coercion the old code used.
    if (new Date(matchedExpiresAt).getTime() < Date.now())
      throw new apiError(401, 'Refresh token expired. Please login again.')

    const userResult = await pool.query(
      'SELECT id, username, first_name, last_name, email, phone, is_active FROM users WHERE id = $1',
      [userId]
    )
    if (userResult.rowCount == 0) throw new apiError(404, 'No user found')
    const user = userResult.rows[0]

    // Rotate atomically: delete the consumed row + insert the new one inside
    // BEGIN/COMMIT so a crash between the two statements can't leave the user
    // with zero active refresh tokens (forced relogin) or two (token reuse).
    const { token: newRefreshRaw, expiresAt: newExpiresAt } =
      generateRefreshToken()
    const newRefreshHash = await bcrypt.hash(newRefreshRaw, 10)

    await withTransaction(async (client) => {
      const deleted = await client.query(
        'DELETE FROM user_refresh_tokens WHERE user_id = $1 AND token_hash = $2',
        [userId, matchedHash]
      )
      // If the row vanished between SELECT and DELETE (concurrent refresh
      // from the same device), treat it as a reuse attempt and refuse —
      // a rotated token must be single-use.
      if (deleted.rowCount === 0) {
        throw new apiError(
          401,
          'Refresh token already used. Please login again.'
        )
      }
      // Preserve device_id on the rotated row so the next refresh hits the
      // indexed (user_id, device_id) lookup again. Also bumps last_used_at
      // so a future cron sweeper can GC stale sessions.
      await client.query(
        `INSERT INTO user_refresh_tokens
           (user_id, token_hash, expires_at, created_at, device_id, user_agent, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $4)`,
        [
          userId,
          newRefreshHash,
          newExpiresAt,
          currentIST,
          deviceId ?? null,
          req.headers['user-agent']?.toString().slice(0, 500) ?? null,
        ]
      )
    })

    const accessToken = generateAccessToken(user.id, user.username, deviceId)

    res.status(200).json(
      new apiResponse(
        200,
        {
          accessToken,
          refreshToken: newRefreshRaw,
          user,
        },
        'Access token refreshed successfully'
      )
    )
  })

  /**
   * FE C6 (server side) — capability flags so the frontend stops trusting
   * `user.role` echoed from localStorage for routing decisions.
   *
   * Auth: must run behind `checkAuth` (the middleware sets `req.user`).
   * The frontend then reads `capabilities.*` to decide which routes to
   * mount — the role string in the payload is informational only.
   *
   * Capabilities are derived SERVER-SIDE from the role + live DB lookups
   * (hospital_assignments, hospital_users). That's the whole point —
   * we never trust a flag the client could mint.
   *
   * Response:
   *   {
   *     user: { id, username, email, role },
   *     capabilities: {
   *       canManageHospitals, canManageAdmins, canViewAllPatients,
   *       canEditOwnHospital, canDischargePatients, canManagePanels,
   *       canViewAuditLogs, assignedHospitalIds[]
   *     }
   *   }
   *
   * ROUTING TODO (for whoever owns auth.routes.ts):
   *   router.route("/me").get(AuthMiddleware.checkAuth, AuthController.me)
   * The handler is exported on the controller class. Until the route is
   * wired the endpoint is unreachable — harmless to ship.
   */
  me = asyncHandler(async (req: Request, res: Response) => {
    const authUser = req.user
    if (!authUser?.id) throw new apiError(401, 'Unauthorized')

    // Always re-pull from DB. The JWT can be stale (role demoted, account
    // disabled) — we treat the DB as source of truth.
    const userResult = await pool.query(
      'SELECT id, username, email, role, is_active FROM users WHERE id = $1',
      [authUser.id]
    )
    if (userResult.rowCount === 0)
      throw new apiError(401, 'User no longer exists')

    const user = userResult.rows[0]
    if (user.is_active === false)
      throw new apiError(403, 'Account is disabled')

    const role = user.role as string

    // Default-deny: every capability starts false and only flips on for
    // roles that should have it. Easier to reason about than a default-allow
    // mask.
    const capabilities = {
      canManageHospitals: false,
      canManageAdmins: false,
      canViewAllPatients: false,
      canEditOwnHospital: false,
      canDischargePatients: false,
      canManagePanels: false,
      canViewAuditLogs: false,
      assignedHospitalIds: [] as string[],
    }

    if (role === 'superadmin') {
      capabilities.canManageHospitals = true
      capabilities.canManageAdmins = true
      capabilities.canViewAllPatients = true
      capabilities.canEditOwnHospital = true
      capabilities.canDischargePatients = true
      capabilities.canManagePanels = true
      capabilities.canViewAuditLogs = true
    } else if (role === 'admin') {
      // Admins can act on the hospitals they're assigned to. Aggregate the
      // can_edit / can_discharge flags across all their assignments — if
      // they can edit ANY hospital they get the capability; the per-route
      // tenant gates (checkHospitalAccess etc) still enforce which specific
      // hospital each call is allowed to touch.
      const assignResult = await pool.query(
        `SELECT hospital_id, can_view, can_edit, can_discharge
           FROM hospital_assignments
          WHERE admin_id = $1`,
        [user.id]
      )
      const rows = assignResult.rows
      capabilities.assignedHospitalIds = rows.map((r: any) => r.hospital_id)
      capabilities.canViewAllPatients = rows.some((r: any) => r.can_view)
      capabilities.canEditOwnHospital = rows.some((r: any) => r.can_edit)
      capabilities.canDischargePatients = rows.some(
        (r: any) => r.can_discharge
      )
      capabilities.canManagePanels = capabilities.canEditOwnHospital
    } else if (role === 'hospital') {
      // Hospital users can only see their own patients; what they can do
      // is gated by their per-panel role array, but at the top level the
      // capability is "scoped to my hospital". We surface the hospital ids
      // so the FE can route them straight to their hospital view.
      const huResult = await pool.query(
        `SELECT hospital_id, role FROM hospital_users WHERE user_id = $1`,
        [user.id]
      )
      capabilities.assignedHospitalIds = huResult.rows.map(
        (r: any) => r.hospital_id
      )
      capabilities.canViewAllPatients = huResult.rowCount! > 0
      // "admin" inside hospital_users.role[] means the hospital-side admin
      // (front-desk lead etc), not the global admin role.
      const hasHospitalAdmin = huResult.rows.some((r: any) =>
        Array.isArray(r.role) ? r.role.includes('admin') : false
      )
      capabilities.canEditOwnHospital = hasHospitalAdmin
      capabilities.canManagePanels = hasHospitalAdmin
    }
    // Any other role (doctor, etc): all capabilities stay false.

    res.status(200).json(
      new apiResponse(
        200,
        {
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
          },
          capabilities,
        },
        'Current user'
      )
    )
  })

  /**
   * BE M19 — Logout invalidates ONLY the current device's refresh token.
   *
   * The old flow had no logout endpoint, so client-side logout just cleared
   * localStorage and left the refresh-token row alive in the DB. Now the
   * client posts the refresh token here and we revoke that specific row,
   * leaving other devices logged in.
   *
   * Body: `{ refreshToken: string }`. Returns 200 even if the token doesn't
   * match (logout should be idempotent — telling an attacker which tokens
   * exist is worse than silently succeeding).
   *
   * ROUTING TODO (for whoever owns auth.routes.ts): wire
   *   router.route("/logout").post(AuthController.logout)
   * The handler is exported as part of the controller class, so adding the
   * route is a one-liner. Until then this endpoint is reachable only via
   * direct controller invocation — harmless to ship.
   */
  logout = asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body ?? {}
    if (!refreshToken) {
      // Idempotent: nothing to revoke client-side beyond clearing storage.
      res.status(200).json(new apiResponse(200, null, 'Logged out'))
      return
    }

    const oldAccessToken = req.headers['authorization']?.split(' ')[1]
    const decoded = oldAccessToken ? (jwt.decode(oldAccessToken) as any) : null
    const userId = decoded?.id
    const deviceId: string | undefined = decoded?.deviceId

    if (!userId) {
      // Without a user-id hint we can't bcrypt-scan a sensible subset of
      // rows, and we will not scan the whole table. Treat as success.
      res.status(200).json(new apiResponse(200, null, 'Logged out'))
      return
    }

    // Prod-readiness #2: fast path when the access token carries a deviceId.
    // Single indexed row lookup + DELETE instead of bcrypt-scanning every
    // refresh row this user owns.
    let revoked = false
    if (deviceId) {
      const fast = await pool.query(
        'SELECT token_hash FROM user_refresh_tokens WHERE user_id = $1 AND device_id = $2',
        [userId, deviceId]
      )
      if ((fast.rowCount ?? 0) > 0) {
        const ok = await bcrypt.compare(refreshToken, fast.rows[0].token_hash)
        if (ok) {
          await pool.query(
            'DELETE FROM user_refresh_tokens WHERE user_id = $1 AND device_id = $2',
            [userId, deviceId]
          )
          revoked = true
        }
      }
    }

    if (!revoked) {
      // Legacy scan path: pre-deviceId sessions. Restricted to rows where
      // device_id IS NULL so we don't also re-scan device-tagged rows that
      // belong to other sessions.
      const tokenResult = await pool.query(
        'SELECT token_hash FROM user_refresh_tokens WHERE user_id = $1 AND device_id IS NULL',
        [userId]
      )
      for (const row of tokenResult.rows) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await bcrypt.compare(refreshToken, row.token_hash)
        if (ok) {
          await pool.query(
            'DELETE FROM user_refresh_tokens WHERE user_id = $1 AND token_hash = $2',
            [userId, row.token_hash]
          )
          revoked = true
          break
        }
      }
    }

    // Sprint 1B — leave an audit trail. We don't surface to the client
    // whether a row was actually found (don't leak token shape), but we
    // do record it for ops.
    await auditService.log({
      userId,
      action: 'LOGOUT',
      entityType: 'user',
      entityId: userId,
      details: { revoked },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    })

    res.status(200).json(new apiResponse(200, null, 'Logged out'))
  })
}

export default authController
