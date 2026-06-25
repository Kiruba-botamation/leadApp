import { getAdminsService } from './accountService.js';
import acctDataModel from '../models/accountModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import UserAccount from '../models/userAccountModel.js';
import { performGet, performCount, perfomDataExistanceCheck } from '../config/mongoConnector.js';
import logger from '../utils/logger.js';

/**
 * Resolve acctNo from acctId.
 * Throws if account not found.
 */
const resolveAcctNo = async (acctId) => {
    const acctRecord = await perfomDataExistanceCheck(acctDataModel, { _id: acctId });
    if (!acctRecord) {
        const err = new Error('Account not found');
        err.statusCode = 404;
        throw err;
    }
    return acctRecord.acctNo;
};

/** Normalise a single Botamation admin payload to the fields we mirror locally. */
export const normaliseBotamationAdmin = (a) => ({
    chatbotAdminId: a.adminId ?? a.id ?? a._id ?? null,
    firstName: a.firstName ?? a.first_name ?? null,
    lastName: a.lastName ?? a.last_name ?? null,
    profileImage: a.profile_pic ?? a.profileImage ?? a.profile_image ?? a.profileImageUrl
        ?? a.picture ?? a.photo ?? a.avatar ?? a.image ?? a.thumbnail
        ?? a.profile_photo ?? a.dp ?? null
});

/**
 * Sync existing admins for an account against the Botamation platform.
 *
 * Admin records are NEVER created here — they are created only when a user links
 * the account. This sync only:
 *   - refreshes firstName/lastName/profileImage for admins still present in Botamation, and
 *   - removes admins whose chatbotAdminId no longer exists in Botamation (deleting both the
 *     account_admins record and its user_account_rel link).
 */
export const syncAdminsFromPlatform = async (acctId) => {
    // acctNo is required to call the Botamation platform API (page_id param)
    const acctNo = await resolveAcctNo(acctId);

    const admins = await getAdminsService(acctNo);
    const adminList = Array.isArray(admins) ? admins : [admins];

    // Map external admins by chatbotAdminId for O(1) match/refresh
    const externalById = new Map();
    for (const a of adminList) {
        const n = normaliseBotamationAdmin(a);
        if (n.chatbotAdminId) externalById.set(String(n.chatbotAdminId), n);
    }

    const existing = await AccountAdmin.find({ acctId }).lean();

    let updated = 0;
    let removed = 0;

    await Promise.all(existing.map(async (admin) => {
        const match = admin.chatbotAdminId ? externalById.get(String(admin.chatbotAdminId)) : null;

        if (match) {
            // Refresh mirrored profile fields only — never touches userId or accessLevel
            await AccountAdmin.updateOne(
                { _id: admin._id },
                { $set: { firstName: match.firstName, lastName: match.lastName, profileImage: match.profileImage } }
            );
            updated += 1;
        } else {
            // Admin gone from Botamation — remove the admin record and unlink the user
            await AccountAdmin.deleteOne({ _id: admin._id });
            if (admin.userId) {
                await UserAccount.deleteOne({ acctId, userId: admin.userId });
            }
            removed += 1;
        }
    }));

    logger.info('Admins synced to database', { acctId, updated, removed });

    return { updated, removed };
};

/**
 * Fetch admins for an account from the local DB with optional filtering and pagination.
 */
export const getAdminsFromDb = async (acctId, { page, limit, sortBy, sortOrder, firstName, lastName, email, phone, accessLevel, chatbotAdminId } = {}) => {
    const query = { acctId };

    if (firstName) query.firstName = { $regex: firstName, $options: 'i' };
    if (lastName) query.lastName = { $regex: lastName, $options: 'i' };
    if (email) query.email = { $regex: email, $options: 'i' };
    if (phone) query.phone = { $regex: phone, $options: 'i' };
    if (accessLevel) query.accessLevel = accessLevel;
    if (chatbotAdminId) query.chatbotAdminId = { $regex: chatbotAdminId, $options: 'i' };

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 20);
    const skip = (pageNum - 1) * limitNum;

    const sortField = sortBy || 'createdAt';
    const sortDir = sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortField]: sortDir };

    const [adminsResult, total] = await Promise.all([
        performGet(AccountAdmin, query, [], { sort, skip, limit: limitNum }),
        performCount(AccountAdmin, query)
    ]);

    return {
        admins: adminsResult.data,
        pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            pages: Math.ceil(total / limitNum)
        }
    };
};

/**
 * Sync the current user's contact details (email/phone) onto their admin record.
 * Only updates an existing record for {acctId, userId} — never creates one.
 * Returns the updated record, or null if the user isn't an admin of the account.
 */
export const setAdminContact = async (acctId, userId, { email, phone }) => {
    const fields = {};
    if (email !== undefined) fields.email = email;
    if (phone !== undefined) fields.phone = phone;
    if (Object.keys(fields).length === 0) return null;
    return AccountAdmin.findOneAndUpdate({ acctId, userId }, { $set: fields }, { new: true }).lean();
};

/**
 * Update an admin's access level, identified by chatbotAdminId within an account.
 * Validates accessLevel against the roles collection in the controller.
 * Returns the updated admin record, or null if not found.
 */
export const setAdminAccessLevel = async (acctId, chatbotAdminId, accessLevel) => {
    const updated = await AccountAdmin.findOneAndUpdate(
        { acctId, chatbotAdminId },
        { $set: { accessLevel } },
        { new: true }
    ).lean();
    return updated;
};
