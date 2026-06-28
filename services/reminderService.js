/**
 * Reminder Service
 *
 * CRUD for lead_reminders + BullMQ job lifecycle management.
 */
import LeadReminder  from '../models/leadReminderModel.js';
import Lead          from '../models/leadModel.js';
import {
    scheduleReminderJobs,
    cancelReminderJobs
} from '../queue/reminderQueue.js';
import logger from '../utils/logger.js';

/**
 * A reminder may be edited/deleted only while it is still PENDING (not yet fired
 * and scheduled in the future), and only by the lead's current responsible —
 * falling back to the creator when the lead is unassigned.
 *
 * Superadmins may manage ANY reminder within their own account, including ones on
 * leads they aren't responsible for (the per-account scope is still enforced).
 */
const canManageReminder = async (reminder, userId, { isSuperadmin = false, acctId = null } = {}) => {
    if (!reminder) return false;
    if (isSuperadmin) {
        return !acctId || String(reminder.acctId) === String(acctId);
    }
    const isPending = !reminder.mainSent && new Date(reminder.scheduledAt) > new Date();
    if (!isPending) return false;
    const lead = await Lead.findById(reminder.leadId, { responsible: 1 }).lean();
    const allowedUserId = lead?.responsible || reminder.userId;
    return String(userId) === String(allowedUserId);
};

class ReminderService {
    /**
     * List all reminders for a lead — all admins can read all reminders.
     * Write operations (create / update / delete) are still creator-only.
     * Returns reminders sorted by scheduledAt descending.
     *
     * @param {string} acctId
     * @param {string} leadId
     * @returns {Promise<object[]>}
     */
    async getReminders(acctId, leadId) {
        return LeadReminder.find({ acctId, leadId })
            .sort({ scheduledAt: -1 })
            .lean();
    }

    /**
     * Get pending reminder counts per lead for a batch of leadIds.
     * Counts all not-yet-fired reminders for the lead (reminders are visible to all
     * admins on a lead), so the grid badge matches the per-lead reminder list.
     *
     * @param {string}   acctId
     * @param {string[]} leadIds
     * @returns {Promise<Record<string, number>>}
     */
    async getBatchReminderCounts(acctId, leadIds) {
        if (!leadIds?.length) return {};
        const results = await LeadReminder.aggregate([
            { $match: { acctId, leadId: { $in: leadIds }, mainSent: false } },
            { $group: { _id: '$leadId', count: { $sum: 1 } } }
        ]);
        return Object.fromEntries(results.map(r => [r._id, r.count]));
    }

    /**
     * Create a reminder and schedule its BullMQ jobs.
     *
     * @param {object} data
     * @returns {Promise<object>}
     */
    async createReminder(data) {
        const reminder = await LeadReminder.create({
            acctId:             data.acctId,
            userId:             data.userId,
            leadId:             data.leadId,
            description:        data.description.trim(),
            scheduledAt:        new Date(data.scheduledAt),
            preReminderEnabled: data.preReminderEnabled || false,
            preReminderValue:   data.preReminderValue   || null,
            preReminderUnit:    data.preReminderUnit     || null,
            channels:           data.channels?.length ? data.channels : ['inApp', 'push'],
            // Client reminder
            clientReminderEnabled: data.clientReminderEnabled || false,
            clientMessage:         data.clientMessage || '',
            clientScheduledAt:     data.clientScheduledAt ? new Date(data.clientScheduledAt) : undefined,
            clientChannels:        data.clientChannels || [],
        });

        // Schedule BullMQ jobs (non-fatal if Redis is down)
        await scheduleReminderJobs(reminder);

        logger.info(`[ReminderService] Reminder created | id=${reminder._id} | leadId=${data.leadId} | userId=${data.userId}`);
        return reminder.toObject();
    }

