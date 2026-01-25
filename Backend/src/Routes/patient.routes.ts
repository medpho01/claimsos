import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import patientController from "../Controllers/patient.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const PatientController = new patientController();

router.route("/addPatient").post(AuthMiddleware.checkAuth, PatientController.addPatient);
router.route("/getAllPatients").get(AuthMiddleware.checkAuth, PatientController.getAllPatients);
router.route("/getActivePatients").get(AuthMiddleware.checkAuth, PatientController.getActivePatients);

// Generic update route using unified permission check
router.route("/:id").patch(AuthMiddleware.checkAuth, AuthMiddleware.checkPatientEditAccess, PatientController.updatePatientDetails);

// Discharge route
router.route("/:id/discharge").patch(AuthMiddleware.checkSuperAdminOrAdmin, AuthMiddleware.checkAdminPermission('can_discharge'), PatientController.dischargePatient);

router.route("/:id/toggle-active").patch(AuthMiddleware.checkAuth, AuthMiddleware.checkAdminPermission('can_edit'), PatientController.togglePatientActiveStatus);
router.route("/:id").delete(AuthMiddleware.checkSuperAdmin, PatientController.deletePatient);

export default router;