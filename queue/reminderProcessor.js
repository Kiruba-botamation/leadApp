/**
 * Reminder Processor
 *
 * The BullMQ worker calls this function for each scheduled job.
 * It loads the reminder from MongoDB, resolves admin info, and
 * dispatches notifications to all enabled channels.
 *
 * Job data shape:
 * {
 *   reminderId : string   — LeadReminder._id
 *   jobType    : 'main' | 'pre'
 * }
 */
import LeadReminder    from '../models/leadReminderModel.js';
import AccountAdmin    from '../models/accountAdminModel.js';
import { dispatchNotification } from '../services/channelDispatcher.js';
import { getRedisConnection }   from '../config/redisConnector.js';
import logger from '../utils/logger.js';

/**
 * Core processing logic — shared by the BullMQ worker AND the recovery cron.
 *
 * @param {string} reminderId
 * @param {'main'|'pre'} jobType
 */
export const processReminder = async (reminderId, jobType = 'main') => {
    const reminder = await LeadReminder.findById(reminderId);

    if (!reminder) {
        logger.warn(`[ReminderProcessor] Reminder ${reminderId} not found — skipping`);
        return;
    }

    // Guard against duplicate delivery
    if (jobType === 'main'  && reminder.mainSent) {
        logger.info(`[ReminderProcessor] Main reminder ${reminderId} already sent — skipping`);
        return;
    }
    if (jobType === 'pre' && reminder.preReminderSent) {
        logger.info(`[ReminderProcessor] Pre-reminder ${reminderId} already sent — skipping`);
        return;
    }

    // Resolve admin info (for email / WhatsApp channels)
    // reminder.adminId stores account_admins._id (resolved by ssoAuthMiddleware at creation time)
    const adminInfo = await AccountAdmin.findOne(
        { _id: reminder.adminId },
        { firstName: 1, lastName: 1, email: 1, phone: 1 }
    ).lean();

    const payload = {
        reminderId:  reminder._id.toString(),
        description: reminder.description,
        scheduledAt: reminder.scheduledAt,
        leadId:      reminder.leadId,
        type:        jobType,
        leadName:    reminder.leadSnapshot?.name  || '',
        leadPhone:   reminder.leadSnapshot?.phone || '',
    };

    // Dispatch to all enabled channels
    await dispatchNotification({
        channels:       reminder.channels,
        adminId:        reminder.adminId,
        adminInfo:      adminInfo || {},
        payload,
        redisPublisher: getRedisConnection()
    });

    // Mark notification as sent + unread (for bell inbox)
    const update = jobType === 'main'
        ? { mainSent: true, notificationRead: false }
        : { preReminderSent: true };

    await LeadReminder.findByIdAndUpdate(reminderId, update);
    logger.info(`[ReminderProcessor] ${jobType} reminder ${reminderId} processed successfully`);
};

/**
 * BullMQ job processor — called by the worker for each job.
 * Throws on failure so BullMQ can apply configured retry/backoff.
 *
 * @param {import('bullmq').Job} job
 */
export const processor = async (job) => {
    const { reminderId, jobType } = job.data;
    logger.info(`[ReminderProcessor] Job [${job.id}] | reminderId=${reminderId} | type=${jobType} | attempt=${job.attemptsMade + 1}`);
    await processReminder(reminderId, jobType);
};
