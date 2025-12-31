import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import patientController from "../Controllers/patient.controller.js";

const router = Router();
const AuthMiddleware = new authMiddleware();
const PatientController = new patientController();

router.route("/addPatient").post(AuthMiddleware.checkHospital,PatientController.addPatient);
router.route("/getAllPatients").get(AuthMiddleware.checkHospital,PatientController.getAllPatients);

export default router;