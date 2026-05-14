import express from 'express'
import HospitalDocsController from '../Controllers/hospitalDocs.controller.js'
import AuthMiddleware from '../Middlewares/auth.middleware.js'
import upload from '../Middlewares/multer.middleware.js'

const router = express.Router()
const controller = new HospitalDocsController()
const authMiddleware = new AuthMiddleware()

/**
 * POST /api/v1/hospital-docs/upload
 * Upload official hospital documents to S3
 */
router.post(
    '/upload',
    authMiddleware.checkAuth,
    upload.array('files', 20),
    controller.uploadDoc
)

/**
 * GET /api/v1/hospital-docs/:hospitalId
 * Get official documents for a hospital
 */
router.get(
    '/:hospitalId',
    authMiddleware.checkAuth,
    authMiddleware.checkHospitalAccess,
    controller.getDocs
)

/**
 * DELETE /api/v1/hospital-docs/:id
 * Delete document
 */
router.delete(
    '/:id',
    authMiddleware.checkAuth,
    controller.deleteDoc
)

/**
 * GET /api/v1/hospital-docs/proxy/:fileId
 * Proxy photo download from S3
 */
router.get(
    '/proxy/:fileId',
    authMiddleware.checkAuth,
    controller.proxyPhoto
)

export default router
