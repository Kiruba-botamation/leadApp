import express from 'express';
import jwt from 'jsonwebtoken';
import ssoAuthMiddleware from '../middleware/ssoAuthMiddleware.js';

const router = express.Router();

/**
 * SSO Routes
 */

/**
 * POST /api/auth/login
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
            actualAuthUrl = `http://localhost:${process.env.PORT || 8083}/api/auth/mock-auth-login?redirect=${encodedRedirect}`;
        } else {
            // Use real external auth service - auth service must redirect to OUR callback
            // The callback URL includes the final frontend redirect as a parameter
            const callbackUrl = `http://localhost:${process.env.PORT || 8083}/api/auth/callback?redirect=${encodeURIComponent(finalRedirectUrl)}`;
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
 * GET /api/auth/callback
 * @desc    SSO callback - receives token from auth service and creates session
 * @access  Public
 */
router.get('/callback', (req, res) => {
    try {
        const { token, redirect } = req.query;

        console.log('\n========================================');
        console.log('[SSO Callback] 🔐 Processing authentication callback');
        console.log('[SSO Callback] Token:', token ? '✓ present' : '❌ MISSING');
        console.log('[SSO Callback] Redirect param:', redirect);

        if (!token) {
            console.log('[SSO Callback] ❌ No token provided');
            return res.status(400).json({
                success: false,
                message: 'Missing SSO token in callback'
            });
        }

        // Verify the token from auth service and extract user info
        try {
            console.log('[SSO Callback] 🔍 Verifying token from auth service...');
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            console.log('[SSO Callback] ✓ Token valid for user:', decoded.email);

            // Generate our own access and refresh tokens
            const accessToken = jwt.sign(
                {
                    userId: decoded.userId || decoded.id || decoded.email,
                    email: decoded.email,
                    acctId: decoded.acctId,
                    acctNo: decoded.acctNo,
                    role: decoded.role || 'user',
                    permissions: decoded.permissions || []
                },
                process.env.JWT_SECRET,
                { expiresIn: '15m' }
            );

            const refreshToken = jwt.sign(
                {
                    userId: decoded.userId || decoded.id || decoded.email,
                    email: decoded.email,
                    acctId: decoded.acctId,
                    acctNo: decoded.acctNo,
                    role: decoded.role || 'user',
                    permissions: decoded.permissions || []
                },
                process.env.JWT_REFRESH_SECRET,
                { expiresIn: '7d' }
            );

            console.log('[SSO Callback] ✅ Generated new access & refresh tokens');

            // Set HTTP-only cookies
            res.cookie('access_token', accessToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 15 * 60 * 1000, // 15 minutes
                path: '/'
            });

            res.cookie('refresh_token', refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
                path: '/'
            });

            console.log('[SSO Callback] ✅ Cookies set successfully');

            // Instead of direct redirect, send an HTML page that will redirect after confirming cookies
            const redirectUrl = decodeURIComponent(redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:5173');
            console.log('[SSO Callback] → Creating redirect page to:', redirectUrl);

            // Send HTML page that redirects and confirms auth
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Login Success</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                            margin: 0;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        }
                        .container {
                            text-align: center;
                            background: white;
                            padding: 40px;
                            border-radius: 10px;
                            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                        }
                        .success-icon {
                            font-size: 64px;
                            color: #4CAF50;
                            margin-bottom: 20px;
                        }
                        h1 { color: #333; margin: 0 0 10px 0; }
                        p { color: #666; margin: 10px 0; }
                        .redirect-info {
                            margin-top: 20px;
                            font-size: 14px;
                            color: #999;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="success-icon">✓</div>
                        <h1>Login Successful!</h1>
                        <p>Authentication complete</p>
                        <p>Redirecting to application...</p>
                        <div class="redirect-info">
                            <p>Email: ${decoded.email}</p>
                            <p id="countdown">Redirecting in 2 seconds...</p>
                        </div>
                    </div>
                    <script>
                        console.log('✅ Authentication successful!');
                        console.log('User:', '${decoded.email}');
                        console.log('Cookies should be set on localhost:8083');
                        console.log('Redirecting to:', '${redirectUrl}');
                        
                        let seconds = 2;
                        const countdown = setInterval(() => {
                            seconds--;
                            document.getElementById('countdown').textContent = 
                                seconds > 0 ? \`Redirecting in \${seconds} second\${seconds !== 1 ? 's' : ''}...\` : 'Redirecting now...';
                            
                            if (seconds <= 0) {
                                clearInterval(countdown);
                                window.location.href = '${redirectUrl}';
                            }
                        }, 1000);
                    </script>
                </body>
                </html>
            `);

        } catch (verifyError) {
            console.error('[SSO Callback] ❌ Token verification failed:', verifyError.message);
            return res.status(401).json({
                success: false,
                message: 'Invalid SSO token',
                error: verifyError.message
            });
        }
    } catch (error) {
        console.error('[SSO Callback] ❌ Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Callback failed',
            error: error.message
        });
    }
});

/**
 * GET /api/auth/me
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
 * GET /api/ui/sso/auth (also /api/auth/auth, /api/sso/auth)
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
 * GET /api/auth/verify
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
 * POST /api/auth/logout
 * @desc    Logout user
 * @access  Protected
 */
router.post('/logout', ssoAuthMiddleware, (req, res) => {
    // Clear both access and refresh tokens
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/' });
    res.clearCookie('sso_token', { path: '/' }); // Legacy cookie

    return res.json({
        success: true,
        message: 'Logged out successfully'
    });
});

/**
 * MOCK AUTH SERVICE ENDPOINTS (for local development)
 * These simulate an external SSO auth service when USE_MOCK_AUTH=true
 */

/**
 * GET /api/auth/mock-auth-login
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
          const response = await fetch(window.location.origin + '/api/auth/mock-auth-callback', {
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
 * POST /api/auth/mock-auth-callback
 * @desc    Process mock login and generate JWT tokens
 * @access  Public
 */
router.post('/mock-auth-callback', (req, res) => {
    try {
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

        // Generate access token (15 minutes)
        const accessToken = jwt.sign(userData, process.env.JWT_SECRET, {
            expiresIn: '15m'
        });

        // Generate refresh token (7 days)
        const refreshToken = jwt.sign(userData, process.env.JWT_REFRESH_SECRET, {
            expiresIn: '7d'
        });

        console.log('[MOCK AUTH CALLBACK] ✅ Access token generated (length):', accessToken.length);
        console.log('[MOCK AUTH CALLBACK] ✅ Refresh token generated (length):', refreshToken.length);

        // Cookie configuration
        const cookieOptions = {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
            domain: process.env.COOKIE_DOMAIN || undefined,
            path: '/'
        };

        console.log('[MOCK AUTH CALLBACK] Cookie config:', JSON.stringify(cookieOptions, null, 2));

        // Set HTTP-only cookies (like real auth service would)
        res.cookie('access_token', accessToken, {
            ...cookieOptions,
            maxAge: 15 * 60 * 1000 // 15 minutes
        });
        console.log('[MOCK AUTH CALLBACK] ✅ access_token cookie set');

        res.cookie('refresh_token', refreshToken, {
            ...cookieOptions,
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
        console.log('[MOCK AUTH CALLBACK] ✅ refresh_token cookie set');

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
