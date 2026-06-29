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
import LeadCollection from '../models/leadCollectionModel.js';
import bus, { EVENTS } from './eventBus.js';
import { enqueueWebhook } from '../queue/webhookQueue.js';
import { validateTemplate, getAvailableVariables } from './webhookTemplate.js';
import logger from '../utils/logger.js';

export const AVAILABLE_EVENTS = WEBHOOK_EVENTS;

/** Variable catalog for the payload-template picker, scoped to one collection. */
export const listVariables = (acctId, collectionId) => getAvailableVariables(acctId, collectionId);

/** Resolve a collection owned by the account, or throw a client-facing error. */
const requireCollection = async (acctId, collectionId) => {
    if (!collectionId) throw new Error('collectionId is required');
    const col = await LeadCollection.findOne({ _id: collectionId, acctId }, { collectionName: 1 }).lean();
    if (!col) throw new Error('Collection not found for this account');
    return col;
};

/** Coerce arbitrary header input into a clean { string: string } map (drops empties). */
const sanitizeHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') return undefined;
    const out = {};
    for (const [rawKey, rawVal] of Object.entries(headers)) {
        const key = String(rawKey || '').trim();
        if (!key) continue;
        out[key] = rawVal === undefined || rawVal === null ? '' : String(rawVal);
    }
    return Object.keys(out).length ? out : undefined;
};

/** Generate a random signing secret for a new webhook. */
export const generateSecret = () => crypto.randomBytes(24).toString('hex');

// ── Config CRUD ──────────────────────────────────────────────────────────────

export const listConfigs = async (acctId) => {
    const configs = await WebhookConfig.find({ acctId }).sort({ createdAt: -1 }).lean();
    if (configs.length === 0) return configs;
    // Enrich with the collection display name so the UI needn't re-resolve it
    const cols = await LeadCollection.find({ acctId }, { collectionName: 1 }).lean();
    const nameById = new Map(cols.map(c => [String(c._id), c.collectionName]));
    return configs.map(c => ({ ...c, collectionName: nameById.get(String(c.collectionId)) ?? null }));
};

export const createConfig = async (acctId, { url, events, headers, payloadTemplate, collectionId }) => {
    await requireCollection(acctId, collectionId);
    const validEvents = (events || []).filter(e => WEBHOOK_EVENTS.includes(e));
    const { valid, error } = validateTemplate(payloadTemplate);
    if (!valid) throw new Error(error);
    const config = await WebhookConfig.create({
        acctId,
        collectionId,
        url,
        events: validEvents,
        secret: generateSecret(),
        headers: sanitizeHeaders(headers),
        payloadTemplate: payloadTemplate && String(payloadTemplate).trim() ? payloadTemplate : null,
        active: true
    });
    return config.toObject();
};

export const updateConfig = async (acctId, id, updates) => {
    const fields = {};
    if (updates.collectionId !== undefined) {
        await requireCollection(acctId, updates.collectionId);
        fields.collectionId = updates.collectionId;
    }
    if (updates.url !== undefined) fields.url = updates.url;
    if (updates.active !== undefined) fields.active = !!updates.active;
    if (updates.events !== undefined) {
        fields.events = (updates.events || []).filter(e => WEBHOOK_EVENTS.includes(e));
    }
    if (updates.headers !== undefined) {
        fields.headers = sanitizeHeaders(updates.headers) || {};
    }
    if (updates.payloadTemplate !== undefined) {
        const { valid, error } = validateTemplate(updates.payloadTemplate);
        if (!valid) throw new Error(error);
        fields.payloadTemplate = updates.payloadTemplate && String(updates.payloadTemplate).trim()
            ? updates.payloadTemplate : null;
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
const handleEvent = async ({ event, acctId, collectionId, data }) => {
    if (!acctId) return;
    try {
        // Webhooks are collection-scoped: only deliver to configs for this lead's collection.
        const filter = { acctId, active: true, events: event };
        if (collectionId) filter.collectionId = collectionId;
        const configs = await WebhookConfig.find(filter, { _id: 1 }).lean();
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
