/**
 * Notification Channel Dispatcher
 *
 * Single entry point for dispatching a reminder notification across
 * all enabled channels. Each channel is independent — failures in one
 * channel never block the others (Promise.allSettled).
 *
 * Channel modules:
 *   inApp       — SSE + Redis pub/sub (real-time in-browser)
 *   push        — Browser Web Push (works even when tab is closed)
 *   email       — SMTP email via Nodemailer
 *   whatsapp    — Botamation /contacts API (phone required)
 *   sms         — Coming soon (no-op stub)
 *
 * Adding a new channel: create a new file in ./channels/ that exports
 *   async function send(adminInfo, payload) { ... }
 * Then register it in the CHANNEL_MAP below.
 */
import { send as sendInApp }       from './channels/inApp.js';
import { send as sendBrowserPush } from './channels/browserPush.js';
import { send as sendEmail }        from './channels/email.js';
import { send as sendWhatsApp }     from './channels/whatsapp.js';
import { send as sendSMS }          from './channels/sms.js';
import logger from '../utils/logger.js';

/**
 * Maps channel key (stored in reminder.channels[]) → handler function.
 * inApp requires a redisPublisher; others only need adminInfo + payload.
 */
const CHANNEL_MAP = {
    inApp:    null, // handled separately — requires redisPublisher
    push:     sendBrowserPush,
    email:    sendEmail,
    whatsapp: sendWhatsApp,
    sms:      sendSMS
};

/**
 * Dispatch a reminder notification to all enabled channels.
 *
 * @param {object} options
 * @param {string[]} options.channels       - Enabled channel keys from reminder.channels
 * @param {string}   options.adminId        - Recipient admin's ID
 * @param {object}   options.adminInfo      - { email, phone, firstName, lastName } from account_admins
 * @param {object}   options.payload        - Notification content
 * @param {string}   options.payload.reminderId
 * @param {string}   options.payload.title
 * @param {string}   options.payload.description
 * @param {Date}     options.payload.scheduledAt
 * @param {string}   options.payload.leadId
 * @param {string}   options.payload.type   - 'main' | 'pre'
 * @param {import('ioredis').Redis} options.redisPublisher - Required for inApp channel
 */
export const dispatchNotification = async ({ channels, adminId, adminInfo, payload, redisPublisher }) => {
    if (!channels?.length) {
        logger.warn(`[Dispatcher] No channels configured for reminder ${payload.reminderId}`);
        return;
    }

    const tasks = channels.map(channel => {
        if (channel === 'inApp') {
            if (!redisPublisher) return Promise.resolve();
            return sendInApp(redisPublisher, adminId, payload);
        }

        const handler = CHANNEL_MAP[channel];
        if (!handler) {
            logger.warn(`[Dispatcher] Unknown channel "${channel}" — skipping`);
            return Promise.resolve();
        }

        // Email and WhatsApp need adminInfo; push only needs adminId + payload
        if (channel === 'push') return handler(adminId, payload);
        return handler(adminInfo, payload);
    });

    const results = await Promise.allSettled(tasks);

    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            logger.error(`[Dispatcher] Channel "${channels[i]}" failed for reminder ${payload.reminderId}: ${result.reason?.message}`);
        }
    });

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    logger.info(`[Dispatcher] Dispatched reminder ${payload.reminderId} | channels=${channels.join(',')} | ${succeeded}/${channels.length} succeeded`);
};
