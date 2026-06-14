/**
 * Reminder Queue
 *
 * BullMQ queue + worker exclusively for scheduled lead reminders.
 * Built on the same queueManager infrastructure as the lead queue.
 *
 * Job types:
 *   "reminder-main"  — fires at reminder.scheduledAt
 *   "reminder-pre"   — fires at scheduledAt minus the pre-reminder offset
 *
 * Job IDs are deterministic:
 *   "{reminderId}-main"
 *   "{reminderId}-pre"
 * This makes them idempotent — re-scheduling the same reminder
 * replaces the existing job rather than creating a duplicate.
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
    removeOnComplete: true,        // Clean up after successful delivery
    removeOnFail: {
        age: 7 * 24 * 3600         // Keep failed jobs for 7 days
    }
};

// ── Worker options ───────────────────────────────────────────────────────────
const WORKER_OPTIONS = {
    concurrency: 5
};

// ── Internal helper — calculate pre-reminder Date ───────────────────────────

/**
 * @param {Date}   scheduledAt
 * @param {number} value
 * @param {string} unit  'minutes' | 'hours' | 'days'
 * @returns {Date}
 */
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
 * Creates a "main" job at scheduledAt and, when enabled, a "pre" job
 * at scheduledAt minus the configured offset.
 *
 * Jobs are idempotent via deterministic jobIds — calling this again
 * after a reschedule replaces the existing delayed jobs.
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
        // jobScheduled stays false — recovery cron will catch it
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

    // Mark jobScheduled in DB so the recovery cron doesn't re-process it
    if (jobScheduledSuccessfully) {
        await LeadReminder.findByIdAndUpdate(reminder._id, { jobScheduled: true });
    }
};

/**
 * Cancel both the main and pre-reminder jobs for a reminder.
 * Call before deleting or rescheduling a reminder.
 *
 * @param {string} reminderId
 */
export const cancelReminderJobs = async (reminderId) => {
    const { getQueue } = await import('../config/queueManager.js');
    const queue = getQueue(QUEUE_NAME);

    const jobIds = [`${reminderId}-main`, `${reminderId}-pre`];
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
