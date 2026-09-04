/**
 * Reminder Processor
 *
 * Mongo is the durable source of truth. Every dispatch first acquires a
 * per-reminder, per-channel lease so BullMQ workers and recovery workers on
 * multiple instances cannot dispatch the same reminder concurrently.
 */
import { randomUUID } from 'node:crypto';
import LeadReminder from '../models/leadReminderModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import Lead from '../models/leadModel.js';
import { dispatchNotification, dispatchClientNotification } from '../services/channelDispatcher.js';
import { getRedisConnection } from '../config/redisConnector.js';
import logger from '../utils/logger.js';

export const CLAIM_LEASE_MS = 15 * 60 * 1000;

const JOB_CONFIG = {
    main: {
        sent: 'mainSent',
        due: 'scheduledAt',
        token: 'mainClaimToken',
        until: 'mainClaimUntil',
        attempts: 'mainAttempts',
        error: 'mainLastError',
    },
    pre: {
        sent: 'preReminderSent',
        due: 'preScheduledAt',
        token: 'preClaimToken',
        until: 'preClaimUntil',
        attempts: 'preAttempts',
        error: 'preLastError',
        enabled: 'preReminderEnabled',
    },
    client: {
        sent: 'clientSent',
        due: 'clientScheduledAt',
        token: 'clientClaimToken',
        until: 'clientClaimUntil',
        attempts: 'clientAttempts',
        error: 'clientLastError',
        enabled: 'clientReminderEnabled',
    },
};

/** Atomically claim one due, unsent delivery. Returns null when another worker owns it. */
export const claimReminder = async (reminderId, jobType, scope = {}) => {
    const config = JOB_CONFIG[jobType];
    if (!config) throw new Error(`Unsupported reminder job type: ${jobType}`);
    const now = new Date();
    const token = randomUUID();
    const filter = {
        _id: reminderId,
        ...scope,
        [config.sent]: false,
        [config.due]: { $lte: now },
        $or: [
            { [config.until]: null },
            { [config.until]: { $lte: now } },
        ],
    };
    if (config.enabled) filter[config.enabled] = true;

    return LeadReminder.findOneAndUpdate(
        filter,
        {
            $set: {
                [config.token]: token,
                [config.until]: new Date(now.getTime() + CLAIM_LEASE_MS),
                [config.error]: null,
            },
            $inc: { [config.attempts]: 1 },
        },
        { new: true }
    );
};

const releaseClaim = async (reminder, jobType, error) => {
    const config = JOB_CONFIG[jobType];
    await LeadReminder.updateOne(
        {
            _id: reminder._id,
            acctId: reminder.acctId,
            leadId: reminder.leadId,
            [config.token]: reminder[config.token],
            [config.sent]: false,
        },
        {
            $set: {
                [config.token]: null,
                [config.until]: null,
                [config.error]: String(error?.message || error || 'Dispatch failed').slice(0, 1000),
            },
        }
    );
};

const finishClaim = async (reminder, jobType, extra = {}) => {
    const config = JOB_CONFIG[jobType];
    return LeadReminder.updateOne(
        {
            _id: reminder._id,
            acctId: reminder.acctId,
            leadId: reminder.leadId,
            [config.token]: reminder[config.token],
            [config.sent]: false,
        },
        {
            $set: {
                [config.sent]: true,
                [config.token]: null,
                [config.until]: null,
                [config.error]: null,
                ...extra,
            },
        }
    );
};

/** Process an admin reminder after atomically acquiring its Mongo lease. */
export const processReminder = async (reminderId, jobType = 'main', scope = {}) => {
    if (!['main', 'pre'].includes(jobType)) throw new Error(`Unsupported admin reminder type: ${jobType}`);
    const reminder = await claimReminder(reminderId, jobType, scope);
    if (!reminder) {
        logger.info(`[ReminderProcessor] ${jobType} reminder ${reminderId} is sent, not due, or already claimed`);
        return false;
    }

    try {
        const lead = await Lead.findOne(
            { _id: reminder.leadId, acctId: reminder.acctId },
            { responsible: 1 }
        ).lean();
        const recipientUserId = lead?.responsible || reminder.userId;
        const recipientAdmin = await AccountAdmin.findOne(
            { acctId: reminder.acctId, userId: recipientUserId },
            { firstName: 1, lastName: 1, email: 1, phone: 1 }
        ).lean();

        if (!recipientAdmin) {
            const extra = jobType === 'main'
                ? { notificationRead: false, bellDismissed: false, notifiedUserId: null }
                : {};
            await finishClaim(reminder, jobType, extra);
            logger.info(`[ReminderProcessor] ${jobType} reminder ${reminderId} has no current admin recipient`);
            return true;
        }

        await dispatchNotification({
            channels: reminder.channels,
            userId: recipientUserId,
            adminInfo: {
                firstName: recipientAdmin.firstName || '',
                lastName: recipientAdmin.lastName || '',
                email: recipientAdmin.email || null,
                phone: recipientAdmin.phone || null,
            },
            payload: {
                reminderId: reminder._id.toString(),
                description: reminder.description,
                scheduledAt: reminder.scheduledAt,
                leadId: reminder.leadId,
                type: jobType,
                leadName: reminder.leadSnapshot?.name || '',
                leadPhone: reminder.leadSnapshot?.phone || '',
            },
            redisPublisher: getRedisConnection(),
        });

        const extra = jobType === 'main'
            ? { notificationRead: false, bellDismissed: false, notifiedUserId: recipientUserId }
            : { notifiedUserId: recipientUserId };
        const result = await finishClaim(reminder, jobType, extra);
        if (!result.modifiedCount) throw new Error('Reminder claim expired before finalization');
        logger.info(`[ReminderProcessor] ${jobType} reminder ${reminderId} delivered to ${recipientUserId}`);
        return true;
    } catch (error) {
        await releaseClaim(reminder, jobType, error);
        throw error;
    }
};

/** Process a client reminder after atomically acquiring its Mongo lease. */
export const processClientReminder = async (reminderId, scope = {}) => {
    const reminder = await claimReminder(reminderId, 'client', scope);
    if (!reminder) {
        logger.info(`[ReminderProcessor] Client reminder ${reminderId} is sent, not due, disabled, or already claimed`);
        return false;
    }

    try {
        await dispatchClientNotification({
            channels: reminder.clientChannels || [],
            clientInfo: {
                name: reminder.clientName || '',
                phone: reminder.clientPhone || '',
                email: reminder.clientEmail || '',
            },
            payload: {
                reminderId: reminder._id.toString(),
                message: reminder.clientMessage || '',
                scheduledAt: reminder.clientScheduledAt,
                leadId: reminder.leadId,
            },
        });

        const result = await finishClaim(reminder, 'client');
        if (!result.modifiedCount) throw new Error('Client reminder claim expired before finalization');
        logger.info(`[ReminderProcessor] Client reminder ${reminderId} processed successfully`);
        return true;
    } catch (error) {
        await releaseClaim(reminder, 'client', error);
        throw error;
    }
};

/** BullMQ entry point. Jobs must include tenant scope. */
export const processor = async (job) => {
    const { reminderId, jobType, acctId, leadId } = job.data;
    if (!reminderId || !jobType || !acctId || !leadId) {
        throw new Error('Reminder job is missing required tenant scope');
    }
    logger.info(`[ReminderProcessor] Job [${job.id}] | reminderId=${reminderId} | type=${jobType} | attempt=${job.attemptsMade + 1}`);
    const scope = { acctId, leadId };
    if (jobType === 'client') return processClientReminder(reminderId, scope);
    return processReminder(reminderId, jobType, scope);
};
