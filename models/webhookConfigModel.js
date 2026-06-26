import mongoose from 'mongoose';

/**
 * Webhook Configs — `webhook_configs` collection
 *
 * Per-account outbound webhook subscriptions. An admin configures a target URL
 * and the events it should receive. Deliveries are signed with `secret`
 * (HMAC-SHA256) so the receiver can verify authenticity.
 */
export const WEBHOOK_EVENTS = ['lead.created', 'lead.assigned', 'lead.unassigned', 'lead.stage_changed'];

const webhookConfigSchema = new mongoose.Schema(
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
        /** Events this endpoint subscribes to */
        events: {
            type: [String],
            enum: WEBHOOK_EVENTS,
            default: []
        },
        /** Target URL deliveries are POSTed to */
        url: {
            type: String,
            required: true,
            trim: true
        },
        /** Shared secret used to sign payloads (HMAC-SHA256) */
        secret: {
            type: String,
            required: true
        },
        /** When false, no deliveries are enqueued */
        active: {
            type: Boolean,
            default: true
        }
    },
    { timestamps: true, collection: 'webhook_configs' }
);

// List + match configs for an account when an event fires
webhookConfigSchema.index({ acctId: 1 });

const WebhookConfig = mongoose.model('WebhookConfig', webhookConfigSchema);

export default WebhookConfig;
