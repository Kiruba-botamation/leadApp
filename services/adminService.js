import { getAdminsService } from './accountService.js';
import acctDataModel from '../models/accountModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import UserAccount from '../models/userAccountModel.js';
import leadService from './leadService.js';
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
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
    phone: a.phone ?? a.phoneNumber ?? a.mobile ?? a.contact ?? null,
    profileImage: a.profile_pic ?? a.profileImage ?? a.profile_image ?? a.profileImageUrl
        ?? a.picture ?? a.photo ?? a.avatar ?? a.image ?? a.thumbnail
        ?? a.profile_photo ?? a.dp ?? null
});

/**
 * Sync admins for an account against the Botamation platform — matched by
 * chatbotAdminId. Sync NEVER adds or updates admins (admins are added/updated only
 * when a user links the account). It only prunes admins that no longer exist in
 * Botamation:
 *
 *   - chatbotAdminId in BOTH Botamation and the app    → NO UPDATE (left untouched).
 *   - chatbotAdminId in the app but NOT in Botamation  → REMOVE the admin record,
 *     unlink the user, and unassign any leads still assigned to them.
 */
export const syncAdminsFromPlatform = async (acctId) => {
    // acctNo is required to call the Botamation platform API (page_id param)
    const acctNo = await resolveAcctNo(acctId);

    const admins = await getAdminsService(acctNo);
    const adminList = Array.isArray(admins) ? admins : [admins];

    // Set of external admin ids (chatbotAdminId) currently in Botamation
    const externalIds = new Set();
    for (const a of adminList) {
        const n = normaliseBotamationAdmin(a);
        if (n.chatbotAdminId) externalIds.add(String(n.chatbotAdminId));
    }

    const existing = await AccountAdmin.find({ acctId }).lean();

    let removed = 0;

    // REMOVE — present in the app, gone from Botamation
    await Promise.all(existing.map(async (admin) => {
        const id = admin.chatbotAdminId ? String(admin.chatbotAdminId) : null;
        if (id && externalIds.has(id)) return; // present in both → no update

        await AccountAdmin.deleteOne({ _id: admin._id });
        if (admin.userId) {
            await UserAccount.deleteOne({ acctId, userId: admin.userId });
            // Removed admins leave no dangling lead assignments
            await leadService.unassignAdminLeads(acctId, admin.userId);
            invalidateAdminCache(admin.userId, acctId);
        }
        removed += 1;
    }));

    logger.info('Admins synced to database', { acctId, removed });

    return { removed };
};

/**
 * Fetch admins for an account from the local DB with optional filtering and pagination.
 */
export const getAdminsFromDb = async (acctId, { page, limit, sortBy, sortOrder, userId, firstName, lastName, email, phone, accessLevel, chatbotAdminId } = {}) => {
    const query = { acctId };

    // Exact-match scoping (used to restrict non-superadmins to their own record)
    if (userId) query.userId = userId;
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

/** Fetch a single admin record for {acctId, userId}, or null. */
export const getAdminByUser = async (acctId, userId) => {
    if (!acctId || !userId) return null;
    return AccountAdmin.findOne({ acctId, userId }).lean();
};

/**
 * Update an admin's editable profile fields (firstName, lastName, email, phone,
 * profileImage), identified by chatbotAdminId within an account. Access level is
 * intentionally NOT updatable here — that goes through setAdminAccessLevel.
 * Used both by the edit form and by the "sync from auth app" action.
 * Returns the updated record, or null if not found / nothing to update.
 */
export const setAdminProfile = async (acctId, chatbotAdminId, fields = {}) => {
    const allowed = ['firstName', 'lastName', 'email', 'phone', 'profileImage'];
    const set = {};
    for (const key of allowed) {
        if (fields[key] !== undefined) set[key] = fields[key];
    }
    if (Object.keys(set).length === 0) return null;
    return AccountAdmin.findOneAndUpdate({ acctId, chatbotAdminId }, { $set: set }, { new: true }).lean();
};
