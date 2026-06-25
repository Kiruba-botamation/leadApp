import { verifyAccountServices, getAdminsService } from '../services/accountService.js';
import { normaliseBotamationAdmin } from '../services/adminService.js';
import acctDataModel from '../models/accountModel.js';
import accountApiKeyModel from '../models/accountApiKeyModel.js';
import UserAccount from '../models/userAccountModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import { performUpsert, performGet, perfomDataExistanceCheck, performDelete } from '../config/mongoConnector.js';
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
import { generateAccountToken } from '../utils/tokenGenerator.js';
import logger from '../utils/logger.js';

/**
 * Check if the given email exists in the list of account admins.
 * Case-insensitive, trims whitespace.
 * @param {Array} admins - List of admin objects from Botamation API
 * @param {string} email - Email to match against
 * @returns {Object|null} - The matching admin or null
 */
const findAdminByEmail = (admins, email) => {
    if (!Array.isArray(admins) || !email) return null;
    const normalizedEmail = email.toLowerCase().trim();
    return admins.find(
        admin => admin.email && admin.email.toLowerCase().trim() === normalizedEmail
    ) || null;
};

/**
 * POST /itinerary/verifyAccount
 * Verify an account number against the Botamation platform API,
 * persist it locally, generate an API key, and optionally link to a user.
 */
