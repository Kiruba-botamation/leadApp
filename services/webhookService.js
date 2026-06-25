/**
 * Webhook Service
 *
 * Manages webhook configs and bridges domain events → the webhook delivery queue.
 * Subscribing to the in-process eventBus keeps lead operations decoupled from
 * delivery: emitters never block, and delivery is retried by BullMQ.
 */
import crypto from 'crypto';
import WebhookConfig, { WEBHOOK_EVENTS } from '../models/webhookConfigModel.js';
import WebhookDelivery from '../models/webhookDeliveryModel.js';
import bus, { EVENTS } from './eventBus.js';
import { enqueueWebhook } from '../queue/webhookQueue.js';
import logger from '../utils/logger.js';

export const AVAILABLE_EVENTS = WEBHOOK_EVENTS;

/** Generate a random signing secret for a new webhook. */
export const generateSecret = () => crypto.randomBytes(24).toString('hex');

// ── Config CRUD ──────────────────────────────────────────────────────────────

export const listConfigs = async (acctId) =>
    WebhookConfig.find({ acctId }).sort({ createdAt: -1 }).lean();

export const createConfig = async (acctId, { url, events }) => {
    const validEvents = (events || []).filter(e => WEBHOOK_EVENTS.includes(e));
    const config = await WebhookConfig.create({
        acctId,
        url,
        events: validEvents,
        secret: generateSecret(),
        active: true
    });
    return config.toObject();
};

export const updateConfig = async (acctId, id, updates) => {
    const fields = {};
    if (updates.url !== undefined) fields.url = updates.url;
    if (updates.active !== undefined) fields.active = !!updates.active;
    if (updates.events !== undefined) {
        fields.events = (updates.events || []).filter(e => WEBHOOK_EVENTS.includes(e));
    }
    return WebhookConfig.findOneAndUpdate({ _id: id, acctId }, fields, { new: true }).lean();
};

export const deleteConfig = async (acctId, id) => {
    const res = await WebhookConfig.deleteOne({ _id: id, acctId });
    return res.deletedCount > 0;
};

export const listDeliveries = async (acctId, { limit = 50 } = {}) =>
    WebhookDelivery.find({ acctId }).sort({ createdAt: -1 }).limit(limit).lean();

// ── Event bridge ─────────────────────────────────────────────────────────────

/**
 * On a domain event, find active configs subscribed to it and enqueue a delivery
 * job per config. Errors are swallowed so emitters are never affected.
 */
const handleEvent = async ({ event, acctId, data }) => {
    if (!acctId) return;
    try {
        const configs = await WebhookConfig.find({ acctId, active: true, events: event }, { _id: 1 }).lean();
        for (const cfg of configs) {
            try {
                await enqueueWebhook({ configId: cfg._id, acctId, event, data });
            } catch (err) {
                logger.error(`[WebhookService] Failed to enqueue webhook for config ${cfg._id}: ${err.message}`);
            }
        }
    } catch (err) {
        logger.error(`[WebhookService] handleEvent(${event}) failed: ${err.message}`);
    }
};

/** Subscribe the dispatcher to all webhook-relevant events. Call once on startup. */
export const registerWebhookDispatcher = () => {
    Object.values(EVENTS).forEach(ev => bus.on(ev, handleEvent));
    logger.info('[WebhookService] Webhook dispatcher registered for events: ' + Object.values(EVENTS).join(', '));
};
