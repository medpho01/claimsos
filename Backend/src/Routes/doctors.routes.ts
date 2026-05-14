import express from 'express'
import DoctorsController from '../Controllers/doctors.controller.js'
import AuthMiddleware from '../Middlewares/auth.middleware.js'
import upload from '../Middlewares/multer.middleware.js'

const router = express.Router()
const controller = new DoctorsController()
const authMiddleware = new AuthMiddleware()

// ---- Doctors Management ----

/**
 * GET /api/v1/doctors/hospital/:hospitalId
 * Get all doctors for a specific hospital
 */
router.get(
    '/hospital/:hospitalId',
    authMiddleware.checkAuth,
    authMiddleware.checkHospitalAccess,
    controller.getDoctors
)

/**
 * POST /api/v1/doctors
 * Add a new doctor
 */
router.post(
    '/',
    authMiddleware.checkAuth,
    controller.addDoctor
)

/**
 * PATCH /api/v1/doctors/:id
 * Update an existing doctor
 */
router.patch(
    '/:id',
    authMiddleware.checkAuth,
    controller.updateDoctor
)

/**
 * DELETE /api/v1/doctors/:id
 * Delete a doctor
 */
router.delete(
    '/:id',
    authMiddleware.checkAuth,
    controller.deleteDoctor
)

// ---- Doctor Documents Management ----

/**
 * POST /api/v1/doctors/:id/docs
 * Upload doctor documents mapping array to custom names
 */
router.post(
    '/:id/docs',
    authMiddleware.checkAuth,
    upload.array('files', 20),
    controller.uploadDoc
)

/**
 * GET /api/v1/doctors/:id/docs
 * Get all docs for a specific doctor
 */
router.get(
    '/:id/docs',
    authMiddleware.checkAuth,
    controller.getDocs
)

/**
 * DELETE /api/v1/doctors/docs/:docId
 * Delete a doctor document
 */
router.delete(
    '/docs/:docId',
    authMiddleware.checkAuth,
    controller.deleteDoc
)

/**
 * GET /api/v1/doctors/docs/proxy/:docId
 * Proxy photo download from S3
 */
router.get(
    '/docs/proxy/:docId',
    authMiddleware.checkAuth,
    controller.proxyPhoto
)

export default router