export const verifyAccount = async (req, res) => {
    try {
        const { acctNo, userId, email, phone } = req.body;

        if (!acctNo) {
            return res.status(400).json({ success: false, message: 'Account Number is required' });
        }

        // Ensure the userId in the request matches the authenticated user
        if (userId && req.user?.userId && userId !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Access denied: userId does not match authenticated user' });
        }

        // Make API call to the Botamation API
        const response = await verifyAccountServices(acctNo);

        // Check if the account is active
        if (response.active === '1') {
            try {
                const accountData = {
                    acctNo,
                    accountName: response.name || 'Unknown Account',
                    timezone: response.timezone || 'Asia/Calcutta'
                };

                // Upsert account record
                const upsertResult = await performUpsert(acctDataModel, { acctNo }, accountData);
                logger.info('Account created or updated', { acctNo, operation: 'createOrUpdateAccount', user: userId || null });

                let acctId = null;
                if (upsertResult.upsertedId) {
                    acctId = upsertResult.upsertedId;
                } else {
                    const acctInfo = await performGet(acctDataModel, { acctNo });
                    if (acctInfo?.success && acctInfo.data?.length > 0) {
                        acctId = acctInfo.data[0]._id;
                    }
                }

                // Get or create API key
                let apiKey = null;
                if (acctId) {
                    const existingToken = await perfomDataExistanceCheck(accountApiKeyModel, { acctId });
                    if (!existingToken) {
                        apiKey = generateAccountToken();
                        await performUpsert(accountApiKeyModel, { acctId }, { acctId, apiKey, name: 'Default API Key' });
                        logger.info('New API key created for account', { acctId, operation: 'createApiKey', user: userId || null });
                    } else {
                        const tokenDoc = await performGet(accountApiKeyModel, { acctId });
                        apiKey = tokenDoc?.data?.[0]?.apiKey || null;
                    }
                }

                // Verify the linking user is a Botamation admin of this account, and
                // create exactly ONE admin record for them (matched by email).
                // Admins are added to account_admins ONLY here — on link.
                if (email) {
                    try {
                        const admins = await getAdminsService(acctNo);
                        const matchedAdmin = findAdminByEmail(admins, email);
                        if (!matchedAdmin) {
                            return res.status(403).json({
                                success: false,
                                emailMismatch: true,
                                message: 'You should be an admin of the chatbot account to use this application. Please ask your account administrator for an invitation link to add yourself as admin of chatbot account.',
                                account: {
                                    acctId,
                                    acctNo,
                                    name: accountData.accountName,
                                    timezone: accountData.timezone,
                                    active: true
                                }
                            });
                        }

                        // Create/refresh the single admin record for the linking user.
                        // Default access level is superadmin; email/phone are not stored.
                        if (userId && acctId) {
                            const n = normaliseBotamationAdmin(matchedAdmin);
                            await performUpsert(
                                AccountAdmin,
                                { acctId, userId },
                                {
                                    userId,
                                    acctId,
                                    chatbotAdminId: n.chatbotAdminId,
                                    firstName: n.firstName,
                                    lastName: n.lastName,
                                    profileImage: n.profileImage,
                                    // Contact details come from the user's profile, not Botamation
                                    email: email || req.user?.email || null,
                                    phone: phone || null,
                                    accessLevel: 'superadmin'
                                }
                            );
                            invalidateAdminCache(userId, acctId);
                            logger.info('Admin record created for linking user', { acctId, userId, operation: 'createAccountAdmin' });
                        }
                    } catch (adminError) {
                        console.error('verifyAccount: Error verifying account admin:', adminError);
                        // Don't fail the entire operation if admin check fails
                    }
                }

                // Link account to user if userId is provided
                let linkedUser = null;
                if (userId && acctId) {
                    const alreadyLinked = await perfomDataExistanceCheck(UserAccount, { userId, acctId });
                    if (!alreadyLinked) {
                        await performUpsert(UserAccount, {}, {
                            userId,
                            acctId,
                            calendarIds: [],
                            canCreateCalendar: true,
                            role: 0
                        });
                        logger.info('Account linked to user', { acctNo, acctId, userId, operation: 'accountLinkedToUser' });
                    }
                    linkedUser = { userId };
                }

                return res.status(200).json({
                    success: true,
                    message: linkedUser
                        ? `Account verified, saved successfully and linked to user`
                        : 'Account verified and saved successfully',
                    account: {
                        acctId,
                        acctNo,
                        name: accountData.accountName,
                        timezone: accountData.timezone,
                        active: true,
                        apiKey
                    },
                    linkedUser
                });
            } catch (dbError) {
                console.error("Error processing account data:", dbError);
                return res.status(500).json({
                    success: false,
                    message: 'Account verified but failed to save to database or link to user',
                    error: dbError.message,
                    account: {
                        acctNo: acctNo,
                        name: response.name || 'Unknown Account',
                        timezone: response.timezone,
                        active: response.active === '1'
                    }
                });
            }
        } else {
            console.error('verifyAccount: Account not active or not found:', acctNo, response);
            return res.status(404).json({
                success: false,
                message: 'Account not found or inactive',
                account: {
                    acctNo: acctNo,
                    name: response.name || 'Unknown Account',
                    active: false
                }
            });
        }
    } catch (error) {
        console.error('Error verifying account:', error);

        // Handle specific error cases
        if (error.response) {
            const { status } = error.response;

            if (status === 404) {
                console.error('verifyAccount: 404 from Botamation API', error.response.data);
                return res.status(404).json({
                    success: false,
                    message: 'Account not found',
                    account: {
                        acctNo: req.body.acctNo,
                        name: null,
                        active: false
                    }
                });
            } else if (status === 401 || status === 403) {
                console.error('verifyAccount: Unauthorized access to Botamation API', error.response.data);
                return res.status(error.response.status).json({
                    success: false,
                    message: `Unauthorized access to ${process.env.BRAND_NAME || 'Botamation'} API`, account: {
                        acctNo: req.body.acctNo,
                        name: null,
                        active: false
                    }
                });
            }
        }

        // Fallback error response with request and error details
        return res.status(500).json({
            success: false,
            message: 'Failed to verify account',
            error: error.message,
            requestBody: req.body,
            stack: error.stack,
            account: {
                acctNo: req.body.acctNo,
                name: null,
                active: false
            }
        });
    }
};

/**
 * GET /api/accounts/user/:userId
 * Fetch all account names linked to a user.
 */
export const accountName = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) {
            return res.status(400).json({ success: false, message: 'User ID is required' });
        }

        // Ensure the requested userId matches the authenticated user
        if (req.user?.userId && userId !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Access denied: cannot view accounts for another user' });
        }

        // Find all userAccounts for this userId
        const userAccountsResult = await performGet(UserAccount, { userId });
        if (!userAccountsResult?.success || !userAccountsResult.data?.length) {
            return res.status(404).json({ success: false, message: 'No accounts found for user' });
        }

        // For each acctId, get the account details
        const acctIds = userAccountsResult.data.map(ua => ua.acctId);
        const accountsResult = await performGet(acctDataModel, { _id: { $in: acctIds } });
        if (!accountsResult?.success || !accountsResult.data?.length) {
            return res.status(404).json({ success: false, message: 'No account data found for user' });
        }

        const accounts = accountsResult.data.map(acc => ({
            acctId: acc._id,
            acctNo: acc.acctNo,
            accountName: acc.accountName || 'Account'
        }));

        return res.status(200).json({ success: true, accounts });
    } catch (error) {
        console.error('Error fetching account name by userId:', error);
        return res.status(500).json({ success: false, message: 'Internal Server Error', error: error.message });
    }
};

