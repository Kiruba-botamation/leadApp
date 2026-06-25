/**
 * SMS Notification Channel — Structured Stub
 *
 * SMS delivery is not yet wired to a provider.
 * Wire up Twilio, AWS SNS, etc. in the `send` function below when ready.
 * The stub logs the attempt and returns without error so `clientSent` is
 * marked true — the reminder won't re-fire once a provider is configured.
 */
import logger from '../../utils/logger.js';

/**
 * @param {object} clientInfo  - { name, phone, email }
 * @param {object} payload     - { reminderId, message, scheduledAt, leadId }
 */
export const send = async (clientInfo, payload) => {
    logger.info(`[SMS stub] Would send to ${clientInfo?.phone || 'unknown'}: "${payload?.message || ''}"`);
    // TODO: Replace this stub with a real provider call, e.g.:
    //   await twilioClient.messages.create({ to: clientInfo.phone, body: payload.message, from: process.env.SMS_FROM });
};
