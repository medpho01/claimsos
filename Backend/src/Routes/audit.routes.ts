import { Router } from 'express';
import auditController from '../Controllers/audit.controller.js';
import authMiddleware from '../Middlewares/auth.middleware.js';

const router = Router();
const controller = new auditController();
const auth = new authMiddleware();

// Only SuperAdmin or Admin can view logs
router.get('/', auth.checkSuperAdminOrAdmin, controller.getLogs);

export default router;
