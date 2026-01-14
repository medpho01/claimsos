import { pool } from '../DB/db.js';
import asyncHandler from '../Utils/asyncHandler.util.js';
import type { Request, Response, NextFunction } from 'express';
import apiError from '../Utils/errorHandler.util.js';
import apiResponse from '../Utils/apiResponse.util.js';

class auditController {
    getLogs = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const { page = 1, limit = 50, action, userId, entityType } = req.query;
        const offset = (Number(page) - 1) * Number(limit);

        // Build query dynamically
        let query = `
      SELECT al.*, u.username, u.first_name, u.last_name, u.role as user_role
      FROM hospital.audit_logs al
      LEFT JOIN hospital.users u ON al.user_id = u.id
      WHERE 1=1
    `;
        const params: any[] = [];
        let paramIndex = 1;

        if (action) {
            query += ` AND al.action = $${paramIndex}`;
            params.push(action);
            paramIndex++;
        }

        if (userId) {
            query += ` AND al.user_id = $${paramIndex}`;
            params.push(userId);
            paramIndex++;
        }

        if (entityType) {
            query += ` AND al.entity_type = $${paramIndex}`;
            params.push(entityType);
            paramIndex++;
        }

        query += ` ORDER BY al.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        // Get total count
        const countResult = await pool.query('SELECT COUNT(*) FROM hospital.audit_logs');

        res.status(200).json(new apiResponse(200, {
            logs: result.rows,
            total: parseInt(countResult.rows[0].count),
            page: Number(page),
            limit: Number(limit)
        }, 'Audit logs fetched successfully'));
    });
}

export default auditController;
