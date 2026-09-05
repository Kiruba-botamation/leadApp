import { getAdminsService } from './accountService.js';
import acctDataModel from '../models/accountModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import UserAccount from '../models/userAccountModel.js';
import leadService from './leadService.js';
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
import { performGet, performCount, perfomDataExistanceCheck } from '../config/mongoConnector.js';
import logger from '../utils/logger.js';

export const ADMIN_LIMIT_MAX = 100;
export const ADMIN_FILTER_MAX = 100;
export const ADMIN_SORT_FIELDS = new Set([
    'createdAt', 'updatedAt', 'firstName', 'lastName', 'email', 'phone',
    'accessLevel', 'chatbotAdminId'
]);
const ADMIN_SORT_STORAGE_FIELDS = {
    firstName: 'firstNameNormalized',
    lastName: 'lastNameNormalized',
    email: 'emailNormalized',
    phone: 'phoneNormalized',
    chatbotAdminId: 'chatbotAdminIdNormalized'
};
const SYNC_BATCH_SIZE = 100;
const ADMIN_QUERY_MAX_TIME_MS = 10000;

export const escapeRegexLiteral = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const normalizeAdminFilter = (value, field = 'filter') => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > ADMIN_FILTER_MAX) {
        const error = new Error(`${field} must be at most ${ADMIN_FILTER_MAX} characters`);
        error.statusCode = 400;
        throw error;
    }
    const normalized = value.trim().toLowerCase();
    return normalized ? new RegExp(`^${escapeRegexLiteral(normalized)}`) : null;
};

export const normalizeAdminListOptions = ({ page, limit, sortBy, sortOrder, includeCount } = {}) => ({
    page: Math.max(1, Number.parseInt(page, 10) || 1),
    limit: Math.min(ADMIN_LIMIT_MAX, Math.max(1, Number.parseInt(limit, 10) || 20)),
    sortBy: ADMIN_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt',
    sortOrder: sortOrder === 'asc' ? 1 : -1,
    includeCount: includeCount !== false && includeCount !== 'false'
});

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
export const normaliseBotamationAdmin = (admin = {}) => {
    const fullName = admin.name ?? admin.fullName ?? admin.full_name ?? null;
    const nameParts = typeof fullName === 'string' ? fullName.trim().split(/\s+/).filter(Boolean) : [];

    return {
        chatbotAdminId: admin.adminId ?? admin.admin_id ?? admin.chatbotAdminId ?? admin.chatbot_admin_id ?? admin.id ?? null,
        firstName: admin.firstName ?? admin.first_name ?? nameParts[0] ?? null,
        lastName: admin.lastName ?? admin.last_name ?? (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null),
        phone: admin.phone ?? admin.phoneNumber ?? admin.phone_number ?? admin.mobile ?? null,
        profileImage: admin.profileImage ?? admin.profile_image ?? admin.profileImageUrl
            ?? admin.profile_image_url ?? admin.profilePic ?? admin.profile_pic
            ?? admin.avatar ?? admin.photo ?? null
    };
};

export const isAdminMissingFromPlatform = (admin, externalIds) => {
    const id = admin.chatbotAdminId ? String(admin.chatbotAdminId).trim().toLowerCase() : null;
    return Boolean(id && !externalIds.has(id));
};

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
        if (n.chatbotAdminId) externalIds.add(String(n.chatbotAdminId).trim().toLowerCase());
    }

    let removed = 0;

    let afterId = null;
    while (true) {
        const batchQuery = afterId ? { acctId, _id: { $gt: afterId } } : { acctId };
        const batch = await AccountAdmin.find(batchQuery)
            .sort({ _id: 1 })
            .limit(SYNC_BATCH_SIZE)
            .lean();
        if (!batch.length) break;
        afterId = batch[batch.length - 1]._id;

        for (const admin of batch) {
            // Without an external id there is no reliable way to prove that this
            // linked admin was removed from Botamation. Preserve the link rather
            // than treating an unmatchable record as stale.
            if (!isAdminMissingFromPlatform(admin, externalIds)) continue;

            const deletion = await AccountAdmin.deleteOne({ _id: admin._id, acctId });
            if (!deletion.deletedCount) continue;
            if (admin.userId) {
                await UserAccount.deleteOne({ acctId, userId: admin.userId });
                await leadService.unassignAdminLeads(acctId, admin.userId);
                invalidateAdminCache(admin.userId, acctId);
            }
            removed += 1;
        }
    }

    logger.info('Admins synced to database', { acctId, removed });

    return { removed };
};

/**
 * Fetch admins for an account from the local DB with optional filtering and pagination.
 */
export const getAdminsFromDb = async (acctId, options = {}) => {
    const { userId, firstName, lastName, email, phone, accessLevel, chatbotAdminId } = options;
    const query = { acctId };

    // Exact-match scoping (used to restrict non-superadmins to their own record)
    if (userId) query.userId = userId;
    const normalizedFilters = {
        firstNameNormalized: normalizeAdminFilter(firstName, 'firstName'),
        lastNameNormalized: normalizeAdminFilter(lastName, 'lastName'),
        emailNormalized: normalizeAdminFilter(email, 'email'),
        phoneNormalized: normalizeAdminFilter(phone, 'phone'),
        chatbotAdminIdNormalized: normalizeAdminFilter(chatbotAdminId, 'chatbotAdminId')
    };
    for (const [field, regex] of Object.entries(normalizedFilters)) {
        if (regex) query[field] = regex;
    }
    if (accessLevel) query.accessLevel = accessLevel;

    const normalized = normalizeAdminListOptions(options);
    const skip = (normalized.page - 1) * normalized.limit;
    const storageSortField = ADMIN_SORT_STORAGE_FIELDS[normalized.sortBy] || normalized.sortBy;
    const sort = { [storageSortField]: normalized.sortOrder, _id: normalized.sortOrder };

    const adminsResult = await performGet(AccountAdmin, query, [], {
        sort, skip, limit: normalized.limit, maxTimeMS: ADMIN_QUERY_MAX_TIME_MS
    });
    const total = normalized.includeCount
        ? await performCount(AccountAdmin, query, { maxTimeMS: ADMIN_QUERY_MAX_TIME_MS })
        : null;

    return {
        admins: adminsResult.data,
        pagination: {
            total,
            page: normalized.page,
            limit: normalized.limit,
            pages: total === null ? null : Math.ceil(total / normalized.limit)
        }
    };
};

/**
 * Sync the current user's contact details (email/phone) onto their admin record.
 * Only updates an existing record for {acctId, userId} — never creates one.
 * Returns the updated record, or null if the user isn't an admin of the account.
 */
export const buildAdminContactUpdate = ({ email, phone }) => {
    const fields = {};
    if (typeof email === 'string' && email.trim()) {
        fields.email = email.trim();
        fields.emailNormalized = email.trim().toLowerCase();
    }
    if (typeof phone === 'string' && phone.trim()) {
        fields.phone = phone.trim();
        fields.phoneNormalized = phone.trim().toLowerCase();
    }
    return fields;
};

export const setAdminContact = async (acctId, userId, contact) => {
    const fields = buildAdminContactUpdate(contact);
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
    for (const key of ['firstName', 'lastName', 'email', 'phone']) {
        if (fields[key] !== undefined) {
            const value = fields[key];
            set[`${key}Normalized`] = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
        }
    }
    if (Object.keys(set).length === 0) return null;
    return AccountAdmin.findOneAndUpdate({ acctId, chatbotAdminId }, { $set: set }, { new: true }).lean();
};
