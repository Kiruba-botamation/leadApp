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
            trim: true,
            maxlength: 4000
        },
        /** When the main reminder should fire */
        scheduledAt: {
            type: Date,
            required: true
        },
        /** Materialized pre-reminder due time, used by indexed recovery scans. */
        preScheduledAt: {
            type: Date,
            default: null
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

        // Mongo leases make dispatch mutually exclusive across queue workers and app instances.
        mainClaimToken:       { type: String, default: null },
        mainClaimUntil:       { type: Date, default: null },
        mainAttempts:         { type: Number, default: 0 },
        mainLastError:        { type: String, default: null, maxlength: 1000 },
        preClaimToken:        { type: String, default: null },
        preClaimUntil:        { type: Date, default: null },
        preAttempts:          { type: Number, default: 0 },
        preLastError:         { type: String, default: null, maxlength: 1000 },
        clientClaimToken:     { type: String, default: null },
        clientClaimUntil:     { type: Date, default: null },
        clientAttempts:       { type: Number, default: 0 },
        clientLastError:      { type: String, default: null, maxlength: 1000 },

        // ── Client Reminder ──────────────────────────────────────────────────
        clientReminderEnabled: { type: Boolean, default: false },
        clientMessage:         { type: String,  trim: true, default: '', maxlength: 4000 },
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
leadReminderSchema.index({ notifiedUserId: 1, mainSent: 1, bellDismissed: 1, notificationRead: 1 });

// Per-recipient fired reminders list, sorted by scheduled time
leadReminderSchema.index({ notifiedUserId: 1, mainSent: 1, bellDismissed: 1, scheduledAt: -1, _id: -1 });

// Same bell queries when the selected account is supplied by the client.
leadReminderSchema.index({ acctId: 1, notifiedUserId: 1, mainSent: 1, bellDismissed: 1, scheduledAt: -1, _id: -1 });
leadReminderSchema.index({ acctId: 1, notifiedUserId: 1, mainSent: 1, bellDismissed: 1, notificationRead: 1 });

// Per-lead panel view
leadReminderSchema.index({ acctId: 1, leadId: 1, scheduledAt: -1, _id: -1 });

// Account calendar range scan before lead-owner enrichment.
leadReminderSchema.index({ acctId: 1, scheduledAt: 1, _id: 1 });

// Batch count queries: pending reminders per lead (mainSent:false filter)
leadReminderSchema.index({ acctId: 1, leadId: 1, mainSent: 1 });

// Recovery cron — find reminders that were never enqueued
leadReminderSchema.index({ mainSent: 1, scheduledAt: 1, mainClaimUntil: 1 });

// Pre-reminder recovery
leadReminderSchema.index({ preReminderEnabled: 1, preReminderSent: 1, preScheduledAt: 1, preClaimUntil: 1 });

// Supports bounded lazy backfill of preScheduledAt for reminders created before this field existed.
leadReminderSchema.index({ preReminderEnabled: 1, preReminderSent: 1, scheduledAt: 1 });

// Client reminder recovery
leadReminderSchema.index({ clientReminderEnabled: 1, clientSent: 1, clientScheduledAt: 1, clientClaimUntil: 1 });

const LeadReminder = mongoose.model('LeadReminder', leadReminderSchema);

export default LeadReminder;
