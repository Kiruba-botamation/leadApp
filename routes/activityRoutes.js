/**
 * Activity Routes
 *
 * Batch aggregation endpoints for the leads grid activity badges.
 * Mounted at /api/ui/activity (separate from parameterised per-lead routes
 * to avoid Express :leadId pattern conflicts).
 *
 * POST /api/ui/activity/notes/batch-counts
 * POST /api/ui/activity/reminders/batch-counts
 */
import express from 'express';
import noteController      from '../controllers/noteController.js';
import reminderController  from '../controllers/reminderController.js';

const router = express.Router();

/**
 * POST /api/ui/activity/notes/batch-counts
 * Get note counts for an array of lead IDs (all admins can see all notes).
 * Body: { leadIds: string[] }
 */
router.post('/notes/batch-counts', noteController.getBatchCounts.bind(noteController));

/**
 * POST /api/ui/activity/reminders/batch-counts
 * Get pending reminder counts per lead for the current admin (creator-only).
 * Body: { leadIds: string[] }
 */
router.post('/reminders/batch-counts', reminderController.getBatchReminderCounts.bind(reminderController));

/**
 * POST /api/ui/activity/batch-counts
 * Combined notes + reminders counts in one round-trip (preferred over the two separate endpoints).
 * Body: { leadIds: string[] }
 */
router.post('/batch-counts', noteController.getCombinedBatchCounts.bind(noteController));

export default router;
