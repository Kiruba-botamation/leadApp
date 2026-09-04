/**
 * Activity Routes
 *
 * Batch aggregation endpoints for the leads grid activity badges.
 * Mounted at /api/ui/activity (separate from parameterised per-lead routes
 * to avoid Express :leadId pattern conflicts).
 *
 * POST /api/ui/activity/batch-counts
 */
import express from 'express';
import noteController      from '../controllers/noteController.js';

const router = express.Router();

/**
 * POST /api/ui/activity/batch-counts
 * Combined notes + reminders counts in one round-trip (preferred over the two separate endpoints).
 * Body: { leadIds: string[] }
 */
router.post('/batch-counts', noteController.getCombinedBatchCounts.bind(noteController));

export default router;
