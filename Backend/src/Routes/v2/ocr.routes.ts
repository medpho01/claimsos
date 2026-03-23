import express from 'express'
import OcrController from '../../Controllers/v2/ocr.controller.js'
import AuthMiddleware from '../../Middlewares/auth.middleware.js'

const router = express.Router()
const controller = new OcrController()
const authMiddleware = new AuthMiddleware()

/**
 * POST /api/v2/ocr/trigger/:ipdId
 * Manually trigger OCR pipeline for a patient (Superadmin only)
 */
router.post(
    '/trigger/:ipdId',
    authMiddleware.checkAuth,
    controller.triggerPipeline
)

/**
 * GET /api/v2/ocr/status/:ipdId
 * Get OCR processing status
 */
router.get(
    '/status/:ipdId',
    authMiddleware.checkAuth,
    controller.getStatus
)

/**
 * GET /api/v2/ocr/results/:ipdId
 * Get canonical JSON results
 */
router.get(
    '/results/:ipdId',
    authMiddleware.checkAuth,
    controller.getResults
)

/**
 * GET /api/v2/ocr/results/:ipdId/documents
 * Get per-document OCR results
 */
router.get(
    '/results/:ipdId/documents',
    authMiddleware.checkAuth,
    controller.getDocumentResults
)

export default router
