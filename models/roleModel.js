import mongoose from 'mongoose';

/**
 * Roles — `roles` collection
 *
 * Global, seeded list of access levels an admin can hold. `level` gives a numeric
 * ordering for upgrade/downgrade decisions (higher = more privileged). Currently
 * two roles exist: superadmin and admin. New admins default to superadmin.
 */
const roleSchema = new mongoose.Schema(
    {
        _id: {
            type: String,
            default: () => new mongoose.Types.ObjectId().toHexString()
        },
        /** Stable machine key stored on account_admins.accessLevel */
        key: {
            type: String,
            required: true
        },
        /** Human-readable label for UIs */
        label: {
            type: String,
            required: true
        },
        /** Numeric privilege level — higher is more privileged */
        level: {
            type: Number,
            required: true
        }
    },
    { timestamps: true, collection: 'roles' }
);

roleSchema.index({ key: 1 }, { unique: true });

const Role = mongoose.model('Role', roleSchema);

/** The two roles this app ships with. superadmin is the highest privilege. */
export const DEFAULT_ROLES = [
    { key: 'superadmin', label: 'Super Admin', level: 100 },
    { key: 'admin',      label: 'Admin',       level: 10 }
];

/**
 * Idempotently seed the default roles. Safe to call on every startup.
 */
export const seedRoles = async () => {
    await Promise.all(
        DEFAULT_ROLES.map((role) =>
            Role.updateOne({ key: role.key }, { $set: role }, { upsert: true })
        )
    );
};

export default Role;
