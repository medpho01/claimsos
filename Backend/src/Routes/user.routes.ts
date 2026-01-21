import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import userController from "../Controllers/user.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const UserController = new userController();

// Accessible by both admin and hospital users
router.route("/me").get(AuthMiddleware.checkHospital, UserController.getCurrentUser);
router.route("/all").get(AuthMiddleware.checkSuperAdmin, UserController.getAllHospitalUsers);
router.route("/getHospitalUserRoles").get(AuthMiddleware.checkHospital,UserController.getUserHospitalRoles);
router.route("/getAllUsersByHospital/:hospitalId").get(AuthMiddleware.checkSuperAdminOrAdmin,UserController.getAllUsersByHospital);

// Admin only routes
router.route("/:userId/toggle-status").patch(AuthMiddleware.checkSuperAdmin, UserController.toggleUserStatus);

export default router;