import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import HospitalProfileController from '../Controllers/hospitalProfile.controller.js';
import AttributeController from '../Controllers/attribute.controller.js';
import DocumentController from '../Controllers/document.controller.js';
import VerificationController from '../Controllers/verification.controller.js';
import PublicShareController from '../Controllers/publicShare.controller.js';
import { uploadMemory } from '../Middlewares/multer.middleware.js';

const router = Router();
const AuthMiddleware = new authMiddleware();
// Shared multer instance: MIME allow-list + 25 MB cap. Was an inline
// { memoryStorage, 100 MB, no filter } that bypassed every other upload
// constraint in the system.
const upload = uploadMemory;

// ============================================================================
// HOSPITAL PROFILE ROUTES
// ============================================================================

// Get hospital profile (with all related data)
router.get('/hospitals/:hospitalId/profile', AuthMiddleware.checkAuth, HospitalProfileController.getProfile);

// Update hospital profile
router.put('/hospitals/:hospitalId/profile', AuthMiddleware.checkAuth, HospitalProfileController.updateProfile);

// Get profile summary (for quick view)
router.get('/hospitals/:hospitalId/profile/summary', HospitalProfileController.getProfileSummary);

// Get public hospital profile
router.get('/hospitals/:hospitalId/profile/public', HospitalProfileController.getPublicProfile);

// Publish/unpublish profile
router.put('/hospitals/:hospitalId/profile/publish', AuthMiddleware.checkAuth, HospitalProfileController.publishProfile);
router.put('/hospitals/:hospitalId/profile/unpublish', AuthMiddleware.checkAuth, HospitalProfileController.unpublishProfile);

// Search hospitals
router.get('/hospitals/search', HospitalProfileController.searchHospitals);

// ============================================================================
// ATTRIBUTE ROUTES
// ============================================================================

// Get all attribute definitions
router.get('/attributes/definitions', AttributeController.getDefinitions);

// Get single attribute definition
router.get('/attributes/definitions/:key', AttributeController.getDefinition);

// Get hospital attributes
router.get('/hospitals/:hospitalId/attributes', AuthMiddleware.checkAuth, AttributeController.getAttributes);

// Get single attribute
router.get('/hospitals/:hospitalId/attributes/:attributeKey', AuthMiddleware.checkAuth, AttributeController.getAttribute);

// Set attribute value
router.post('/hospitals/:hospitalId/attributes/:attributeKey', AuthMiddleware.checkAuth, AttributeController.setAttribute);

// Get unverified attributes
router.get('/hospitals/:hospitalId/attributes/status/unverified', AuthMiddleware.checkAuth, AttributeController.getUnverifiedAttributes);

// Get expiring attributes
router.get('/hospitals/:hospitalId/attributes/status/expiring', AuthMiddleware.checkAuth, AttributeController.getExpiringAttributes);

// Get expired attributes
router.get('/hospitals/:hospitalId/attributes/status/expired', AuthMiddleware.checkAuth, AttributeController.getExpiredAttributes);

// Verify attribute
router.put('/hospitals/:hospitalId/attributes/:attributeKey/verify', AuthMiddleware.checkAuth, AttributeController.verifyAttribute);

// Reject attribute
router.put('/hospitals/:hospitalId/attributes/:attributeKey/reject', AuthMiddleware.checkAuth, AttributeController.rejectAttribute);

// Delete attribute
router.delete('/hospitals/:hospitalId/attributes/:attributeKey', AuthMiddleware.checkAuth, AttributeController.deleteAttribute);

// Add document to attribute
router.post('/hospitals/:hospitalId/attributes/:attributeKey/documents', AuthMiddleware.checkAuth, AttributeController.addDocumentToAttribute);

// Remove document from attribute
router.delete('/hospitals/:hospitalId/attributes/:attributeKey/documents/:documentId', AuthMiddleware.checkAuth, AttributeController.removeDocumentFromAttribute);

// Set primary document for attribute
router.put('/hospitals/:hospitalId/attributes/:attributeKey/documents/:documentId/primary', AuthMiddleware.checkAuth, AttributeController.setPrimaryDocument);

// ============================================================================
// DOCUMENT ROUTES
// ============================================================================

// Upload document
router.post('/hospitals/:hospitalId/documents/upload', AuthMiddleware.checkAuth, upload.single('file'), DocumentController.uploadDocument);

// Get hospital documents
router.get('/hospitals/:hospitalId/documents', AuthMiddleware.checkAuth, DocumentController.getDocuments);

