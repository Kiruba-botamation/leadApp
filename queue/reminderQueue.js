/**
 * Reminder Queue
 *
 * BullMQ queue + worker exclusively for scheduled lead reminders.
 *
 * Job types:
 *   "reminder-main"    — fires at reminder.scheduledAt
 *   "reminder-pre"     — fires at scheduledAt minus the pre-reminder offset
 *   "client-reminder"  — fires at reminder.clientScheduledAt (client notification)
 *
 * Job IDs are deterministic:
 *   "{reminderId}-main"
 *   "{reminderId}-pre"
 *   "{reminderId}-client"
 */
import { addJob, createWorker, getQueueStats } from '../config/queueManager.js';
import { processor } from './reminderProcessor.js';
import LeadReminder from '../models/leadReminderModel.js';
import logger from '../utils/logger.js';

const appAcct = process.env.APP_ACCT || 'development';
export const QUEUE_NAME = `reminder-queue-${appAcct}`;

// ── Job options ──────────────────────────────────────────────────────────────
const JOB_OPTIONS = {
    attempts: 3,
    backoff: {
        type: 'exponential',
        delay: 2000
    },
    removeOnComplete: true,
    removeOnFail: {
        age: 7 * 24 * 3600
    }
};

// ── Worker options ───────────────────────────────────────────────────────────
const WORKER_OPTIONS = {
    concurrency: 5
};

// ── Internal helper — calculate pre-reminder Date ───────────────────────────
const calcPreReminderDate = (scheduledAt, value, unit) => {
    const ms = {
        minutes: value * 60 * 1000,
        hours:   value * 60 * 60 * 1000,
        days:    value * 24 * 60 * 60 * 1000
    }[unit] ?? 0;
    return new Date(new Date(scheduledAt).getTime() - ms);
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Schedule BullMQ jobs for a reminder.
 * Creates a "main" job at scheduledAt, an optional "pre" job,
 * and an optional "client" job at clientScheduledAt.
 *
 * @param {import('../models/leadReminderModel.js').default} reminder - Mongoose document
 */
export const scheduleReminderJobs = async (reminder) => {
    const now    = Date.now();
    const mainMs = new Date(reminder.scheduledAt).getTime();
    const mainDelay = Math.max(0, mainMs - now);

    let jobScheduledSuccessfully = false;

    // ── Main job ──────────────────────────────────────────────────────────
    try {
        await addJob(
            QUEUE_NAME,
            'reminder-main',
            { reminderId: reminder._id.toString(), jobType: 'main' },
            {
                ...JOB_OPTIONS,
                jobId: `${reminder._id}-main`,
                delay: mainDelay
            }
        );
        logger.info(`[ReminderQueue] Main job scheduled | reminderId=${reminder._id} | delay=${Math.round(mainDelay / 1000)}s`);
        jobScheduledSuccessfully = true;
    } catch (err) {
        logger.error(`[ReminderQueue] Failed to schedule main job for ${reminder._id}: ${err.message}`);
    }

    // ── Pre-reminder job (when enabled) ──────────────────────────────────
    if (reminder.preReminderEnabled && reminder.preReminderValue && reminder.preReminderUnit) {
        const preDate  = calcPreReminderDate(reminder.scheduledAt, reminder.preReminderValue, reminder.preReminderUnit);
        const preDelay = Math.max(0, preDate.getTime() - now);

        try {
            await addJob(
                QUEUE_NAME,
                'reminder-pre',
                { reminderId: reminder._id.toString(), jobType: 'pre' },
                {
                    ...JOB_OPTIONS,
                    jobId: `${reminder._id}-pre`,
                    delay: preDelay
                }
            );
            logger.info(`[ReminderQueue] Pre-reminder job scheduled | reminderId=${reminder._id} | delay=${Math.round(preDelay / 1000)}s`);
        } catch (err) {
            logger.error(`[ReminderQueue] Failed to schedule pre job for ${reminder._id}: ${err.message}`);
        }
    }

    // ── Client reminder job (when enabled) ───────────────────────────────
    if (reminder.clientReminderEnabled && reminder.clientScheduledAt && !reminder.clientSent) {
        const clientMs    = new Date(reminder.clientScheduledAt).getTime();
        const clientDelay = Math.max(0, clientMs - now);

        try {
            await addJob(
                QUEUE_NAME,
                'client-reminder',
                { reminderId: reminder._id.toString(), jobType: 'client' },
                {
                    ...JOB_OPTIONS,
                    jobId: `${reminder._id}-client`,
                    delay: clientDelay
                }
            );
            logger.info(`[ReminderQueue] Client reminder job scheduled | reminderId=${reminder._id} | delay=${Math.round(clientDelay / 1000)}s`);
            await LeadReminder.findByIdAndUpdate(reminder._id, { clientJobScheduled: true });
        } catch (err) {
            logger.error(`[ReminderQueue] Failed to schedule client job for ${reminder._id}: ${err.message}`);
        }
    }

    // Mark jobScheduled in DB so the recovery cron doesn't re-process it
    if (jobScheduledSuccessfully) {
        await LeadReminder.findByIdAndUpdate(reminder._id, { jobScheduled: true });
    }
};

/**
 * Cancel main, pre-reminder, and client jobs for a reminder.
 * Call before deleting or rescheduling a reminder.
 *
 * @param {string} reminderId
 */
export const cancelReminderJobs = async (reminderId) => {
    const { getQueue } = await import('../config/queueManager.js');
    const queue = getQueue(QUEUE_NAME);

    const jobIds = [`${reminderId}-main`, `${reminderId}-pre`, `${reminderId}-client`];
    for (const jobId of jobIds) {
        try {
            const job = await queue.getJob(jobId);
            if (job) {
                await job.remove();
                logger.info(`[ReminderQueue] Cancelled job ${jobId}`);
            }
        } catch (err) {
            logger.error(`[ReminderQueue] Failed to cancel job ${jobId}: ${err.message}`);
        }
    }
};

/**
 * Start the reminder queue worker.
 * Call once during server startup — never per-request.
 */
export const initializeWorker = () => {
    logger.info(`[ReminderQueue] Starting worker | queue=${QUEUE_NAME} | concurrency=${WORKER_OPTIONS.concurrency}`);
    return createWorker(QUEUE_NAME, processor, WORKER_OPTIONS);
};

/**
 * Return health stats for the reminder queue.
 */
export const getHealth = async () => {
    try {
        const stats = await getQueueStats(QUEUE_NAME);
        return { success: true, queue: QUEUE_NAME, status: 'operational', stats };
    } catch (error) {
        logger.error(`[ReminderQueue] Health check failed: ${error.message}`);
        return { success: false, queue: QUEUE_NAME, status: 'unavailable', error: error.message };
    }
};
