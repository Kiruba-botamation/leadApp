import express from 'express';
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
    const redirectUrl = req.body.redirect || req.query.redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const encodedRedirect = encodeURIComponent(redirectUrl);

    console.log('[SSO] POST /login');
    console.log('  AUTH_SERVICE_URL:', authServiceUrl);
    console.log('  FRONTEND_BASE_URL:', process.env.FRONTEND_BASE_URL);
    console.log('  Redirect URL:', redirectUrl);
    console.log('  Auth URL:', `${authServiceUrl}/login?redirect=${encodedRedirect}`);

    return res.json({
      success: true,
      message: 'Login initiated',
      authUrl: `${authServiceUrl}/login?redirect=${encodedRedirect}`
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
 * @desc    SSO callback - receives token from auth service
 * @access  Public
 */
router.get('/callback', (req, res) => {
  try {
    const { token, redirect } = req.query;

    console.log('[SSO] GET /callback');
    console.log('  Token:', token ? 'present' : 'MISSING');
    console.log('  Redirect param:', redirect);
    console.log('  FRONTEND_BASE_URL:', process.env.FRONTEND_BASE_URL);

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Missing SSO token in callback'
      });
    }

    // Set SSO token as HTTP-only cookie
    res.cookie('sso_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    // Redirect to frontend or specified redirect URL
    const redirectUrl = redirect || process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    console.log('  Final redirect URL:', redirectUrl);
    return res.redirect(decodeURIComponent(redirectUrl));
  } catch (error) {
    console.error('Callback error:', error);
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
  res.clearCookie('sso_token');
  return res.json({ 
    success: true, 
    message: 'Logged out successfully' 
  });
});

export default router;
