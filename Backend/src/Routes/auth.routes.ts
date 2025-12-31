import { Router } from "express";
import authController from "../Controllers/auth.controller.js";
import authMiddleware from "../Middlewares/auth.middleware.js";

const router = Router();
const AuthController = new authController();
const AuthMiddleware = new authMiddleware(); 

router.route("/login").post(AuthController.login);
router.route("/signup").post(AuthMiddleware.checkAdmin,AuthController.signUp);
router.route("/refreshAccessToken").post(AuthController.refreshAccessToken);

export default router;