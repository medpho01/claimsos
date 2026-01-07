import { pool } from '../DB/db.js'
import asyncHandler from '../Utils/asyncHandler.util.js'
import type { NextFunction, Request, Response } from 'express'
import apiError from '../Utils/errorHandler.util.js'
import apiResponse from '../Utils/apiResponse.util.js'

class userController {
    // Get all users (for admin to see hospital users they created)
    getAllUsers = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const adminId = req.user?.id;
            const userRole = req.user?.role;

            if (!adminId) throw new apiError(401, "Unauthorized");

            let users;

            // Admin users can see all hospital users
            if (userRole === 'admin') {
                users = await pool.query(
                    `SELECT id, username, email, first_name, last_name, phone, role, is_active, created_at, folder_id
           FROM users 
           WHERE role = 'hospital'
           ORDER BY created_at DESC`
                );
            } else {
                // Hospital users can only see their own info
                users = await pool.query(
                    `SELECT id, username, email, first_name, last_name, phone, role, is_active, created_at, folder_id  
           FROM users 
           WHERE id = $1`,
                    [adminId]
                );
            }

            res.status(200).json(
                new apiResponse(200, users.rows, 'Successfully fetched users')
            );
        }
    )

    // Get current user info
    getCurrentUser = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const userId = req.user?.id;

            if (!userId) throw new apiError(401, "Unauthorized");

            const userResult = await pool.query(
                'SELECT id, username, email, first_name, last_name, phone, role, folder_id, is_active FROM users WHERE id = $1',
                [userId]
            );

            if (userResult.rowCount === 0) {
                throw new apiError(404, 'User not found');
            }

            res.status(200).json(
                new apiResponse(200, userResult.rows[0], 'Successfully fetched user info')
            );
        }
    )

    // Toggle user active status (admin only)
    toggleUserStatus = asyncHandler(
        async (req: Request, res: Response, next: NextFunction) => {
            const { userId } = req.params;
            const { isActive } = req.body;

            const result = await pool.query(
                'UPDATE users SET is_active = $1 WHERE id = $2 AND role = \'hospital\' RETURNING id, username, first_name, last_name, is_active',
                [isActive, userId]
            );

            if (result.rowCount === 0) {
                throw new apiError(404, 'User not found or cannot be modified');
            }

            res.status(200).json(
                new apiResponse(200, result.rows[0], 'User status updated successfully')
            );
        }
    )
}

export default userController
