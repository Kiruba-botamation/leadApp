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

export const REMINDER_DESCRIPTION_MAX = 4000;
export const CLIENT_MESSAGE_MAX = 4000;
export const REMINDER_BATCH_MAX = 200;
export const CALENDAR_RESULT_MAX = 1000;
export const CALENDAR_RANGE_MAX_MS = 366 * 24 * 60 * 60 * 1000;
const LIST_DEFAULT = 50;
const LIST_MAX = 100;
const PRIVATE_REMINDER_FIELDS = {
    mainClaimToken: 0, mainClaimUntil: 0, mainAttempts: 0, mainLastError: 0,
    preClaimToken: 0, preClaimUntil: 0, preAttempts: 0, preLastError: 0,
    clientClaimToken: 0, clientClaimUntil: 0, clientAttempts: 0, clientLastError: 0,
};

const serviceError = (message, status = 400) => Object.assign(new Error(message), { status });

export const calculatePreScheduledAt = (scheduledAt, enabled, value, unit) => {
    if (!enabled || !value || !unit) return null;
    const unitMs = { minutes: 60000, hours: 3600000, days: 86400000 }[unit];
    if (!unitMs) return null;
    return new Date(new Date(scheduledAt).getTime() - (Number(value) * unitMs));
};

const encodeCursor = (reminder) => Buffer.from(JSON.stringify({
    scheduledAt: reminder.scheduledAt,
    id: reminder._id,
})).toString('base64url');

const decodeCursor = (cursor) => {
    if (!cursor) return null;
    if (typeof cursor !== 'string' || cursor.length > 1024) throw serviceError('Invalid reminders cursor');
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        const scheduledAt = new Date(parsed.scheduledAt);
        if (!parsed.id || Number.isNaN(scheduledAt.getTime())) throw new Error('invalid');
        return { scheduledAt, id: String(parsed.id) };
    } catch {
        throw serviceError('Invalid reminders cursor');
    }
};

const normalizeBatchIds = (ids, name) => {
    if (ids.length > REMINDER_BATCH_MAX) throw serviceError(`${name} is limited to ${REMINDER_BATCH_MAX}`);
    if (ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) {
        throw serviceError(`${name} must contain non-empty strings of at most 128 characters`);
    }
    return [...new Set(ids)];
};

const getTenantLead = async (acctId, leadId, projection = { _id: 1 }) => {
    const lead = await Lead.findOne({ _id: leadId, acctId }, projection).lean();
    if (!lead) throw serviceError('Lead not found', 404);
    return lead;
};

const getAuthorizedAccountScope = async (userId, acctId) => {
    if (acctId) {
        const authorized = await AccountAdmin.exists({ acctId, userId });
        return authorized ? acctId : { $in: [] };
    }
    const accountIds = await AccountAdmin.distinct('acctId', { userId });
    return { $in: accountIds.filter(Boolean).map(String) };
};

const claimsAvailable = (now = new Date()) => ({
    $and: ['mainClaimUntil', 'preClaimUntil', 'clientClaimUntil'].map(field => ({
        $or: [{ [field]: null }, { [field]: { $lte: now } }],
    })),
});

/**
 * A reminder may be edited/deleted only while it is still PENDING (not yet fired
 * and scheduled in the future), and only by the lead's current responsible —
 * falling back to the creator when the lead is unassigned.
 *
 * Superadmins may manage ANY reminder within their own account, including ones on
 * leads they aren't responsible for (the per-account scope is still enforced).
 */
