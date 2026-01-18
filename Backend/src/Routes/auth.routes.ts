import { Router } from "express";
import authController from "../Controllers/auth.controller.js";
import authMiddleware from "../Middlewares/auth.middleware.js";

const router = Router();
const AuthController = new authController();
const AuthMiddleware = new authMiddleware();

router.route("/login").post(AuthController.login);
router.route("/signup").post(AuthMiddleware.checkSuperAdmin,AuthController.signUp);
router.route("/addHospital").post(AuthMiddleware.checkSuperAdmin);
router.route("/refreshAccessToken").post(AuthController.refreshAccessToken);

export default router;