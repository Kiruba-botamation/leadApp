import mongoose from 'mongoose';

/**
 * Webhook Deliveries — `webhook_deliveries` collection
 *
 * One row per delivery attempt outcome, written by the webhook queue processor.
 * Powers the "recent deliveries" view in Settings → Webhooks and aids debugging
 * of failed deliveries.
 */
const webhookDeliverySchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        acctId: {
            type: String,
            required: true
        },
        /** webhook_configs._id this delivery targeted */
        configId: {
            type: String,
            required: true
        },
        event: {
            type: String,
            required: true
        },
        /** The JSON body that was sent */
        payload: {
            type: mongoose.Schema.Types.Mixed,
            default: {}
        },
        /** 'success' | 'failed' */
        status: {
            type: String,
            required: true
        },
        /** HTTP status code returned by the receiver (null on network error) */
        statusCode: {
            type: Number,
            default: null
        },
        /** Number of attempts made (final value when recorded) */
        attempts: {
            type: Number,
            default: 1
        },
        /** Last error message on failure */
        lastError: {
            type: String,
            default: null
        }
    },
    { timestamps: true, collection: 'webhook_deliveries' }
);

// Recent deliveries for an account, latest first
webhookDeliverySchema.index({ acctId: 1, createdAt: -1 });

const WebhookDelivery = mongoose.model('WebhookDelivery', webhookDeliverySchema);

export default WebhookDelivery;