/**
 * POST /api/accounts/link-user
 * Link an account to a user without calling the external verification API.
 * Supports both flat and nested { userData: {...} } request body formats.
 */
export const accountLinkToUser = async (req, res) => {
    try {
        const requestData = req.body;

        // Normalise to nested format
        let userData;
        if (requestData.userData) {
            userData = requestData;
        } else {
            userData = {
                userData: {
                    name: requestData.name,
                    email: requestData.email,
                    phone: requestData.phone || requestData.phoneNo,
                    acctNo: requestData.acctNo,
                    accountName: requestData.accountName || requestData.name,
                    role: requestData.role,
                    timezone: requestData.timezone,
                    profileImageUrl: requestData.profileImageUrl
                }
            };
        }

        // Prefer SSO-authenticated user, fall back to body
        const userId = req.user?.userId || req.body.userId || userData.userData.userId;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'User not authenticated. userId is required.'
            });
        }

        if (!userData.userData?.acctNo) {
            return res.status(400).json({
                success: false,
                message: 'Account number (acctNo) is required'
            });
        }

        const profileImageUrl = userData.userData?.profileImageUrl || '/profile.png';

        // 1. Upsert account in accounts collection
        const accountData = {
            acctNo: userData.userData.acctNo,
            accountName: userData.userData.accountName || userData.userData.name,
            profileImageUrl,
            timezone: userData.userData.timezone || 'Asia/Calcutta'
        };

        const accountResult = await performUpsert(
            acctDataModel,
            { acctNo: userData.userData.acctNo },
            accountData
        );
        let acctId = accountResult.upsertedId;

        if (!acctId) {
            const existingAcct = await performGet(acctDataModel, { acctNo: userData.userData.acctNo });
            if (existingAcct?.success && existingAcct.data?.length > 0) {
                acctId = existingAcct.data[0]._id;
            }
        }

        if (!acctId) {
            return res.status(500).json({
                success: false,
                message: 'Failed to create or retrieve account'
            });
        }

        // 2. Upsert user ↔ account relationship
        // role: 0 = superadmin (default), 1 = admin
        const roleValue = userData.userData.role !== undefined
            ? (userData.userData.role === 'admin' || userData.userData.role === 1 ? 1 : 0)
            : 0;

        const filterCriteria = { userId, acctId };
        const existingLink = await perfomDataExistanceCheck(UserAccount, filterCriteria);

        if (existingLink) {
            const updateData = { canCreateCalendar: true };
            if (userData.userData.role !== undefined) {
                updateData.role = roleValue;
            }
            await performUpsert(UserAccount, filterCriteria, updateData);
        } else {
            await performUpsert(UserAccount, {}, {
                userId,
                acctId,
                calendarIds: [],
                canCreateCalendar: true,
                role: roleValue
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Account linked successfully',
            data: {
                name: userData.userData.name,
                email: userData.userData.email,
                profileImageUrl,
                acctNo: userData.userData.acctNo,
                acctId,
                userId
            }
        });
    } catch (error) {
        console.error('Error in accountLinkToUser:', error);
        return res.status(500).json({
            success: false,
            message: 'Error saving user data',
            error: error.message
        });
    }
};

/**
 * POST /api/accounts/token
 * Get the current API key for an account (masked by default).
 * @access  Protected (SSO)
 * @body    { acctId: string, masked?: boolean }
 * @query   ?masked=true|false
 */
