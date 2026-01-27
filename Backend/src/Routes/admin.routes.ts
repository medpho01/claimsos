import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import adminController from "../Controllers/admin.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const AdminController = new adminController();

// Get all admins and hospitals (superadmin only)
router.route("/admins").get(AuthMiddleware.checkSuperAdmin, AdminController.getAllAdmins);
// router.route("/hospitals").get(AuthMiddleware.checkSuperAdmin, AdminController.getAllHospitals);

// System Stats
router.route("/stats").get(AuthMiddleware.checkSuperAdmin, AdminController.getSystemStats);

// Hospital assignment management (superadmin only)
router.route("/assign-hospital").post(AuthMiddleware.checkSuperAdmin, AdminController.assignHospitalToAdmin);
router.route("/remove-assignment").delete(AuthMiddleware.checkSuperAdmin, AdminController.removeHospitalAssignment);

// Get relationships
// router.route("/admin/:adminId/hospitals").get(AuthMiddleware.checkSuperAdminOrAdmin, AdminController.getAdminHospitals);
router.route("/admin/:adminId/patients").get(AuthMiddleware.checkSuperAdminOrAdmin, AdminController.getAdminPatients);
router.route("/hospital/:hospitalId/admins").get(AuthMiddleware.checkSuperAdmin, AdminController.getHospitalAdmins);

// Update permissions (superadmin only)
router.route("/update-permissions").patch(AuthMiddleware.checkSuperAdmin, AdminController.updateHospitalPermissions);

export default router;
