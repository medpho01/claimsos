import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import upload from "../Middlewares/multer.middleware.js";
import uploadsController from "../Controllers/uploads.controller.js";


const router = Router();
const AuthMiddleware = new authMiddleware();
const UploadsController = new uploadsController();

router.route("/getImageCounts/:patientId").get(AuthMiddleware.checkHospital, UploadsController.getCounts);
router.route("/").post(AuthMiddleware.checkHospital, upload.array("files", 50), UploadsController.upload);
router.route("/dishargePhotos/:patientId/:category").get(AuthMiddleware.checkHospital, UploadsController.listPhotos);
router.route("/:fileId").delete(AuthMiddleware.checkHospital, UploadsController.deletePhoto);
router.route("/discharge").post(AuthMiddleware.checkHospital,upload.fields([
    { name: 'discharge_slip', maxCount: 20 },
    { name: 'investigations', maxCount: 20 },
    { name: 'treatment', maxCount: 20 },
    { name: 'icps', maxCount: 20 },
    { name: 'surgical_discharge_slip', maxCount: 20 },
    { name: 'ot_notes_and_photos', maxCount: 20 },
    { name: 'post_op_photo', maxCount: 20 },
    { name: 'post_op_reports', maxCount: 20 },
    { name: 'implant_invoice', maxCount: 20 },
    { name: 'others', maxCount: 20 }
]),UploadsController.uploadDischargePhotos)
router.route("/generatePDF/:patientId").get(AuthMiddleware.checkAuth,UploadsController.generatePDFs);

export default router;