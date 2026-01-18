import { Router } from "express";
import hospitalController from "../Controllers/hospitalContoller.js";
import authMiddleware from "../Middlewares/auth.middleware.js";

const router = Router();
const HospitalController = new hospitalController();
const AuthMiddleware = new authMiddleware();

router.route("/addHospital").post(AuthMiddleware.checkSuperAdmin,HospitalController.addHospital);
router.route("/getAllHospitals").get(AuthMiddleware.checkSuperAdmin,HospitalController.getAllHospitals);
router.route("/getAllHospitalsByAdmin/:adminId").get(AuthMiddleware.checkSuperAdmin,HospitalController.getHospitalsByAdmin);
router.route("/getAllHospitalsForAdmin").get(AuthMiddleware.checkAdmin,HospitalController.getHospitalsByAdmin);
router.route("/addPanel").post(AuthMiddleware.checkSuperAdmin,HospitalController.addPanel);

export default router;