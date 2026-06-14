import express from 'express';
import leadController from '../controllers/leadController.js';
import categoryController from '../controllers/categoryController.js';

const router = express.Router();

// ── Category management (SSO-only — mounted under /api/ui/leads) ─────────────

/** List all categories (lightweight — no field details) */
router.get('/categories', categoryController.getCategories.bind(categoryController));

/** Get full column definitions for one category */
router.get('/categories/:categoryId/fields', categoryController.getCategoryFields.bind(categoryController));

/** Create a new category */
router.post('/categories', categoryController.createCategory.bind(categoryController));

/** Update category name and/or column definitions */
router.put('/categories/:categoryId', categoryController.updateCategory.bind(categoryController));

/** Set a category as the account default */
router.put('/categories/:categoryId/default', categoryController.setDefaultCategory.bind(categoryController));

/** Delete a category and all its leads */
router.delete('/categories/:categoryId', categoryController.deleteCategory.bind(categoryController));

// ── Lead CRUD ────────────────────────────────────────────────────────────────

/** Get paginated leads (with optional typed fieldFilters) */
router.get('/', leadController.getAllLeads.bind(leadController));

/** Get a single lead by ID — must come after static routes */
router.get('/:id', leadController.getLeadById.bind(leadController));

/** Create lead(s) — no category (uses default) */
router.post('/', leadController.createLead.bind(leadController));

/** Create lead(s) under a named category */
router.post('/:category', leadController.createLead.bind(leadController));

/** Update a lead */
router.put('/:id', leadController.updateLead.bind(leadController));

/** Delete a lead */
router.delete('/:id', leadController.deleteLead.bind(leadController));

export default router;
