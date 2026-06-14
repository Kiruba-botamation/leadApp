/**
 * In-App Notification Channel
 *
 * Delivers reminder notifications to admin browser sessions in real-time
 * using Server-Sent Events (SSE) + Redis pub/sub.
 *
 * Architecture (PM2 cluster-safe):
 *   - Each PM2 instance maintains an in-memory Map of adminId → Set<SSE res objects>
 *   - When a reminder fires (BullMQ worker), it publishes to Redis channel
 *     `reminder:notify:{adminId}` — all PM2 instances receive it via a shared
 *     subscriber connection, and the instance holding that admin's SSE connection
 *     delivers the event to the browser.
 *
 * The SSE connections and subscriber are managed by sseManager.js (see server.js).
 */
import logger from '../../utils/logger.js';

/** In-process map — each PM2 instance has its own copy */
const sseClients = new Map(); // adminId → Set<res>

/**
 * Register an SSE response object for an admin.
 * Called when admin opens GET /api/ui/reminders/stream.
 */
export const registerSSEClient = (adminId, res) => {
    if (!sseClients.has(adminId)) sseClients.set(adminId, new Set());
    sseClients.get(adminId).add(res);
    logger.info(`[InApp] SSE client registered | adminId=${adminId} | total=${sseClients.get(adminId).size}`);
};

/**
 * Remove a specific SSE response object (called on connection close).
 */
export const removeSSEClient = (adminId, res) => {
    const set = sseClients.get(adminId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) sseClients.delete(adminId);
    logger.info(`[InApp] SSE client removed | adminId=${adminId}`);
};

/**
 * Push a notification event to all active SSE connections for this admin.
 * Called by the Redis subscriber when a `reminder:notify:{adminId}` message arrives.
 *
 * @param {string} adminId
 * @param {object} payload - { reminderId, title, description, leadId, type }
 */
export const deliverToSSEClients = (adminId, payload) => {
    const set = sseClients.get(adminId);
    if (!set || set.size === 0) {
        logger.info(`[InApp] No active SSE clients for adminId=${adminId} — skipping in-app delivery`);
        return;
    }

    const data = JSON.stringify(payload);
    const deadClients = [];

    for (const res of set) {
        try {
            res.write(`data: ${data}\n\n`);
        } catch {
            deadClients.push(res);
        }
    }

    // Clean up broken connections
    for (const res of deadClients) set.delete(res);
    if (set.size === 0) sseClients.delete(adminId);

    logger.info(`[InApp] Delivered to ${set.size} SSE client(s) | adminId=${adminId}`);
};

/**
 * Send in-app notification via Redis pub/sub publish.
 * The worker calls this; one of the PM2 instances will pick it up and
 * call deliverToSSEClients if it holds the connection.
 *
 * @param {import('ioredis').Redis} redisPublisher
 * @param {string} adminId
 * @param {object} payload
 */
export const send = async (redisPublisher, adminId, payload) => {
    try {
        await redisPublisher.publish(
            `reminder:notify:${adminId}`,
            JSON.stringify(payload)
        );
        logger.info(`[InApp] Published reminder:notify for adminId=${adminId}`);
    } catch (err) {
        logger.error(`[InApp] Failed to publish Redis event for adminId=${adminId}: ${err.message}`);
    }
};