// Get batch documents by IDs (must be before :documentId route to avoid conflict)
router.get('/hospitals/:hospitalId/documents/batch', AuthMiddleware.checkAuth, DocumentController.getBatchDocuments);

// Get single document metadata
router.get('/hospitals/:hospitalId/documents/:documentId', AuthMiddleware.checkAuth, DocumentController.getDocument);

// Download document
router.get('/hospitals/:hospitalId/documents/:documentId/download', AuthMiddleware.checkAuth, DocumentController.downloadDocument);

// Update document metadata
router.put('/hospitals/:hospitalId/documents/:documentId', AuthMiddleware.checkAuth, DocumentController.updateDocument);

// Delete document
router.delete('/hospitals/:hospitalId/documents/:documentId', AuthMiddleware.checkAuth, DocumentController.deleteDocument);

// Submit for AI extraction
router.post('/hospitals/:hospitalId/documents/:documentId/extract', AuthMiddleware.checkAuth, DocumentController.submitForExtraction);

// Get extraction results
router.get('/hospitals/:hospitalId/documents/:documentId/extraction', AuthMiddleware.checkAuth, DocumentController.getExtraction);

// Approve extraction
router.post('/hospitals/:hospitalId/documents/:documentId/extraction/approve', AuthMiddleware.checkAuth, DocumentController.approveExtraction);

// Link document to attribute
router.put('/hospitals/:hospitalId/documents/:documentId/link/:attributeKey', AuthMiddleware.checkAuth, DocumentController.linkToAttribute);

// Get storage usage
router.get('/hospitals/:hospitalId/documents/storage-usage', AuthMiddleware.checkAuth, DocumentController.getStorageUsage);

// ============================================================================
// VERIFICATION ROUTES
// ============================================================================

// Get verification dashboard
router.get('/hospitals/:hospitalId/verification/dashboard', AuthMiddleware.checkAuth, VerificationController.getVerificationDashboard);

// Get verification checklist
router.get('/hospitals/:hospitalId/verification/checklist', AuthMiddleware.checkAuth, VerificationController.getVerificationChecklist);

// Get verification progress
router.get('/hospitals/:hospitalId/verification/progress', AuthMiddleware.checkAuth, VerificationController.getVerificationProgress);

// Submit for verification
router.post('/hospitals/:hospitalId/verification/submit', AuthMiddleware.checkAuth, VerificationController.submitForVerification);

// Submit evidence for attribute
router.post('/hospitals/:hospitalId/verification/evidence', AuthMiddleware.checkAuth, VerificationController.submitEvidence);

// Get evidence for attribute
router.get('/hospitals/:hospitalId/verification/evidence/:attributeId', AuthMiddleware.checkAuth, VerificationController.getAttributeEvidence);

// Review evidence
router.put('/hospitals/:hospitalId/verification/evidence/:evidenceId', AuthMiddleware.checkAuth, VerificationController.reviewEvidence);

// Get pending review items
router.get('/hospitals/:hospitalId/verification/pending', AuthMiddleware.checkAuth, VerificationController.getPendingReview);

// Admin: Get verification summary
router.get('/admin/verification/summary', AuthMiddleware.checkAuth, VerificationController.getVerificationSummary);

// Admin: Set verification level
router.put('/admin/hospitals/:hospitalId/verification/level', AuthMiddleware.checkAuth, VerificationController.setVerificationLevel);

// ============================================================================
// PUBLIC SHARE ROUTES
// ============================================================================

// Generate share link
router.post('/hospitals/:hospitalId/shares', AuthMiddleware.checkAuth, PublicShareController.generateShareLink);

// List share links for hospital
router.get('/hospitals/:hospitalId/shares', AuthMiddleware.checkAuth, PublicShareController.getShareLinks);

// Update share link settings
router.put('/hospitals/:hospitalId/shares/:shareId', AuthMiddleware.checkAuth, PublicShareController.updateShareLink);

// Revoke share link
router.delete('/hospitals/:hospitalId/shares/:shareId', AuthMiddleware.checkAuth, PublicShareController.revokeShareLink);

// Public: Access shared profile (no auth required)
router.get('/share/:token', PublicShareController.accessPublicProfile);

// Public: Download document from shared profile (no auth required)
router.get('/share/:token/documents/:documentId/download', PublicShareController.downloadDocumentByToken);

// Public: Preview document from shared profile (no auth required)
router.get('/share/:token/documents/:documentId/preview', PublicShareController.previewDocumentByToken);

// Public: Hospital directory
router.get('/hospitals/public/directory', PublicShareController.getPublicDirectory);

export default router;
