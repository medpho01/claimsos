import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as panelAttributeDefinitionController from '../Controllers/panelAttributeDefinition.controller.js';
import * as panelAttributeController from '../Controllers/panelAttribute.controller.js';
import * as panelAttributeDocumentController from '../Controllers/panelAttributeDocument.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// PANEL ATTRIBUTE DEFINITION ROUTES (Admin - Read Only for now)
// ============================================================================

// Get all definitions
router.get('/admin/panel-attributes/definitions',
  AuthMiddleware.checkAuth,
  panelAttributeDefinitionController.getAllDefinitions
);

// Get definitions grouped by category
router.get('/admin/panel-attributes/definitions/by-category',
  AuthMiddleware.checkAuth,
  panelAttributeDefinitionController.getDefinitionsByCategory
);

// Get specific definition
router.get('/admin/panel-attributes/definitions/:id',
  AuthMiddleware.checkAuth,
  panelAttributeDefinitionController.getDefinition
);

// ============================================================================
// PANEL ATTRIBUTE VALUE ROUTES (Hospital Managers)
// ============================================================================

// Fleet view: all linked panels + their attributes for a hospital in one call.
// Used by the Panels tab table on the hospital profile page.
router.get('/hospitals/:hospitalId/panels-fleet',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.getPanelsFleet
);

// Get all attributes for hospital-panel relationship
router.get('/hospitals/:hospitalId/panels/:panelId/attributes',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.getAttributes
);

// Get specific attribute
router.get('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.getAttribute
);

// Create/set panel attribute value
router.post('/hospitals/:hospitalId/panels/:panelId/attributes',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.setAttributeValue
);

// Update attribute value
router.put('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.updateAttributeValue
);

// Delete attribute
router.delete('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.deleteAttribute
);

// Set multiple attributes at once (bulk)
router.post('/hospitals/:hospitalId/panels/:panelId/attributes/bulk',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.setMultipleAttributes
);

// Get complete panel information (all attributes)
router.get('/hospitals/:hospitalId/panels/:panelId/details',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeController.getCompleteInfo
);

// ============================================================================
// PANEL ATTRIBUTE DOCUMENT ROUTES
// ============================================================================

// Get all documents for an attribute
router.get('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.getDocuments
);

// Get specific document
router.get('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.getDocument
);

// Add document to attribute
router.post('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.addDocument
);

// Update document metadata
router.put('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.updateDocument
);

// Set document as primary
router.put('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId/primary',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.setPrimaryDocument
);

// Remove document from attribute
router.delete('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/:docId',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.removeDocument
);

// Get expiring documents
router.get('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/expiring',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.getExpiringDocuments
);

// Get expired documents
router.get('/hospitals/:hospitalId/panels/:panelId/attributes/:attributeId/documents/expired',
  AuthMiddleware.checkAuth,
  AuthMiddleware.checkHospitalAccess,
  panelAttributeDocumentController.getExpiredDocuments
);

export default router;
