import express from 'express';
import leadController from '../controllers/leadController.js';
import ssoAuthMiddleware from '../middleware/ssoAuthMiddleware.js';

const router = express.Router();

// Apply SSO authentication to all lead routes
router.use(ssoAuthMiddleware);

/**
 * API 1: POST /api/leads
 * @desc    Send JSON data to create new lead(s)
 * @access  Protected (requires authentication)
 * @body    Single lead object or array of leads
 */
router.post('/', leadController.createLead.bind(leadController));

/**
 * API 2: GET /api/leads
 * @desc    Get JSON data to fill frontend grid
 * @access  Protected (requires authentication)
 * @query   page, limit, sortBy, sortOrder, status, search
 */
router.get('/', leadController.getAllLeads.bind(leadController));

/**
 * API 3: PUT /api/leads/:id
 * @desc    Update a lead
 * @access  Protected (requires authentication)
 */
router.put('/:id', leadController.updateLead.bind(leadController));

/**
 * API 4: DELETE /api/leads/:id
 * @desc    Delete a lead
 * @access  Protected (requires authentication)
 */
router.delete('/:id', leadController.deleteLead.bind(leadController));

export default router;
