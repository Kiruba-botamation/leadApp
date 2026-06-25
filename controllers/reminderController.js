/**
 * Reminder Controller
 *
 * HTTP handlers for lead reminders.
 * Auth enforced by ssoAuthMiddleware (mounted in server.js).
 * The reminder owner is the lead-app userId from the authenticated session (req.user.userId).
 */
import reminderService from '../services/reminderService.js';
import Lead from '../models/leadModel.js';
import LeadReminder from '../models/leadReminderModel.js';
import logger from '../utils/logger.js';

const VALID_CHANNELS        = ['inApp', 'push', 'email', 'whatsapp'];
const VALID_CLIENT_CHANNELS = ['email', 'whatsapp', 'sms'];
const VALID_UNITS = ['minutes', 'hours', 'days'];

class ReminderController {
    /**
     * GET /api/ui/leads/:leadId/reminders
     * List reminders for a lead (creator-only).
     */
    async getReminders(req, res) {
        try {
            const { leadId } = req.params;
            const acctId = req.query.acctId || req.headers['x-acctno'];

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
            const { leadId } = req.params;
            const acctId = req.query.acctId || req.headers['x-acctno'];
            const userId = req.user?.userId;
            const {
                description, scheduledAt,
                preReminderEnabled, preReminderValue, preReminderUnit,
                channels,
                clientReminderEnabled, clientMessage, clientScheduledAt, clientChannels
            } = req.body;

            if (!acctId || !userId) return res.status(400).json({ success: false, message: 'Account context required' });
            if (!description?.trim()) return res.status(400).json({ success: false, message: 'description is required' });
            if (!scheduledAt) return res.status(400).json({ success: false, message: 'scheduledAt is required' });

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

            // Validate optional client reminder fields
            let validClientChannels = [];
            if (clientReminderEnabled) {
                if (!clientMessage?.trim()) {
                    return res.status(400).json({ success: false, message: 'clientMessage is required when clientReminderEnabled is true' });
                }
                if (!clientScheduledAt) {
                    return res.status(400).json({ success: false, message: 'clientScheduledAt is required when clientReminderEnabled is true' });
                }
                if (new Date(clientScheduledAt) <= new Date()) {
                    return res.status(400).json({ success: false, message: 'clientScheduledAt must be in the future' });
                }
                validClientChannels = (clientChannels || []).filter(c => VALID_CLIENT_CHANNELS.includes(c));
                if (validClientChannels.length === 0) {
                    return res.status(400).json({ success: false, message: 'At least one valid clientChannel (email, whatsapp, sms) is required' });
                }
            }

            const validChannels = channels?.filter(c => VALID_CHANNELS.includes(c));

            const reminder = await reminderService.createReminder({
                acctId, userId, leadId,
                description, scheduledAt,
                preReminderEnabled, preReminderValue, preReminderUnit,
                channels: validChannels,
                clientReminderEnabled: clientReminderEnabled || false,
                clientMessage:         clientReminderEnabled ? clientMessage.trim() : '',
                clientScheduledAt:     clientReminderEnabled ? clientScheduledAt : undefined,
                clientChannels:        validClientChannels,
            });

            // Best-effort: populate lead snapshot + client contact info (from system fields)
            try {
                const lead = await Lead.findById(leadId).lean();
                if (lead) {
                    await LeadReminder.findByIdAndUpdate(reminder._id, {
                        leadSnapshot: {
                            name:  String(lead.name  || ''),
                            phone: String(lead.phone || ''),
                        },
                        clientName:  String(lead.name  || ''),
                        clientPhone: String(lead.phone || ''),
                        clientEmail: String(lead.email || ''),
                    });
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
            const { reminderId } = req.params;
            const updates = req.body;
            const userId = req.user?.userId;

            if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

            if (updates.scheduledAt && new Date(updates.scheduledAt) <= new Date()) {
                return res.status(400).json({ success: false, message: 'scheduledAt must be in the future' });
            }

            if (updates.channels) {
                updates.channels = updates.channels.filter(c => VALID_CHANNELS.includes(c));
            }

            // Validate client reminder fields if enabled
            if (updates.clientReminderEnabled) {
                if (!updates.clientMessage?.trim()) {
                    return res.status(400).json({ success: false, message: 'clientMessage is required when clientReminderEnabled is true' });
                }
                if (!updates.clientScheduledAt) {
                    return res.status(400).json({ success: false, message: 'clientScheduledAt is required when clientReminderEnabled is true' });
                }
                if (new Date(updates.clientScheduledAt) <= new Date()) {
                    return res.status(400).json({ success: false, message: 'clientScheduledAt must be in the future' });
                }
                const validClientChs = (updates.clientChannels || []).filter(c => VALID_CLIENT_CHANNELS.includes(c));
                if (validClientChs.length === 0) {
                    return res.status(400).json({ success: false, message: 'At least one valid clientChannel is required' });
                }
                updates.clientChannels = validClientChs;
            } else if (updates.clientChannels) {
                updates.clientChannels = updates.clientChannels.filter(c => VALID_CLIENT_CHANNELS.includes(c));
            }

            const updated = await reminderService.updateReminder(reminderId, userId, updates);
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
            const userId         = req.user?.userId;

            if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

            const deleted = await reminderService.deleteReminder(reminderId, userId);
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
            const userId = req.user?.userId;
            if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(50, parseInt(req.query.limit, 10) || 10);

            const { items, total, unread } = await reminderService.getFiredUnreadReminders(userId, { page, limit });
            return res.status(200).json({
                success: true,
                data: items,
                count: unread,
                total,
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
     */
    async markRead(req, res) {
        try {
            const userId = req.user?.userId;
            const { reminderIds } = req.body;

            if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

            await reminderService.markRemindersRead(userId, reminderIds);
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
            const userId = req.user?.userId;
            if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

            await reminderService.deleteFiredReminder(reminderId, userId);
            return res.status(200).json({ success: true, message: 'Reminder dismissed' });
        } catch (err) {
            console.error('[ReminderController] dismissFired:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    /**
     * POST /api/ui/activity/reminders/batch-counts
     * Get pending reminder counts for multiple leads (used to highlight grid buttons).
     */
    async getBatchReminderCounts(req, res) {
        try {
            const acctId = req.query.acctId || req.headers['x-acctno'];
            const userId = req.user?.userId;
            const { leadIds } = req.body;

            if (!acctId || !userId) return res.status(400).json({ success: false, message: 'Account context required' });
            if (!Array.isArray(leadIds) || !leadIds.length) {
                return res.status(400).json({ success: false, message: 'leadIds array is required' });
            }

            const counts = await reminderService.getBatchReminderCounts(acctId, leadIds);
            return res.status(200).json({ success: true, data: counts });
        } catch (err) {
            console.error('[ReminderController] getBatchReminderCounts:', err);
            return res.status(500).json({ success: false, message: err.message });
        }
    }
}

export default new ReminderController();
