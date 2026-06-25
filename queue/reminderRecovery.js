/**
 * Reminder Recovery Cron
 *
 * Runs at server boot and every 2 minutes thereafter.
 * Finds reminders whose fire time has passed but were never enqueued
 * (Redis was down, server crashed, etc.) and processes them directly.
 *
 * Covers three cases:
 *   1. Missed main reminders
 *   2. Missed pre-reminders
 *   3. Missed client reminders
 */
import LeadReminder from '../models/leadReminderModel.js';
import { processReminder, processClientReminder } from './reminderProcessor.js';
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

        // ── Missed client reminders ────────────────────────────────────────
        const missedClient = await LeadReminder.find({
            clientReminderEnabled: true,
            clientSent:            false,
            clientJobScheduled:    false,
            clientScheduledAt:     { $lte: now },
        }).lean();

        if (missedClient.length) {
            logger.info(`[ReminderRecovery] Found ${missedClient.length} missed client reminder(s)`);
            for (const reminder of missedClient) {
                try {
                    await processClientReminder(reminder._id.toString());
                } catch (err) {
                    logger.error(`[ReminderRecovery] Failed to recover client reminder ${reminder._id}: ${err.message}`);
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
    runRecovery();
    setInterval(runRecovery, RECOVERY_INTERVAL_MS);
    logger.info('[ReminderRecovery] Recovery cron started (interval: 2 min)');
};
