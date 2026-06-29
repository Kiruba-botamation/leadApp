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
        /**
         * Collection this webhook is scoped to. A webhook only fires for events on
         * leads in this collection, and its payload variables are limited to this
         * collection's fields. References `lead_collections._id`.
         */
        collectionId: {
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
        /**
         * Custom HTTP headers sent with every delivery (e.g. an Authorization
         * token for the receiver). Stored as string→string. Reserved headers
         * (Content-Type, the signature/event headers) are still set by the
         * processor and take precedence so deliveries stay verifiable.
         */
        headers: {
            type: Map,
            of: String,
            default: undefined
        },
        /**
         * Optional custom JSON payload template. A JSON string that may contain
         * `{{path}}` placeholders (e.g. `{{data.lead.name}}`, `{{data.stage.id}}`)
         * resolved against the event context at delivery time. When empty/null the
         * default full envelope `{ event, acctId, data, timestamp }` is sent, so
         * existing webhooks are unaffected.
         */
        payloadTemplate: {
            type: String,
            default: null
        },
        /** When false, no deliveries are enqueued */
        active: {
            type: Boolean,
            default: true
        }
    },
    { timestamps: true, collection: 'webhook_configs' }
);

// Match configs for an account + collection when an event fires
webhookConfigSchema.index({ acctId: 1, collectionId: 1 });

const WebhookConfig = mongoose.model('WebhookConfig', webhookConfigSchema);

export default WebhookConfig;
