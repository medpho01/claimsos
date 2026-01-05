import { Router } from "express";
import authMiddleware from "../Middlewares/auth.middleware.js";
import upload from "../Middlewares/multer.middleware.js";
import uploadsController from "../Controllers/uploads.controller.js";


const router = Router();
const AuthMiddleware = new authMiddleware();
const UploadsController = new uploadsController();

router.route("/").post(AuthMiddleware.checkHospital, upload.array("files", 50), UploadsController.upload);
router.route("/:folderId/photos").get(AuthMiddleware.checkHospital, UploadsController.listPhotos);
router.route("/:fileId").delete(AuthMiddleware.checkHospital, UploadsController.deletePhoto);

export default router;