import jwt from 'jsonwebtoken';
import axios from 'axios';
import AccountAdmin from '../models/accountAdminModel.js';

// ── In-memory cache: 'email:acctId' → { id, exp } ───────────────────────────
// Avoids a DB round-trip on every request while keeping identity fresh.
const _adminIdCache = new Map();
const ADMIN_ID_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Resolves the account_admins._id for the logged-in user.
 * Sets user.accountAdminId — used as fallback adminId in lead notes and reminders.
 *
 * Requires acctId — without it we cannot safely identify which account_admins
 * record belongs to this user (same email can exist in multiple accounts).
 * When acctId is absent, accountAdminId is set to null and the caller must
 * supply adminId directly in the request body.
 *
 * acctId is intentionally NOT stored on req.user — it always comes from
 * the request (query param / body / path param) so account switching works.
 */
async function enrichWithAccountAdminId(user, acctId) {
    if (!user?.email || !acctId) {
        user.accountAdminId = null;
        return;
    }

    const key    = `${user.email}:${acctId}`;
    const cached = _adminIdCache.get(key);
    if (cached && cached.exp > Date.now()) {
        user.accountAdminId = cached.id;
        return;
    }

    try {
        const rec = await AccountAdmin.findOne({ email: user.email, acctId }, { _id: 1 }).lean();
        const id  = rec?._id ?? null;
        _adminIdCache.set(key, { id, exp: Date.now() + ADMIN_ID_CACHE_TTL });
        user.accountAdminId = id;
    } catch (err) {
        console.warn('[SSO] enrichWithAccountAdminId error:', err.message);
        user.accountAdminId = null;
    }
}

/**
 * Check if authentication should be skipped for local development.
 * When SKIP_LOGIN=true and NODE_ENV is local/development, returns mock user data
 * so the SSO auth service doesn't need to be running.
 * Both conditions must be true — NODE_ENV guard prevents accidental bypass in production.
 */
function getSkipLoginUser() {
    const skipLogin = process.env.SKIP_LOGIN === 'true';
    const env = process.env.NODE_ENV;
    if (skipLogin && (env === 'local' || env === 'development')) {
        return {
            _id: process.env.SKIP_LOGIN_USER_ID,
            userId: process.env.SKIP_LOGIN_USER_ID,
            email: process.env.SKIP_LOGIN_USER_EMAIL,
            name: process.env.SKIP_LOGIN_USER_NAME,
            google_email: process.env.SKIP_LOGIN_USER_GOOGLE_EMAIL,
            profileImageUrl: process.env.SKIP_LOGIN_USER_PROFILE_IMAGE
        };
    }
    return null;
}

/**
 * Returns shared cookie configuration for setting/clearing cookies.
 * @param {number} maxAge - Cookie max-age in milliseconds
 */
export const getCookieConfig = (maxAge) => {
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieDomain = process.env.COOKIE_DOMAIN || (isProduction ? '.botamation.in' : 'localhost');

    return {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: cookieDomain,
        path: '/',
        ...(maxAge !== undefined ? { maxAge } : {})
    };
};

/**
 * Fetch fresh user data from the centralised auth service.
 * @param {string} token - The access_token JWT string
 */
