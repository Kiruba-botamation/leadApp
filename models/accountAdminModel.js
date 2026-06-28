import mongoose from 'mongoose';

/**
 * Account Admins — `account_admins` collection
 *
 * An admin record is keyed by `chatbotAdminId` — the external Botamation admin id.
 * Records are created ONLY when a user links the account (matched to a Botamation
 * admin by email); the record always carries a `userId` (lead-app user id from SSO).
 * On link, if a record for the same `chatbotAdminId` already exists, its `email` and
 * `userId` are updated in place (and that admin's leads are reassigned if the userId
 * changes). Platform sync never creates admins — it only removes records whose
 * `chatbotAdminId` no longer exists in Botamation (unassigning their leads).
 * All downstream references (lead `responsible`, notes, reminders, analytics) key
 * off `userId`.
 *
 * Global uniqueness: `userId`, `email`, and `chatbotAdminId` are each unique across
 * the ENTIRE collection — no value may appear in two documents (see indexes below).
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

// Global uniqueness — a given userId / email / chatbotAdminId may appear in at
// most ONE document across the entire collection. No value may be shared by two
// documents in any combination. (This also implies one admin record per user.)
//
// The userId index doubles as the lead-enrichment lookup
// ($lookup leads.responsible → account_admins.userId).
accountAdminSchema.index({ userId: 1 }, { unique: true });

// email / chatbotAdminId are optional — partial so missing (null) values are
// exempt from the constraint (only real string values must be unique).
accountAdminSchema.index(
    { email: 1 },
    { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);
accountAdminSchema.index(
    { chatbotAdminId: 1 },
    { unique: true, partialFilterExpression: { chatbotAdminId: { $type: 'string' } } }
);

const AccountAdmin = mongoose.model('AccountAdmin', accountAdminSchema);

export default AccountAdmin;
