import mongoose from 'mongoose';

const accountAdminSchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        acctId: {
            type: String,
            required: true,
            trim: true
        },
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
        phone: {
            type: String,
            default: null
        },
        email: {
            type: String,
            default: null
        },
        profileImage: {
            type: String,
            default: null
        }
    },
    { timestamps: true, collection: 'account_admins' }
);

// Compound index for admin upsert filter and admin list queries (acctId prefix covers single-field acctId queries too)
accountAdminSchema.index({ acctId: 1, chatbotAdminId: 1 });

// Index for lead enrichment — find admins by chatbotAdminId $in after every paginated lead list
accountAdminSchema.index({ chatbotAdminId: 1 });

const AccountAdmin = mongoose.model('AccountAdmin', accountAdminSchema);

export default AccountAdmin;
