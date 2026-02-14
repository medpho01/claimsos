import express from 'express'
import UploadsControllerV2 from '../../Controllers/v2/uploads.controller.js'
import AuthMiddleware from '../../Middlewares/auth.middleware.js'
import multer from 'multer'

const router = express.Router()
const controller = new UploadsControllerV2()
const authMiddleware = new AuthMiddleware()

// Multer configuration for in-memory storage (for S3)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
    },
})

/**
 * POST /api/v2/uploads/photos
 * Upload photos to S3 with background Drive backup
 * Body: { patientId, category? }
 * Files: multipart/form-data
 */
router.post(
    '/photos',
    authMiddleware.checkAuth,
    upload.array('files', 50), // Max 50 files at once
    controller.uploadPhotos
)

/**
 * GET /api/v2/uploads/photos/:patientId
 * Get photos for a patient with presigned URLs
 * Query params: category? (optional filter)
 */
router.get(
    '/photos/:patientId',
    authMiddleware.checkAuth,
    controller.getPhotos
)

/**
 * DELETE /api/v2/uploads/photos
 * Delete photo from both S3 and Drive
 */
router.delete(
    '/photos',
    authMiddleware.checkAuth,
    controller.deletePhoto
)

/**
 * DELETE /api/v2/uploads/photos/:id
 * Delete photo from both S3 and Drive
 */
router.delete(
    '/photos/:id',
    authMiddleware.checkAuth,
    controller.deletePhoto
)


/**
 * GET /api/v2/admin/backup-status
 * Get Drive backup queue status (Admin only)
 */
router.get(
    '/admin/backup-status',
    authMiddleware.checkAuth,
    controller.getBackupStatus
)

/**
 * POST /api/v2/admin/retry-failed
 * Retry failed Drive backups (Admin only)
 */
router.post(
    '/admin/retry-failed',
    authMiddleware.checkAuth,
    controller.retryFailedBackups
)

/**
 * GET /getFileCounts/:patientId
 * get file counts for each category(Only hospital app user)
 */
router.route("/getFileCounts/:patientId").get(authMiddleware.checkAuth,authMiddleware.checkHospitalUserPermission,controller.getFileCounts);

export default router
