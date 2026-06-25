import mongoose from 'mongoose';

/**
 * Account Admins — `account_admins` collection
 *
 * An admin IS a lead-app user who has linked this account. A record is created
 * only when a user links the account (matched to a Botamation admin by email),
 * and removed only on unlink or when the chatbotAdminId disappears from Botamation
 * on sync. All downstream references (lead `responsible`, notes, reminders,
 * analytics) key off `userId` — the lead-app user id from SSO.
 *
 * Name & profile image are mirrored from the Botamation admin and refreshed on
 * sync. Email/phone are intentionally NOT stored here — they live on the user
 * profile (auth service) and are read from there when needed.
 */
const accountAdminSchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        /** Lead-app user id (from SSO) — the canonical reference everywhere */
        userId: {
            type: String,
            required: true
        },
        /** Owning account */
        acctId: {
            type: String,
            required: true,
            trim: true
        },
        /** External (Botamation) admin id — used to match/refresh on sync */
        chatbotAdminId: {
            type: String,
            default: null
        },
        firstName: {
            type: String,
            default: null
        },
        lastName: {
            type: String,
            default: null
        },
        profileImage: {
            type: String,
            default: null
        },
        /**
         * Contact details mirrored from the lead-app user's profile (NOT Botamation).
         * Set at link time and refreshed via the contact-sync endpoint. Used by the
         * email/WhatsApp reminder channels to reach the assigned admin.
         */
        email: {
            type: String,
            default: null
        },
        phone: {
            type: String,
            default: null
        },
        /** Access level — references roles.key. Defaults to superadmin on create. */
        accessLevel: {
            type: String,
            default: 'superadmin'
        }
    },
    { timestamps: true, collection: 'account_admins' }
);

// One admin record per user per account — also serves visibility/enrichment lookups by (acctId, userId)
accountAdminSchema.index({ acctId: 1, userId: 1 }, { unique: true });

// Sync match — find the admin record to refresh/remove by external id
accountAdminSchema.index({ acctId: 1, chatbotAdminId: 1 });

// Lead enrichment ($lookup leads.responsible → account_admins.userId) and cross-account user lookups
accountAdminSchema.index({ userId: 1 });

const AccountAdmin = mongoose.model('AccountAdmin', accountAdminSchema);

export default AccountAdmin;
