import express from 'express';
import { verifyAccount, accountLinkToUser, accountName, getAccountToken, regenerateAccountToken, deleteAccount } from '../controllers/accountController.js';
import verifiedTenantMiddleware, { requireSuperadmin } from '../middleware/verifiedTenantMiddleware.js';

const router = express.Router();

/**
 * POST /verify — SSO-authenticated bootstrap; no existing tenant membership required
 */
router.post('/verify', verifyAccount);

/**
 * POST /link-user — SSO-authenticated bootstrap; verifies the user's platform-admin email
 */
router.post('/link-user', accountLinkToUser);

/**
 * GET /user/:userId — account discovery for the authenticated user
 */
router.get('/user/:userId', accountName);

/**
 * POST /token
 */
router.post('/token', verifiedTenantMiddleware, requireSuperadmin, getAccountToken);

/**
 * POST /token/regenerate
 */
router.post('/token/regenerate', verifiedTenantMiddleware, requireSuperadmin, regenerateAccountToken);

/**
 * DELETE /:acctId/user/:userId
 */
router.delete('/:acctId/user/:userId', verifiedTenantMiddleware, requireSuperadmin, deleteAccount);

export default router;
