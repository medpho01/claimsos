import { Router } from "express";
import hospitalController from "../Controllers/hospitalContoller.js";
import authMiddleware from "../Middlewares/auth.middleware.js";

const router = Router();
const HospitalController = new hospitalController();
const AuthMiddleware = new authMiddleware();

// Hospital CRUD (Superadmin only)
router.route("/addHospital").post(AuthMiddleware.checkSuperAdmin, HospitalController.addHospital);
router.route("/getAllHospitals").get(AuthMiddleware.checkSuperAdmin, HospitalController.getAllHospitals);
router.route("/getAllHospitalsByAdmin/:adminId").get(AuthMiddleware.checkSuperAdmin, HospitalController.getHospitalsByAdmin);
router.route("/getAllHospitalsForAdmin").get(AuthMiddleware.checkAdmin, HospitalController.getHospitalsByAdmin);

// Master Panels (Superadmin for create, all authenticated users can read)
router.route("/panel/create").post(AuthMiddleware.checkSuperAdmin, HospitalController.createMasterPanel);
router.route("/panel/all").get(AuthMiddleware.checkAuth, HospitalController.getAllMasterPanels);

// Link panel to hospital (Superadmin or Hospital User)
router.route("/addPanel").post(AuthMiddleware.checkAuth, HospitalController.addPanel);

router.route("/getPanelsSummary/:hospitalId").get(AuthMiddleware.checkAuth, HospitalController.getHospitalPatientsSummary);

// Hospital Panels & Users (Superadmin/Admin)
router.route("/:hospitalId/panels").get(AuthMiddleware.checkAuth, HospitalController.getHospitalPanels);
router.route("/:hospitalId/panels/details").get(AuthMiddleware.checkAuth, HospitalController.getHospitalPanelsDetails);
router.route("/:hospitalId/users").get(AuthMiddleware.checkAuth, HospitalController.getHospitalUsers);
router.route("/:hospitalId/users/:userId/role").patch(AuthMiddleware.checkSuperAdmin, HospitalController.updateHospitalUserRole);

// Hospital user self-service
router.route("/my-hospital").get(AuthMiddleware.checkHospital, HospitalController.getMyHospital);

router.route("/:hospitalId").get(AuthMiddleware.checkAuth, HospitalController.getHospitalById);

export default router;
