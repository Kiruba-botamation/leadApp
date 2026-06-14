import express from 'express';
import reminderController from '../controllers/reminderController.js';

const router = express.Router({ mergeParams: true });

// ── Per-lead reminders ────────────────────────────────────────────────────────
// Mounted at /api/ui/leads/:leadId/reminders

/** List reminders for a lead (creator-only) */
router.get('/', reminderController.getReminders.bind(reminderController));

/** Create and schedule a new reminder */
router.post('/', reminderController.createReminder.bind(reminderController));

/** Update and reschedule a reminder (creator only) */
router.put('/:reminderId', reminderController.updateReminder.bind(reminderController));

/** Delete a reminder and cancel its jobs (creator only) */
router.delete('/:reminderId', reminderController.deleteReminder.bind(reminderController));

export default router;
