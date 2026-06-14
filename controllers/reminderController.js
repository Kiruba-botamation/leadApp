/**
 * Reminder Controller
 *
 * HTTP handlers for lead reminders.
 * Auth enforced by ssoAuthMiddleware (mounted in server.js).
 * Admin identity resolved from req.user.accountAdminId (account_admins._id).
 */
import reminderService from '../services/reminderService.js';
import Lead             from '../models/leadModel.js';
import LeadCategory     from '../models/leadCategoryModel.js';
import LeadReminder     from '../models/leadReminderModel.js';
import logger           from '../utils/logger.js';

const VALID_CHANNELS = ['inApp', 'push', 'email', 'whatsapp'];
const VALID_UNITS    = ['minutes', 'hours', 'days'];

class ReminderController {
    /**
     * GET /api/ui/leads/:leadId/reminders
     * List reminders for a lead (creator-only).
     */
    async getReminders(req, res) {
        try {
            const { leadId } = req.params;
            const acctId     = req.query.acctId || req.headers['x-acctno'];

            if (!acctId) return res.status(400).json({ success: false, message: 'Account context required' });

            // All admins can see all reminders for a lead — no adminId filter here.
            // adminId is only enforced on create / update / delete (creator-only writes).
            const reminders = await reminderService.getReminders(acctId, leadId);
            return res.status(200).json({ success: true, data: reminders });
        } catch (err) {
            console.error('[ReminderController] getReminders:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/leads/:leadId/reminders
     * Create and schedule a reminder.
     */
    async createReminder(req, res) {
        try {
            const { leadId }           = req.params;
            const acctId               = req.query.acctId || req.headers['x-acctno'];
            // Prefer adminId sent explicitly by the frontend (account-specific _id from localStorage).
            // Fall back to middleware-resolved accountAdminId (requires acctId to be accurate).
            const adminId              = req.body.adminId || req.user?.accountAdminId;
            const {
                description, scheduledAt,
                preReminderEnabled, preReminderValue, preReminderUnit,
                channels
            } = req.body;

            if (!acctId || !adminId) return res.status(400).json({ success: false, message: 'Account context required' });
            if (!description?.trim()) return res.status(400).json({ success: false, message: 'description is required' });
            if (!scheduledAt)         return res.status(400).json({ success: false, message: 'scheduledAt is required' });

            if (new Date(scheduledAt) <= new Date()) {
                return res.status(400).json({ success: false, message: 'scheduledAt must be in the future' });
            }

            // Validate optional pre-reminder fields
            if (preReminderEnabled) {
                if (!preReminderValue || !preReminderUnit) {
                    return res.status(400).json({ success: false, message: 'preReminderValue and preReminderUnit are required when preReminderEnabled is true' });
                }
                if (!VALID_UNITS.includes(preReminderUnit)) {
                    return res.status(400).json({ success: false, message: `preReminderUnit must be one of: ${VALID_UNITS.join(', ')}` });
                }
            }

            // Validate channels
            const validChannels = channels?.filter(c => VALID_CHANNELS.includes(c));

            const reminder = await reminderService.createReminder({
                acctId, adminId, leadId,
                description, scheduledAt,
                preReminderEnabled, preReminderValue, preReminderUnit,
                channels: validChannels
            });

            // Best-effort: populate lead snapshot so notifications can show name/phone
            try {
                const lead = await Lead.findById(leadId).lean();
                if (lead) {
                    const category  = await LeadCategory.findById(lead.categoryId).lean();
                    const nameField = category?.fields?.[0]?.field;
                    const name      = nameField ? String(lead[nameField] || '') : '';
                    const phoneCol  = category?.fields?.find(f =>
                        /phone|mobile|tel/i.test(f.label || '') ||
                        /phone|mobile|tel/i.test(f.field || '')
                    );
                    const phone = phoneCol ? String(lead[phoneCol.field] || '') : '';
                    await LeadReminder.findByIdAndUpdate(reminder._id, { leadSnapshot: { name, phone } });
                }
            } catch (snapErr) {
                logger.warn('[ReminderController] leadSnapshot error:', snapErr.message);
            }

            return res.status(201).json({ success: true, message: 'Reminder created', data: reminder });
        } catch (err) {
            console.error('[ReminderController] createReminder:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * PUT /api/ui/leads/:leadId/reminders/:reminderId
     * Update and reschedule a reminder (creator only).
     */
    async updateReminder(req, res) {
        try {
            const { reminderId }       = req.params;
            const adminId              = req.user?.accountAdminId;
            const updates              = req.body;

            if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required' });

            if (updates.scheduledAt && new Date(updates.scheduledAt) <= new Date()) {
                return res.status(400).json({ success: false, message: 'scheduledAt must be in the future' });
            }

            if (updates.channels) {
                updates.channels = updates.channels.filter(c => VALID_CHANNELS.includes(c));
            }

            const updated = await reminderService.updateReminder(reminderId, adminId, updates);
            if (!updated) {
                return res.status(404).json({ success: false, message: 'Reminder not found or you do not have permission to edit it' });
            }

            return res.status(200).json({ success: true, message: 'Reminder updated', data: updated });
        } catch (err) {
            console.error('[ReminderController] updateReminder:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * DELETE /api/ui/leads/:leadId/reminders/:reminderId
     * Delete a reminder and cancel its jobs (creator only).
     */
    async deleteReminder(req, res) {
        try {
            const { reminderId } = req.params;
            const adminId        = req.user?.accountAdminId;

            if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required' });

            const deleted = await reminderService.deleteReminder(reminderId, adminId);
            if (!deleted) {
                return res.status(404).json({ success: false, message: 'Reminder not found or you do not have permission to delete it' });
            }

            return res.status(200).json({ success: true, message: 'Reminder deleted' });
        } catch (err) {
            console.error('[ReminderController] deleteReminder:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * GET /api/ui/reminders/fired
     * Get fired-but-unread reminders for the bell inbox.
     */
    async getFiredReminders(req, res) {
        try {
            const adminId = req.query.adminId || req.user?.accountAdminId;
            if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required' });

            const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
            const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);

            const { items, total, unread } = await reminderService.getFiredUnreadReminders(adminId, { page, limit });
            return res.status(200).json({
                success: true,
                data:    items,
                count:   unread,        // unread count for badge
                total,                  // total non-dismissed items
                page,
                limit,
                hasMore: page * limit < total,
            });
        } catch (err) {
            console.error('[ReminderController] getFiredReminders:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/reminders/mark-read
     * Mark fired reminders as read (clears the bell badge).
     * Body: { reminderIds?: string[] }  — omit to mark all
     */
    async markRead(req, res) {
        try {
            const adminId            = req.body.adminId || req.user?.accountAdminId;
            const { reminderIds }    = req.body;

            if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required' });

            await reminderService.markRemindersRead(adminId, reminderIds);
            return res.status(200).json({ success: true, message: 'Reminders marked as read' });
        } catch (err) {
            console.error('[ReminderController] markRead:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * DELETE /api/ui/reminders/fired/:reminderId
     * Remove a single fired reminder from the bell inbox permanently.
     */
    async dismissFired(req, res) {
        try {
            const { reminderId } = req.params;
            const adminId        = req.query.adminId || req.user?.accountAdminId;
            if (!adminId) return res.status(400).json({ success: false, message: 'Admin identity required' });

            await reminderService.deleteFiredReminder(reminderId, adminId);
            return res.status(200).json({ success: true, message: 'Reminder dismissed' });
        } catch (err) {
            console.error('[ReminderController] dismissFired:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/activity/reminders/batch-counts
     * Get pending reminder counts for multiple leads (used to highlight grid buttons).
     * Body: { leadIds: string[] }
     */
    async getBatchReminderCounts(req, res) {
        try {
            const acctId    = req.query.acctId || req.headers['x-acctno'];
            const adminId   = req.query.adminId || req.body.adminId || req.user?.accountAdminId;
            const { leadIds } = req.body;

            if (!acctId || !adminId) return res.status(400).json({ success: false, message: 'Account context required' });
            if (!Array.isArray(leadIds) || !leadIds.length) {
                return res.status(400).json({ success: false, message: 'leadIds array is required' });
            }

            const counts = await reminderService.getBatchReminderCounts(acctId, adminId, leadIds);
            return res.status(200).json({ success: true, data: counts });
        } catch (err) {
            console.error('[ReminderController] getBatchReminderCounts:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }
}

export default new ReminderController();
