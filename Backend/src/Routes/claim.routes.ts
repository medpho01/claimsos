import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import claimsController from "../Controllers/claims.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const ClaimsController = new claimsController();

// Accessible by both admin and hospital users
router.route("/").post(AuthMiddleware.checkSuperAdminOrAdmin,AuthMiddleware.checkAdminPermission("can_edit"), ClaimsController.addClaim);

export default router;