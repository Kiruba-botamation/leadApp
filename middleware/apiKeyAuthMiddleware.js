import accountApiKeyModel from '../models/accountApiKeyModel.js';
import { performAggregate } from '../config/mongoConnector.js';

const API_KEY_AUTH_TIMEOUT_MS = parseInt(process.env.API_KEY_AUTH_TIMEOUT_MS ?? '5000', 10);
const withTimeout = (promise, timeoutMs, message) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
]);

/**
 * Middleware to validate x-api-key and acctId against the accountApiKey collection.
 * - Requires both apiKey and acctId to be present
 * - Requires x-api-key and x-page-id headers
 * - Validates that the apiKey belongs to the provided acctId
 * - Uses efficient token lookup with indexed query
 */
export const apiKeyAuthMiddleware = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'];

        // Resolve the provider account number from its documented header.
        const acctNo = req.headers['x-page-id'] ? String(req.headers['x-page-id']) : null;

        // 3️⃣ Validate both apiKey and acctNo are present
        if (!apiKey) {
            return res.status(400).json({ success: false, message: 'Missing apiKey' });
        }

        if (!acctNo) {
            return res.status(400).json({ success: false, message: 'Missing acctNo' });
        }

        //TODO: Add caching layer here if needed to reduce DB load for repeated requests with the same apiKey + acctNo
        // 5️⃣ Single query: match apiKey + join Account to verify acctNo — replaces 2 separate queries
        const results = await withTimeout(
            performAggregate(accountApiKeyModel, [
                { $match: { apiKey } },
                {
                    $lookup: {
                        from: 'accounts',
                        localField: 'acctId',
                        foreignField: '_id',
                        as: 'account'
                    }
                },
                { $unwind: '$account' },
                { $match: { 'account.acctNo': acctNo } }
            ]),
            API_KEY_AUTH_TIMEOUT_MS,
            `apiKeyAuth query timeout after ${API_KEY_AUTH_TIMEOUT_MS}ms`
        );

        if (!results || results.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid api key or account' });
        }

        const tokenDoc = results[0];
        const acctId = String(tokenDoc.acctId);

        // 6️⃣ Attach validated account info for downstream handlers
        req.acctId = acctId;
        req.acctNo = acctNo;
        req.accountToken = tokenDoc.apiKey;

        return next();
    } catch (err) {
        console.error('apiKeyAuthMiddleware error', err);
        if (err.message && err.message.includes('timeout')) {
            return res.status(503).json({ success: false, message: 'Authentication service timeout. Please retry.' });
        }
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
};
