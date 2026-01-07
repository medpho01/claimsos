import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import userController from "../Controllers/user.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const UserController = new userController();

// Accessible by both admin and hospital users
router.route("/me").get(AuthMiddleware.checkHospital, UserController.getCurrentUser);
router.route("/all").get(AuthMiddleware.checkAdmin, UserController.getAllUsers);

// Admin only routes
router.route("/:userId/toggle-status").patch(AuthMiddleware.checkAdmin, UserController.toggleUserStatus);

export default router;