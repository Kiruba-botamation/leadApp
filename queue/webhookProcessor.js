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
import logger from '../utils/logger.js';

export const processor = async (job) => {
    const { configId, acctId, event, data } = job.data;

    const config = await WebhookConfig.findById(configId).lean();
    if (!config || !config.active) {
        logger.info(`[WebhookProcessor] Config ${configId} missing/inactive — dropping delivery`);
        return;
    }

    const bodyObj = { event, acctId, data, timestamp: new Date().toISOString() };
    const body = JSON.stringify(bodyObj);
    const signature = crypto.createHmac('sha256', config.secret).update(body).digest('hex');

    const maxAttempts = job.opts?.attempts || 1;
    const attemptNo = job.attemptsMade + 1;
    const isFinalAttempt = attemptNo >= maxAttempts;

    try {
        const res = await axios.post(config.url, body, {
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Event': event,
                'X-Webhook-Signature': `sha256=${signature}`
            },
            timeout: 10000,
            validateStatus: () => true
        });

        const ok = res.status >= 200 && res.status < 300;
        if (ok) {
            await WebhookDelivery.create({
                acctId, configId, event, payload: bodyObj,
                status: 'success', statusCode: res.status, attempts: attemptNo, lastError: null
            });
            logger.info(`[WebhookProcessor] Delivered ${event} to ${config.url} (${res.status})`);
            return;
        }

        // Non-2xx — record only on the final attempt, then throw to retry/fail
        if (isFinalAttempt) {
            await WebhookDelivery.create({
                acctId, configId, event, payload: bodyObj,
                status: 'failed', statusCode: res.status, attempts: attemptNo, lastError: `HTTP ${res.status}`
            });
        }
        throw new Error(`Webhook returned HTTP ${res.status}`);
    } catch (err) {
        // Network/timeout errors land here too — record on the final attempt
        if (isFinalAttempt) {
            await WebhookDelivery.create({
                acctId, configId, event, payload: bodyObj,
                status: 'failed', statusCode: null, attempts: attemptNo, lastError: err.message
            }).catch(() => { /* delivery-log write best-effort */ });
        }
        throw err;
    }
};
