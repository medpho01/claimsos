import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import upload from "../Middlewares/multer.middleware.js";
import uploadsController from "../Controllers/uploads.controller.js";


const router = Router();
const AuthMiddleware = new authMiddleware();
const UploadsController = new uploadsController();

router.route("/getImageCounts/:patientId").get(AuthMiddleware.checkHospital, AuthMiddleware.checkHospitalUserPermission, UploadsController.getCounts);


// Admin/Superadmin route to view patient photos
router.route("/admin/photos/:patientId").get(AuthMiddleware.checkSuperAdminOrAdmin, UploadsController.listPhotosForAdmin);
// Admin/Superadmin route to delete a file
router.route("/admin/file/:fileId").delete(AuthMiddleware.checkSuperAdminOrAdmin, UploadsController.deletePhotoForAdmin);
// Admin/Superadmin route to upload files
router.route("/admin/upload").post(AuthMiddleware.checkSuperAdminOrAdmin, upload.array("files", 50), UploadsController.uploadForAdmin);


router.route("/dishargePhotos/:patientId/:category").get(AuthMiddleware.checkHospital, AuthMiddleware.checkHospitalUserPermission, UploadsController.listPhotos);
router.route("/discharge/:patientId").post(AuthMiddleware.checkHospital, AuthMiddleware.checkHospitalUserPermission, upload.fields([
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
]), UploadsController.uploadDischargePhotos)
router.route("/proxy/:fileId").get(UploadsController.getThumbnail);
router.route("/generatePDF/:patientId").get(AuthMiddleware.checkAuth, UploadsController.generatePDFs);
router.route("/renameFileHospital").post(AuthMiddleware.checkHospital,AuthMiddleware.checkHospitalUserPermission,UploadsController.renameFiles)
router.route("/:patientId").post(AuthMiddleware.checkHospital, AuthMiddleware.checkHospitalUserPermission, upload.array("files", 50), UploadsController.upload);
router.route("/:fileId").delete(AuthMiddleware.checkHospital, AuthMiddleware.checkHospitalUserPermission, UploadsController.deletePhoto);

export default router;