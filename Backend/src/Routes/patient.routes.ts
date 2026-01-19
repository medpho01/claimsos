import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import patientController from "../Controllers/patient.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const PatientController = new patientController();

router.route("/addPatient").post(AuthMiddleware.checkAuth, PatientController.addPatient);
router.route("/getAllPatients").get(AuthMiddleware.checkAuth, PatientController.getAllPatients);
router.route("/getActivePatients").get(AuthMiddleware.checkAuth, PatientController.getActivePatients);
router.route("/update/admin/:id").patch(AuthMiddleware.checkAdmin, AuthMiddleware.checkAdminPermission('can_edit'), PatientController.updatePatientDetails);
router.route("/update/hospitalUser/:id").patch(AuthMiddleware.checkHospital, AuthMiddleware.checkHospitalUserPermission, PatientController.updatePatientDetails);
router.route("/:id").patch(AuthMiddleware.checkHospital, AuthMiddleware.checkAdminPermission('can_discharge'), PatientController.dischargePatient);
router.route("/:id/toggle-active").patch(AuthMiddleware.checkAuth, AuthMiddleware.checkAdminPermission('can_edit'), PatientController.togglePatientActiveStatus);
router.route("/:id").delete(AuthMiddleware.checkSuperAdmin, PatientController.deletePatient);

export default router;