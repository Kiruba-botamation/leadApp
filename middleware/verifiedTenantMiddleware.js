import AccountAdmin from '../models/accountAdminModel.js';

const scalarAccountId = (value, source) => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value) || typeof value === 'object') {
        throw new TypeError(`Invalid acctId in ${source}`);
    }
    const normalized = String(value).trim();
    if (!normalized) throw new TypeError(`Invalid acctId in ${source}`);
    return normalized;
};

export const resolveCanonicalAcctId = (req) => {
    return scalarAccountId(req.query?.acctId, 'query');
};

const setReadonly = (target, property, value) => {
    const existing = Object.getOwnPropertyDescriptor(target, property);
    if (existing && existing.value === value) return;
    Object.defineProperty(target, property, {
        value,
        enumerable: true,
        configurable: false,
        writable: false
    });
};

/** Require authenticated AccountAdmin membership for one canonical account. */
export const verifiedTenantMiddleware = async (req, res, next) => {
    let acctId;
    try {
        acctId = resolveCanonicalAcctId(req);
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }

    if (!acctId) {
        return res.status(400).json({ success: false, message: 'acctId is required' });
    }
    if (!req.user?.userId) {
        return res.status(403).json({ success: false, message: 'Verified account membership required' });
    }

    try {
        const membership = await AccountAdmin.findOne(
            { acctId, userId: String(req.user.userId) },
            { _id: 1, accessLevel: 1 }
        ).lean();

        if (!membership?.accessLevel) {
            return res.status(403).json({ success: false, message: 'Access denied to this account' });
        }

        req.tenant = Object.freeze({ acctId });
        setReadonly(req, 'acctId', acctId);
        setReadonly(req.user, 'isAdmin', true);
        setReadonly(req.user, 'accessLevel', membership.accessLevel);
        return next();
    } catch (error) {
        console.error('[TenantAuth] membership verification failed:', error.message);
        return res.status(403).json({ success: false, message: 'Unable to verify account access' });
    }
};

export const requireTenantRole = (...allowedRoles) => (req, res, next) => {
    if (!req.tenant?.acctId || !allowedRoles.includes(req.user?.accessLevel)) {
        return res.status(403).json({ success: false, message: 'Insufficient account permissions' });
    }
    return next();
};

export const requireSuperadmin = requireTenantRole('superadmin');

export default verifiedTenantMiddleware;
