import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import DoctorController from '../Controllers/doctor.controller.js';
import DoctorAttributeController from '../Controllers/doctorAttribute.controller.js';
import DoctorAttributeDefinitionController from '../Controllers/doctorAttributeDefinition.controller.js';
import HospitalDoctorController from '../Controllers/hospitalDoctor.controller.js';
import HospitalDoctorAttributeController from '../Controllers/hospitalDoctorAttribute.controller.js';
import { uploadMemory } from '../Middlewares/multer.middleware.js';

const router = Router();
const AuthMiddleware = new authMiddleware();
// Shared multer instance: MIME allow-list + 25 MB cap. Was previously an
// inline { memoryStorage, 100 MB, no filter } that bypassed every other
// upload constraint in the system.
const upload = uploadMemory;

// ============================================================================
// DOCTOR MANAGEMENT ROUTES
// ============================================================================

/**
 * POST /api/v1/doctors/register
 * Register a new doctor (self-registration)
 */
router.post('/doctors/register', DoctorController.registerDoctor);

/**
 * GET /api/v1/doctors/me
 * Get own doctor profile (authenticated)
 */
router.get('/doctors/me', AuthMiddleware.checkAuth, DoctorController.getOwnProfile);

/**
 * PUT /api/v1/doctors/me
 * Update own doctor profile
 */
router.put('/doctors/me', AuthMiddleware.checkAuth, DoctorController.updateOwnProfile);

/**
 * GET /api/v1/doctors/search
 * Search for doctors (public, paginated)
 */
router.get('/doctors/search', DoctorController.searchDoctors);

/**
 * GET /api/v1/admin/doctors
 * List all doctors (admin, with pagination and filtering)
 */
router.get('/admin/doctors', AuthMiddleware.checkAuth, DoctorController.listDoctors);

/**
 * POST /api/v1/admin/doctors
 * Create new doctor (admin)
 */
router.post('/admin/doctors', AuthMiddleware.checkAuth, DoctorController.createDoctor);

/**
 * PUT /api/v1/admin/doctors/:doctorId
 * Update doctor profile (admin)
 *
 * BE C1: was checkAuth-only — any authenticated user could update / verify /
 * suspend any doctor. The endpoints are admin actions on platform-level
 * doctor records (cross-hospital), so they're locked to the superadmin/admin
 * role pair rather than tenant-scoped via checkDoctorAccess.
 */
router.put('/admin/doctors/:doctorId', AuthMiddleware.checkAuth, AuthMiddleware.checkSuperAdminOrAdmin, DoctorController.updateDoctor);

/**
 * POST /api/v1/admin/doctors/:doctorId/verify
 * Verify doctor registration (superadmin)
 */
router.post('/admin/doctors/:doctorId/verify', AuthMiddleware.checkAuth, AuthMiddleware.checkSuperAdminOrAdmin, DoctorController.verifyDoctor);

/**
 * POST /api/v1/admin/doctors/:doctorId/suspend
 * Suspend doctor account (admin)
 */
router.post('/admin/doctors/:doctorId/suspend', AuthMiddleware.checkAuth, AuthMiddleware.checkSuperAdminOrAdmin, DoctorController.suspendDoctor);

// ============================================================================
// DOCTOR ATTRIBUTE ROUTES (MUST BE BEFORE :doctorId ROUTE)
// ============================================================================

/**
 * GET /api/v1/doctors/:doctorId/attributes
 * Get all doctor attributes (with optional category filter)
 */
router.get('/doctors/:doctorId/attributes', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.getDoctorAttributes);

/**
 * GET /api/v1/doctors/:doctorId/attributes/:attributeId
 * Get single doctor attribute with documents
 */
router.get('/doctors/:doctorId/attributes/:attributeId', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.getAttribute);

/**
 * POST /api/v1/doctors/:doctorId/attributes/:attributeKey
 * Set/update doctor attribute value
 */
router.post('/doctors/:doctorId/attributes/:attributeKey', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.setAttribute);

/**
 * GET /api/v1/doctors/:doctorId/attributes/expiring
 * Get doctor attributes expiring soon (30-day window)
 */
router.get('/doctors/:doctorId/attributes-status/expiring', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.getExpiringAttributes);

