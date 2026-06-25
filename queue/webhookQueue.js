/**
 * Webhook Queue
 *
 * BullMQ queue + worker for outbound webhook delivery. Each domain event
 * (lead.created / lead.assigned / lead.unassigned) that matches an active
 * webhook config is enqueued here and delivered with retries + backoff.
 */
import { addJob, createWorker, getQueueStats } from '../config/queueManager.js';
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
