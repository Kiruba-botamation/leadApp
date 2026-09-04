import express from 'express';
import leadController from '../controllers/leadController.js';
import collectionController from '../controllers/collectionController.js';
import { requireSuperadmin } from '../middleware/verifiedTenantMiddleware.js';

const router = express.Router();

// ── Collection management (SSO-only — mounted under /api/ui/leads) ────────────

/** List all collections (lightweight — no field details) */
router.get('/collections', collectionController.getCollections.bind(collectionController));

/** Get full column definitions for one collection */
router.get('/collections/:collectionId/fields', collectionController.getCollectionFields.bind(collectionController));

/** Create a new collection */
router.post('/collections', requireSuperadmin, collectionController.createCollection.bind(collectionController));

/** Update collection name and/or column definitions */
router.put('/collections/:collectionId', requireSuperadmin, collectionController.updateCollection.bind(collectionController));

/** Set a collection as the account default */
router.put('/collections/:collectionId/default', requireSuperadmin, collectionController.setDefaultCollection.bind(collectionController));

/** Delete a collection and all its leads */
router.delete('/collections/:collectionId', requireSuperadmin, collectionController.deleteCollection.bind(collectionController));

// ── Stage management (embedded in a collection) ──────────────────────────────

/** Add a stage to a collection */
router.post('/collections/:collectionId/stages', requireSuperadmin, collectionController.addStage.bind(collectionController));

/** Reorder stages — must precede the :stageId route so "reorder" isn't read as an id */
router.put('/collections/:collectionId/stages/reorder', requireSuperadmin, collectionController.reorderStages.bind(collectionController));

/** Update a stage's name / colour / order */
router.put('/collections/:collectionId/stages/:stageId', requireSuperadmin, collectionController.updateStage.bind(collectionController));

/** Delete a stage (reassigns its leads to the first remaining stage) */
router.delete('/collections/:collectionId/stages/:stageId', requireSuperadmin, collectionController.deleteStage.bind(collectionController));

// ── Lead CRUD ────────────────────────────────────────────────────────────────

/** Get paginated leads (with optional typed fieldFilters) */
router.get('/', leadController.getAllLeads.bind(leadController));

/** Get a single lead by ID — must come after static routes */
router.get('/:id', leadController.getLeadById.bind(leadController));

/** Create lead(s) — no collection (uses default) */
router.post('/', leadController.createLead.bind(leadController));

/** Create lead(s) under a named collection */
router.post('/:collection', leadController.createLead.bind(leadController));

/** Update a lead */
router.put('/:id', leadController.updateLead.bind(leadController));

/** Delete a lead */
router.delete('/:id', leadController.deleteLead.bind(leadController));

export default router;
