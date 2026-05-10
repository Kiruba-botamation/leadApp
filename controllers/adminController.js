import { getAdminsFromDb as getAdminsFromDbService, syncAdminsFromPlatform } from '../services/adminService.js';
import logger from '../utils/logger.js';

/**
 * GET /api/ui/admins/list?acctId=<acctId>
 * Return admins for an account from the local database.
 * @access  Protected (SSO)
 */
export const getAdminsFromDb = async (req, res) => {
    try {
        const { acctId, ...filters } = req.query;

        if (!acctId) {
            return res.status(400).json({ success: false, message: 'acctId query parameter is required' });
        }

        // Ensure the requested acctId matches the authenticated user's account
        if (req.user?.acctId && acctId !== req.user.acctId) {
            return res.status(403).json({ success: false, message: 'Access denied: acctId does not match authenticated user' });
        }

        const result = await getAdminsFromDbService(acctId, filters);

        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        logger.error('Failed to fetch admins from database', { error: error.message });
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message || 'Failed to fetch admins from database' });
    }
};

/**
 * GET /api/ui/admins?acctId=<acctId>
 * Sync admins from the Botamation platform into the local DB, then return the
 * refreshed paginated list — single endpoint, single response.
 * @access  Protected (SSO)
 */
export const getAdmins = async (req, res) => {
    try {
        const { acctId, ...filters } = req.query;

        if (!acctId) {
            return res.status(400).json({ success: false, message: 'acctId query parameter is required' });
        }

        // Ensure the requested acctId matches the authenticated user's account
        if (req.user?.acctId && acctId !== req.user.acctId) {
            return res.status(403).json({ success: false, message: 'Access denied: acctId does not match authenticated user' });
        }

        // Sync from Botamation platform first, then fetch the refreshed local list
        await syncAdminsFromPlatform(acctId);
        const result = await getAdminsFromDbService(acctId, filters);


        return res.status(200).json({ success: true, ...result });
    } catch (error) {
        logger.error('Failed to sync and fetch admins', { error: error.message });
        const status = error.statusCode || 500;
        return res.status(status).json({ success: false, message: error.message || 'Failed to sync admins' });
    }
};
