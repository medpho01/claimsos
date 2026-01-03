import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import patientController from "../Controllers/patient.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const PatientController = new patientController();

router.route("/addPatient").post(AuthMiddleware.checkHospital, PatientController.addPatient);
router.route("/getAllPatients").get(AuthMiddleware.checkHospital, PatientController.getAllPatients);
router.route("/:id").patch(AuthMiddleware.checkHospital, PatientController.updatePatient);
router.route("/:id/discharge").patch(AuthMiddleware.checkHospital, PatientController.dischargePatient);
router.route("/:id").delete(AuthMiddleware.checkHospital, PatientController.deletePatient);

export default router;