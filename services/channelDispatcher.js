/**
 * Notification Channel Dispatcher
 *
 * Single entry point for dispatching reminder notifications.
 * Each channel is independent — failures in one never block the others.
 *
 * dispatchNotification      — admin notification (all 5 channels)
 * dispatchClientNotification — client notification (email/whatsapp/sms only)
 */
import { send as sendInApp }                                       from './channels/inApp.js';
import { send as sendBrowserPush }                                  from './channels/browserPush.js';
import { send as sendEmail,    sendToClient as emailToClient }     from './channels/email.js';
import { send as sendWhatsApp, sendToClient as whatsappToClient }  from './channels/whatsapp.js';
import { send as sendSMS }                                          from './channels/sms.js';
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
 * Dispatch a reminder notification to the admin across all enabled channels.
 *
 * @param {object} options
 * @param {string[]} options.channels       - Enabled channel keys from reminder.channels
 * @param {string}   options.userId         - Recipient's lead-app userId (routing key for inApp/push)
 * @param {object}   options.adminInfo      - { email, phone, firstName, lastName } recipient contact
 * @param {object}   options.payload        - Notification content
 * @param {import('ioredis').Redis} options.redisPublisher - Required for inApp channel
 */
export const dispatchNotification = async ({ channels, userId, adminInfo, payload, redisPublisher }) => {
    if (!channels?.length) {
        logger.warn(`[Dispatcher] No channels configured for reminder ${payload.reminderId}`);
        return;
    }

    const tasks = channels.map(channel => {
        if (channel === 'inApp') {
            if (!redisPublisher) return Promise.resolve();
            return sendInApp(redisPublisher, userId, payload);
        }

        const handler = CHANNEL_MAP[channel];
        if (!handler) {
            logger.warn(`[Dispatcher] Unknown channel "${channel}" — skipping`);
            return Promise.resolve();
        }

        // Email and WhatsApp need adminInfo; push only needs the routing userId + payload
        if (channel === 'push') return handler(userId, payload);
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

/**
 * Dispatch a client reminder notification via email, WhatsApp, or SMS.
 *
 * @param {object}   options
 * @param {string[]} options.channels    - Client channel keys: 'email' | 'whatsapp' | 'sms'
 * @param {object}   options.clientInfo  - { name, phone, email } — lead's own contact info
 * @param {object}   options.payload     - { reminderId, message, scheduledAt, leadId }
 */
export const dispatchClientNotification = async ({ channels, clientInfo, payload }) => {
    if (!channels?.length) {
        logger.warn(`[Dispatcher] No client channels configured for reminder ${payload.reminderId}`);
        return;
    }

    const handlers = {
        email:    () => emailToClient(clientInfo, payload),
        whatsapp: () => whatsappToClient(clientInfo, payload),
        sms:      () => sendSMS(clientInfo, payload),
    };

    const validChannels = channels.filter(ch => handlers[ch]);
    const tasks         = validChannels.map(ch => handlers[ch]());

    const results = await Promise.allSettled(tasks);

    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            logger.error(`[Dispatcher] Client channel "${validChannels[i]}" failed for reminder ${payload.reminderId}: ${result.reason?.message}`);
        }
    });

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    logger.info(`[Dispatcher] Dispatched client reminder ${payload.reminderId} | channels=${validChannels.join(',')} | ${succeeded}/${validChannels.length} succeeded`);
};