const canManageReminder = async (reminder, userId, { isSuperadmin = false, acctId, leadId } = {}) => {
    if (!reminder) return false;
    if (String(reminder.acctId) !== String(acctId) || String(reminder.leadId) !== String(leadId)) return false;
    if (isSuperadmin) return true;
    const isPending = !reminder.mainSent && new Date(reminder.scheduledAt) > new Date();
    if (!isPending) return false;
    const lead = await Lead.findOne({ _id: leadId, acctId }, { responsible: 1 }).lean();
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
    async getReminders(acctId, leadId, { cursor = null, limit = LIST_DEFAULT } = {}) {
        await getTenantLead(acctId, leadId);
        const boundedLimit = Math.min(LIST_MAX, Math.max(1, Number(limit) || LIST_DEFAULT));
        const decoded = decodeCursor(cursor);
        const filter = { acctId, leadId };
        if (decoded) {
            filter.$or = [
                { scheduledAt: { $lt: decoded.scheduledAt } },
                { scheduledAt: decoded.scheduledAt, _id: { $lt: decoded.id } },
            ];
        }
        const rows = await LeadReminder.find(filter, PRIVATE_REMINDER_FIELDS)
            .sort({ scheduledAt: -1, _id: -1 })
            .limit(boundedLimit + 1)
            .lean();
        const hasMore = rows.length > boundedLimit;
        const items = hasMore ? rows.slice(0, boundedLimit) : rows;
        return {
            items,
            nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
            hasMore,
            limit: boundedLimit,
        };
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
        const uniqueIds = normalizeBatchIds(leadIds, 'leadIds');
        const results = await LeadReminder.aggregate([
            { $match: { acctId, leadId: { $in: uniqueIds }, mainSent: false } },
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
        if (data.description.length > REMINDER_DESCRIPTION_MAX) throw serviceError(`description is limited to ${REMINDER_DESCRIPTION_MAX} characters`);
        if ((data.clientMessage || '').length > CLIENT_MESSAGE_MAX) throw serviceError(`clientMessage is limited to ${CLIENT_MESSAGE_MAX} characters`);
        const lead = await getTenantLead(data.acctId, data.leadId, { name: 1, phone: 1, email: 1 });
        const scheduledAt = new Date(data.scheduledAt);
        const preScheduledAt = calculatePreScheduledAt(
            scheduledAt, data.preReminderEnabled, data.preReminderValue, data.preReminderUnit
        );
        const reminder = await LeadReminder.create({
            acctId:             data.acctId,
            userId:             data.userId,
            leadId:             data.leadId,
            description:        data.description.trim(),
            scheduledAt,
            preScheduledAt,
            preReminderEnabled: data.preReminderEnabled || false,
            preReminderValue:   data.preReminderValue   || null,
            preReminderUnit:    data.preReminderUnit     || null,
            channels:           data.channels?.length ? data.channels : ['inApp', 'push'],
            // Client reminder
            clientReminderEnabled: data.clientReminderEnabled || false,
            clientMessage:         data.clientMessage || '',
            clientScheduledAt:     data.clientScheduledAt ? new Date(data.clientScheduledAt) : undefined,
            clientChannels:        data.clientChannels || [],
            leadSnapshot:          { name: String(lead.name || ''), phone: String(lead.phone || '') },
            clientName:            String(lead.name || ''),
            clientPhone:           String(lead.phone || ''),
            clientEmail:           String(lead.email || ''),
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
    async updateReminder(acctId, leadId, reminderId, userId, updates, { isSuperadmin = false } = {}) {
        // Only the current assignee may edit (and only while pending); superadmins
        // may edit any reminder within their account.
        const existing = await LeadReminder.findOne({ _id: reminderId, acctId, leadId });
        if (!(await canManageReminder(existing, userId, { isSuperadmin, acctId, leadId }))) return null;
        const now = Date.now();
        if ([existing.mainClaimUntil, existing.preClaimUntil, existing.clientClaimUntil]
            .some(until => until && new Date(until).getTime() > now)) {
            throw serviceError('Reminder is currently being dispatched; retry the update shortly', 409);
        }
        if (updates.description?.length > REMINDER_DESCRIPTION_MAX) throw serviceError(`description is limited to ${REMINDER_DESCRIPTION_MAX} characters`);
        if (updates.clientMessage?.length > CLIENT_MESSAGE_MAX) throw serviceError(`clientMessage is limited to ${CLIENT_MESSAGE_MAX} characters`);

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

        const nextScheduledAt = fields.scheduledAt || existing.scheduledAt;
        const nextPreEnabled = fields.preReminderEnabled ?? existing.preReminderEnabled;
        const nextPreValue = fields.preReminderValue ?? existing.preReminderValue;
        const nextPreUnit = fields.preReminderUnit ?? existing.preReminderUnit;
        fields.preScheduledAt = calculatePreScheduledAt(nextScheduledAt, nextPreEnabled, nextPreValue, nextPreUnit);
        if (nextPreEnabled && !fields.preScheduledAt) {
            throw serviceError('preReminderValue and preReminderUnit are required when preReminderEnabled is true');
        }

        // Reset all sent flags and job state when rescheduling
        fields.mainSent          = false;
        fields.preReminderSent   = false;
        fields.jobScheduled      = false;
        fields.clientSent        = false;
        fields.clientJobScheduled = false;
        fields.mainClaimToken = null;
        fields.mainClaimUntil = null;
        fields.preClaimToken = null;
        fields.preClaimUntil = null;
        fields.clientClaimToken = null;
        fields.clientClaimUntil = null;

        const updated = await LeadReminder.findOneAndUpdate(
            { _id: reminderId, acctId, leadId, ...claimsAvailable() },
            fields,
            { new: true }
        );

        if (!updated) return null;

        // Old workers observe the new due times through the atomic Mongo claim, so
        // persistence can safely happen before replacing the deterministic jobs.
        await cancelReminderJobs(reminderId);
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
    async deleteReminder(acctId, leadId, reminderId, userId, { isSuperadmin = false } = {}) {
        const existing = await LeadReminder.findOne({ _id: reminderId, acctId, leadId });
        if (!(await canManageReminder(existing, userId, { isSuperadmin, acctId, leadId }))) return false;
        const now = Date.now();
        if ([existing.mainClaimUntil, existing.preClaimUntil, existing.clientClaimUntil]
            .some(until => until && new Date(until).getTime() > now)) {
            throw serviceError('Reminder is currently being dispatched; retry deletion shortly', 409);
        }

        await cancelReminderJobs(reminderId);
        const result = await LeadReminder.deleteOne({ _id: reminderId, acctId, leadId, ...claimsAvailable() });
        if (!result.deletedCount) return false;
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
    async getFiredUnreadReminders(userId, { acctId = null, page = 1, limit = 10, includeCounts = false } = {}) {
        const skip = (page - 1) * limit;
        const filter = {
            acctId: await getAuthorizedAccountScope(userId, acctId),
            notifiedUserId: userId,
            mainSent: true,
            bellDismissed: false,
        };
        const unreadFilter = { ...filter, notificationRead: false };
        const countTasks = includeCounts
            ? [LeadReminder.countDocuments(filter), LeadReminder.countDocuments(unreadFilter)]
            : [
                Promise.resolve(null),
                LeadReminder.find(unreadFilter, { _id: 1 }).limit(100).lean().then(rows => rows.length),
            ];
        const [rows, total, unread] = await Promise.all([
            // Enrich each item with the lead's collection name so the bell shows
            // which collection the reminder is from. Paginate first, then join.
            LeadReminder.aggregate([
                { $match: filter },
                { $sort: { scheduledAt: -1 } },
                { $skip: skip },
                { $limit: limit + 1 },
                { $lookup: {
                    from: 'leads',
                    let: { leadId: '$leadId', accountId: '$acctId' },
                    pipeline: [
                        { $match: { $expr: { $and: [
                            { $eq: ['$_id', '$$leadId'] },
                            { $eq: ['$acctId', '$$accountId'] },
                        ] } } },
                        { $project: { collectionId: 1 } },
                    ],
                    as: 'lead'
                } },
                { $addFields: { lead: { $arrayElemAt: ['$lead', 0] } } },
                { $lookup: { from: 'lead_collections', localField: 'lead.collectionId', foreignField: '_id', as: 'coll' } },
                { $addFields: { collectionName: { $arrayElemAt: ['$coll.collectionName', 0] } } },
                { $project: { lead: 0, coll: 0, ...PRIVATE_REMINDER_FIELDS } },
            ]),
            ...countTasks,
        ]);
        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        return { items, total, unread, page, limit, hasMore };
    }

    /**
     * Dismiss a reminder from the bell inbox by flagging it (recipient only).
     */
    async deleteFiredReminder(reminderId, userId, acctId = null) {
        const filter = {
            _id: reminderId,
            acctId: await getAuthorizedAccountScope(userId, acctId),
            notifiedUserId: userId,
        };
        await LeadReminder.updateOne(
            filter,
            { bellDismissed: true, notificationRead: true }
        );
    }

    async markRemindersRead(userId, reminderIds, acctId = null) {
        const filter = {
            acctId: await getAuthorizedAccountScope(userId, acctId),
            notifiedUserId: userId,
            mainSent: true,
            notificationRead: false,
        };
        if (reminderIds?.length) {
            const uniqueIds = normalizeBatchIds(reminderIds, 'reminderIds');
            filter._id = { $in: uniqueIds };
        }

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
        if (end <= start) throw serviceError('end must be after start');
        if (end.getTime() - start.getTime() > CALENDAR_RANGE_MAX_MS) {
            throw serviceError('Calendar range is limited to 366 days');
        }
        const rows = await LeadReminder.aggregate([
            { $match: { acctId, scheduledAt: { $gte: start, $lt: end } } },
            { $lookup: {
                from: 'leads',
                let: { leadId: '$leadId', accountId: '$acctId' },
                pipeline: [
                    { $match: { $expr: { $and: [
                        { $eq: ['$_id', '$$leadId'] },
                        { $eq: ['$acctId', '$$accountId'] },
                    ] } } },
                    { $project: { responsible: 1, collectionId: 1, name: 1, phone: 1, email: 1 } },
                ],
                as: 'lead'
            } },
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
            { $sort: { scheduledAt: 1 } },
            { $limit: CALENDAR_RESULT_MAX + 1 }
        ]);
        return {
            items: rows.slice(0, CALENDAR_RESULT_MAX),
            hasMore: rows.length > CALENDAR_RESULT_MAX,
            limit: CALENDAR_RESULT_MAX,
        };
    }
}

export default new ReminderService();