/**
 * GET /api/v1/doctors/:doctorId/attributes/expired
 * Get doctor expired attributes
 */
router.get('/doctors/:doctorId/attributes-status/expired', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.getExpiredAttributes);

/**
 * PUT /api/v1/doctors/:doctorId/attributes/:attributeId/verify
 * Verify doctor attribute (admin)
 */
router.put('/doctors/:doctorId/attributes/:attributeId/verify', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.verifyAttribute);

/**
 * GET /api/v1/doctors/:doctorId/attributes/:attributeKey/history
 * Get attribute verification history
 */
router.get('/doctors/:doctorId/attributes/:attributeKey/history', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.getAttributeHistory);

/**
 * POST /api/v1/doctors/:doctorId/attributes/:attributeId/documents
 * Add document to attribute
 */
router.post('/doctors/:doctorId/attributes/:attributeId/documents', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.addDocumentToAttribute);

/**
 * DELETE /api/v1/doctors/:doctorId/attributes/:attributeId/documents/:documentId
 * Remove document from attribute
 */
router.delete('/doctors/:doctorId/attributes/:attributeId/documents/:documentId', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.removeDocumentFromAttribute);

/**
 * DELETE /api/v1/doctors/:doctorId/attributes/:attributeId
 * Delete a doctor attribute
 */
router.delete('/doctors/:doctorId/attributes/:attributeId', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorAttributeController.deleteAttribute);

// ============================================================================
// DOCTOR ATTRIBUTE DEFINITIONS ROUTES (SUPERADMIN)
// ============================================================================

/**
 * GET /api/v1/admin/doctor-attributes/definitions
 * Get all doctor attribute definitions
 */
router.get('/admin/doctor-attributes/definitions', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.getDefinitions);

/**
 * GET /api/v1/admin/doctor-attributes/definitions/grouped-by-category
 * Get doctor attribute definitions grouped by category
 */
router.get('/admin/doctor-attributes/definitions/grouped', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.getDefinitionsByCategory);

/**
 * GET /api/v1/admin/doctor-attributes/definitions/stats
 * Get doctor attribute definition statistics
 */
router.get('/admin/doctor-attributes/definitions/stats', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.getDefinitionStats);

/**
 * GET /api/v1/admin/doctor-attributes/definitions/:id
 * Get single doctor attribute definition by ID
 */
router.get('/admin/doctor-attributes/definitions/:id', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.getDefinition);

/**
 * GET /api/v1/admin/doctor-attributes/definitions/by-key/:key
 * Get single doctor attribute definition by key
 */
router.get('/admin/doctor-attributes/by-key/:key', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.getDefinitionByKey);

/**
 * POST /api/v1/admin/doctor-attributes/definitions
 * Create new doctor attribute definition
 */
router.post('/admin/doctor-attributes/definitions', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.createDefinition);

/**
 * PUT /api/v1/admin/doctor-attributes/definitions/:id
 * Update doctor attribute definition
 */
router.put('/admin/doctor-attributes/definitions/:id', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.updateDefinition);

/**
 * DELETE /api/v1/admin/doctor-attributes/definitions/:id
 * Deactivate doctor attribute definition
 */
router.delete('/admin/doctor-attributes/definitions/:id', AuthMiddleware.checkAuth, DoctorAttributeDefinitionController.deactivateDefinition);

// ============================================================================
// HOSPITAL-DOCTOR RELATIONSHIP ROUTES
// ============================================================================

/**
 * GET /api/v1/hospitals/:hospitalId/doctors
 * Get all doctors for a hospital (with pagination)
 */
router.get('/hospitals/:hospitalId/doctors', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorController.getHospitalDoctors);

/**
 * POST /api/v1/hospitals/:hospitalId/doctors/create
 * Create a new doctor and add them to hospital in one operation
 */
router.post('/hospitals/:hospitalId/doctors/create', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorController.createAndAddDoctorToHospital);

/**
 * POST /api/v1/hospitals/:hospitalId/doctors
 * Add doctor to hospital
 */
router.post('/hospitals/:hospitalId/doctors', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorController.addDoctorToHospital);

/**
 * GET /api/v1/hospitals/:hospitalId/doctors/:doctorId
 * Get hospital-doctor relationship details
 */
