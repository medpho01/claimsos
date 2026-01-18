import { pool } from '../DB/db.js';

export interface AuditLogParams {
    userId: string | null | undefined;
    action: string;
    entityType?: string | null | undefined;
    entityId?: string | null | undefined;
    details?: Record<string, any> | null | undefined;
    ipAddress?: string | null | undefined;
    userAgent?: string | null | undefined;
}

export class AuditService {
    /**
     * Logs an action to the audit_logs table.
          */
    async log(params: AuditLogParams): Promise<void> {
        const { userId, action, entityId, entityType, details, ipAddress, userAgent } = params;

        try {
           
            const detailsJson = details ? JSON.stringify(details) : null;

            await pool.query(
                `INSERT INTO hospital.audit_logs 
        (user_id, action, entity_type, entity_id, details, ip_address, user_agent) 
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [userId, action, entityType || null, entityId || null, detailsJson, ipAddress || null, userAgent || null]
            );
        } catch (error) {
            console.error('[AuditService] Failed to log action:', error);
           
        }
    }
}

export const auditService = new AuditService();
