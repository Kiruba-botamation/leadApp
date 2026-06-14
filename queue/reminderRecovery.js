/**
 * Reminder Recovery Cron
 *
 * Runs at server boot and every 2 minutes thereafter.
 * Finds reminders whose fire time has passed but were never enqueued
 * (Redis was down, server crashed, etc.) and processes them directly.
 *
 * A reminder is considered "missed" when:
 *   - scheduledAt <= now (the fire time has passed)
 *   - jobScheduled === false (was never enqueued in BullMQ)
 *   - mainSent === false (hasn't been delivered yet)
 *
 * For pre-reminders, the same logic applies separately.
 */
import LeadReminder from '../models/leadReminderModel.js';
import { processReminder } from './reminderProcessor.js';
import logger from '../utils/logger.js';

const RECOVERY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Find and process all missed reminders.
 * Errors in individual reminders are caught and logged — never crash the cron.
 */
const runRecovery = async () => {
    try {
        const now = new Date();

        // ── Missed main reminders ──────────────────────────────────────────
        const missedMain = await LeadReminder.find({
            scheduledAt:   { $lte: now },
            mainSent:      false,
            jobScheduled:  false
        }).lean();

        if (missedMain.length) {
            logger.info(`[ReminderRecovery] Found ${missedMain.length} missed main reminder(s)`);
            for (const reminder of missedMain) {
                try {
                    await processReminder(reminder._id.toString(), 'main');
                } catch (err) {
                    logger.error(`[ReminderRecovery] Failed to recover main reminder ${reminder._id}: ${err.message}`);
                }
            }
        }

        // ── Missed pre-reminders ───────────────────────────────────────────
        // Calculate the pre-reminder fire time for each and check if it's past
        const pendingPre = await LeadReminder.find({
            preReminderEnabled: true,
            preReminderSent:    false,
            jobScheduled:       false
        }).lean();

        const missedPre = pendingPre.filter(r => {
            if (!r.preReminderValue || !r.preReminderUnit) return false;
            const msMap = {
                minutes: r.preReminderValue * 60 * 1000,
                hours:   r.preReminderValue * 60 * 60 * 1000,
                days:    r.preReminderValue * 24 * 60 * 60 * 1000
            };
            const preFireTime = new Date(r.scheduledAt).getTime() - (msMap[r.preReminderUnit] ?? 0);
            return preFireTime <= now.getTime();
        });

        if (missedPre.length) {
            logger.info(`[ReminderRecovery] Found ${missedPre.length} missed pre-reminder(s)`);
            for (const reminder of missedPre) {
                try {
                    await processReminder(reminder._id.toString(), 'pre');
                } catch (err) {
                    logger.error(`[ReminderRecovery] Failed to recover pre-reminder ${reminder._id}: ${err.message}`);
                }
            }
        }
    } catch (err) {
        logger.error(`[ReminderRecovery] Recovery scan failed: ${err.message}`);
    }
};

/**
 * Start the recovery cron.
 * Runs immediately on call, then every 2 minutes.
 * Call once from server.js after MongoDB is connected.
 */
export const startReminderRecovery = () => {
    // Run immediately on startup to catch anything missed during downtime
    runRecovery();
    setInterval(runRecovery, RECOVERY_INTERVAL_MS);
    logger.info('[ReminderRecovery] Recovery cron started (interval: 2 min)');
};
