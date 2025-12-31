import { Router } from "express";
import authController from "../Controllers/auth.controller.js";

const router = Router();
const AuthController = new authController();

router.route("/login").post(AuthController.login);
router.route("/signup").post(AuthController.signUp);
router.route("/refreshAccessToken").post(AuthController.refreshAccessToken);

export default router;