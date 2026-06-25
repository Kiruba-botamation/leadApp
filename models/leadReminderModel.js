import mongoose from 'mongoose';

/**
 * Lead Reminders — `lead_reminders` collection
 *
 * A reminder is created by `userId` but delivered at fire time to the lead's
 * current responsible (see `notifiedUserId`). Only pending reminders may be
 * edited/deleted, and only by the current assignee.
 * Supports a primary fire time (scheduledAt) and an optional
 * pre-reminder fired N minutes/hours/days before.
 *
 * BullMQ jobs are scheduled with IDs:
 *   "{_id}-main"  — fires at scheduledAt
 *   "{_id}-pre"   — fires at scheduledAt - preReminderOffset (when enabled)
 *
 * jobScheduled:false is the recovery cron's signal that a job
 * was never enqueued (Redis was down) and must be processed directly.
 */
const leadReminderSchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        /** Owning account */
        acctId: {
            type: String,
            required: true
        },
        /** Lead-app user who created this reminder (account_admins.userId) */
        userId: {
            type: String,
            required: true
        },
        /**
         * The user the notification was actually delivered to — resolved at fire time
         * as the lead's current responsible (falling back to the creator when the lead
         * is unassigned). Drives the bell inbox so a reassigned reminder reaches the new
         * assignee. Null until the reminder fires.
         */
        notifiedUserId: {
            type: String,
            default: null
        },
        /** The lead this reminder is about (leads._id) */
        leadId: {
            type: String,
            required: true
        },
        /** Reminder body — required */
        description: {
            type: String,
            required: true,
            trim: true
        },
        /** When the main reminder should fire */
        scheduledAt: {
            type: Date,
            required: true
        },

        // ── Pre-reminder (optional secondary reminder) ──────────────────────
        preReminderEnabled: {
            type: Boolean,
            default: false
        },
        /** How many units before scheduledAt */
        preReminderValue: {
            type: Number,
            default: null
        },
        /** Unit of time for the pre-reminder offset */
        preReminderUnit: {
            type: String,
            default: null
        },

        // ── Delivery channels ────────────────────────────────────────────────
        /** Array of enabled channel keys */
        channels: {
            type: [String],
            enum: ['inApp', 'push', 'email', 'whatsapp'],
            default: ['inApp', 'push']
        },

        // ── Job state ────────────────────────────────────────────────────────
        /** Set true once the pre-reminder notification has been dispatched */
        preReminderSent: {
            type: Boolean,
            default: false
        },
        /** Set true once the main notification has been dispatched */
        mainSent: {
            type: Boolean,
            default: false
        },
        /**
         * Set true when the BullMQ job was successfully enqueued.
         * Stays false when Redis was unavailable — recovery cron uses this flag.
         */
        jobScheduled: {
            type: Boolean,
            default: false
        },
        /**
         * Set false whenever a notification fires (so the bell badge lights up).
         * Set true when admin opens the notification bell panel.
         */
        notificationRead: {
            type: Boolean,
            default: false
        },
        /**
         * Set true when the admin clicks "Clear all" or the × on a bell item.
         * Hides the reminder from the bell inbox without deleting the reminder itself.
         */
        bellDismissed: {
            type: Boolean,
            default: false
        },

        // ── Client Reminder ──────────────────────────────────────────────────
        clientReminderEnabled: { type: Boolean, default: false },
        clientMessage:         { type: String,  trim: true, default: '' },
        clientScheduledAt:     { type: Date },
        clientChannels:        { type: [String], enum: ['email', 'whatsapp', 'sms'], default: [] },
        clientSent:            { type: Boolean, default: false },
        clientJobScheduled:    { type: Boolean, default: false },
        clientName:            { type: String, default: '' },
        clientPhone:           { type: String, default: '' },
        clientEmail:           { type: String, default: '' },

        /**
         * Snapshot of the lead's display name and phone at creation time.
         * Stored so notifications (SSE, push, bell inbox) can show lead context
         * without a live join to the leads collection.
         */
        leadSnapshot: {
            name:  { type: String, default: '' },
            phone: { type: String, default: '' },
        },
    },
    {
        timestamps: true,
        collection: 'lead_reminders'
    }
);

// Bell badge query — unread fired reminders delivered to a user
leadReminderSchema.index({ notifiedUserId: 1, mainSent: 1, notificationRead: 1 });

// Per-recipient fired reminders list, sorted by scheduled time
leadReminderSchema.index({ notifiedUserId: 1, mainSent: 1, scheduledAt: -1 });

// Per-lead panel view
leadReminderSchema.index({ acctId: 1, leadId: 1, scheduledAt: 1 });

// Recovery cron — find reminders that were never enqueued
leadReminderSchema.index({ mainSent: 1, jobScheduled: 1, scheduledAt: 1 });

// Pre-reminder recovery
leadReminderSchema.index({ preReminderEnabled: 1, preReminderSent: 1, jobScheduled: 1, scheduledAt: 1 });

// Client reminder recovery
leadReminderSchema.index({ clientReminderEnabled: 1, clientSent: 1, clientJobScheduled: 1, clientScheduledAt: 1 });

const LeadReminder = mongoose.model('LeadReminder', leadReminderSchema);

export default LeadReminder;