export const getAccountToken = async (req, res) => {
    try {
        const { acctId } = req.body;
        if (!acctId) {
            return res.status(400).json({ success: false, message: 'acctId is required' });
        }

        // Verify the account exists
        const acctCheck = await perfomDataExistanceCheck(acctDataModel, { _id: acctId });
        if (!acctCheck) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        let result = await performGet(accountApiKeyModel, { acctId });
        let apiKey = result?.data?.[0]?.apiKey;

        // Auto-generate if missing — account exists but key was never created
        if (!apiKey || typeof apiKey !== 'string') {
            apiKey = generateAccountToken();
            await performUpsert(accountApiKeyModel, { acctId }, { acctId, apiKey });
            logger.info('API key auto-generated for existing account', { acctId, operation: 'autoGenerateApiKey' });
        }

        // Determine masking from query/body
        const masked = req.query.masked !== undefined
            ? req.query.masked === 'true' || req.query.masked === true
            : (req.body.masked === undefined ? true : req.body.masked === true || req.body.masked === 'true');

        let displayApiKey = apiKey;
        if (masked) {
            displayApiKey = apiKey.length > 4
                ? '*'.repeat(apiKey.length - 4) + '....' + apiKey.slice(-4)
                : '*'.repeat(apiKey.length);
        }
        return res.status(200).json({ success: true, apiKey: displayApiKey });
    } catch (error) {
        console.error('Error fetching account token:', error);
        return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
};

/**
 * POST /api/accounts/token/regenerate
 * Regenerate the API key for an account.
 * @access  Protected (SSO)
 * @body    { acctId: string }
 */
export const regenerateAccountToken = async (req, res) => {
    try {
        const { acctId } = req.body;
        if (!acctId) {
            return res.status(400).json({ success: false, message: 'acctId is required' });
        }

        // Generate new API key
        const newApiKey = generateAccountToken();
        // Upsert the apiKey for this acctId
        await performUpsert(
            accountApiKeyModel,
            { acctId },
            { acctId, apiKey: newApiKey }
        );
        logger.info('API key regenerated', { acctId, operation: 'regenerateApiKey' });
        // Mask all but last 4 characters
        let maskedApiKey = newApiKey;
        if (newApiKey.length > 4) {
            maskedApiKey = '*'.repeat(newApiKey.length - 4) + '....' + newApiKey.slice(-4);
        } else {
            maskedApiKey = '*'.repeat(newApiKey.length);
        }
        return res.status(200).json({ success: true, apiKey: maskedApiKey, realApiKey: newApiKey });
    } catch (error) {
        console.error('Error regenerating account token:', error);
        return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
};

/**
 * DELETE /api/accounts/:acctId/user/:userId
 * Delete a user's association with an account and clean up related data.
 * Deletes: UserAccount link, AccountApiKey, and the Account itself.
 * @access  Protected (SSO)
 */
export const deleteAccount = async (req, res) => {
    try {
        const { acctId, userId } = req.params;

        if (!acctId || !userId) {
            return res.status(400).json({ success: false, message: 'acctId and userId are required' });
        }

        if (req.user?.userId && userId !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Access denied: userId does not match authenticated user' });
        }

        // Verify the account exists
        const accountResult = await performGet(acctDataModel, { _id: acctId });
        if (!accountResult?.success || !accountResult.data?.length) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }

        // Verify the user is actually linked to this account
        const userLinkResult = await performGet(UserAccount, { acctId, userId });
        if (!userLinkResult?.success || !userLinkResult.data?.length) {
            return res.status(404).json({ success: false, message: 'User is not linked to this account' });
        }

        // Delete UserAccount link
        await performDelete(UserAccount, { acctId, userId });
        logger.info('UserAccount link deleted', { acctId, userId, operation: 'deleteUserAccount' });

        // Remove the user's admin record for this account (unlink removes admin status)
        await performDelete(AccountAdmin, { acctId, userId });
        invalidateAdminCache(userId, acctId);
        logger.info('AccountAdmin record deleted', { acctId, userId, operation: 'deleteAccountAdmin' });

        // Delete API keys for this account
        await performDelete(accountApiKeyModel, { acctId });
        logger.info('AccountApiKey deleted', { acctId, operation: 'deleteAccountApiKey' });

        // Delete the account itself
        await performDelete(acctDataModel, { _id: acctId });
        logger.info('Account deleted', { acctId, userId, operation: 'deleteAccount' });

        return res.status(200).json({
            success: true,
            message: 'Account and all associated data deleted successfully',
            deleted: { acctId, userId }
        });
    } catch (error) {
        console.error('Error deleting account:', error);
        return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
};
