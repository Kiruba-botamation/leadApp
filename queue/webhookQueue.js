/**
 * Webhook Queue
 *
 * BullMQ queue + worker for outbound webhook delivery. Each domain event
 * (lead.created / lead.assigned / lead.unassigned) that matches an active
 * webhook config is enqueued here and delivered with retries + backoff.
 */
import { addJob, createWorker, getQueue, getQueueStats } from '../config/queueManager.js';
import { processor } from './webhookProcessor.js';
import logger from '../utils/logger.js';

const appAcct = process.env.APP_ACCT || 'development';
export const QUEUE_NAME = `webhook-queue-${appAcct}`;

// Retry with exponential backoff; keep failed jobs a week for debugging
const JOB_OPTIONS = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 }
};

/**
 * Enqueue a single webhook delivery.
 * @param {object} data - { configId, acctId, event, data }
 */
export const enqueueWebhook = (data) =>
    addJob(QUEUE_NAME, data.event, data, { ...JOB_OPTIONS });

export const removeWebhookJobs = async ({ acctId, configIds = [], leadIds = [], allForAccount = false }) => {
    const configSet = new Set(configIds.map(String));
    const leadSet = new Set(leadIds.map(String));
    if (!allForAccount && !configSet.size && !leadSet.size) return;
    try {
        const jobs = await getQueue(QUEUE_NAME).getJobs(['waiting', 'delayed', 'prioritized', 'failed', 'completed']);
        const matches = jobs.filter(job => String(job.data?.acctId) === String(acctId) && (
            allForAccount
            || configSet.has(String(job.data?.configId))
            || leadSet.has(String(job.data?.data?.leadId))
        ));
        await Promise.allSettled(matches.map(job => job.remove()));
    } catch (error) {
        logger.warn(`[WebhookQueue] Could not remove owned jobs | acctId=${acctId} | error=${error.message}`);
    }
};

/** Start the webhook delivery worker. Call once on startup. */
export const initializeWorker = () => {
    logger.info(`[WebhookQueue] Starting worker | queue=${QUEUE_NAME}`);
    return createWorker(QUEUE_NAME, processor, { concurrency: 5 });
};

/** Health stats for the webhook queue. */
export const getHealth = async () => {
    try {
        const stats = await getQueueStats(QUEUE_NAME);
        return { success: true, queue: QUEUE_NAME, status: 'operational', stats };
    } catch (error) {
        return { success: false, queue: QUEUE_NAME, status: 'unavailable', error: error.message };
    }
};
