/**
 * Durable reminder recovery.
 *
 * Mongo due-time indexes are scanned in bounded batches. jobScheduled flags are
 * deliberately ignored: Redis can acknowledge a job and subsequently lose it.
 * The processor's atomic leases make this safe on multiple app instances.
 */
import LeadReminder from '../models/leadReminderModel.js';
import { processReminder, processClientReminder } from './reminderProcessor.js';
import logger from '../utils/logger.js';

export const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;
export const RECOVERY_BATCH_SIZE = 100;
const RECOVERY_CONCURRENCY = 5;

const calculatePreScheduledAt = (reminder) => {
    const unitMs = { minutes: 60000, hours: 3600000, days: 86400000 }[reminder.preReminderUnit];
    if (!unitMs || !reminder.preReminderValue) return null;
    return new Date(new Date(reminder.scheduledAt).getTime() - (Number(reminder.preReminderValue) * unitMs));
};

/** Lazily migrate old reminders so all future pre-reminder scans use a due-time index. */
const backfillPreScheduledAt = async () => {
    const legacy = await LeadReminder.find(
        {
            preReminderEnabled: true,
            preReminderSent: false,
            preScheduledAt: null,
            preReminderValue: { $gt: 0 },
            preReminderUnit: { $in: ['minutes', 'hours', 'days'] },
        },
        { acctId: 1, leadId: 1, scheduledAt: 1, preReminderValue: 1, preReminderUnit: 1 }
    )
        .sort({ scheduledAt: 1, _id: 1 })
        .limit(RECOVERY_BATCH_SIZE)
        .lean();

    const operations = legacy.flatMap((reminder) => {
        const preScheduledAt = calculatePreScheduledAt(reminder);
        if (!preScheduledAt) return [];
        return [{
            updateOne: {
                filter: {
                    _id: reminder._id,
                    acctId: reminder.acctId,
                    leadId: reminder.leadId,
                    preScheduledAt: null,
                },
                update: { $set: { preScheduledAt } },
            },
        }];
    });
    if (operations.length) await LeadReminder.bulkWrite(operations, { ordered: false });
};

const processInChunks = async (items, handler, label) => {
    for (let offset = 0; offset < items.length; offset += RECOVERY_CONCURRENCY) {
        const chunk = items.slice(offset, offset + RECOVERY_CONCURRENCY);
        const results = await Promise.allSettled(chunk.map(handler));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.error(`[ReminderRecovery] Failed ${label} ${chunk[index]._id}: ${result.reason?.message || result.reason}`);
            }
        });
    }
};

const availableLease = (field, now) => ({
    $or: [{ [field]: null }, { [field]: { $lte: now } }],
});

const findDue = (filter, dueField, claimField, now) => LeadReminder.find(
    { ...filter, [dueField]: { $lte: now }, ...availableLease(claimField, now) },
    { _id: 1, acctId: 1, leadId: 1 }
)
    .sort({ [dueField]: 1, _id: 1 })
    .limit(RECOVERY_BATCH_SIZE)
    .lean();

export const runRecovery = async () => {
    try {
        await backfillPreScheduledAt();
        const now = new Date();
        const [main, pre, client] = await Promise.all([
            findDue({ mainSent: false }, 'scheduledAt', 'mainClaimUntil', now),
            findDue({ preReminderEnabled: true, preReminderSent: false }, 'preScheduledAt', 'preClaimUntil', now),
            findDue({ clientReminderEnabled: true, clientSent: false }, 'clientScheduledAt', 'clientClaimUntil', now),
        ]);

        if (main.length) logger.info(`[ReminderRecovery] Recovering ${main.length} due main reminder(s)`);
        if (pre.length) logger.info(`[ReminderRecovery] Recovering ${pre.length} due pre-reminder(s)`);
        if (client.length) logger.info(`[ReminderRecovery] Recovering ${client.length} due client reminder(s)`);

        await processInChunks(main, (item) => processReminder(String(item._id), 'main', {
            acctId: item.acctId, leadId: item.leadId,
        }), 'main reminder');
        await processInChunks(pre, (item) => processReminder(String(item._id), 'pre', {
            acctId: item.acctId, leadId: item.leadId,
        }), 'pre-reminder');
        await processInChunks(client, (item) => processClientReminder(String(item._id), {
            acctId: item.acctId, leadId: item.leadId,
        }), 'client reminder');
    } catch (error) {
        logger.error(`[ReminderRecovery] Recovery scan failed: ${error.message}`);
    }
};

export const startReminderRecovery = () => {
    void runRecovery();
    const timer = setInterval(runRecovery, RECOVERY_INTERVAL_MS);
    timer.unref?.();
    logger.info('[ReminderRecovery] Recovery cron started (interval: 2 min)');
    return timer;
};
