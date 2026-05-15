import { Router } from "express";
import authController from "../Controllers/auth.controller.js";
import authMiddleware from "../Middlewares/auth.middleware.js";

const router = Router();
const AuthController = new authController();
const AuthMiddleware = new authMiddleware();

router.route("/login").post(AuthController.login);
router.route("/signup").post(AuthMiddleware.checkSuperAdmin,AuthController.signUp);
router.route("/refreshAccessToken").post(AuthController.refreshAccessToken);

// Sprint 1A: wire the per-device handlers Agent F landed in auth.controller.ts.
// /me returns the caller's user record + a capabilities map derived from their
// role + live DB lookups (hospital_assignments / hospital_users). /logout is
// idempotent and revokes only the matching refresh-token row (per-device).
router.route("/me").get(AuthMiddleware.checkAuth, AuthController.me);
router.route("/logout").post(AuthController.logout);

export default router;