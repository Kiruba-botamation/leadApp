/**
 * WhatsApp Notification Channel (Botamation API)
 *
 * Sends WhatsApp messages via the internal Botamation chatbot platform.
 * Only fires when the admin has a phone number in account_admins.
 *
 * Endpoint:  POST {WHATSAPP_API_URL}/contacts
 * Auth:      x-access-token: {CHATBOT_PLATFORM_API_KEY}
 *
 * TODO: Confirm the exact request body schema with the Botamation API.
 *       Update the `payload` object below to match the expected format.
 *
 * Required environment variables:
 *   WHATSAPP_API_URL          — e.g. https://app.botamation.in/api
 *   CHATBOT_PLATFORM_API_KEY  — already used by accountService.js
 */
import axios from 'axios';
import logger from '../../utils/logger.js';

/**
 * Send a WhatsApp message to the admin.
 * Silently skips if the admin has no phone number or WhatsApp is not configured.
 *
 * @param {object} adminInfo  - { phone, firstName, lastName }
 * @param {object} payload    - { reminderId, title, description, scheduledAt, type }
 */
export const send = async (adminInfo, payload) => {
    const apiUrl = process.env.WHATSAPP_API_URL;
    const apiKey = process.env.CHATBOT_PLATFORM_API_KEY;

    if (!apiUrl || !apiKey) {
        logger.warn('[WhatsApp] Not configured (WHATSAPP_API_URL or CHATBOT_PLATFORM_API_KEY missing) — skipping');
        return;
    }

    if (!adminInfo?.phone) {
        logger.info('[WhatsApp] Admin has no phone number — skipping WhatsApp channel');
        return;
    }

    const adminName  = [adminInfo.firstName, adminInfo.lastName].filter(Boolean).join(' ') || 'Admin';
    const typeLabel  = payload.type === 'pre' ? '⏰ Pre-Reminder' : '🔔 Reminder';
    const body       = `${typeLabel}\n\nHi ${adminName},\n\n${payload.description}\n\n_Scheduled: ${new Date(payload.scheduledAt).toLocaleString()}_`;

    // ── TODO: Update the body below to match the exact Botamation /contacts API schema ──
    const requestBody = {
        phone:   adminInfo.phone,
        message: body,
        // Add any additional fields required by your Botamation /contacts endpoint
    };

    try {
        await axios.post(`${apiUrl}/contacts`, requestBody, {
            headers: {
                'x-access-token': apiKey,
                'Content-Type':   'application/json'
            },
            timeout: 10000
        });
        logger.info(`[WhatsApp] Sent reminder to phone ${adminInfo.phone}`);
    } catch (err) {
        logger.error(`[WhatsApp] Failed to send to ${adminInfo.phone}: ${err.message}`);
        throw err;
    }
};
