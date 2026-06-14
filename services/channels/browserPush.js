/**
 * Browser Push Notification Channel
 *
 * Sends Web Push notifications to all registered browser subscriptions
 * for the target admin using the `web-push` library.
 *
 * Required environment variables:
 *   VAPID_PUBLIC_KEY   — generate with: npx web-push generate-vapid-keys
 *   VAPID_PRIVATE_KEY  — same command
 *   VAPID_MAILTO       — mailto:admin@yourdomain.com
 *
 * Expired subscriptions (HTTP 410/404 from push service) are auto-deleted.
 */
import webpush from 'web-push';
import PushSubscription from '../../models/pushSubscriptionModel.js';
import logger from '../../utils/logger.js';

// Initialise VAPID only when keys are configured
let vapidInitialised = false;

const initVapid = () => {
    if (vapidInitialised) return;
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_MAILTO } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_MAILTO) {
        logger.warn('[BrowserPush] VAPID keys not configured — browser push disabled');
        return;
    }
    webpush.setVapidDetails(VAPID_MAILTO, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidInitialised = true;
};

/**
 * Send a browser push notification to all subscriptions for an admin.
 *
 * @param {string} adminId
 * @param {object} payload - { reminderId, description, leadId, type, leadName, leadPhone }
 */
export const send = async (adminId, payload) => {
    initVapid();
    if (!vapidInitialised) return;

    const subscriptions = await PushSubscription.find({ adminId });
    if (!subscriptions.length) {
        logger.info(`[BrowserPush] No subscriptions for adminId=${adminId}`);
        return;
    }

    // Build body: "Lead Name · +91… · reminder description"
    const bodyParts  = [payload.leadName, payload.leadPhone, payload.description].filter(Boolean);
    const pushPayload = JSON.stringify({
        title: 'Reminder',
        body:  bodyParts.join(' · '),
        icon:  '/favicon.ico',
        data: {
            reminderId: payload.reminderId,
            leadId:     payload.leadId,
            url:        `/leads?openLead=${payload.leadId}&tab=reminders`,
        }
    });

    const results = await Promise.allSettled(
        subscriptions.map(sub =>
            webpush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                pushPayload
            )
        )
    );

    // Auto-delete expired/invalid subscriptions (410 Gone / 404 Not Found)
    const deleteIds = [];
    results.forEach((result, i) => {
        if (result.status === 'rejected') {
            const status = result.reason?.statusCode;
            if (status === 410 || status === 404) {
                deleteIds.push(subscriptions[i]._id);
            } else {
                logger.error(`[BrowserPush] Push failed for sub ${subscriptions[i]._id}: ${result.reason?.message}`);
            }
        }
    });

    if (deleteIds.length) {
        await PushSubscription.deleteMany({ _id: { $in: deleteIds } });
        logger.info(`[BrowserPush] Removed ${deleteIds.length} expired subscription(s) for adminId=${adminId}`);
    }

    const sent = results.filter(r => r.status === 'fulfilled').length;
    logger.info(`[BrowserPush] Sent ${sent}/${subscriptions.length} push(es) for adminId=${adminId}`);
};
