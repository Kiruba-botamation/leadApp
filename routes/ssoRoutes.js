import express from 'express';
import jwt from 'jsonwebtoken';
import ssoAuthMiddleware, { getUserFromAuthService, getCookieConfig } from '../middleware/ssoAuthMiddleware.js';

const router = express.Router();

/**
 * SSO Routes
 */

/**
 * POST /api/ui/sso/login
 * @desc    Initiate SSO login
 * @access  Public
 */
router.post('/login', (req, res) => {
    try {
        const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8081';
        const authFrontendUrl = process.env.AUTH_FRONTEND_URL || 'http://localhost:3001';
        const finalRedirectUrl = req.body.redirect || req.query.redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:3000';

        // Determine if we should use mock auth
        const useMockAuth = process.env.USE_MOCK_AUTH === 'true';

        let actualAuthUrl;
        if (useMockAuth) {
            // Use built-in mock auth - redirect includes final destination
            const encodedRedirect = encodeURIComponent(finalRedirectUrl);
            const backendBaseUrl = process.env.BACKEND_BASE_URL || `http://localhost:${process.env.PORT || 8083}`;
            actualAuthUrl = `${backendBaseUrl}/api/ui/sso/mock-auth-login?redirect=${encodedRedirect}`;
        } else {
            // Use real external auth service - auth service must redirect to OUR callback
            // The callback URL includes the final frontend redirect as a parameter
            const backendBaseUrl = process.env.BACKEND_BASE_URL || `http://localhost:${process.env.PORT || 8083}`;
            const callbackUrl = `${backendBaseUrl}/api/ui/sso/callback?redirect=${encodeURIComponent(finalRedirectUrl)}`;
            const encodedCallbackUrl = encodeURIComponent(callbackUrl);
            actualAuthUrl = `${authFrontendUrl}/login?redirect=${encodedCallbackUrl}`;
        }

        console.log('\n========================================');
        console.log('[SSO] 🔐 POST /login - Initiating authentication');
        console.log('[SSO] AUTH_SERVICE_URL (backend):', authServiceUrl);
        console.log('[SSO] AUTH_FRONTEND_URL:', authFrontendUrl);
        console.log('[SSO] Final destination:', finalRedirectUrl);
        console.log('[SSO] USE_MOCK_AUTH:', useMockAuth);
        console.log('[SSO] Auth service URL:', actualAuthUrl);
        console.log('========================================\n');

        return res.json({
            success: true,
            message: 'Login initiated',
            authUrl: actualAuthUrl,
            useMockAuth: useMockAuth
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({
            success: false,
            message: 'Login failed',
            error: error.message
        });
    }
});

/**
 * GET /api/ui/sso/callback
 * @desc    SSO callback — receives tokens from auth service, sets HTTP-only cookies,
 *          and redirects the user to the original URL.
 *          Expects ?access_token=<jwt>&refresh_token=<jwt>&redirect=<url>.
 * @access  Public
 */
router.get('/callback', (req, res) => {
    const { access_token, refresh_token, redirect } = req.query;

    console.log('[SSO Callback] Processing authentication callback');
    console.log('[SSO Callback] access_token:', access_token ? 'present' : 'missing');
    console.log('[SSO Callback] refresh_token:', refresh_token ? 'present' : 'missing');
    console.log('[SSO Callback] redirect param:', redirect);

    if (!access_token || !refresh_token) {
        console.error('[SSO Callback] Missing tokens in callback');
        return res.status(400).json({
            success: false,
            message: 'Missing authentication tokens'
        });
    }

    // Trust tokens issued by the auth service — do not re-verify here.
    // Both services share the same JWT_SECRET so the middleware will validate on every request.
    res.cookie('access_token', access_token, getCookieConfig(6 * 60 * 60 * 1000));          // 6 hours
    res.cookie('refresh_token', refresh_token, getCookieConfig(15 * 24 * 60 * 60 * 1000));  // 15 days

    const redirectUrl = redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    console.log('[SSO Callback] Cookies set. Redirecting to:', redirectUrl);
    return res.redirect(redirectUrl);
});

/**
 * GET /api/ui/sso/me
 * @desc    Get current authenticated user
 * @access  Protected (requires authentication)
 */
router.get('/me', ssoAuthMiddleware, (req, res) => {
    res.json({
        success: true,
        user: req.user,
        message: 'User authenticated'
    });
});

/**
 * GET /api/ui/sso/auth
 * @desc    Get authenticated user information
 * @access  Protected (requires authentication)
 */
router.get('/auth', ssoAuthMiddleware, (req, res) => {
    console.log('[SSO] GET /auth - returning user info');
    res.json({
        success: true,
        authenticated: true,
        user: req.user
    });
});

/**
 * GET /api/ui/sso/user
 * @desc    Fetch fresh user data from the centralised auth service
 * @access  Protected (requires authentication)
 */
router.get('/user', ssoAuthMiddleware, async (req, res) => {
    try {
        const accessToken = req.cookies?.access_token;
        const freshUser = await getUserFromAuthService(accessToken);
        if (freshUser) {
            return res.json({ success: true, user: freshUser });
        }
        // Fall back to local JWT data if auth service is unreachable
        return res.json({ success: true, user: req.user, source: 'local' });
    } catch (error) {
        console.error('[SSO] GET /user error:', error.message);
        return res.status(500).json({ success: false, message: 'Failed to fetch user data' });
    }
});

/**
 * GET /api/ui/sso/verify
 * @desc    Verify if user is authenticated
 * @access  Protected (requires authentication)
 */
router.get('/verify', ssoAuthMiddleware, (req, res) => {
    res.json({
        success: true,
        authenticated: true,
        user: req.user
    });
});

/**
 * POST /api/ui/sso/logout
 * @desc    Logout — clears HTTP-only cookies and returns the login URL.
 *          Public: no auth required so unauthenticated clients can still logout cleanly.
 * @access  Public
 */
router.post('/logout', (req, res) => {
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieClearOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: process.env.COOKIE_DOMAIN || (isProduction ? '.botamation.in' : 'localhost'),
        path: '/'
    };

    res.clearCookie('access_token', cookieClearOptions);
    res.clearCookie('refresh_token', cookieClearOptions);

    const redirectParam = req.query.redirect || (req.body && req.body.redirect) || '';
    const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:8081';
    const redirectTarget = redirectParam || process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const loginUrl = `${authServiceUrl}/login?redirect=${encodeURIComponent(redirectTarget)}`;

    return res.json({
        success: true,
        message: 'Logged out successfully',
        clearLocalStorage: true,
        loginUrl
    });
});

/**
 * MOCK AUTH SERVICE ENDPOINTS (for local development)
 * These simulate an external SSO auth service when USE_MOCK_AUTH=true
 */

/**
 * GET /api/ui/sso/mock-auth-login
 * @desc    Mock auth service login page (simulates external SSO at port 3001)
 * @access  Public
 */
router.get('/mock-auth-login', (req, res) => {
    const redirect = req.query.redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:5173';

    console.log('\n========================================');
    console.log('[MOCK AUTH] 🔓 LOGIN PAGE ACCESSED!');
    console.log('[MOCK AUTH] Redirect parameter:', redirect);
    console.log('[MOCK AUTH] This page should be visible in browser');
    console.log('========================================\n');

    // Return HTML login page
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mock SSO Login</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; padding: 20px; background: #f5f5f5; }
        .login-box { background: white; border: 1px solid #ddd; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h2 { margin-top: 0; color: #333; }
        .form-group { margin-bottom: 20px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; color: #555; }
        input { width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; }
        button { width: 100%; padding: 12px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; }
        button:hover { background: #0056b3; }
        .info { background: #e7f3ff; padding: 15px; margin-top: 20px; font-size: 13px; border-radius: 4px; border-left: 4px solid #007bff; }
        .info strong { display: block; margin-bottom: 5px; }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h2>🔐 Mock SSO Login</h2>
        <form id="loginForm">
          <div class="form-group">
            <label>Email:</label>
            <input type="email" id="email" value="testuser@example.com" required />
          </div>
          <div class="form-group">
            <label>Password:</label>
            <input type="password" id="password" value="password123" required />
          </div>
          <button type="submit">Login</button>
        </form>
        <div class="info">
          <strong>Development Mock Auth Service</strong>
          This simulates your external auth service (port 3001).<br>
          Any email/password combination will work.<br>
          <small>Redirect to: ${redirect}</small>
        </div>
      </div>
      <script>
        document.getElementById('loginForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const email = document.getElementById('email').value;
          
          // Call backend to generate JWT tokens
          const response = await fetch(window.location.origin + '/api/ui/sso/mock-auth-callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              email: email,
              redirect: '${redirect}'
            })
          });
          
          const data = await response.json();
          
          if (data.success && data.redirectUrl) {
            // Redirect to the application (cookies are set by server)
            window.location.href = data.redirectUrl;
          } else {
            alert('Login failed: ' + (data.message || 'Unknown error'));
          }
        });
      </script>
    </body>
    </html>
  `);
});

/**
 * POST /api/ui/sso/mock-auth-callback
 * @desc    Process mock login and generate JWT tokens
 * @access  Public
 */
router.post('/mock-auth-callback', (req, res) => {
    try {
        // Block this endpoint in production or when mock auth is not explicitly enabled
        const useMockAuth = process.env.USE_MOCK_AUTH === 'true';
        const nodeEnv = process.env.NODE_ENV;
        if (!useMockAuth || nodeEnv === 'production') {
            return res.status(403).json({ success: false, message: 'Mock authentication is not enabled' });
        }

        console.log('[MOCK AUTH CALLBACK] ==== START ====');
        console.log('[MOCK AUTH CALLBACK] Request body:', req.body);

        const { email, redirect } = req.body;

        if (!email) {
            console.log('[MOCK AUTH CALLBACK] ERROR: Email missing');
            return res.status(400).json({
                success: false,
                message: 'Email required'
            });
        }

        console.log('[MOCK AUTH CALLBACK] Generating tokens for:', email);
        console.log('[MOCK AUTH CALLBACK] Redirect URL:', redirect);

        // Generate mock user data
        const userData = {
            userId: '507f1f77bcf86cd799439011', // Mock user ID
            email: email,
            acctId: 'mock-acct-123',
            acctNo: 'ACC001',
            role: 'admin',
            permissions: ['read', 'write', 'delete']
        };

        // Generate access token (6 hours)
        const accessToken = jwt.sign(userData, process.env.JWT_SECRET, {
            expiresIn: '6h'
        });

        // Generate refresh token (15 days)
        const refreshToken = jwt.sign(userData, process.env.JWT_REFRESH_SECRET, {
            expiresIn: '15d'
        });

        console.log('[MOCK AUTH CALLBACK] ✅ Access token generated (length):', accessToken.length);
        console.log('[MOCK AUTH CALLBACK] ✅ Refresh token generated (length):', refreshToken.length);

        res.cookie('access_token', accessToken, getCookieConfig(6 * 60 * 60 * 1000));          // 6 hours
        res.cookie('refresh_token', refreshToken, getCookieConfig(15 * 24 * 60 * 60 * 1000));  // 15 days
        console.log('[MOCK AUTH CALLBACK] ✅ access_token and refresh_token cookies set');

        const finalRedirect = redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
        console.log('[MOCK AUTH CALLBACK] Final redirect URL:', finalRedirect);
        console.log('[MOCK AUTH CALLBACK] ==== END - SUCCESS ====');

        return res.json({
            success: true,
            message: 'Authentication successful',
            redirectUrl: finalRedirect
        });
    } catch (error) {
        console.error('[MOCK AUTH CALLBACK] ==== ERROR ====');
        console.error('[MOCK AUTH CALLBACK] Error:', error);
        console.error('[MOCK AUTH CALLBACK] Stack:', error.stack);
        return res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message
        });
    }
});

export default router;
