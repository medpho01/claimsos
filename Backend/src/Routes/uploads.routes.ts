import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import upload from "../Middlewares/multer.middleware.js";
import uploadsController from "../Controllers/uploads.controller.js";


const router = Router();
const AuthMiddleware = new authMiddleware();
const UploadsController = new uploadsController();

router.route("/getImageCounts/:patientId").get(AuthMiddleware.checkHospital, AuthMiddleware.checkHospitalUserPermission, UploadsController.getCounts);


// Photo routes - allows superadmin, admin, and hospital users with panel access
router.route("/admin/photos/:patientId").get(AuthMiddleware.checkPatientViewAccess, UploadsController.listPhotosForAdmin);
// NOTE: v1 admin/file/:fileId DELETE removed — the underlying controller was
// a no-op that returned 200 success without deleting anything (Drive delete
// was disabled, no S3/DB cleanup). Frontend should use POST /api/v2/uploads
// /photos (deletePhoto) which does the real delete.
// Upload route - uses checkHospital since patientId is in body (parsed by multer)
// Access verification is done in the controller after body is parsed
router.route("/admin/upload").post(AuthMiddleware.checkHospital, upload.array("files", 50), UploadsController.uploadForAdmin);


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
// NOTE: v1 /:fileId DELETE removed — same reason as above. The handler was
// a no-op (Drive delete disabled, no S3/DB cleanup) returning 200 success.
// Use /api/v2/uploads/photos for real deletion.

export default router;