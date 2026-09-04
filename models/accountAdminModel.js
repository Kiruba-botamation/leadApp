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
 * Identity is account-scoped. A user or external admin may belong to multiple
 * accounts, but each normalized identity may occur only once within an account.
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
        },
        firstNameNormalized: { type: String, default: null, select: false },
        lastNameNormalized: { type: String, default: null, select: false },
        emailNormalized: { type: String, default: null, select: false },
        phoneNormalized: { type: String, default: null, select: false },
        chatbotAdminIdNormalized: { type: String, default: null, select: false }
    },
    { timestamps: true, collection: 'account_admins' }
);

const normalize = value => typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;

accountAdminSchema.pre('validate', function setNormalizedAdminFields(next) {
    this.firstNameNormalized = normalize(this.firstName);
    this.lastNameNormalized = normalize(this.lastName);
    this.emailNormalized = normalize(this.email);
    this.phoneNormalized = normalize(this.phone);
    this.chatbotAdminIdNormalized = normalize(this.chatbotAdminId);
    next();
});

// Every operational query is tenant-scoped, so account is the leading key.
accountAdminSchema.index({ acctId: 1, createdAt: -1, _id: -1 });
accountAdminSchema.index({ acctId: 1, updatedAt: -1, _id: -1 });
accountAdminSchema.index({ acctId: 1, userId: 1 }, { unique: true });
accountAdminSchema.index({ acctId: 1, firstNameNormalized: 1, _id: 1 });
accountAdminSchema.index({ acctId: 1, lastNameNormalized: 1, _id: 1 });
accountAdminSchema.index({ acctId: 1, phoneNormalized: 1, _id: 1 });
accountAdminSchema.index({ acctId: 1, accessLevel: 1, _id: 1 });

// email / chatbotAdminId are optional — partial so missing (null) values are
// exempt from the constraint (only real string values must be unique).
accountAdminSchema.index(
    { acctId: 1, emailNormalized: 1 },
    { unique: true, partialFilterExpression: { emailNormalized: { $type: 'string' } } }
);
accountAdminSchema.index(
    { acctId: 1, chatbotAdminIdNormalized: 1 },
    { unique: true, partialFilterExpression: { chatbotAdminIdNormalized: { $type: 'string' } } }
);

const AccountAdmin = mongoose.model('AccountAdmin', accountAdminSchema);

export default AccountAdmin;
