import { getAdminsFromDb as getAdminsFromDbService, syncAdminsFromPlatform, setAdminAccessLevel, setAdminContact, setAdminProfile, getAdminByUser } from '../services/adminService.js';
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
import Role from '../models/roleModel.js';
import logger from '../utils/logger.js';

/**
 * Non-superadmins may only see and act on their own admin record. Returns extra
 * query filters that scope a listing to the requesting user when they aren't a
 * superadmin (an empty object for superadmins, who see everyone).
 */
const ownScopeFilters = (req) =>
    req.user?.accessLevel === 'superadmin' ? {} : { userId: req.user?.userId ?? '__none__' };

/**
 * GET /api/ui/admins/list?acctId=<acctId>[&roster=1]
 * Return admins for an account from the local database.
 * Includes the requesting user's own access level so the UI can gate edit actions.
 *
 * By default non-superadmins are scoped to their own record (admin-management view).
 * Pass `roster=1` to get the full account roster regardless of access level — used by
 * the lead "assign to" dropdown, where any admin must be able to pick another admin.
 * @access  Protected (SSO)
 */
export const getAdminsFromDb = async (req, res) => {
    try {
        const { acctId, roster, ...filters } = req.query;

        if (!acctId) {
            return res.status(400).json({ success: false, message: 'acctId query parameter is required' });
        }

        // Roster mode returns every admin (for assignment); otherwise non-superadmins
        // only ever see their own admin record.
        const isRoster = roster === '1' || roster === 'true';
        const scope = isRoster ? {} : ownScopeFilters(req);
        const result = await getAdminsFromDbService(acctId, { ...filters, ...scope });

        return res.status(200).json({
            success: true,
            currentUserAccessLevel: req.user?.accessLevel ?? null,
            ...result
        });
    } catch (error) {
        logger.error('Failed to fetch admins from database', { error: error.message });
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message || 'Failed to fetch admins from database' });
    }
};

/**
 * GET /api/ui/admins?acctId=<acctId>
 * Sync admins from the Botamation platform (refresh profiles, prune removed admins),
 * then return the refreshed paginated list — single endpoint, single response.
 * @access  Protected (SSO)
 */
export const getAdmins = async (req, res) => {
    try {
        const { acctId, ...filters } = req.query;

        if (!acctId) {
            return res.status(400).json({ success: false, message: 'acctId query parameter is required' });
        }

        // Platform sync adds/removes admins — a destructive operation restricted to
        // superadmins. Non-superadmins just get their own (un-synced) record back.
        if (req.user?.accessLevel === 'superadmin') {
            await syncAdminsFromPlatform(acctId);
        }
        const result = await getAdminsFromDbService(acctId, { ...filters, ...ownScopeFilters(req) });

        return res.status(200).json({
            success: true,
            currentUserAccessLevel: req.user?.accessLevel ?? null,
            ...result
        });
    } catch (error) {
        logger.error('Failed to sync and fetch admins', { error: error.message });
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message || 'Failed to sync admins' });
    }
};

/**
 * POST /api/ui/admins/contact
 * Sync the authenticated user's own contact details (email/phone) from their
 * profile onto their admin record. No-op if they aren't an admin of the account.
 * @access  Protected (SSO)
 * @body    { acctId, email, phone }
 */
export const updateContact = async (req, res) => {
    try {
        const { acctId, email, phone } = req.body;
        const userId = req.user?.userId;

        if (!acctId) return res.status(400).json({ success: false, message: 'acctId is required' });
        if (!userId) return res.status(400).json({ success: false, message: 'User identity required' });

        const updated = await setAdminContact(acctId, userId, { email, phone });
        // Not being an admin of this account is fine — just nothing to sync
        return res.status(200).json({ success: true, updated: !!updated });
    } catch (error) {
        logger.error('Failed to sync admin contact', { error: error.message });
        return res.status(500).json({ success: false, message: error.message || 'Failed to sync contact' });
    }
};

/**
 * PATCH /api/ui/admins/access-level
 * Change an admin's access level, identified by chatbotAdminId within an account.
 * Superadmin-only. Validates the requested accessLevel against the roles collection.
 * @access  Protected (SSO, superadmin)
 * @body    { acctId, chatbotAdminId, accessLevel }
 */
export const updateAccessLevel = async (req, res) => {
    try {
        const { acctId, chatbotAdminId, accessLevel } = req.body;

        if (!acctId || !chatbotAdminId || !accessLevel) {
            return res.status(400).json({ success: false, message: 'acctId, chatbotAdminId and accessLevel are required' });
        }

        // Only superadmins of this account may change access levels
        if (req.user?.accessLevel !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'Only superadmins can change access levels' });
        }

        // Validate the requested role exists
        const role = await Role.findOne({ key: accessLevel }).lean();
        if (!role) {
            return res.status(400).json({ success: false, message: `Unknown access level "${accessLevel}"` });
        }

        const updated = await setAdminAccessLevel(acctId, chatbotAdminId, accessLevel);
        if (!updated) {
            return res.status(404).json({ success: false, message: 'Admin not found for this account' });
        }

        // The updated admin's cached access level must be refreshed on their next request
        invalidateAdminCache(updated.userId, acctId);
        logger.info('Admin access level updated', { acctId, chatbotAdminId, accessLevel, operation: 'updateAccessLevel' });

        return res.status(200).json({ success: true, admin: updated });
    } catch (error) {
        logger.error('Failed to update access level', { error: error.message });
        return res.status(500).json({ success: false, message: error.message || 'Failed to update access level' });
    }
};

/**
 * PATCH /api/ui/admins/profile
 * Update an admin's profile fields (firstName, lastName, email, phone, profileImage),
 * identified by chatbotAdminId within an account. Access level is NOT editable here.
 * Used by the edit form and the "sync from auth app" action.
 *
 * Permissions: superadmins may edit any admin in the account; non-superadmins may
 * edit ONLY their own record.
 * @access  Protected (SSO)
 * @body    { acctId, chatbotAdminId, firstName?, lastName?, email?, phone?, profileImage? }
 */
export const updateProfile = async (req, res) => {
    try {
        const { acctId, chatbotAdminId, firstName, lastName, email, phone, profileImage } = req.body;

        if (!acctId || !chatbotAdminId) {
            return res.status(400).json({ success: false, message: 'acctId and chatbotAdminId are required' });
        }

        // Non-superadmins may only edit their own admin record
        if (req.user?.accessLevel !== 'superadmin') {
            const own = await getAdminByUser(acctId, req.user?.userId);
            if (!own || String(own.chatbotAdminId) !== String(chatbotAdminId)) {
                return res.status(403).json({ success: false, message: 'You can only edit your own admin profile' });
            }
        }

        const updated = await setAdminProfile(acctId, chatbotAdminId, { firstName, lastName, email, phone, profileImage });
        if (!updated) {
            return res.status(404).json({ success: false, message: 'Admin not found for this account' });
        }

        logger.info('Admin profile updated', { acctId, chatbotAdminId, operation: 'updateAdminProfile' });
        return res.status(200).json({ success: true, admin: updated });
    } catch (error) {
        logger.error('Failed to update admin profile', { error: error.message });
        return res.status(500).json({ success: false, message: error.message || 'Failed to update admin profile' });
    }
};