router.get('/hospitals/:hospitalId/doctors/:doctorId', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorController.getHospitalDoctor);

/**
 * PUT /api/v1/hospitals/:hospitalId/doctors/:doctorId
 * Update hospital-doctor relationship (employment type, department, etc.)
 */
router.put('/hospitals/:hospitalId/doctors/:doctorId', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorController.updateHospitalDoctor);

/**
 * DELETE /api/v1/hospitals/:hospitalId/doctors/:doctorId
 * Remove doctor from hospital
 */
router.delete('/hospitals/:hospitalId/doctors/:doctorId', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorController.removeDoctorFromHospital);

// ============================================================================
// HOSPITAL-DOCTOR ATTRIBUTE OVERRIDE ROUTES
// ============================================================================

/**
 * GET /api/v1/hospitals/:hospitalId/doctors/:doctorId/attributes
 * Get hospital-specific attribute overrides for a doctor
 */
router.get('/hospitals/:hospitalId/doctors/:doctorId/attributes', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorAttributeController.getHospitalSpecificAttributes);

/**
 * POST /api/v1/hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override
 * Create/update hospital-specific attribute override
 */
router.post('/hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorAttributeController.overrideAttribute);

/**
 * GET /api/v1/hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override
 * Get hospital-specific attribute override
 */
router.get('/hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorAttributeController.getHospitalAttributeOverride);

/**
 * DELETE /api/v1/hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override
 * Remove hospital-specific attribute override
 */
router.delete('/hospitals/:hospitalId/doctors/:doctorId/attributes/:doctorAttributeId/override', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorAttributeController.removeOverride);

/**
 * GET /api/v1/hospitals/:hospitalId/doctor-attributes/overrides
 * Get all attribute overrides for a hospital (grouped by doctor)
 */
router.get('/hospitals/:hospitalId/doctor-attributes/overrides', AuthMiddleware.checkAuth, AuthMiddleware.checkHospitalAccess, HospitalDoctorAttributeController.getHospitalOverrides);

// ============================================================================
// DOCTOR DOCUMENTS UPLOAD ROUTES
// ============================================================================

/**
 * POST /api/v1/doctors/:doctorId/docs
 * Upload document for doctor (SINGLE FILE - matches hospital pattern)
 */
// Use upload.any() so it accepts both `file` and `files` field names (defensive)
router.post('/doctors/:doctorId/docs', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, upload.any(), DoctorController.uploadDoc);

/**
 * GET /api/v1/doctors/:doctorId/docs
 * Get documents for doctor attributes
 */
router.get('/doctors/:doctorId/docs', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorController.getDocs);

/**
 * GET /api/v1/doctors/:doctorId/docs/:documentId/download
 * Download/retrieve doctor document file content
 */
router.get('/doctors/:doctorId/docs/:documentId/download', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorController.downloadDoc);

/**
 * DELETE /api/v1/doctors/:doctorId/docs/:documentId
 * Delete doctor document
 */
router.delete('/doctors/:doctorId/docs/:documentId', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorController.deleteDoc);

// ============================================================================
// DOCTOR SHARE LINKS ROUTES
// ============================================================================

/**
 * GET /api/v1/doctors/public/directory
 * Get public doctor directory (search and filter)
 */
router.get('/doctors/public/directory', DoctorController.getPublicDirectory);

/**
 * POST /api/v1/doctors/:doctorId/share-links
 * Generate shareable link for doctor profile
 */
router.post('/doctors/:doctorId/share-links', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorController.generateShareLink);

/**
 * GET /api/v1/doctors/:doctorId/share-links
 * List share links for doctor
 */
router.get('/doctors/:doctorId/share-links', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorController.getShareLinks);

/**
 * DELETE /api/v1/doctors/:doctorId/share-links/:linkId
 * Revoke share link
 */
router.delete('/doctors/:doctorId/share-links/:linkId', AuthMiddleware.checkAuth, AuthMiddleware.checkDoctorAccess, DoctorController.revokeShareLink);

/**
 * GET /api/v1/public/doctor/:token
 * Access public doctor profile via share link (NO AUTH)
 */
router.get('/doctors/public/doctor/:token', DoctorController.accessPublicProfile);

export default router;
