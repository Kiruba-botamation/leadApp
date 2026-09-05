import { verifyAccountServices, getAdminsService } from '../services/accountService.js';
import { normaliseBotamationAdmin } from '../services/adminService.js';
import leadService from '../services/leadService.js';
import acctDataModel from '../models/accountModel.js';
import accountApiKeyModel from '../models/accountApiKeyModel.js';
import UserAccount from '../models/userAccountModel.js';
import AccountAdmin from '../models/accountAdminModel.js';
import LeadCollection from '../models/leadCollectionModel.js';
import Lead from '../models/leadModel.js';
import LeadNote from '../models/leadNoteModel.js';
import LeadReminder from '../models/leadReminderModel.js';
import LeadExport from '../models/leadExportModel.js';
import AnalyticsSchema from '../models/analyticsSchemaModel.js';
import WebhookConfig from '../models/webhookConfigModel.js';
import WebhookDelivery from '../models/webhookDeliveryModel.js';
import { performUpsert, performGet, perfomDataExistanceCheck, performDelete } from '../config/mongoConnector.js';
import { invalidateAdminCache } from '../middleware/ssoAuthMiddleware.js';
import { generateAccountToken } from '../utils/tokenGenerator.js';
import logger from '../utils/logger.js';
import collectionService from '../services/collectionService.js';
import { deleteStoredExport } from '../services/exportService.js';
import { cancelReminderJobs } from '../queue/reminderQueue.js';
import { removeWebhookJobs } from '../queue/webhookQueue.js';

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
        const { acctNo, phone } = req.body;
        const userId = req.user?.userId;
        const email = req.user?.email;

        if (!acctNo) {
            return res.status(400).json({ success: false, message: 'Account Number is required' });
        }

        if (!userId || !email) {
            return res.status(400).json({ success: false, message: 'Authenticated user ID and email are required' });
        }
        if (req.body.userId && String(req.body.userId) !== String(userId)) {
            return res.status(403).json({ success: false, message: 'Access denied: userId does not match authenticated user' });
        }

        // Make API call to the Botamation API
        const response = await verifyAccountServices(acctNo);

        // Check if the account is active
        if (response.active === '1') {
            try {
                let matchedAdmin;
                try {
                    matchedAdmin = findAdminByEmail(await getAdminsService(acctNo), email);
                } catch (adminError) {
                    console.error('verifyAccount: Error verifying account admin:', adminError);
                    return res.status(502).json({ success: false, message: 'Unable to verify account administrator membership' });
                }
                if (!matchedAdmin) {
                    return res.status(403).json({
                        success: false,
                        emailMismatch: true,
                        message: 'You should be an admin of the chatbot account to use this application. Please ask your account administrator for an invitation link to add yourself as admin of chatbot account.'
                    });
                }

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
                        // Reconcile the admin record for the linking user, keyed by
                        // chatbotAdminId:
                        //   - existing record for this chatbotAdminId → update email + userId
                        //     in place (preserving accessLevel). If the userId changed, move
                        //     that admin's leads to the new userId.
                        //   - no existing record → create a new one (default superadmin).
                        if (userId && acctId) {
                            const n = normaliseBotamationAdmin(matchedAdmin);
                            const resolvedEmail = email || req.user?.email || null;

                            let existingAdmin = n.chatbotAdminId
                                ? await AccountAdmin.findOne({ acctId, chatbotAdminId: n.chatbotAdminId })
                                : null;
                            if (!existingAdmin) {
                                existingAdmin = await AccountAdmin.findOne({ acctId, userId });
                            }

                            if (existingAdmin) {
                                const previousUserId = existingAdmin.userId;
                                existingAdmin.userId = userId;
                                existingAdmin.email = resolvedEmail ?? existingAdmin.email ?? null;
                                if (phone) existingAdmin.phone = phone;
                                existingAdmin.firstName = n.firstName;
                                existingAdmin.lastName = n.lastName;
                                existingAdmin.profileImage = n.profileImage;
                                if (n.chatbotAdminId) existingAdmin.chatbotAdminId = n.chatbotAdminId;
                                await existingAdmin.save();

                                // Leads follow the admin to the new user id when it changes
                                if (previousUserId && String(previousUserId) !== String(userId)) {
                                    const newName = [n.firstName, n.lastName].filter(Boolean).join(' ') || null;
                                    await leadService.reassignAdminLeads(acctId, previousUserId, userId, {
                                        name: newName,
                                        profileImage: n.profileImage || null
                                    });
                                    invalidateAdminCache(previousUserId, acctId);
                                }
                                logger.info('Admin record updated for linking user', { acctId, userId, operation: 'updateAccountAdmin' });
                            } else {
                                await AccountAdmin.create({
                                    userId,
                                    acctId,
                                    chatbotAdminId: n.chatbotAdminId,
                                    firstName: n.firstName,
                                    lastName: n.lastName,
                                    profileImage: n.profileImage,
                                    // Contact details come from the user's profile, not Botamation
                                    email: resolvedEmail,
                                    phone: phone || null,
                                    accessLevel: 'superadmin'
                                });
                                logger.info('Admin record created for linking user', { acctId, userId, operation: 'createAccountAdmin' });
                            }
                            invalidateAdminCache(userId, acctId);
                        }
                    } catch (adminError) {
                        console.error('verifyAccount: Error verifying account admin:', adminError);
                        return res.status(500).json({ success: false, message: 'Failed to link verified account administrator' });
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
 * Link an account after verifying the SSO email against the platform admin roster.
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

        const userId = req.user?.userId;
        const authenticatedEmail = req.user?.email;

        if (!userId || !authenticatedEmail) {
            return res.status(401).json({
                success: false,
                message: 'Authenticated user ID and email are required.'
            });
        }

        const suppliedUserId = req.body.userId || userData.userData.userId;
        if (suppliedUserId && String(suppliedUserId) !== String(userId)) {
            return res.status(403).json({ success: false, message: 'Access denied: userId does not match authenticated user' });
        }

        if (!userData.userData?.acctNo) {
            return res.status(400).json({
                success: false,
                message: 'Account number (acctNo) is required'
            });
        }

        let matchedAdmin;
        try {
            matchedAdmin = findAdminByEmail(
                await getAdminsService(userData.userData.acctNo),
                authenticatedEmail
            );
        } catch (error) {
            return res.status(502).json({ success: false, message: 'Unable to verify account administrator membership' });
        }
        if (!matchedAdmin) {
            return res.status(403).json({ success: false, message: 'Authenticated email is not an administrator of this account' });
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

        const normalizedAdmin = normaliseBotamationAdmin(matchedAdmin);
        let existingAdmin = normalizedAdmin.chatbotAdminId
            ? await AccountAdmin.findOne({ acctId, chatbotAdminId: normalizedAdmin.chatbotAdminId })
            : null;
        if (!existingAdmin) {
            existingAdmin = await AccountAdmin.findOne({ acctId, userId });
        }
        if (existingAdmin) {
            existingAdmin.userId = userId;
            existingAdmin.email = authenticatedEmail;
            existingAdmin.phone = userData.userData.phone || existingAdmin.phone || null;
            if (normalizedAdmin.chatbotAdminId) existingAdmin.chatbotAdminId = normalizedAdmin.chatbotAdminId;
            existingAdmin.firstName = normalizedAdmin.firstName;
            existingAdmin.lastName = normalizedAdmin.lastName;
            existingAdmin.profileImage = normalizedAdmin.profileImage;
            await existingAdmin.save();
        } else {
            await AccountAdmin.create({
                acctId,
                userId,
                email: authenticatedEmail,
                phone: userData.userData.phone || null,
                chatbotAdminId: normalizedAdmin.chatbotAdminId,
                firstName: normalizedAdmin.firstName,
                lastName: normalizedAdmin.lastName,
                profileImage: normalizedAdmin.profileImage,
                accessLevel: 'superadmin'
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
        const acctId = req.tenant.acctId;
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
        const acctId = req.tenant.acctId;
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
        const { userId } = req.params;
        const acctId = req.tenant.acctId;

        if (!acctId || !userId) {
            return res.status(400).json({ success: false, message: 'acctId and userId are required' });
        }
        if (String(req.params.acctId) !== String(acctId)) {
            return res.status(400).json({ success: false, message: 'Account path does not match verified account context' });
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

        // Revoke API access and queued writes before removing tenant data.
        await accountApiKeyModel.deleteMany({ acctId });
        const [{ removeExportJobs }, { removeLeadJobs }] = await Promise.all([
            import('../queue/exportQueue.js'),
            import('../queue/leadQueue.js')
        ]);
        await Promise.allSettled([
            removeLeadJobs({ acctId }),
            removeWebhookJobs({ acctId, allForAccount: true })
        ]);

        const exports = await LeadExport.find({ acctId }).lean();
        for (const exportDoc of exports) {
            await removeExportJobs(exportDoc).catch(() => {});
            await deleteStoredExport(exportDoc).catch(() => {});
        }

        const collections = await LeadCollection.find({ acctId }, { _id: 1 }).lean();
        for (const collection of collections) {
            await collectionService.deleteCollection(acctId, collection._id);
        }

        // Remove legacy/orphan leads that are not attached to an existing collection.
        while (true) {
            const leads = await Lead.find({ acctId }, { _id: 1 }).limit(200).lean();
            if (!leads.length) break;
            for (const lead of leads) await leadService.deleteLead(lead._id, acctId);
        }

        while (true) {
            const reminders = await LeadReminder.find({ acctId }, { _id: 1 }).limit(200).lean();
            if (!reminders.length) break;
            await LeadReminder.updateMany(
                { acctId, _id: { $in: reminders.map(item => item._id) } },
                { $set: { mainSent: true, preReminderSent: true, clientSent: true } }
            );
            await Promise.allSettled(reminders.map(item => cancelReminderJobs(item._id)));
            await LeadReminder.deleteMany({ acctId, _id: { $in: reminders.map(item => item._id) } });
        }
        await Promise.all([
            LeadNote.deleteMany({ acctId }),
            LeadExport.deleteMany({ acctId }),
            AnalyticsSchema.deleteMany({ acctId }),
            WebhookConfig.deleteMany({ acctId }),
            WebhookDelivery.deleteMany({ acctId }),
            Lead.deleteMany({ acctId }),
            LeadCollection.deleteMany({ acctId }),
            UserAccount.deleteMany({ acctId }),
            AccountAdmin.deleteMany({ acctId })
        ]);
        invalidateAdminCache(userId, acctId);
        logger.info('Tenant data deleted', { acctId, userId, operation: 'deleteTenantData' });

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
