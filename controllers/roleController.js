import Role from '../models/roleModel.js';
import logger from '../utils/logger.js';

/**
 * GET /api/ui/roles
 * List all available access-level roles (sorted most-privileged first).
 * @access Protected (SSO)
 */
export const getRoles = async (req, res) => {
    try {
        const roles = await Role.find({}, { _id: 0, key: 1, label: 1, level: 1 })
            .sort({ level: -1 })
            .lean();
        return res.status(200).json({ success: true, roles });
    } catch (error) {
        logger.error('Failed to fetch roles', { error: error.message });
        return res.status(500).json({ success: false, message: 'Failed to fetch roles' });
    }
};
