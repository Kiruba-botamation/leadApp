import { getAdminsService } from './accountService.js';
import acctDataModel from '../models/accountModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import { performUpsert, performGet, performDelete, performCount, perfomDataExistanceCheck } from '../config/mongoConnector.js';
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

/**
 * Fetch admins from the Botamation platform, sync to local DB, and return normalised list.
 */
export const syncAdminsFromPlatform = async (acctId) => {
    // acctNo is still required to call the Botamation platform API (page_id param)
    const acctNo = await resolveAcctNo(acctId);

    const admins = await getAdminsService(acctNo);

    // ── Print full admin details from Botamation ──────────────────────
    const adminList = Array.isArray(admins) ? admins : [admins];
    console.log('\n[AdminService] ══════════════════════════════════════');
    console.log(`[AdminService] Full admin details from Botamation (acctId: ${acctId})`);
    console.log(`[AdminService] Total admins returned: ${adminList.length}`);
    adminList.forEach((a, i) => {
        console.log(`\n[AdminService] ── Admin #${i + 1} ──────────────────────────`);
        Object.entries(a).forEach(([key, value]) => {
            console.log(`[AdminService]   ${key}: ${JSON.stringify(value)}`);
        });
    });
    console.log('[AdminService] ══════════════════════════════════════\n');
    // ─────────────────────────────────────────────────────────────────

    const normalised = adminList.map((a) => ({
        chatbotAdminId: a.adminId ?? a.id ?? a._id ?? null,
        firstName: a.firstName ?? a.first_name ?? null,
        lastName: a.lastName ?? a.last_name ?? null,
        phone: a.phone ?? a.mobile ?? null,
        email: a.email ?? null,
        profileImage: a.profile_pic ?? a.profileImage ?? a.profile_image ?? a.profileImageUrl
            ?? a.picture ?? a.photo ?? a.avatar ?? a.image ?? a.thumbnail
            ?? a.profile_photo ?? a.dp ?? null
    }));

    // Upsert each admin returned by Botamation — scoped by acctId
    await Promise.all(
        normalised.map((admin) => {
            const filter = admin.chatbotAdminId
                ? { acctId, chatbotAdminId: admin.chatbotAdminId }
                : { acctId, email: admin.email };
            return performUpsert(AccountAdmin, filter, { ...admin, acctId });
        })
    );

    // Remove admins no longer in the Botamation response
    const activeChatbotAdminIds = normalised.map((a) => a.chatbotAdminId).filter(Boolean);
    const activeEmails = normalised.map((a) => a.email).filter(Boolean);
    const deleteResult = await performDelete(AccountAdmin, {
        acctId,
        $nor: [
            { chatbotAdminId: { $in: activeChatbotAdminIds } },
            { email: { $in: activeEmails } }
        ]
    });

    logger.info('Admins synced to database', {
        acctId,
        upserted: normalised.length,
        removed: deleteResult.deletedCount
    });

    return normalised;
};

/**
 * Fetch admins for an account from the local DB with optional filtering and pagination.
 * Uses acctId directly — no resolveAcctNo round-trip needed.
 */
export const getAdminsFromDb = async (acctId, { page, limit, sortBy, sortOrder, firstName, lastName, email, phone } = {}) => {
    const query = { acctId };

    if (firstName) query.firstName = { $regex: firstName, $options: 'i' };
    if (lastName) query.lastName = { $regex: lastName, $options: 'i' };
    if (email) query.email = { $regex: email, $options: 'i' };
    if (phone) query.phone = { $regex: phone, $options: 'i' };

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
