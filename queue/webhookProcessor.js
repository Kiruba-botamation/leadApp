/**
 * Webhook Processor
 *
 * Delivers one webhook job: POSTs the signed payload to the configured URL.
 * Throws on non-2xx so BullMQ retries with backoff. A delivery row is recorded
 * on success and on the final failed attempt (so the audit log isn't spammed
 * with a row per retry).
 */
import crypto from 'crypto';
import axios from 'axios';
import WebhookConfig from '../models/webhookConfigModel.js';
import WebhookDelivery from '../models/webhookDeliveryModel.js';
import { buildContext, renderPayload } from '../services/webhookTemplate.js';
import logger from '../utils/logger.js';

/** Headers the processor always controls — custom headers cannot override these. */
const RESERVED_HEADERS = new Set(['content-type', 'x-webhook-event', 'x-webhook-signature']);

/** Normalize a config.headers value (Map under hydrated docs, object under lean()) to a plain object. */
const headersToObject = (headers) => {
    if (!headers) return {};
    if (headers instanceof Map) return Object.fromEntries(headers);
    if (typeof headers === 'object') return { ...headers };
    return {};
};

export const processor = async (job) => {
    const { configId, acctId, event, data } = job.data;

    const config = await WebhookConfig.findOne({ _id: configId, acctId }).lean();
    if (!config || !config.active) {
        logger.info(`[WebhookProcessor] Config ${configId} missing/inactive — dropping delivery`);
        return;
    }

    const timestamp = new Date().toISOString();
    const context = buildContext({ event, acctId, data, timestamp });
    const bodyObj = renderPayload(config.payloadTemplate, context);
    const body = JSON.stringify(bodyObj);
    const signature = crypto.createHmac('sha256', config.secret).update(body).digest('hex');

    // Custom headers first, then reserved headers so signing/identification can't be clobbered.
    const customHeaders = {};
    for (const [key, value] of Object.entries(headersToObject(config.headers))) {
        if (!RESERVED_HEADERS.has(String(key).toLowerCase())) customHeaders[key] = value;
    }

    const maxAttempts = job.opts?.attempts || 1;
    const attemptNo = job.attemptsMade + 1;
    const isFinalAttempt = attemptNo >= maxAttempts;

    try {
        const res = await axios.post(config.url, body, {
            headers: {
                ...customHeaders,
                'Content-Type': 'application/json',
                'X-Webhook-Event': event,
                'X-Webhook-Signature': `sha256=${signature}`
            },
            timeout: 10000,
            validateStatus: () => true
        });

        const ok = res.status >= 200 && res.status < 300;
        if (ok) {
            if (await WebhookConfig.exists({ _id: configId, acctId })) {
                await WebhookDelivery.create({
                    acctId, configId, leadId: data?.leadId || null, collectionId: config.collectionId, event, payload: bodyObj,
                    status: 'success', statusCode: res.status, attempts: attemptNo, lastError: null
                });
            }
            logger.info(`[WebhookProcessor] Delivered ${event} to ${config.url} (${res.status})`);
            return;
        }

        const error = new Error(`Webhook returned HTTP ${res.status}`);
        error.statusCode = res.status;
        throw error;
    } catch (err) {
        // Network/timeout errors land here too — record on the final attempt
        if (isFinalAttempt) {
            const configStillExists = await WebhookConfig.exists({ _id: configId, acctId }).catch(() => false);
            if (configStillExists) {
                await WebhookDelivery.create({
                    acctId, configId, leadId: data?.leadId || null, collectionId: config.collectionId, event, payload: bodyObj,
                    status: 'failed', statusCode: err.statusCode ?? null, attempts: attemptNo, lastError: err.message
                }).catch(() => { /* delivery-log write best-effort */ });
            }
        }
        throw err;
    }
};
