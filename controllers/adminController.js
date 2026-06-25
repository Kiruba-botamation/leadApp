import { getAdminsFromDb as getAdminsFromDbService, syncAdminsFromPlatform, setAdminAccessLevel, setAdminContact } from '../services/adminService.js';
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
import Role from '../models/roleModel.js';
import logger from '../utils/logger.js';

/**
 * GET /api/ui/admins/list?acctId=<acctId>
 * Return admins for an account from the local database.
 * Includes the requesting user's own access level so the UI can gate edit actions.
 * @access  Protected (SSO)
 */
export const getAdminsFromDb = async (req, res) => {
    try {
        const { acctId, ...filters } = req.query;

        if (!acctId) {
            return res.status(400).json({ success: false, message: 'acctId query parameter is required' });
        }

        const result = await getAdminsFromDbService(acctId, filters);

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

        await syncAdminsFromPlatform(acctId);
        const result = await getAdminsFromDbService(acctId, filters);

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
