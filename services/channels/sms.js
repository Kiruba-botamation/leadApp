/**
 * SMS Notification Channel — Coming Soon
 *
 * This is a placeholder module. SMS delivery is not yet implemented.
 * When ready, integrate an SMS provider (Twilio, AWS SNS, etc.) here
 * following the same pattern as the other channel modules.
 *
 * The `send` function is a no-op so it doesn't break the dispatcher.
 */
import logger from '../../utils/logger.js';

/**
 * @param {object} adminInfo  - { phone, firstName, lastName }
 * @param {object} payload    - { reminderId, title, description, scheduledAt, type }
 */
export const send = async (adminInfo, payload) => {
    logger.info(`[SMS] Channel not yet implemented — skipping SMS for adminId via phone ${adminInfo?.phone || 'unknown'}`);
};
