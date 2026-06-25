import mongoose from 'mongoose';

/**
 * Push Subscriptions — `push_subscriptions` collection
 *
 * Stores browser Web Push API subscriptions per user.
 * One user may have multiple subscriptions (different browsers/devices).
 * Expired subscriptions (410/404 from push service) are auto-deleted
 * by the browserPush channel module.
 */
const pushSubscriptionSchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        /** The lead-app user this subscription belongs to (account_admins.userId) */
        userId: {
            type: String,
            required: true
        },
        /** Push endpoint URL provided by the browser */
        endpoint: {
            type: String,
            required: true,
            unique: true
        },
        /** Encryption keys from the browser PushSubscription object */
        keys: {
            p256dh: { type: String, required: true },
            auth:   { type: String, required: true }
        }
    },
    {
        timestamps: true,
        collection: 'push_subscriptions'
    }
);

// All subscriptions for a user (used when sending push to all their devices)
pushSubscriptionSchema.index({ userId: 1 });

const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);

export default PushSubscription;