    /**
     * Update a reminder and reschedule its BullMQ jobs.
     * Only the creator (userId) may update.
     *
     * @param {string} reminderId
     * @param {string} userId
     * @param {object} updates
     * @returns {Promise<object|null>}
     */
    async updateReminder(reminderId, userId, updates, { isSuperadmin = false, acctId = null } = {}) {
        // Only the current assignee may edit (and only while pending); superadmins
        // may edit any reminder within their account.
        const existing = await LeadReminder.findById(reminderId);
        if (!(await canManageReminder(existing, userId, { isSuperadmin, acctId }))) return null;

        // Cancel existing jobs before applying any changes
        await cancelReminderJobs(reminderId);

        const fields = {};
        if (updates.description !== undefined) fields.description        = updates.description.trim();
        if (updates.scheduledAt !== undefined) fields.scheduledAt        = new Date(updates.scheduledAt);
        if (updates.channels    !== undefined) fields.channels           = updates.channels;
        if (updates.preReminderEnabled !== undefined) fields.preReminderEnabled = updates.preReminderEnabled;
        if (updates.preReminderValue   !== undefined) fields.preReminderValue   = updates.preReminderValue;
        if (updates.preReminderUnit    !== undefined) fields.preReminderUnit    = updates.preReminderUnit;

        // Client reminder fields
        if (updates.clientReminderEnabled !== undefined) fields.clientReminderEnabled = updates.clientReminderEnabled;
        if (updates.clientMessage         !== undefined) fields.clientMessage         = updates.clientMessage;
        if (updates.clientScheduledAt     !== undefined) fields.clientScheduledAt     = new Date(updates.clientScheduledAt);
        if (updates.clientChannels        !== undefined) fields.clientChannels        = updates.clientChannels;

        // Reset all sent flags and job state when rescheduling
        fields.mainSent          = false;
        fields.preReminderSent   = false;
        fields.jobScheduled      = false;
        fields.clientSent        = false;
        fields.clientJobScheduled = false;

        const updated = await LeadReminder.findOneAndUpdate(
            { _id: reminderId },
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
     * Only the current assignee may delete, and only while pending.
     *
     * @param {string} reminderId
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    async deleteReminder(reminderId, userId, { isSuperadmin = false, acctId = null } = {}) {
        const existing = await LeadReminder.findById(reminderId);
        if (!(await canManageReminder(existing, userId, { isSuperadmin, acctId }))) return false;

        await cancelReminderJobs(reminderId);
        await LeadReminder.deleteOne({ _id: reminderId });
        logger.info(`[ReminderService] Reminder deleted | id=${reminderId}`);
        return true;
    }

    /**
     * Get all fired-but-unread reminders for the bell inbox.
     * Keyed by `notifiedUserId` — the user the reminder was actually delivered to.
     *
     * @param {string} userId
     * @returns {Promise<object[]>}
     */
    async getFiredUnreadReminders(userId, { page = 1, limit = 10 } = {}) {
        const skip = (page - 1) * limit;
        const filter = { notifiedUserId: userId, mainSent: true, bellDismissed: { $ne: true } };
        const [items, total, unread] = await Promise.all([
            // Enrich each item with the lead's collection name so the bell shows
            // which collection the reminder is from. Paginate first, then join.
            LeadReminder.aggregate([
                { $match: filter },
                { $sort: { scheduledAt: -1 } },
                { $skip: skip },
                { $limit: limit },
                { $lookup: { from: 'leads', localField: 'leadId', foreignField: '_id', as: 'lead' } },
                { $addFields: { lead: { $arrayElemAt: ['$lead', 0] } } },
                { $lookup: { from: 'lead_collections', localField: 'lead.collectionId', foreignField: '_id', as: 'coll' } },
                { $addFields: { collectionName: { $arrayElemAt: ['$coll.collectionName', 0] } } },
                { $project: { lead: 0, coll: 0 } },
            ]),
            LeadReminder.countDocuments(filter),
            LeadReminder.countDocuments({ ...filter, notificationRead: false }),
        ]);
        return { items, total, unread, page, limit };
    }

    /**
     * Dismiss a reminder from the bell inbox by flagging it (recipient only).
     */
    async deleteFiredReminder(reminderId, userId) {
        await LeadReminder.updateOne(
            { _id: reminderId, notifiedUserId: userId },
            { bellDismissed: true, notificationRead: true }
        );
    }

    async markRemindersRead(userId, reminderIds) {
        const filter = { notifiedUserId: userId, mainSent: true, notificationRead: false };
        if (reminderIds?.length) filter._id = { $in: reminderIds };

        await LeadReminder.updateMany(filter, { notificationRead: true });
        logger.info(`[ReminderService] Marked reminders as read | userId=${userId}`);
    }

    /**
     * Calendar view — reminders a user is currently responsible for, within a date
     * range.
     *
     * A reminder belongs to the lead's CURRENT assignee (lead.responsible), so a
     * reassigned reminder follows the lead to the new admin even if another admin
     * created it. When the lead is unassigned, it falls back to the creator
     * (userId) — mirroring how notifications are delivered and who may edit it.
     *
     * Each item is enriched with the lead's live Name / Phone / Email (falling back
     * to the reminder's stored snapshot), so the calendar list can show lead context.
     *
     * @param {string} acctId
     * @param {string} userId
     * @param {Date}   start  inclusive
     * @param {Date}   end    exclusive
     * @returns {Promise<object[]>} reminders sorted by scheduledAt ascending
     */
    async getCalendarReminders(acctId, userId, start, end) {
        return LeadReminder.aggregate([
            { $match: { acctId, scheduledAt: { $gte: start, $lt: end } } },
            { $lookup: { from: 'leads', localField: 'leadId', foreignField: '_id', as: 'lead' } },
            { $addFields: { lead: { $arrayElemAt: ['$lead', 0] } } },
            // Effective owner = lead's current responsible; creator only when unassigned
            {
                $addFields: {
                    effectiveOwner: {
                        $let: {
                            vars: { resp: { $ifNull: ['$lead.responsible', null] } },
                            in: {
                                $cond: [
                                    { $in: ['$$resp', [null, '', 'none', 'None']] },
                                    '$userId',
                                    '$$resp'
                                ]
                            }
                        }
                    }
                }
            },
            { $match: { effectiveOwner: userId } },
            // Resolve the collection the lead belongs to
            { $lookup: { from: 'lead_collections', localField: 'lead.collectionId', foreignField: '_id', as: 'coll' } },
            {
                $project: {
                    _id: 1,
                    leadId: 1,
                    description: 1,
                    scheduledAt: 1,
                    mainSent: 1,
                    notificationRead: 1,
                    preReminderEnabled: 1,
                    preReminderValue: 1,
                    preReminderUnit: 1,
                    channels: 1,
                    name:  { $ifNull: ['$lead.name',  '$leadSnapshot.name'] },
                    phone: { $ifNull: ['$lead.phone', '$leadSnapshot.phone'] },
                    email: { $ifNull: ['$lead.email', '$clientEmail'] },
                    collectionName: { $arrayElemAt: ['$coll.collectionName', 0] },
                }
            },
            { $sort: { scheduledAt: 1 } }
        ]);
    }
}

export default new ReminderService();
