import { Router } from 'express';
import authMiddleware from '../Middlewares/auth.middleware.js';
import * as insuranceSubmissionController from '../Controllers/insuranceSubmission.controller.js';

const router = Router();
const AuthMiddleware = new authMiddleware();

// ============================================================================
// Insurance Submission flow (channel-agnostic; today email-only, portal later)
//
// Stage-agnostic by design: pre-auth, enhancement, discharge intimation,
// query response, final-bill submission, etc. all flow through the SAME
// endpoints. The IPD's gmail_thread_id glues every stage to one conversation.
// ============================================================================

// Check that the configured comms channel is live for this IPD's panel and
// resolve send-time config (recipients, templates, attachments).
router.post(
  '/ipds/:ipdId/insurance/preflight',
  AuthMiddleware.checkAuth,
  insuranceSubmissionController.preflight
);

// Build the draft preview (subject/body/attachments) the FE renders before send.
router.post(
  '/ipds/:ipdId/insurance/draft',
  AuthMiddleware.checkAuth,
  insuranceSubmissionController.draft
);

// Commit the submission + enqueue the email for send.
router.post(
  '/ipds/:ipdId/insurance/send',
  AuthMiddleware.checkAuth,
  insuranceSubmissionController.send
);

// List submissions for an IPD (timeline view).
router.get(
  '/ipds/:ipdId/insurance/submissions',
  AuthMiddleware.checkAuth,
  insuranceSubmissionController.listSubmissions
);

// Set the IPD's claim filing route (cashless_everywhere | network).
router.put(
  '/ipds/:ipdId/filing-route',
  AuthMiddleware.checkAuth,
  insuranceSubmissionController.setFilingRoute
);

// Set the IPD's lifecycle stage. Value must be a Label from
// master_options(category='ipd_stage', is_active=true).
router.put(
  '/ipds/:ipdId/stage',
  AuthMiddleware.checkAuth,
  insuranceSubmissionController.setStage
);

export default router;