export const getUserFromAuthService = async (token) => {
    try {
        const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8081';
        const response = await axios.get(`${authServiceUrl}/api/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 5000
        });
        return response.data?.user || response.data || null;
    } catch (error) {
        console.error('[SSO] getUserFromAuthService error:', error.message);
        return null;
    }
};

/**
 * SSO Authentication Middleware
 * Validates JWT tokens from HTTP-only cookies
 * Automatically refreshes expired access tokens using refresh tokens
 */
const ssoAuthMiddleware = async (req, res, next) => {
    // Skip authentication for local development
    const skipUser = getSkipLoginUser();
    if (skipUser) {
        req.user = skipUser;
        const acctId = req.query?.acctId || req.body?.acctId || req.headers?.['x-acctno'];
        await enrichWithAccountAdminId(req.user, acctId);
        return next();
    }

    try {
        // Extract tokens from cookies
        const accessToken = req.cookies?.access_token;
        const refreshToken = req.cookies?.refresh_token;

        // Diagnostic logging — helps trace production auth issues
        console.log('[SSO] %s %s | cookies: %s | access_token: %s | refresh_token: %s | origin: %s',
            req.method, req.path,
            Object.keys(req.cookies || {}).join(',') || 'none',
            accessToken ? 'present' : 'MISSING',
            refreshToken ? 'present' : 'MISSING',
            req.get('origin') || req.get('referer') || 'unknown'
        );

        if (!accessToken && !refreshToken) {
            console.log('[SSO] No tokens — returning 401');
            const frontendUrl = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
            return res.status(401).json({
                success: false,
                authenticated: false,
                message: 'Authentication required. Please log in.',
                authUrl: `${process.env.AUTH_SERVICE_URL || 'http://localhost:8081'}/login?redirect=${encodeURIComponent(frontendUrl)}`
            });
        }

        // Try to validate access token
        if (accessToken) {
            try {
                const decoded = jwt.verify(accessToken, process.env.JWT_SECRET);
                console.log('[SSO] Access token valid for %s — proceeding', decoded.email);

                // Set user information in request
        req.user = {
            userId: decoded.userId,
            email:  decoded.email,
            role:   decoded.role,
            permissions: decoded.permissions || [],
        };

        const acctId = req.query?.acctId || req.body?.acctId || req.headers?.['x-acctno'];
        await enrichWithAccountAdminId(req.user, acctId);
        return next();
    } catch (error) {
        console.log('[SSO] Access token invalid (%s) — trying refresh', error.message);
                if (error.name === 'TokenExpiredError' || refreshToken) {
                    return await tryRefreshToken(req, res, next, refreshToken);
                }
            }
        }

        // If no access token but have refresh token, try to refresh
        if (refreshToken) {
            return await tryRefreshToken(req, res, next, refreshToken);
        }

        // No valid authentication
        console.log('[SSO] No valid auth — returning 401');
        const frontendUrl = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
        return res.status(401).json({
            success: false,
            authenticated: false,
            message: 'Invalid or expired authentication. Please log in again.',
            authUrl: `${process.env.AUTH_SERVICE_URL || 'http://localhost:8081'}/login?redirect=${encodeURIComponent(frontendUrl)}`
        });
    } catch (error) {
        console.error('[SSO] Middleware error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Authentication error',
            error: error.message
        });
    }
};

/**
 * Try to refresh the access token using refresh token
 */
async function tryRefreshToken(req, res, next, refreshToken) {
    try {
        const refreshSecret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
        const decoded = jwt.verify(refreshToken, refreshSecret);
        console.log('[SSO] Refresh token valid for %s — issuing new tokens', decoded.email);

        // Generate new access token (6 hours)
        const tokenPayload = {
            userId: decoded.userId,
            email:  decoded.email,
            role:   decoded.role,
            permissions: decoded.permissions,
        };
        const newAccessToken = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '6h' });

        // Generate new refresh token (15 days)
        const newRefreshToken = jwt.sign(
            tokenPayload,
            process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
            { expiresIn: '15d' }
        );

        // Set refreshed cookies
        res.cookie('access_token', newAccessToken, getCookieConfig(6 * 60 * 60 * 1000));
        res.cookie('refresh_token', newRefreshToken, getCookieConfig(15 * 24 * 60 * 60 * 1000));

        console.log('[SSO] Tokens refreshed successfully for %s', decoded.email);

        // Set user information in request
        req.user = {
            userId: decoded.userId,
            email:  decoded.email,
            role:   decoded.role,
            permissions: decoded.permissions || [],
        };

        const acctId = req.query?.acctId || req.body?.acctId || req.headers?.['x-acctno'];
        await enrichWithAccountAdminId(req.user, acctId);
        return next();
    } catch (error) {
        console.error('[SSO] Refresh failed:', error.message);

        const frontendUrl = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
        return res.status(401).json({
            success: false,
            authenticated: false,
            message: 'Session expired. Please log in again.',
            authUrl: `${process.env.AUTH_SERVICE_URL || 'http://localhost:8081'}/login?redirect=${encodeURIComponent(frontendUrl)}`
        });
    }
}

/**
 * Optional: Account-level authorization middleware
 * Validates user has access to specific account
 */
export const requireAccount = async (req, res, next) => {
    try {
        const acctNo = req.params.acctNo || req.body.acctNo || req.headers['x-account-no'];

        if (!acctNo) {
            return res.status(400).json({
                success: false,
                message: 'Account number required'
            });
        }

        if (req.user.acctNo !== acctNo) {
            console.log(`[SSO] Access denied: User ${req.user.email} attempted to access account ${acctNo}`);
            return res.status(403).json({
                success: false,
                message: 'Access denied to this account'
            });
        }

        next();
    } catch (error) {
        console.error('[SSO] Account authorization error:', error);
        return res.status(500).json({
            success: false,
            message: 'Authorization error'
        });
    }
};

/**
 * Hybrid Auth Middleware — supports both HTTP-only cookies AND Bearer token.
 * Useful for backward compatibility with clients that send Authorization headers.
 */
export const hybridAuthMiddleware = async (req, res, next) => {
    // Skip authentication for local development
    const skipUser = getSkipLoginUser();
    if (skipUser) {
        req.user = skipUser;
        const acctId = req.query?.acctId || req.body?.acctId || req.headers?.['x-acctno'];
        await enrichWithAccountAdminId(req.user, acctId);
        return next();
    }

    // First try Bearer token from Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = {
                userId: decoded.userId,
                email:  decoded.email,
                role:   decoded.role,
                permissions: decoded.permissions || [],
            };
            const acctId = req.query?.acctId || req.body?.acctId || req.headers?.['x-acctno'];
            await enrichWithAccountAdminId(req.user, acctId);
            return next();
        } catch (err) {
            // Fall through to cookie-based auth
            console.log('[Hybrid Auth] Bearer token invalid, trying cookies:', err.message);
        }
    }
    // Fall back to cookie-based SSO auth
    return ssoAuthMiddleware(req, res, next);
};

export default ssoAuthMiddleware;
