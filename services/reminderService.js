/**
 * Reminder Service
 *
 * CRUD for lead_reminders + BullMQ job lifecycle management.
 */
import LeadReminder  from '../models/leadReminderModel.js';
import AccountAdmin  from '../models/accountAdminModel.js';
import {
    scheduleReminderJobs,
    cancelReminderJobs
} from '../queue/reminderQueue.js';
import logger from '../utils/logger.js';

class ReminderService {
    /**
     * List reminders for a lead, visible only to the requesting admin.
     * Returns reminders sorted by scheduledAt descending.
     *
     * @param {string} acctId
     * @param {string} leadId
     * @param {string} adminId
     * @returns {Promise<object[]>}
     */
    async getReminders(acctId, leadId, adminId) {
        return LeadReminder.find({ acctId, leadId, adminId })
            .sort({ scheduledAt: -1 })
            .lean();
    }

    /**
     * Get reminder counts per lead for a batch of leadIds.
     * Only counts future / active reminders (mainSent: false) for this admin.
     *
     * @param {string}   acctId
     * @param {string}   adminId
     * @param {string[]} leadIds
     * @returns {Promise<Record<string, number>>}
     */
    async getBatchReminderCounts(acctId, adminId, leadIds) {
        if (!leadIds?.length) return {};
        const results = await LeadReminder.aggregate([
            { $match: { acctId, adminId, leadId: { $in: leadIds }, mainSent: false } },
            { $group: { _id: '$leadId', count: { $sum: 1 } } }
        ]);
        return Object.fromEntries(results.map(r => [r._id, r.count]));
    }

    /**
     * Create a reminder and schedule its BullMQ jobs.
     *
     * @param {object} data
     * @param {string} data.acctId
     * @param {string} data.adminId
     * @param {string} data.leadId
     * @param {string} data.description
     * @param {Date}   data.scheduledAt
     * @param {boolean} [data.preReminderEnabled]
     * @param {number}  [data.preReminderValue]
     * @param {string}  [data.preReminderUnit]
     * @param {string[]} [data.channels]
     * @returns {Promise<object>}
     */
    async createReminder(data) {
        const reminder = await LeadReminder.create({
            acctId:             data.acctId,
            adminId:            data.adminId,
            leadId:             data.leadId,
            description:        data.description.trim(),
            scheduledAt:        new Date(data.scheduledAt),
            preReminderEnabled: data.preReminderEnabled || false,
            preReminderValue:   data.preReminderValue   || null,
            preReminderUnit:    data.preReminderUnit     || null,
            channels:           data.channels?.length ? data.channels : ['inApp', 'push']
        });

        // Schedule BullMQ jobs (non-fatal if Redis is down)
        await scheduleReminderJobs(reminder);

        logger.info(`[ReminderService] Reminder created | id=${reminder._id} | leadId=${data.leadId} | adminId=${data.adminId}`);
        return reminder.toObject();
    }

    /**
     * Update a reminder and reschedule its BullMQ jobs.
     * Only the creator (adminId) may update.
     *
     * @param {string} reminderId
     * @param {string} adminId
     * @param {object} updates
     * @returns {Promise<object|null>}
     */
    async updateReminder(reminderId, adminId, updates) {
        // Cancel existing jobs before applying any changes
        await cancelReminderJobs(reminderId);

        const fields = {};
        if (updates.description !== undefined) fields.description        = updates.description.trim();
        if (updates.scheduledAt !== undefined) fields.scheduledAt        = new Date(updates.scheduledAt);
        if (updates.channels    !== undefined) fields.channels           = updates.channels;
        if (updates.preReminderEnabled !== undefined) fields.preReminderEnabled = updates.preReminderEnabled;
        if (updates.preReminderValue   !== undefined) fields.preReminderValue   = updates.preReminderValue;
        if (updates.preReminderUnit    !== undefined) fields.preReminderUnit    = updates.preReminderUnit;

        // Reset sent flags and job state when rescheduling
        fields.mainSent        = false;
        fields.preReminderSent = false;
        fields.jobScheduled    = false;

        const updated = await LeadReminder.findOneAndUpdate(
            { _id: reminderId, adminId },
            fields,
            { new: true }
        );

        if (!updated) return null;

        // Schedule new jobs
        await scheduleReminderJobs(updated);

        logger.info(`[ReminderService] Reminder updated | id=${reminderId}`);
        return updated.toObject();
    }

    /**
     * Delete a reminder and cancel its BullMQ jobs.
     * Only the creator may delete.
     *
     * @param {string} reminderId
     * @param {string} adminId
     * @returns {Promise<boolean>}
     */
    async deleteReminder(reminderId, adminId) {
        await cancelReminderJobs(reminderId);
        const result = await LeadReminder.findOneAndDelete({ _id: reminderId, adminId });
        if (!result) return false;
        logger.info(`[ReminderService] Reminder deleted | id=${reminderId}`);
        return true;
    }

    /**
     * Get all fired-but-unread reminders for the bell inbox.
     *
     * @param {string} adminId
     * @returns {Promise<object[]>}
     */
    async getFiredUnreadReminders(adminId, { page = 1, limit = 10 } = {}) {
        const skip = (page - 1) * limit;
        const filter = { adminId, mainSent: true, bellDismissed: { $ne: true } };
        const [items, total, unread] = await Promise.all([
            LeadReminder.find(filter).sort({ scheduledAt: -1 }).skip(skip).limit(limit).lean(),
            LeadReminder.countDocuments(filter),
            LeadReminder.countDocuments({ ...filter, notificationRead: false }),
        ]);
        return { items, total, unread, page, limit };
    }

    /**
     * Mark all (or specific) fired reminders as read.
     *
     * @param {string}    adminId
     * @param {string[]}  [reminderIds]  — omit to mark all as read
     */
    /**
     * Dismiss a reminder from the bell inbox by flagging it.
     * The reminder document is kept intact so it still appears in the lead panel.
     */
    async deleteFiredReminder(reminderId, adminId) {
        await LeadReminder.updateOne(
            { _id: reminderId, adminId },
            { bellDismissed: true, notificationRead: true }
        );
    }

    async markRemindersRead(adminId, reminderIds) {
        const filter = { adminId, mainSent: true, notificationRead: false };
        if (reminderIds?.length) filter._id = { $in: reminderIds };

        await LeadReminder.updateMany(filter, { notificationRead: true });
        logger.info(`[ReminderService] Marked reminders as read | adminId=${adminId}`);
    }
}

export default new ReminderService();
