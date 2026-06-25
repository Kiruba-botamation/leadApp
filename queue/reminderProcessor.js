/**
 * Reminder Processor
 *
 * The BullMQ worker calls this function for each scheduled job.
 *
 * Job data shape:
 * {
 *   reminderId : string
 *   jobType    : 'main' | 'pre' | 'client'
 * }
 */
import LeadReminder    from '../models/leadReminderModel.js';
import AccountAdmin    from '../models/accountAdminModel.js';
import Lead            from '../models/leadModel.js';
import { dispatchNotification, dispatchClientNotification } from '../services/channelDispatcher.js';
import { getRedisConnection }   from '../config/redisConnector.js';
import logger from '../utils/logger.js';

/**
 * Process admin reminder (main or pre).
 * Shared by the BullMQ worker AND the recovery cron.
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

    // Recipient is the lead's CURRENT responsible at fire time, falling back to the
    // creator when the lead is unassigned. This makes a reassigned reminder reach the
    // new assignee. Contact info (email/phone) comes from the live admin record.
    const lead = await Lead.findById(reminder.leadId, { responsible: 1 }).lean();
    const recipientUserId = lead?.responsible || reminder.userId;

    const recipientAdmin = await AccountAdmin.findOne(
        { acctId: reminder.acctId, userId: recipientUserId },
        { firstName: 1, lastName: 1, email: 1, phone: 1 }
    ).lean();

    // If the recipient is no longer an admin of the account, skip silently —
    // mark as fired so it isn't retried, but deliver nothing.
    if (!recipientAdmin) {
        const skipUpdate = jobType === 'main'
            ? { mainSent: true, notificationRead: false, notifiedUserId: null }
            : { preReminderSent: true };
        await LeadReminder.findByIdAndUpdate(reminderId, skipUpdate);
        logger.info(`[ReminderProcessor] ${jobType} reminder ${reminderId} — no current admin recipient, skipped silently`);
        return;
    }

    const adminInfo = {
        firstName: recipientAdmin.firstName || '',
        lastName:  recipientAdmin.lastName  || '',
        email:     recipientAdmin.email || null,
        phone:     recipientAdmin.phone || null,
    };

    const payload = {
        reminderId:  reminder._id.toString(),
        description: reminder.description,
        scheduledAt: reminder.scheduledAt,
        leadId:      reminder.leadId,
        type:        jobType,
        leadName:    reminder.leadSnapshot?.name  || '',
        leadPhone:   reminder.leadSnapshot?.phone || '',
    };

    await dispatchNotification({
        channels:       reminder.channels,
        userId:         recipientUserId,
        adminInfo,
        payload,
        redisPublisher: getRedisConnection()
    });

    const update = jobType === 'main'
        ? { mainSent: true, notificationRead: false, notifiedUserId: recipientUserId }
        : { preReminderSent: true, notifiedUserId: recipientUserId };

    await LeadReminder.findByIdAndUpdate(reminderId, update);
    logger.info(`[ReminderProcessor] ${jobType} reminder ${reminderId} delivered to ${recipientUserId}`);
};

/**
 * Process client reminder.
 * Dispatches to the lead's own contact info via email/whatsapp/sms.
 * Shared by the BullMQ worker AND the recovery cron.
 *
 * @param {string} reminderId
 */
export const processClientReminder = async (reminderId) => {
    const reminder = await LeadReminder.findById(reminderId);

    if (!reminder) {
        logger.warn(`[ReminderProcessor] Reminder ${reminderId} not found — skipping client reminder`);
        return;
    }

    if (!reminder.clientReminderEnabled) {
        logger.info(`[ReminderProcessor] Client reminder ${reminderId} not enabled — skipping`);
        return;
    }

    if (reminder.clientSent) {
        logger.info(`[ReminderProcessor] Client reminder ${reminderId} already sent — skipping`);
        return;
    }

    await dispatchClientNotification({
        channels:   reminder.clientChannels || [],
        clientInfo: {
            name:  reminder.clientName  || '',
            phone: reminder.clientPhone || '',
            email: reminder.clientEmail || '',
        },
        payload: {
            reminderId:  reminder._id.toString(),
            message:     reminder.clientMessage || '',
            scheduledAt: reminder.clientScheduledAt,
            leadId:      reminder.leadId,
        },
    });

    await LeadReminder.findByIdAndUpdate(reminderId, { clientSent: true });
    logger.info(`[ReminderProcessor] Client reminder ${reminderId} processed successfully`);
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

    if (jobType === 'client') {
        await processClientReminder(reminderId);
    } else {
        await processReminder(reminderId, jobType);
    }
};
